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
 * ## What this file is
 *
 * One node's HTTP surface, and no decisions.
 *
 *   - `info`, `feeEstimate` and `broadcast` against monerod's restricted RPC,
 *     which is the surface a public node exposes and the one your own node
 *     exposes with `--restricted-rpc`.
 *   - `ownsOutput` and `scanTransaction`, the ownership test itself.
 *   - `blockAt` and `transactions`, which are the two calls a chain walk needs.
 *
 * What to do with those, in what order, from which height, and what the
 * resulting numbers may honestly be called, is `core/moneroscan.ts`. The
 * division is the same one `net/esplora.ts` keeps against `core/discover.ts`,
 * and for the same reason: a file that both talks to a node and decides what
 * its answers mean is a file where a wrong answer becomes a wrong balance
 * without passing anything that could have refused it.
 *
 * The scan here is over JSON rather than `/get_blocks.bin`, which is the fast
 * path and speaks epee portable storage, a binary format with no specification
 * outside Monero's own source. That trade is argued in full further down, next
 * to the code it applies to.
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
  const derivation = keyDerivation(keys.viewSecret, txPublicKey);
  return derivation ? ownsWithDerivation(derivation, keys.spendPublic, candidate) : null;
}

/**
 * The shared secret for one transaction, computed once.
 *
 * Split out because it is the expensive half. The derivation is a scalar
 * multiplication and it is the same for every output of a transaction, while
 * the per-output work below is a hash and a point addition. A scanner that
 * recomputed it per output would do the costly operation three times for a
 * three-output transaction and get the same answer each time, which on a phone
 * walking a hundred thousand blocks is the difference between a sync and an
 * afternoon.
 *
 * Null rather than throwing. A malformed key on a chain we do not control is
 * an ordinary event and not an exception.
 */
export function keyDerivation(viewSecret: Uint8Array, txPublicKey: string): Uint8Array | null {
  try {
    return generateKeyDerivation(fromHex(txPublicKey), viewSecret);
  } catch {
    return null;
  }
}

/** The per-output half of `ownsOutput`, given a derivation already computed. */
export function ownsWithDerivation(
  derivation: Uint8Array,
  spendPublic: string,
  candidate: OutputCandidate,
): OwnedOutput | null {
  try {
    const derived = toHex(derivePublicKey(derivation, candidate.index, fromHex(spendPublic)));
    return derived === candidate.key.toLowerCase() ? { ...candidate, derived } : null;
  } catch {
    /* An output we cannot parse is an output that is not ours, which is the
     * same conclusion by a shorter route. */
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
  const derivation = keyDerivation(keys.viewSecret, txPublicKey);
  if (!derivation) return [];

  const found: OwnedOutput[] = [];
  for (const candidate of outputs) {
    const owned = ownsWithDerivation(derivation, keys.spendPublic, candidate);
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

// ---------------------------------------------------------------------------
// Walking the chain, over JSON
//
// `/get_blocks.bin` is the fast way and it speaks epee portable storage, a
// binary format with no specification outside Monero's own source. Writing a
// decoder for it with no real blobs to check against is exactly the kind of
// unverified work this repository refuses elsewhere, so the sync below uses
// the JSON surface instead: `get_block` for a height, `/get_transactions` with
// `decode_as_json` for its contents.
//
// That is slower. More requests, more bytes, more parsing. It is also
// available on every restricted public node, needs nothing that cannot be
// tested here against recorded answers, and is correct. When an epee decoder
// exists and has been checked against a real node, it slots in underneath
// `blockTransactions` and nothing above this line changes.

export interface BlockSummary {
  height: number;
  hash: string;
  /** Hashes of the ordinary transactions. The miner's is not among them. */
  txHashes: string[];
  /** The coinbase transaction, which the node reports separately. */
  minerTxHash: string | null;
  timestamp: number;
}

export async function blockAt(transport: Transport, height: number): Promise<Parsed<BlockSummary>> {
  const reply = await rpc<{
    block_header?: { hash?: string; height?: number; timestamp?: number; miner_tx_hash?: string };
    tx_hashes?: unknown;
    json?: string;
  }>(transport, 'get_block', { height });
  if (!reply.ok) return reply;

  const header = reply.value.block_header;
  if (!header || typeof header.hash !== 'string') {
    return { ok: false, problem: 'That node did not answer with a block.' };
  }

  /* `tx_hashes` is absent on a block containing only its miner transaction,
   * which is most blocks. Absent means empty, not malformed. */
  const hashes = Array.isArray(reply.value.tx_hashes)
    ? reply.value.tx_hashes.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    ok: true,
    value: {
      height: typeof header.height === 'number' ? header.height : height,
      hash: header.hash,
      txHashes: hashes,
      minerTxHash: /^[0-9a-f]{64}$/i.test(String(header.miner_tx_hash))
        ? String(header.miner_tx_hash).toLowerCase()
        : null,
      timestamp: typeof header.timestamp === 'number' ? header.timestamp : 0,
    },
  };
}

/** One transaction, reduced to what scanning needs and nothing else. */
export interface ScannableTx {
  hash: string;
  /** The one-time key on each output, in order. */
  outputs: OutputCandidate[];
  /** The transaction public key, pulled out of `extra`. Null when absent. */
  publicKey: string | null;
  /**
   * The RingCT version, as the transaction declares it.
   *
   * Zero means the amounts are in the clear, which is every transaction before
   * 2017 and every coinbase since. Four and above carry the eight-byte masked
   * amount this wallet can open. One through three are the older RingCT forms,
   * whose amounts are encrypted differently, and `core/moneroscan.ts` says so
   * rather than guessing at them.
   */
  rctType: number;
  /** The masked amount for each output, hex, in output order. */
  ecdh: string[];
  /** The Pedersen commitment for each output, hex, in output order. */
  commitments: string[];
  /**
   * The key image on each input, which is how the chain names a spend.
   *
   * To anyone without the matching list, these are unlinkable points and
   * carrying them is free. To a wallet that has imported its own key images
   * from the vault, one of these matching is the moment it learns an output
   * it received has been spent, which is the entire mechanism behind showing
   * a balance rather than a received total.
   */
  spends: string[];
}

interface RawJsonTx {
  vout?: { amount?: number; target?: { key?: string; tagged_key?: { key?: string } } }[];
  vin?: { key?: { k_image?: string } }[];
  extra?: number[];
  rct_signatures?: {
    type?: number;
    ecdhInfo?: { amount?: string }[];
    outPk?: (string | { mask?: string })[];
  };
}

/** Hex or nothing. The chain is not a trusted source of well-formed strings. */
const hexOrNull = (value: unknown, bytes?: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.toLowerCase();
  if (!/^[0-9a-f]*$/.test(text) || text.length % 2) return null;
  if (bytes !== undefined && text.length !== bytes * 2) return null;
  return text;
};

/**
 * Transactions by hash, decoded far enough to scan.
 *
 * monerod returns each transaction's body as a JSON *string* inside the reply,
 * which then has to be parsed again. That is not a mistake in this code: it is
 * how `decode_as_json` works, and the double parse is the price of not writing
 * an epee decoder.
 */
export async function transactions(
  transport: Transport,
  hashes: readonly string[],
): Promise<Parsed<ScannableTx[]>> {
  if (hashes.length === 0) return { ok: true, value: [] };
  for (const hash of hashes) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) {
      return { ok: false, problem: 'That node listed a transaction hash that is not one.' };
    }
  }

  const reply = parseJson<{ txs?: { tx_hash?: string; as_json?: string }[]; status?: string }>(
    await transport.send({
      method: 'POST',
      path: '/get_transactions',
      body: { txs_hashes: [...hashes], decode_as_json: true },
    }),
  );
  if (!reply.ok) return reply;
  if (!Array.isArray(reply.value.txs)) {
    return { ok: false, problem: 'That node did not answer with transactions.' };
  }

  const out: ScannableTx[] = [];
  for (const entry of reply.value.txs) {
    const hash = typeof entry.tx_hash === 'string' ? entry.tx_hash : '';
    if (!hash || typeof entry.as_json !== 'string') continue;

    let body: RawJsonTx;
    try {
      body = JSON.parse(entry.as_json) as RawJsonTx;
    } catch {
      /* One unreadable transaction is one transaction whose outputs are not
       * found. Failing the whole block would stall the scan on a single odd
       * entry; skipping it loses at most that transaction, and the height is
       * recorded so a later pass over the same range would find it. */
      continue;
    }

    const outputs: OutputCandidate[] = [];
    (body.vout ?? []).forEach((vout, index) => {
      /* Two shapes, and both are current. `target.key` is the older form;
       * `target.tagged_key.key` arrives with view tags, which most outputs
       * have carried since 2022. A scanner that knew only one of them would
       * quietly find nothing on a modern chain. */
      const key = vout.target?.tagged_key?.key ?? vout.target?.key;
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) return;
      outputs.push({
        key: key.toLowerCase(),
        amount: typeof vout.amount === 'number' && vout.amount > 0 ? BigInt(vout.amount) : null,
        index,
      });
    });

    const extra = Array.isArray(body.extra)
      ? Uint8Array.from(body.extra.filter((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256))
      : new Uint8Array(0);

    const rct = body.rct_signatures;
    /* `outPk` is serialized two ways depending on the node's version: a bare
     * mask string, or an object with the mask under a key. Both mean the same
     * commitment, and a scanner that understood only one would report every
     * amount as unverifiable against half the nodes in the network. */
    const commitments = (rct?.outPk ?? []).map((entry) =>
      hexOrNull(typeof entry === 'string' ? entry : entry?.mask, 32) ?? '',
    );

    /* A coinbase input has no key image and arrives as a different shape
     * (`gen` rather than `key`); it simply produces nothing here. */
    const spends = (body.vin ?? [])
      .map((vin) => hexOrNull(vin?.key?.k_image, 32))
      .filter((image): image is string => image !== null);

    out.push({
      hash,
      outputs,
      publicKey: transactionPublicKey(extra),
      rctType: typeof rct?.type === 'number' ? rct.type : 0,
      ecdh: (rct?.ecdhInfo ?? []).map((entry) => hexOrNull(entry?.amount) ?? ''),
      commitments,
      spends,
    });
  }

  return { ok: true, value: out };
}

/**
 * Ask the node whether these key images have been spent.
 *
 * `/is_key_image_spent` answers a number per image: 0 not spent, 1 spent in a
 * block, 2 spent in the transaction pool. Pool counts as spent here, for the
 * same reason an unconfirmed payment counts as used on the Bitcoin side:
 * money that is leaving has left, as far as a person deciding what they can
 * spend is concerned.
 *
 * ## What asking costs, stated where the call is
 *
 * This is the one Monero call in this app that tells the node something about
 * *you*. The scan never does: blocks are fetched whole and tested locally.
 * But a key image handed to a node in a question is a key image the node can
 * recognize later, on the chain, as yours; from then on that operator can tell
 * when you spend, though still not what or to whom. The alternative is
 * rescanning the whole chain after every key image import, which is hours.
 * The caller chooses; this function just says the price. `docs/monero-sync.md`
 * carries the longer version.
 */
export async function isKeyImageSpent(
  transport: Transport,
  images: readonly string[],
): Promise<Parsed<{ image: string; spent: boolean }[]>> {
  if (images.length === 0) return { ok: true, value: [] };
  for (const image of images) {
    if (!/^[0-9a-f]{64}$/i.test(image)) {
      return { ok: false, problem: 'That is not a key image.' };
    }
  }

  const reply = parseJson<{ spent_status?: unknown; status?: string }>(
    await transport.send({
      method: 'POST',
      path: '/is_key_image_spent',
      body: { key_images: [...images] },
    }),
  );
  if (!reply.ok) return reply;

  const statuses = reply.value.spent_status;
  if (!Array.isArray(statuses) || statuses.length !== images.length) {
    /* An answer that does not line up one-to-one with the question cannot be
     * matched to it, and guessing at the alignment would mark the wrong
     * output spent. */
    return { ok: false, problem: 'That node did not answer once per key image.' };
  }

  return {
    ok: true,
    value: images.map((image, at) => ({
      image: image.toLowerCase(),
      spent: statuses[at] === 1 || statuses[at] === 2,
    })),
  };
}
