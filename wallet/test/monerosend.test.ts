/**
 * The whole cold-signing loop, end to end, with the real vault signer.
 *
 * This is the closest a test environment gets to the stagenet dry run that
 * lifts the gate: a wallet built from a seed, funded by a synthetic payer, a
 * plan drawn against a node with a real output distribution, the unsigned set
 * handed to the actual vault signer, and the signed bytes carried back and
 * "broadcast" to the node. The airgap is a direct call to `signMoneroSpend`;
 * on a real device it is a QR round trip, and the loop is identical.
 *
 * What this proves that the isolated tests do not: that the unsigned set the
 * wallet builds is one the vault can actually sign, that the signed bytes parse
 * back, and that the network gate lets a stagenet send through and holds a
 * mainnet one. What it cannot prove is a real node's acceptance; that is the
 * dry run, and `scripts/stagenet-send.ts` is what performs it.
 */

import { describe, expect, it } from 'vitest';
import { executeMoneroSend } from '../src/core/monerosend';
import type { SpendableOutput } from '../src/core/monerospend';
import { signingRandomCount } from '@vault/keys/monerobuild';
import {
  parseUnsignedSet,
  signMoneroSpend,
  encodeSignedTx,
} from '@vault/keys/monerobuild';
import {
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
} from '@vault/keys/monerocrypto';
import { fromHex, publicFromSecret, toHex, walletFromSeed, type Wallet } from '@vault/keys/monero';
import type { Reply, Request, Transport } from '../src/net/http';

function det(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 32; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  b[31] = b[31]! & 0x0f;
  return b;
}

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

const sender: Wallet = walletFromSeed(det(0x51a9e), 'stagenet');
const receiver: Wallet = walletFromSeed(det(0x2ece1), 'stagenet');

/** An output the sender owns, funded the way a real payer funds one. */
function fundSender(amount: bigint, globalIndex: number, seed: number): SpendableOutput {
  const payerSecret = det(seed);
  const txPublicKey = publicFromSecret(payerSecret);
  const derivation = generateKeyDerivation(fromHex(sender.viewPublic), payerSecret);
  const indexInTx = 0;
  const mask = commitmentMask(derivationToScalar(derivation, indexInTx));
  return {
    globalIndex,
    key: toHex(derivePublicKey(derivation, indexInTx, fromHex(sender.spendPublic))),
    commitment: toHex(commit(amount, mask)),
    amount,
    txPublicKey: toHex(txPublicKey),
    indexInTx,
  };
}

/** A node with a dense distribution and get_outs answers matching the input. */
function fakeNode(real: SpendableOutput, options: { rejectBroadcast?: boolean } = {}): { transport: Transport; broadcasts: string[] } {
  const broadcasts: string[] = [];
  const tip = 90_000;
  const transport: Transport = {
    base: 'https://stagenet.example',
    async send(request: Request): Promise<Reply> {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        return { ok: true, status: 200, text: JSON.stringify({ result: { height: tip, target_height: 0, synchronized: true, mainnet: false, status: 'OK' } }) };
      }
      if (request.path === '/json_rpc' && body['method'] === 'get_output_distribution') {
        // 100k blocks, 40 outputs each: ~4M outputs, plenty to hide the real one in.
        const cumulative: number[] = [];
        let total = 0;
        for (let i = 0; i < 100_000; i++) { total += 40; cumulative.push(total); }
        return { ok: true, status: 200, text: JSON.stringify({ result: { distributions: [{ distribution: cumulative, start_height: 0, base: 0 }] } }) };
      }
      if (request.path === '/get_outs') {
        const requested = (body['outputs'] ?? []) as { index: number }[];
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            outs: requested.map((o, position) => {
              if (o.index === real.globalIndex) {
                return { key: real.key, mask: real.commitment, unlocked: true, height: 1 };
              }
              return { key: toHex(publicFromSecret(det(0x8000 + position * 2))), mask: toHex(publicFromSecret(det(0x8001 + position * 2))), unlocked: true, height: 1 };
            }),
          }),
        };
      }
      if (request.path === '/send_raw_transaction') {
        broadcasts.push(String(body['tx_as_hex']));
        if (options.rejectBroadcast) return { ok: true, status: 200, text: JSON.stringify({ status: 'Failed', fee_too_low: true }) };
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK' }) };
      }
      return { ok: false, status: 404, problem: `no ${request.path}` };
    },
  };
  return { transport, broadcasts };
}

/** The vault side of the airgap: parse, sign with the real signer, encode. */
function vaultSigner(wallet: Wallet, randomSeed = 0x9000) {
  return async (unsignedBytes: Uint8Array): Promise<Uint8Array> => {
    const parsed = parseUnsignedSet(unsignedBytes);
    if (!parsed.ok) throw new Error(parsed.problem);
    const need = signingRandomCount(parsed.set.inputs.length, parsed.set.ringSize, parsed.set.outputs.length);
    const scalars = Array.from({ length: need }, (_, i) => det(randomSeed + i));
    const signed = signMoneroSpend(wallet, parsed.set, scalars);
    if (!signed.ok) throw new Error(signed.problem);
    return encodeSignedTx(signed.tx);
  };
}

describe('the cold-signing loop end to end', () => {
  it('plans, signs with the real vault, and broadcasts on stagenet', { timeout: 30_000 }, async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_000, 0xf00d);
    const node = fakeNode(input);
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
      sign: vaultSigner(sender),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    /* The bytes reached the node, and the id they carry is the one signed. */
    expect(node.broadcasts).toHaveLength(1);
    expect(result.tx.txid).toBe(result.txid);
  });

  it('holds a mainnet send at the gate before any work is done', async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_001, 0xf00e);
    const node = fakeNode(input);
    let signerCalled = false;
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
      sign: async () => { signerCalled = true; return new Uint8Array(); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('gate');
    /* Nothing was planned, signed, or sent. */
    expect(signerCalled).toBe(false);
    expect(node.broadcasts).toHaveLength(0);
  });

  it('reports a node rejection at the broadcast stage', { timeout: 30_000 }, async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_002, 0xf00f);
    const node = fakeNode(input, { rejectBroadcast: true });
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
      sign: vaultSigner(sender),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('broadcast');
      expect(result.problem).toMatch(/fee is below/);
    }
  });

  it('reports a planning refusal when the coins cannot cover the send', async () => {
    const input = fundSender(500n, 1_500_003, 0xf010);
    const node = fakeNode(input);
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
      sign: vaultSigner(sender),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('plan');
  });
});
