/**
 * The whole cold-signing loop, as one function, so it can be run and tested.
 *
 * Every piece of a Monero send exists and is tested on its own: coin selection,
 * decoys, the unsigned set, the vault's signer, the broadcast gate. What did
 * not exist was the thing that runs them in order against a real node, which is
 * also the thing a stagenet dry run needs. This is that thing.
 *
 * The airgap is a single injected function. `sign` takes the unsigned set bytes
 * this side produces and returns the signed transaction bytes the vault
 * produces; in the real app those bytes cross as animated QR frames, in the
 * dry-run script they cross an in-process call, and in the test they cross to
 * the real vault signer running beside the test. The loop does not care which,
 * which is the point: it is the same loop in all three.
 *
 * The gate is enforced here as well as in the watcher, because this function is
 * a second door onto the network and a door with no lock is not a gate. A
 * mainnet send is refused before it is even planned; a stagenet or testnet send
 * runs to broadcast, which is how the evidence to lift the gate gets made.
 */

import { info } from '../net/monerod';
import * as monerod from '../net/monerod';
import { moneroBroadcastGate } from './moneroreadiness';
import { planMoneroSpend } from './moneroplan';
import {
  encodeUnsigned,
  parseSignedTx,
  type Destination,
  type Piconero,
  type SpendableOutput,
  type SignedTx,
} from './monerospend';
import type { Transport } from '../net/http';

/**
 * What keeps a broadcast spend from being spent again before the chain
 * confirms it. `KeyImageBook` satisfies this; the loop only needs these two.
 */
export interface SpendGuard {
  /** May this output be selected now? False for confirmed or in-flight spends. */
  isAvailable(oneTimeKey: string): boolean;
  /** Lock these outputs after a broadcast, until the next scan confirms them. */
  markPending(oneTimeKeys: readonly string[]): void;
}

export interface SendParams {
  transport: Transport;
  /** The account's own address, where change and any padding output go. */
  ownAddress: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  /** The spendable outputs, from the scan plus the vault's key images. */
  owned: readonly SpendableOutput[];
  destinations: readonly Destination[];
  /** Piconero per byte, from the node's fee estimate. */
  feePerByte: Piconero;
  /** A uniform source in [0,1); the platform CSPRNG in the app. */
  uniform: () => number;
  /**
   * The airgap. Given the unsigned set bytes, return the signed transaction
   * bytes (an `XMRSIGNED` payload). In the app this is the QR round trip to the
   * vault; in a dry run it is a direct call to the vault signer.
   */
  sign: (unsignedSet: Uint8Array) => Promise<Uint8Array>;
  /**
   * The double-spend guard. When present, its locked outputs are excluded from
   * selection before planning, and the spent outputs are locked into it after a
   * successful broadcast, so a second spend cannot pick the same coins before
   * the next scan.
   */
  guard?: SpendGuard;
  ringSize?: number;
  multiplier?: number;
}

export type SendStage = 'gate' | 'plan' | 'sign' | 'broadcast';

export type SendResult =
  | { ok: true; txid: string; tx: SignedTx; spentOutputKeys: string[] }
  | { ok: false; stage: SendStage; problem: string };

/**
 * Build, sign, and broadcast a Monero spend, or say where and why it stopped.
 *
 * The stages are named in the result so a caller (a script, a screen) can tell
 * a planning refusal from a node rejection without parsing the sentence. The
 * order is the honest one: refuse a gated network first, so no work is done for
 * a transaction that cannot be sent; then plan, then sign, then broadcast.
 */
export async function executeMoneroSend(params: SendParams): Promise<SendResult> {
  const { transport, sign, network } = params;

  const gate = moneroBroadcastGate(network);
  if (!gate.allowed) return { ok: false, stage: 'gate', problem: gate.problem };

  /* Outputs already spent, or in flight from a spend this wallet broadcast and
   * the chain has not yet confirmed, are off the table. Selecting one would
   * build a double spend that no node relays. */
  const owned = params.guard
    ? params.owned.filter((o) => params.guard!.isAvailable(o.key))
    : params.owned;

  const plan = await planMoneroSpend({
    transport,
    ownAddress: params.ownAddress,
    network,
    owned,
    destinations: params.destinations,
    feePerByte: params.feePerByte,
    uniform: params.uniform,
    ...(params.ringSize !== undefined ? { ringSize: params.ringSize } : {}),
    ...(params.multiplier !== undefined ? { multiplier: params.multiplier } : {}),
  });
  if (!plan.ok) return { ok: false, stage: 'plan', problem: plan.problem };

  /* The one-time keys of the outputs being spent, from the real ring position
   * of each input. These are what the guard locks after a successful send. */
  const spentOutputKeys = plan.set.inputs.map((input) => input.ring[input.realPosition]!.key);

  let signedBytes: Uint8Array;
  try {
    signedBytes = await sign(encodeUnsigned(plan.set));
  } catch (error) {
    return { ok: false, stage: 'sign', problem: `The signer failed: ${(error as Error).message}` };
  }

  const parsed = parseSignedTx(signedBytes);
  if (!parsed.ok) return { ok: false, stage: 'sign', problem: parsed.problem };
  const tx = parsed.tx;

  if (tx.network !== network) {
    return { ok: false, stage: 'sign', problem: `The vault signed a ${tx.network} transaction for a ${network} send.` };
  }

  /* The tip must be current enough that the transaction's ring references
   * outputs the node has. A node still syncing would reject a fresh ring. */
  const tip = await info(transport);
  if (!tip.ok) return { ok: false, stage: 'broadcast', problem: tip.problem };
  if (tip.value.syncing) return { ok: false, stage: 'broadcast', problem: 'That node is still catching up; try the broadcast once it is synced.' };

  const relayed = await monerod.broadcast(transport, tx.hex);
  if (!relayed.ok) return { ok: false, stage: 'broadcast', problem: relayed.problem };

  /* The spend is on the network. Lock its inputs so the next spend, before the
   * scan has caught up, cannot pick the same coins. */
  params.guard?.markPending(spentOutputKeys);

  return { ok: true, txid: tx.txid, tx, spentOutputKeys };
}
