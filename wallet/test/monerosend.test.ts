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
import { KeyImageBook } from '../src/core/keyimages';
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
import { fromHex, publicFromSecret, revealSecretHex, toHex, walletFromSeed, wipeWallet, type Wallet } from '@vault/keys/monero';
import { signHere } from '../src/core/hotsign';
import { KEYVAULT_SCHEMA, openMonero, type HotRecord, type Source } from '../src/core/keyvault';
import type { Draft } from '../src/core/model';
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

  it('locks a spent output so a second send cannot reuse it', { timeout: 30_000 }, async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_010, 0xf020);
    const node = fakeNode(input);
    const book = new KeyImageBook();
    const params = {
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet' as const,
      owned: [input],
      destinations: [{ address: receiver.address, amount: 500_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
      sign: vaultSigner(sender),
      guard: book,
    };

    const first = await executeMoneroSend(params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    /* The spend locked its input; the book now knows it is in flight. */
    expect(first.spentOutputKeys).toContain(input.key);
    expect(book.isAvailable(input.key)).toBe(false);

    /* A second send with the same single owned output has nothing to spend,
     * because the guard removed the in-flight coin before planning. */
    const second = await executeMoneroSend(params);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.stage).toBe('plan');
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

/*
 * The same loop, with the signer that lives on this phone.
 *
 * Everything above hands the unsigned set to `signMoneroSpend` directly, which
 * is the vault standing in for itself. This drives the identical loop through
 * `core/hotsign.ts` instead: a real `HotRecord`, the Face ID gate as a
 * parameter, and the record's own keys opened and wiped inside the signer.
 *
 * It exists because that join was the one thing in the hot-signing work with
 * no end-to-end cover. The Bitcoin half had it, `hotsign.test.ts` proves the
 * refusals for both, and the Monero signing loop was proved above with a
 * different signer. What nothing proved until now is that the two fit: that a
 * set this wallet plans is one the *hot* path can sign, and that the bytes it
 * returns reach a node.
 */

describe('the hot-signing loop end to end', () => {
  /** The sender's own keys, as they would sit in this phone's keychain. */
  function senderRecord(): HotRecord {
    return {
      v: KEYVAULT_SCHEMA,
      /* The reduced spend key, which is what `makeHotRecord` stores and what
       * the twenty-five words encode. Reduction is idempotent, so re-deriving
       * from it has to land on the same wallet, and the test below checks
       * exactly that before trusting any signature it makes. */
      xmrSeed: revealSecretHex(sender.spendSecret),
      btcMnemonic: null,
      network: 'stagenet',
      createdAt: 0,
    };
  }

  /** A draft carrying the unsigned set, which is all `signHere` reads. */
  function draftFor(unsigned: Uint8Array): Draft {
    return {
      asset: 'XMR',
      recipient: receiver.address,
      amount: 1_000_000_000_000n,
      fee: 0n,
      feeRate: 10,
      unsigned,
      digest: '0'.repeat(64),
      createdAt: 0,
      inputs: [],
      inputTotal: 2_000_000_000_000n,
      changeAddresses: [sender.address],
    };
  }

  function hotSigner(source: Source, seed = 0xa000) {
    return async (unsignedBytes: Uint8Array): Promise<Uint8Array> => {
      const signed = await signHere({
        source,
        record: senderRecord(),
        draft: draftFor(unsignedBytes),
        gate: async () => ({ ok: true }),
        scalars: (count) => Array.from({ length: count }, (_, i) => det(seed + i)),
      });
      if (!signed.ok) throw new Error(signed.problem);
      return signed.raw;
    };
  }

  it('re-derives the same wallet from the stored seed, or nothing below means anything', () => {
    /* The degenerate-fixture check for this file. If the record opened a
     * different wallet, every assertion after it would be about a signature
     * for somebody else's coins, and it would still pass. */
    const opened = openMonero(senderRecord());
    expect(opened).not.toBeNull();
    expect(opened!.address).toBe(sender.address);
    wipeWallet(opened!);
  });

  it('plans, signs with this phone, and broadcasts on stagenet', { timeout: 30_000 }, async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_010, 0xf10d);
    const node = fakeNode(input);
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x4321),
      sign: hotSigner('hot'),
    });
    expect(result.ok, result.ok ? '' : `${result.stage}: ${result.problem}`).toBe(true);
    if (!result.ok) return;
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(node.broadcasts).toHaveLength(1);
    expect(result.tx.txid).toBe(result.txid);
  });

  it('refuses inside the real loop when the account is a vault one', { timeout: 30_000 }, async () => {
    /* The airgap, checked where it actually has to hold rather than only in a
     * unit test of the signer. The plan is built, the set reaches the signer,
     * and the signature does not happen: nothing is broadcast. */
    const input = fundSender(2_000_000_000_000n, 1_500_011, 0xf10e);
    const node = fakeNode(input);
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x4321),
      sign: hotSigner('vault'),
    });
    expect(result.ok).toBe(false);
    expect(node.broadcasts, 'a vault account produced a broadcast').toHaveLength(0);
  });

  it('signs nothing when the Face ID prompt is refused', { timeout: 30_000 }, async () => {
    const input = fundSender(2_000_000_000_000n, 1_500_012, 0xf10f);
    const node = fakeNode(input);
    const result = await executeMoneroSend({
      transport: node.transport,
      ownAddress: sender.address,
      network: 'stagenet',
      owned: [input],
      destinations: [{ address: receiver.address, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x4321),
      sign: async (unsignedBytes) => {
        const signed = await signHere({
          source: 'hot',
          record: senderRecord(),
          draft: draftFor(unsignedBytes),
          gate: async () => ({ ok: false, problem: 'Face ID was not recognized.' }),
          scalars: (count) => Array.from({ length: count }, (_, i) => det(0xb000 + i)),
        });
        if (!signed.ok) throw new Error(signed.problem);
        return signed.raw;
      },
    });
    expect(result.ok).toBe(false);
    expect(node.broadcasts).toHaveLength(0);
  });
});
