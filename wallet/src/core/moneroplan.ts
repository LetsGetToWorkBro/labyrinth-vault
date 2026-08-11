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

import type { Transport } from '../net/http';
import { info, outputDistribution, outs, type ChainOutput } from '../net/monerod';
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

  const dist = await outputDistribution(transport, 0, tip.value.height - SPENDABLE_AGE);
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
