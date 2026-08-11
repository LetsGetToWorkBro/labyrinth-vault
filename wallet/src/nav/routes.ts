/**
 * The routes, and one deliberate absence.
 *
 * There is no route for a step of the send flow. `Send` is one screen, and
 * which of its eight faces it shows is read from the session state machine in
 * `core/session.ts`. That is not a shortcut — it is the point. If review,
 * transmit, waiting, receiving and broadcast were five routes, the navigator
 * would hold the truth about where a payment is, and the navigator can be
 * pushed, popped, replaced and restored by gestures nobody planned. Then
 * "can this be broadcast" has two answers.
 *
 * One state, one screen, one answer, and the back gesture dispatches an event
 * like anything else.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Asset } from '../core/model';

export type Routes = {
  Onboarding: undefined;
  Home: undefined;
  Activity: undefined;
  Transaction: { id: string };
  Asset: { asset: Asset };
  Receive: { asset?: Asset } | undefined;
  Send: undefined;
  /**
   * One camera screen, two jobs, named rather than inferred.
   *
   * `wire` is the airgap: frames from a vault, assembled by the vault's own
   * collector, refused unless the whole payload matches its digest.
   * `address` is the ordinary case — somebody's payment code on a screen or a
   * printout, which is a single QR carrying text and nothing to assemble.
   *
   * They are one screen because they are one camera and one set of framing
   * marks, and they are one *parameter* because the reader must never guess:
   * treating a stray QR as a transaction frame, or a transaction frame as a
   * destination, are both ways to end up paying the wrong thing.
   */
  Scan: { purpose: 'wire' | 'address' } | undefined;
  /**
   * Swapping one coin for another through an exchange.
   *
   * Its own route rather than a face of Send, unlike the send flow's eight
   * steps, because it is not a step of a payment: it is the thing that decides
   * what payment to make. Once an order exists it hands off to `Send`, and
   * from there a swap deposit is an ordinary payment with an ordinary
   * confirmation on the vault. See core/swap.ts.
   */
  Swap: undefined;
  /**
   * Which node the wallet reads the chain through.
   *
   * Its own route rather than a panel inside Security, because it is not a
   * security setting in the usual sense: it is the one screen where somebody
   * chooses who watches their addresses, and burying that under a gear is how
   * every other wallet ends up making the choice for its users.
   */
  Nodes: undefined;
  /**
   * The key image round trip: outputs to the vault, images back.
   *
   * Its own route because it is a physical procedure with a screen full of
   * codes, like the send flow's transmit step, and unlike that step it is not
   * part of any payment: it is bookkeeping about payments already received.
   */
  KeyImages: undefined;
  Vault: undefined;
  Pair: undefined;
  Security: undefined;
};

export type Nav<Route extends keyof Routes> = NativeStackScreenProps<Routes, Route>;
