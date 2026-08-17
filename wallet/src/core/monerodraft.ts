/**
 * The Monero draft: a real unsigned set in the send flow, and the checks on
 * what comes back.
 *
 * This replaces the provisional payload that used to stand in here. The plan
 * comes from `moneroplan`: decoys from the node's distribution, coins from
 * the scan plus the vault's key images, change to this account's own address
 * with no parameter to point it anywhere else: and what goes on the wire is
 * `encodeUnsigned` of that set, which is exactly what the vault's
 * `moneroDescribe` reads and its confirmation screen renders.
 *
 * ## What the wallet can and cannot verify about the return
 *
 * Bitcoin's `verifySigned` reads the finished transaction and compares every
 * output against the approved draft. A signed Monero transaction does not
 * permit that: its outputs are one-time keys, unlinkable to addresses by
 * design, and the only device that could confirm the destination is the vault
 * that just rendered it to a person. That is not a gap in this file; it is
 * the product's whole argument, stated by Monero's own cryptography.
 *
 * What the wallet *can* check, it checks, and each is a fact an attacker
 * would need to break:
 *
 *   - the key images. One per spent input, and the wallet knows: from the
 *     vault's own earlier key-image round trip: the image of every coin the
 *     draft planned to spend. A signed transaction spending different coins,
 *     or more coins, than were approved fails here as a set comparison.
 *   - the fee, to the piconero, against the fee the plan stated and the
 *     vault's screen showed.
 *   - the network, so a stagenet rehearsal cannot be replayed as a mainnet
 *     payment.
 *
 * A transaction that passes all three spends the approved coins, at the
 * approved cost, on the approved network: and the destination was verified
 * where destinations are verifiable, on the vault's screen, by a person.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
// (Same pinned @noble/hashes the vault uses; the digest must match the one
// moneroDescribe computes over the same bytes, and it does because both are
// keccak-256 of the payload.)
import type { Atoms, Draft } from './model';
import type { OutputFact, Verified } from './build';
import { planMoneroSpend, type PlanParams } from './moneroplan';
import { encodeUnsigned, parseSignedTx, parseUnsigned, type SpendableOutput } from './monerospend';
import type { Transport } from '../net/http';

/** What planning a spend needs from the platform, gathered by the watcher. */
export interface MoneroSpendMaterials {
  transport: Transport;
  ownAddress: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  owned: readonly SpendableOutput[];
  /** Piconero per byte, from the node's own estimate at the last refresh. */
  feePerByte: bigint;
  /** A uniform source in [0,1); the platform CSPRNG in the app. */
  uniform: () => number;
}

export type MoneroPrepared = { ok: true; draft: Draft } | { ok: false; problem: string };

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Plan a spend against the node and wrap the unsigned set as a draft.
 *
 * The digest is keccak of the payload bytes: the same digest the vault
 * computes in `moneroDescribe` and binds its approval to, so the name both
 * halves use for this transaction is the same name. (Bitcoin drafts use
 * sha256 of the PSBT for the same purpose; each chain uses its own hash.)
 */
export async function prepareMoneroDraft(
  materials: MoneroSpendMaterials,
  intent: { recipient: string; amount: Atoms; multiplier: number; now: number },
): Promise<MoneroPrepared> {
  const params: PlanParams = {
    transport: materials.transport,
    ownAddress: materials.ownAddress,
    network: materials.network,
    owned: materials.owned,
    destinations: [{ address: intent.recipient, amount: intent.amount }],
    feePerByte: materials.feePerByte,
    uniform: materials.uniform,
    multiplier: intent.multiplier,
  };
  const plan = await planMoneroSpend(params);
  if (!plan.ok) return { ok: false, problem: plan.problem };

  const unsigned = encodeUnsigned(plan.set);
  const spentKeys = plan.set.inputs.map((input) => input.ring[input.realPosition]!.key);

  return {
    ok: true,
    draft: {
      asset: 'XMR',
      recipient: intent.recipient,
      amount: intent.amount,
      fee: BigInt(plan.set.fee),
      feeRate: intent.multiplier,
      unsigned,
      digest: toHex(keccak_256(unsigned)),
      createdAt: intent.now,
      /* Monero coins have no txid:vout the wallet can quote; the spent-coin
       * record is the one-time keys below, compared through the key image
       * book when the signature returns. */
      inputs: [],
      inputTotal: plan.set.inputs.reduce((sum, input) => sum + BigInt(input.amount), 0n),
      changeAddresses: [materials.ownAddress],
      spentKeys,
    },
  };
}

/**
 * Does the signed set that came back finish the draft that went out?
 *
 * `expectedImages` are the key images of the draft's planned coins, from the
 * book the vault itself populated. Order-insensitive, like the Bitcoin input
 * comparison, and for the same reason: a signer is entitled to order its
 * inputs, and not entitled to spend a coin nobody approved.
 */
export function verifySignedMonero(
  draft: Draft,
  raw: Uint8Array,
  expectedImages: readonly string[],
): Verified {
  const reasons: string[] = [];

  const parsed = parseSignedTx(raw);
  if (!parsed.ok) {
    return { ok: false, outputs: [], reasons: [parsed.problem] };
  }
  const tx = parsed.tx;

  if (BigInt(tx.fee) !== draft.fee) {
    reasons.push(
      `This pays a fee of ${tx.fee} piconero and the approved draft said ${draft.fee}.`,
    );
  }

  /* The third of the three checks this file's header promises, and the one
   * that was being taken on the returned payload's word. `network` was read
   * off the signed set and copied into the verdict, and `store.tsx` hands that
   * field straight to the mainnet broadcast gate, so editing one word in what
   * came back opened a gate `moneroreadiness.ts` deliberately implements as a
   * source constant so it could not be flipped. The approved bytes are the
   * authority, and they are read with the strict parser rather than trusted,
   * even though this app wrote them: the parse is the only place the wire
   * format is checked, and a path that skipped it is where a format bug would
   * live. */
  const approved = parseUnsigned(draft.unsigned);
  if (!approved.ok) {
    reasons.push(
      'The payment you approved could not be read back to check which network it was for, ' +
      'so this signature cannot be matched to it. Build the payment again.',
    );
  } else if (approved.set.network !== tx.network) {
    reasons.push(
      `You approved a ${approved.set.network} payment and this came back signed for ${tx.network}.`,
    );
  }

  const planned = draft.spentKeys ?? [];
  if (expectedImages.length !== planned.length) {
    reasons.push(
      'The key image book does not cover every planned coin, so what this spends cannot be confirmed. ' +
      'Import key images from the vault and rebuild the payment.',
    );
  } else {
    const expected = new Set(expectedImages.map((image) => image.toLowerCase()));
    const got = new Set(tx.keyImages.map((image) => image.toLowerCase()));
    const unapproved = [...got].filter((image) => !expected.has(image));
    const missing = [...expected].filter((image) => !got.has(image));
    if (unapproved.length > 0) {
      reasons.push(
        `This spends ${unapproved.length} coin${unapproved.length === 1 ? '' : 's'} that were not in the payment you approved.`,
      );
    }
    if (missing.length > 0) {
      reasons.push(
        `This leaves ${missing.length} approved coin${missing.length === 1 ? '' : 's'} unspent, so it is not the approved transaction.`,
      );
    }
  }

  /* What no wallet can list for Monero: the destination outputs, which are
   * one-time keys by design. The empty list is honest: the destination was
   * verified on the vault's screen, which is the only place it can be. */
  const outputs: OutputFact[] = [];

  if (reasons.length > 0) return { ok: false, outputs, reasons };

  const rawBytes = new Uint8Array(tx.hex.length / 2);
  for (let i = 0; i < rawBytes.length; i++) {
    rawBytes[i] = parseInt(tx.hex.slice(i * 2, i * 2 + 2), 16);
  }

  return { ok: true, txid: tx.txid, raw: rawBytes, outputs, fee: BigInt(tx.fee), network: tx.network };
}
