/**
 * The stagenet dry run: the one thing a test environment cannot do, made
 * runnable for a human who can.
 *
 * The gate on a mainnet Monero spend stays shut until a transaction built by
 * this code has been accepted by a real node. That evidence is a stagenet
 * transaction id, and making it needs three things a CI box does not have:
 * stagenet coins, a reachable stagenet node, and a person. This script is what
 * that person runs. It drives the exact loop the app drives, `executeMoneroSend`,
 * with the real vault signer in process instead of across a QR airgap, because
 * on stagenet the airgap buys nothing and the loop is identical either way.
 *
 * Run it, from the `wallet` directory, with the funded output described in a
 * JSON file (the one manual step: the global index and commitment of a coin
 * you already hold, which your own node or a stagenet explorer will tell you):
 *
 *   LABYRINTH_XMR_SEED=<64 hex, the spend seed> \
 *   LABYRINTH_XMR_NODE=https://your-stagenet-node:38081 \
 *   LABYRINTH_XMR_TO=<destination stagenet address> \
 *   LABYRINTH_XMR_AMOUNT=<piconero> \
 *   LABYRINTH_XMR_OWNED=./funded.json \
 *   npx tsx scripts/stagenet-send.ts
 *
 * `funded.json` is an array of spendable outputs:
 *   [{ "globalIndex": 12345, "key": "<64 hex>", "commitment": "<64 hex>",
 *      "amount": "2000000000000", "txPublicKey": "<64 hex>", "indexInTx": 0 }]
 *
 * On success it prints the transaction id. That id, and the node that accepted
 * it, are what fill in the "Recorded live acceptances" section of
 * `docs/monero-send.md` and flip `MONERO_SEND_BROADCAST_VERIFIED`, in the same
 * commit, which is the only way that constant is allowed to move.
 *
 * It refuses mainnet. The gate is not this script's to lift.
 */

import { readFileSync } from 'node:fs';
import { live } from '../src/net/http';
import { info, feeEstimate } from '../src/net/monerod';
import { executeMoneroSend } from '../src/core/monerosend';
import type { SpendableOutput } from '../src/core/monerospend';
import {
  parseUnsignedSet,
  signMoneroSpend,
  encodeSignedTx,
  signingRandomCount,
} from '@vault/keys/monerobuild';
import { walletFromSeed, type Network } from '@vault/keys/monero';
import { randomBytes } from 'node:crypto';

function env(name: string, required = true): string {
  const value = process.env[name];
  if (!value && required) {
    console.error(`Missing ${name}. See the header of this file for the full list.`);
    process.exit(2);
  }
  return value ?? '';
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2) throw new Error('not hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main(): Promise<void> {
  const network = (process.env['LABYRINTH_XMR_NETWORK'] ?? 'stagenet') as Network;
  if (network === 'mainnet') {
    console.error('This script is for stagenet or testnet. The mainnet gate is not lifted here.');
    process.exit(2);
  }

  const seed = hexToBytes(env('LABYRINTH_XMR_SEED'));
  if (seed.length !== 32) { console.error('LABYRINTH_XMR_SEED must be 32 bytes of hex.'); process.exit(2); }
  const wallet = walletFromSeed(seed, network);
  console.error(`Wallet ${wallet.address} on ${network}.`);

  const owned = JSON.parse(readFileSync(env('LABYRINTH_XMR_OWNED'), 'utf8')) as Array<Record<string, unknown>>;
  const spendable: SpendableOutput[] = owned.map((o) => ({
    globalIndex: Number(o['globalIndex']),
    key: String(o['key']),
    commitment: String(o['commitment']),
    amount: BigInt(String(o['amount'])),
    txPublicKey: String(o['txPublicKey']),
    indexInTx: Number(o['indexInTx']),
  }));
  console.error(`${spendable.length} funded output(s), totalling ${spendable.reduce((s, o) => s + o.amount, 0n)} piconero.`);

  const transport = live(env('LABYRINTH_XMR_NODE'));
  const tip = await info(transport);
  if (!tip.ok) { console.error(`Node: ${tip.problem}`); process.exit(1); }
  console.error(`Node at height ${tip.value.height}${tip.value.syncing ? ' (still syncing)' : ''}.`);

  let feePerByte = 0n;
  const feeOverride = process.env['LABYRINTH_XMR_FEE_PER_BYTE'];
  if (feeOverride) {
    feePerByte = BigInt(feeOverride);
  } else {
    const estimate = await feeEstimate(transport);
    if (!estimate.ok) { console.error(`Fee estimate: ${estimate.problem}`); process.exit(1); }
    feePerByte = estimate.value;
  }
  console.error(`Fee rate: ${feePerByte} piconero/byte.`);

  /* The vault, in process. It parses the unsigned set exactly as the airgapped
   * device would, signs with fresh CSPRNG entropy, and hands back the signed
   * payload. On a real device this is the QR round trip. */
  const sign = async (unsignedBytes: Uint8Array): Promise<Uint8Array> => {
    const parsed = parseUnsignedSet(unsignedBytes);
    if (!parsed.ok) throw new Error(parsed.problem);
    const need = signingRandomCount(parsed.set.inputs.length, parsed.set.ringSize, parsed.set.outputs.length);
    const scalars = Array.from({ length: need }, () => new Uint8Array(randomBytes(32)));
    const signed = signMoneroSpend(wallet, parsed.set, scalars);
    if (!signed.ok) throw new Error(signed.problem);
    console.error(`Signed: ${signed.tx.txid} (weight ${signed.tx.weight}, fee ${signed.tx.fee}).`);
    return encodeSignedTx(signed.tx);
  };

  const result = await executeMoneroSend({
    transport,
    ownAddress: wallet.address,
    network,
    owned: spendable,
    destinations: [{ address: env('LABYRINTH_XMR_TO'), amount: BigInt(env('LABYRINTH_XMR_AMOUNT')) }],
    feePerByte,
    uniform: () => randomBytes(4).readUInt32BE(0) / 0x100000000,
    sign,
  });

  if (!result.ok) {
    console.error(`Stopped at ${result.stage}: ${result.problem}`);
    process.exit(1);
  }
  console.error('Accepted by the node.');
  /* The one line stdout carries: the txid, for the evidence commit. */
  console.log(result.txid);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
