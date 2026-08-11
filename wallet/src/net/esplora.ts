/**
 * Bitcoin, from an Esplora node.
 *
 * ## Why Esplora
 *
 * Three reasons, in order of how much they matter.
 *
 * It is **self-hostable**, and that is the only one that really counts. The
 * server is `electrs` or Blockstream's `esplora`, both of which run on a
 * laptop against your own bitcoind. A wallet whose only supported backend is
 * somebody's hosted API has quietly made that company a permanent observer of
 * its users, and this app is not going to be that even by default.
 *
 * It is **plain JSON over HTTP**, which a phone can speak without a socket
 * library. Electrum's protocol is line-delimited JSON over raw TCP, which
 * React Native cannot do without a native module, and adding one to a wallet
 * is adding a thing nobody in this repository can audit.
 *
 * And it is **widely deployed**, so somebody who has not yet run a node has
 * somewhere to start while they set one up.
 *
 * ## What this file is and is not
 *
 * It builds requests and parses answers. It does not fetch: the transport is
 * an argument, the same arrangement as `core/swap.ts`, so every function here
 * is tested against recorded responses from a real node rather than mocked at
 * the fetch layer.
 *
 * It also does not decide anything. Which addresses to ask about is
 * `core/discover.ts`; what the numbers mean is `core/watcher.ts`. This file
 * knows one node's HTTP surface and nothing about wallets.
 *
 * ## Amounts
 *
 * Esplora reports satoshis as JSON numbers. A satoshi count above 2^53 is not
 * representable, which is far more Bitcoin than exists, so the danger is not
 * overflow: it is that a number arrives as a float and silently loses its last
 * digit somewhere downstream. So every amount is converted to `bigint` at the
 * boundary here, once, and nothing past this file sees a `number` that means
 * money.
 */

import type { Atoms } from '../core/model';
import { parseJson, type Parsed, type Transport } from './http';

// ---------------------------------------------------------------------------
// Shapes, as Esplora sends them

interface RawStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

interface RawAddress {
  address?: string;
  chain_stats?: RawStats;
  mempool_stats?: RawStats;
}

interface RawUtxo {
  txid?: string;
  vout?: number;
  value?: number;
  status?: { confirmed?: boolean; block_height?: number };
}

interface RawTxVin {
  prevout?: { scriptpubkey_address?: string; value?: number } | null;
}

interface RawTxVout {
  scriptpubkey_address?: string;
  value?: number;
}

interface RawTx {
  txid?: string;
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
  vin?: RawTxVin[];
  vout?: RawTxVout[];
}

// ---------------------------------------------------------------------------
// What this module hands back

/** Whether an address has ever been paid, which is all discovery needs. */
export interface AddressActivity {
  address: string;
  /** Confirmed and unconfirmed together: a mempool payment makes it used. */
  used: boolean;
  received: Atoms;
  sent: Atoms;
  txCount: number;
}

export interface NodeUtxo {
  txid: string;
  vout: number;
  value: Atoms;
  confirmed: boolean;
  /** Null while unconfirmed. */
  height: number | null;
}

export interface NodeTx {
  txid: string;
  fee: Atoms;
  confirmed: boolean;
  height: number | null;
  /** Seconds since the epoch, as the chain reports it. Null while pending. */
  time: number | null;
  inputs: { address: string | null; value: Atoms }[];
  outputs: { address: string | null; value: Atoms }[];
}

/** sat/vB for a handful of block targets, as the node estimates them. */
export type FeeEstimates = Record<number, number>;

const atoms = (value: unknown): Atoms => {
  const n = typeof value === 'number' ? value : Number.NaN;
  /* Not `Math.round`. A non-integer satoshi count means the node is not
   * speaking Esplora, and rounding it would turn a protocol mismatch into a
   * balance that is quietly wrong. */
  if (!Number.isSafeInteger(n) || n < 0) return 0n;
  return BigInt(n);
};

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

// ---------------------------------------------------------------------------
// The calls

export async function addressActivity(
  transport: Transport,
  address: string,
): Promise<Parsed<AddressActivity>> {
  const reply = parseJson<RawAddress>(
    await transport.send({ method: 'GET', path: `/address/${encodeURIComponent(address)}` }),
  );
  if (!reply.ok) return reply;

  const chain = reply.value.chain_stats;
  const pool = reply.value.mempool_stats;
  if (!chain) return { ok: false, problem: 'That node did not answer with address statistics.' };

  const received = atoms(chain.funded_txo_sum) + atoms(pool?.funded_txo_sum);
  const sent = atoms(chain.spent_txo_sum) + atoms(pool?.spent_txo_sum);
  const txCount = (chain.tx_count ?? 0) + (pool?.tx_count ?? 0);

  return {
    ok: true,
    value: {
      address,
      /* Used means "the chain has seen it", not "it holds money". An address
       * that received and spent is used, and handing it out again would join
       * two payments together for anybody reading the chain. */
      used: txCount > 0 || received > 0n,
      received,
      sent,
      txCount,
    },
  };
}

export async function addressUtxos(
  transport: Transport,
  address: string,
): Promise<Parsed<NodeUtxo[]>> {
  const reply = parseJson<RawUtxo[]>(
    await transport.send({ method: 'GET', path: `/address/${encodeURIComponent(address)}/utxo` }),
  );
  if (!reply.ok) return reply;
  if (!Array.isArray(reply.value)) {
    return { ok: false, problem: 'That node did not answer with a list of outputs.' };
  }

  const out: NodeUtxo[] = [];
  for (const raw of reply.value) {
    const txid = text(raw.txid);
    if (!txid || typeof raw.vout !== 'number') continue;
    out.push({
      txid,
      vout: raw.vout,
      value: atoms(raw.value),
      confirmed: raw.status?.confirmed === true,
      height: typeof raw.status?.block_height === 'number' ? raw.status.block_height : null,
    });
  }
  return { ok: true, value: out };
}

export async function addressTxs(transport: Transport, address: string): Promise<Parsed<NodeTx[]>> {
  const reply = parseJson<RawTx[]>(
    await transport.send({ method: 'GET', path: `/address/${encodeURIComponent(address)}/txs` }),
  );
  if (!reply.ok) return reply;
  if (!Array.isArray(reply.value)) {
    return { ok: false, problem: 'That node did not answer with a list of transactions.' };
  }

  return {
    ok: true,
    value: reply.value.flatMap((raw) => {
      const txid = text(raw.txid);
      if (!txid) return [];
      return [{
        txid,
        fee: atoms(raw.fee),
        confirmed: raw.status?.confirmed === true,
        height: typeof raw.status?.block_height === 'number' ? raw.status.block_height : null,
        time: typeof raw.status?.block_time === 'number' ? raw.status.block_time : null,
        inputs: (raw.vin ?? []).map((vin) => ({
          address: text(vin.prevout?.scriptpubkey_address),
          value: atoms(vin.prevout?.value),
        })),
        outputs: (raw.vout ?? []).map((vout) => ({
          address: text(vout.scriptpubkey_address),
          value: atoms(vout.value),
        })),
      }];
    }),
  };
}

export async function tipHeight(transport: Transport): Promise<Parsed<number>> {
  const reply = await transport.send({ method: 'GET', path: '/blocks/tip/height' });
  if (!reply.ok) return { ok: false, problem: reply.problem };
  const body = reply.text.trim();
  /* Digits, explicitly. `Number('')` is zero and `Number(' ')` is zero, so a
   * node answering with nothing would otherwise read as a chain at genesis and
   * every confirmation count computed from it would be wrong rather than
   * missing. */
  const height = /^\d+$/.test(body) ? Number(body) : Number.NaN;
  if (!Number.isSafeInteger(height) || height < 0) {
    return { ok: false, problem: 'That node did not answer with a block height.' };
  }
  return { ok: true, value: height };
}

/**
 * The node's fee estimates, keyed by block target.
 *
 * Esplora answers with every target it knows. What the screen shows is three
 * of them, chosen in `core/watcher.ts`, because a person choosing a fee has
 * one question and it is not "which of twenty-eight confirmation targets".
 */
export async function feeEstimates(transport: Transport): Promise<Parsed<FeeEstimates>> {
  const reply = parseJson<Record<string, number>>(
    await transport.send({ method: 'GET', path: '/fee-estimates' }),
  );
  if (!reply.ok) return reply;

  const out: FeeEstimates = {};
  for (const [key, value] of Object.entries(reply.value ?? {})) {
    const target = Number(key);
    if (Number.isSafeInteger(target) && target > 0 && typeof value === 'number' && value > 0) {
      out[target] = value;
    }
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, problem: 'That node did not answer with any fee estimates.' };
  }
  return { ok: true, value: out };
}

/**
 * Publish a signed transaction.
 *
 * The one call in this file that changes anything, and the one whose failure
 * matters most. A node that rejects a transaction is usually saying something
 * specific and useful, so its answer is passed through rather than replaced
 * with a friendly sentence: "bad-txns-inputs-missingorspent" tells somebody
 * their coin was already spent, and "the broadcast failed" does not.
 */
export async function broadcast(transport: Transport, rawHex: string): Promise<Parsed<string>> {
  if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2) {
    return { ok: false, problem: 'That is not a transaction in hexadecimal.' };
  }
  const reply = await transport.send({
    method: 'POST',
    path: '/tx',
    body: rawHex,
    contentType: 'text/plain',
  });
  if (!reply.ok) return { ok: false, problem: reply.problem };

  const txid = reply.text.trim();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    /* A 200 that is not a txid is a node that accepted the request and did
     * something else. Reporting success here would tell somebody their payment
     * is on the chain when nothing is. */
    return {
      ok: false,
      problem: txid.length < 200 && txid.length > 0
        ? txid
        : 'The node accepted the transaction but did not return an identifier.',
    };
  }
  return { ok: true, value: txid };
}

/**
 * Is this actually an Esplora node, and is it on the chain we think?
 *
 * Run once when somebody adds a node, so the failure happens on the screen
 * where they typed the address rather than three screens later next to a
 * balance of zero. A wallet pointed at a testnet node shows a real, correct,
 * completely irrelevant zero, and that is a bad afternoon.
 */
export async function probe(transport: Transport): Promise<Parsed<{ height: number; genesis: string }>> {
  const height = await tipHeight(transport);
  if (!height.ok) return height;

  const hash = await transport.send({ method: 'GET', path: '/block-height/0' });
  if (!hash.ok) return { ok: false, problem: hash.problem };
  const genesis = hash.text.trim();
  if (!/^[0-9a-f]{64}$/.test(genesis)) {
    return { ok: false, problem: 'That does not answer like an Esplora node.' };
  }
  return { ok: true, value: { height: height.value, genesis } };
}

/** Bitcoin mainnet's genesis hash. The one string that settles which chain. */
export const MAINNET_GENESIS =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
