/**
 * The online half of a Monero send, orchestrated end to end.
 *
 * `monerospend.ts` and `decoys.ts` are pure. This is where they meet the node:
 * fetch the tip and the output distribution, build a ring for each input from
 * the gamma picker plus `get_outs`, select coins, and assemble the unsigned set
 * that crosses to the vault. Kept apart from the pure modules for the reason
 * every boundary in this package is: the arithmetic is tested without a
 * network, and this thin layer is tested against a recorded node.
 *
 * Nothing here signs, and nothing here holds a secret. It produces the
 * `XMRUNSIGNED` payload a view key is enough to build, which is the whole
 * premise of cold signing.
 */

import type { Parsed, Transport } from '../net/http';
import { info, outputDistribution, outs, type ChainOutput, type OutputDistribution } from '../net/monerod';
import { makePicker, selectRing, RING_SIZE, SPENDABLE_AGE } from './decoys';
import {
  assembleUnsigned,
  selectInputs,
  type Destination,
  type Piconero,
  type Ring,
  type SpendableOutput,
  type UnsignedTxSet,
} from './monerospend';

export interface PlanParams {
  transport: Transport;
  /** The account's own address, where change goes. */
  ownAddress: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  /** The spendable outputs, from the scan plus the vault's key images. */
  owned: readonly SpendableOutput[];
  destinations: readonly Destination[];
  /** Piconero per byte, from the node's fee estimate. */
  feePerByte: Piconero;
  /** A uniform source in [0,1); the platform CSPRNG in the app. */
  uniform: () => number;
  ringSize?: number;
  multiplier?: number;
}

export type Plan = { ok: true; set: UnsignedTxSet } | { ok: false; problem: string };

// ---------------------------------------------------------------------------
// The output distribution, fetched once per block rather than once per attempt
//
// `get_output_distribution` from height zero is the largest single thing this
// app ever asks a node for: at mainnet scale it is over two million entries and
// roughly twenty megabytes of JSON, buffered whole under `http.ts`'s timeout.
// It was being fetched on every press of REVIEW, so composing a payment,
// backing out, and composing it again cost that twice on a phone connection.
//
// The cache is keyed on the node and on the exact height the distribution was
// asked for, so it survives repeated attempts and expires the moment a block is
// mined. That is deliberately tighter than a clock: a distribution that lags the
// chain is one whose decoys can never be drawn from the newest outputs, and a
// ring whose members all stop short of the real output's age is a ring that says
// which member is real. Staleness here costs privacy quietly, which is the one
// failure `decoys.ts` says this product is least willing to ship in silence.
//
// What it does not fix: the first fetch of a session still moves that twenty
// megabytes. Narrowing `from_height` would truncate the array `blockOf`
// searches, and the binary path is the epee format this repository has an
// argued policy against decoding blind, so both of the cheap-looking answers
// are worse than the problem. The honest state is one download per node per
// block, and this is what holds it there.

interface CachedDistribution {
  node: string;
  toHeight: number;
  value: OutputDistribution;
}

let cachedDistribution: CachedDistribution | null = null;

/**
 * Drop the cached distribution.
 *
 * It is a large array (nineteen megabytes of numbers at mainnet scale) held for
 * as long as the tip stands still, so a caller leaving the send flow or
 * changing nodes has a way to hand the memory back rather than waiting for the
 * next block to do it.
 */
export function forgetOutputDistribution(): void {
  cachedDistribution = null;
}

async function distributionFor(
  transport: Transport,
  toHeight: number,
): Promise<Parsed<OutputDistribution>> {
  const cached = cachedDistribution;
  if (cached && cached.node === transport.base && cached.toHeight === toHeight) {
    return { ok: true, value: cached.value };
  }
  const fetched = await outputDistribution(transport, 0, toHeight);
  /* Only a good answer is kept. Caching a failure would turn one bad minute on
   * a node into a send path that refuses until the next block. */
  if (fetched.ok) cachedDistribution = { node: transport.base, toHeight, value: fetched.value };
  return fetched;
}

/**
 * Build the unsigned set for a spend, or say why it cannot be built.
 *
 * The order matters. Coins are selected first, so the ring work is done only
 * for inputs that are actually spent. Then, for each chosen input, a ring is
 * drawn from the distribution and its members fetched, and the real output is
 * confirmed to sit where the ring says. Only then is the set assembled, where
 * the balance and the change address are checked a final time.
 */
export async function planMoneroSpend(params: PlanParams): Promise<Plan> {
  const { transport, owned, destinations, feePerByte, uniform, ownAddress, network } = params;
  const ringSize = params.ringSize ?? RING_SIZE;
  const multiplier = params.multiplier ?? 1;

  const sending = destinations.reduce((sum, d) => sum + d.amount, 0n);
  const plan = selectInputs(owned, sending, feePerByte, multiplier, ringSize, destinations.length);
  if (!plan.ok) return { ok: false, problem: plan.problem ?? 'Coin selection failed.' };

  const tip = await info(transport);
  if (!tip.ok) return { ok: false, problem: tip.problem };
  if (tip.value.syncing) return { ok: false, problem: 'That node is still catching up, so its output distribution is incomplete.' };

  /* The chain's *length*, not the index of its top block, and deliberately so:
   * Monero states spendability as `height + SPENDABLE_AGE <= blockchain
   * height`, so the newest spendable block is `length - SPENDABLE_AGE` and both
   * the distribution's end and the maturity check below are in those units.
   * `topBlock` belongs on the chain walk, which reads blocks by index, and
   * applying it here would move the ring's window by one block against
   * consensus. */
  const dist = await distributionFor(transport, tip.value.height - SPENDABLE_AGE);
  if (!dist.ok) return { ok: false, problem: dist.problem };
  const picker = makePicker(dist.value, tip.value.height);
  if (!picker) return { ok: false, problem: 'The chain does not have enough spendable history to build a ring.' };

  const rings: Ring[] = [];
  for (const input of plan.inputs) {
    const selection = selectRing(picker, input.globalIndex, uniform, ringSize);
    if (!selection.ok) return { ok: false, problem: selection.problem ?? 'Could not build a ring.' };

    const fetched = await outs(transport, selection.indices);
    if (!fetched.ok) return { ok: false, problem: fetched.problem };
    if (fetched.value.length !== selection.indices.length) {
      return { ok: false, problem: 'The node did not return every ring member.' };
    }

    /* The real member the node returned must match the output we are spending,
     * key and commitment both. A node that returned a different key at our
     * index would have us sign over an output we hold no key to. */
    const real = fetched.value[selection.realPosition];
    if (!real || real.key !== input.key || real.commitment !== input.commitment) {
      return { ok: false, problem: 'The node returned a different output than the one being spent. Not signing that.' };
    }
    /* The output being spent must itself be old enough. The node's `unlocked`
     * flag already answers this, but the age is also checked here against the
     * tip directly, so a node that lies about `unlocked` cannot walk a freshly
     * received coin into a transaction every relay on the network will reject.
     * A spend of an unconfirmed or barely confirmed output is the common,
     * innocent version of this, and it deserves a sentence that names it. */
    if (tip.value.height - real.height < SPENDABLE_AGE) {
      return {
        ok: false,
        problem: `That output is only ${tip.value.height - real.height} block(s) deep and needs ${SPENDABLE_AGE}. Wait a few blocks and try again.`,
      };
    }
    /* Every member must be spendable, or the ring is one the network rejects. */
    if (fetched.value.some((m: ChainOutput) => !m.unlocked)) {
      return { ok: false, problem: 'A ring member is not yet spendable. Try again in a few blocks.' };
    }

    rings.push({ members: fetched.value, realPosition: selection.realPosition });
  }

  return assembleUnsigned({
    inputs: plan.inputs,
    rings,
    destinations,
    change: plan.change,
    ownAddress,
    fee: plan.fee,
    network,
    ringSize,
  });
}
