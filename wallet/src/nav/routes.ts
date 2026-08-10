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
  Scan: undefined;
  Vault: undefined;
  Pair: undefined;
  Security: undefined;
};

export type Nav<Route extends keyof Routes> = NativeStackScreenProps<Routes, Route>;
