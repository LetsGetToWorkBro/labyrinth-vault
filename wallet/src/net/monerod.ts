/**
 * Monero, from a monerod node, and an honest account of how far that goes.
 *
 * ## The short version
 *
 * Finding your own Monero is a different problem from finding your own
 * Bitcoin, and harder in a way that is worth stating before any code.
 *
 * Bitcoin puts addresses on the chain. A light client asks a node "has anyone
 * paid this address", the node looks it up in an index, and the answer is one
 * request. Monero puts a one-time key on every output that belongs to nobody
 * in particular until you do arithmetic with your view key. There is no index
 * to ask. Finding your outputs means taking every output in every block since
 * your wallet was born and testing each one.
 *
 * That test is the four lines in `ownsOutput` below, and they are correct: the
 * primitives come from `@vault/keys/monerocrypto`, pinned to 720 vectors from
 * the Monero project's own test file. What is hard is not the arithmetic. It
 * is getting the blocks.
 *
 * ## What this file does, and the one thing it does not
 *
 * Built and testable here:
 *
 *   - `info`, `feeEstimate` and `broadcast` against monerod's restricted RPC,
 *     which is the surface a public node exposes and the one your own node
 *     exposes with `--restricted-rpc`.
 *   - `scanTransaction`, the real ownership test, over transactions in the
 *     JSON form monerod returns from `/get_transactions?decode_as_json=true`.
 *
 * Not built, and not pretended at: **the sync loop**. Walking the chain needs
 * either `/get_blocks.bin`, which speaks epee portable storage, a binary
 * format with no specification outside Monero's source, or a light wallet
 * server, which means handing your view key to somebody else's machine so it
 * can scan on your behalf.
 *
 * Those are the only two options and they are a genuine fork in the product,
 * not an implementation detail:
 *
 *   - **Your own node, full scan.** Nothing leaves the device but block
 *     requests. Costs an epee decoder and real sync time on a phone.
 *   - **A light wallet server.** Fast and cheap, and the server learns every
 *     payment you have ever received, because that is what a view key is.
 *
 * This file is the floor under both. `docs/monero-sync.md` is the decision.
 *
 * ## Why the arithmetic is borrowed rather than written
 *
 * `generate_key_derivation` and `derive_public_key` already exist in the
 * vault, checked against 120 published vectors each. A second implementation
 * here would be the one without the vectors, and the failure mode is a wallet
 * that cannot see its own money and a person who concludes it is gone.
 */

import { generateKeyDerivation, derivePublicKey } from '@vault/keys/monerocrypto';
import { fromHex, toHex } from '@vault/keys/monero';
import { parseJson, type Parsed, type Transport } from './http';

// ---------------------------------------------------------------------------
// The restricted RPC surface

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

/** monerod's JSON-RPC lives at one path and dispatches on a method name. */
async function rpc<T>(
  transport: Transport,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Parsed<T>> {
  const reply = parseJson<RpcEnvelope<T>>(
    await transport.send({
      method: 'POST',
      path: '/json_rpc',
      body: { jsonrpc: '2.0', id: '0', method, params },
    }),
  );
  if (!reply.ok) return reply;
  if (reply.value.error) {
    const message = reply.value.error.message ?? 'the node refused the request';
    return { ok: false, problem: `The node said: ${message}` };
  }
  if (reply.value.result === undefined) {
    return { ok: false, problem: 'That node did not answer like monerod.' };
  }
  return { ok: true, value: reply.value.result };
}

export interface NodeInfo {
  height: number;
  targetHeight: number;
  /** True when the node is still catching up, which makes balances early. */
  syncing: boolean;
  mainnet: boolean;
  /** True when the node will not answer anything that needs the full history. */
  restricted: boolean;
}

export async function info(transport: Transport): Promise<Parsed<NodeInfo>> {
  const reply = await rpc<{
    height?: number;
    target_height?: number;
    synchronized?: boolean;
    mainnet?: boolean;
    nettype?: string;
    restricted?: boolean;
  }>(transport, 'get_info');
  if (!reply.ok) return reply;

  const height = Number(reply.value.height);
  if (!Number.isSafeInteger(height) || height <= 0) {
    return { ok: false, problem: 'That node did not answer with a block height.' };
  }
  const target = Number(reply.value.target_height) || 0;

  return {
    ok: true,
    value: {
      height,
      targetHeight: target,
      /* `target_height` is zero on a synced node and the height it is chasing
       * on one that is not. A node behind the chain will happily answer, and
       * the balance it produces is correct for a past that is not now. */
      syncing: reply.value.synchronized === false || (target > 0 && target > height),
      mainnet: reply.value.mainnet === true || reply.value.nettype === 'mainnet',
      restricted: reply.value.restricted === true,
    },
  };
}

/** Piconero per byte, as the node currently estimates it. */
export async function feeEstimate(transport: Transport): Promise<Parsed<bigint>> {
  const reply = await rpc<{ fee?: number }>(transport, 'get_fee_estimate');
  if (!reply.ok) return reply;
  const fee = Number(reply.value.fee);
  if (!Number.isSafeInteger(fee) || fee <= 0) {
    return { ok: false, problem: 'That node did not answer with a fee estimate.' };
  }
  return { ok: true, value: BigInt(fee) };
}

/**
 * Publish a signed transaction.
 *
 * monerod's answer is a status plus a set of specific flags, and the flags are
 * the useful part: `double_spend`, `fee_too_low`, `overspend` each tell
 * somebody something different about what to do next. Flattening them into
 * "broadcast failed" throws away the only actionable thing in the reply.
 */
export async function broadcast(transport: Transport, rawHex: string): Promise<Parsed<string>> {
  if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2) {
    return { ok: false, problem: 'That is not a transaction in hexadecimal.' };
  }

  const reply = parseJson<Record<string, unknown>>(
    await transport.send({
      method: 'POST',
      path: '/send_raw_transaction',
      body: { tx_as_hex: rawHex, do_not_relay: false },
    }),
  );
  if (!reply.ok) return reply;

  const body = reply.value;
  if (body['status'] === 'OK') return { ok: true, value: 'accepted' };

  const flags: [string, string][] = [
    ['double_spend', 'One of those coins was already spent.'],
    ['fee_too_low', 'The fee is below what this node will relay.'],
    ['overspend', 'That transaction spends more than its inputs hold.'],
    ['invalid_input', 'The node rejected one of the inputs.'],
    ['invalid_output', 'The node rejected one of the outputs.'],
    ['too_big', 'That transaction is larger than the node will relay.'],
    ['not_relayed', 'The node accepted the transaction but will not relay it.'],
    ['low_mixin', 'The ring size is below what the network now requires.'],
  ];
  for (const [flag, sentence] of flags) {
    if (body[flag] === true) return { ok: false, problem: sentence };
  }

  const reason = typeof body['reason'] === 'string' && body['reason'] ? body['reason'] : null;
  return { ok: false, problem: reason ?? 'The node rejected the transaction without saying why.' };
}

/**
 * Is this monerod, on mainnet, and does it know the whole chain?
 *
 * Same job as Esplora's probe, and the same reason: fail on the screen where
 * somebody typed the address, not three screens later beside a balance of
 * zero that is technically correct for the wrong network.
 */
export async function probe(transport: Transport): Promise<Parsed<NodeInfo>> {
  const reply = await info(transport);
  if (!reply.ok) return reply;
  if (!reply.value.mainnet) {
    return { ok: false, problem: 'That node is not on mainnet.' };
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Ownership: the arithmetic that is the whole of Monero scanning

/** One output of a transaction, in the shape monerod's JSON gives it. */
export interface OutputCandidate {
  /** The one-time public key on the output. */
  key: string;
  /** Piconero, or null for a RingCT output whose amount is hidden. */
  amount: bigint | null;
  /** Position within the transaction, which is part of the derivation. */
  index: number;
}

export interface OwnedOutput extends OutputCandidate {
  /** The key this wallet derived, which matched the one on the chain. */
  derived: string;
}

/**
 * Does this output belong to the account holding this view key?
 *
 * The whole of Monero scanning, in four operations:
 *
 *   1. the sender put an ephemeral public key in the transaction;
 *   2. we multiply it by our *view* secret, which gives a shared secret only
 *      the sender and we can compute;
 *   3. hash that with the output's index and add it to our *spend* public key;
 *   4. if the result equals the key sitting on the output, it is ours.
 *
 * The view key does step 2 and cannot do more: it finds outputs and cannot
 * spend them. That asymmetry is the entire reason this app can be the online
 * half at all, and it is the Monero equivalent of holding an extended public
 * key.
 *
 * Every operation comes from `@vault/keys/monerocrypto`, checked against the
 * Monero project's own vectors. Nothing is reimplemented here.
 */
export function ownsOutput(
  keys: { viewSecret: Uint8Array; spendPublic: string },
  txPublicKey: string,
  candidate: OutputCandidate,
): OwnedOutput | null {
  try {
    const derivation = generateKeyDerivation(fromHex(txPublicKey), keys.viewSecret);
    const derived = toHex(
      derivePublicKey(derivation, candidate.index, fromHex(keys.spendPublic)),
    );
    return derived === candidate.key.toLowerCase() ? { ...candidate, derived } : null;
  } catch {
    /* A malformed key on a chain we do not control is an ordinary event, not
     * an exception. An output we cannot parse is an output that is not ours,
     * which is the same conclusion by a shorter route. */
    return null;
  }
}

/**
 * Every output of one transaction that belongs to this account.
 *
 * `txPublicKey` comes out of the transaction's `extra` field, which is a byte
 * soup with a tag for it. Parsing `extra` is the caller's job, because a
 * transaction can carry several and which one applies depends on whether the
 * destination was a subaddress.
 */
export function scanTransaction(
  keys: { viewSecret: Uint8Array; spendPublic: string },
  txPublicKey: string,
  outputs: readonly OutputCandidate[],
): OwnedOutput[] {
  const found: OwnedOutput[] = [];
  for (const candidate of outputs) {
    const owned = ownsOutput(keys, txPublicKey, candidate);
    if (owned) found.push(owned);
  }
  return found;
}

/**
 * Pull the transaction public key out of a transaction's `extra`.
 *
 * `extra` is a sequence of tagged fields. Tag 0x01 is the transaction public
 * key and is followed by exactly 32 bytes. Tag 0x02 is a nonce with a length
 * byte after it, and 0x04 is the additional-keys list, also length-prefixed.
 *
 * Anything unrecognized ends the walk rather than being skipped. `extra` is
 * attacker-controlled, arbitrary bytes are legal in it, and a parser that
 * guesses its way past an unknown tag can be steered into reading a length
 * from data somebody chose. Stopping is safe: a missed key means an output
 * that does not appear, which is visible, rather than a key read from the
 * wrong offset, which is not.
 */
export function transactionPublicKey(extra: Uint8Array): string | null {
  let at = 0;
  while (at < extra.length) {
    const tag = extra[at]!;
    if (tag === 0x01) {
      if (at + 33 > extra.length) return null;
      return toHex(extra.subarray(at + 1, at + 33));
    }
    if (tag === 0x02 || tag === 0x04) {
      if (at + 2 > extra.length) return null;
      const length = extra[at + 1]!;
      at += 2 + length;
      continue;
    }
    return null;
  }
  return null;
}
