/**
 * One place where the application's state lives, and one clock.
 *
 * Two decisions worth defending.
 *
 * **A single ticking `now`.** Every relative time in the interface — "3m ago",
 * "Today 1:42 PM", the age of a price — is computed from one value that
 * updates on a timer here. The alternative, each row calling the clock as it
 * renders, produces a list where the top row says "2m ago" and the bottom says
 * "1m ago" for two things that happened together, and a fixture whose ages
 * drift apart as you scroll. It also makes every one of those strings testable
 * from the outside, because `now` is an argument all the way down.
 *
 * **The send session is a reducer from `core/session.ts`, not state scattered
 * across screens.** The screens are a view of it. Which means the property the
 * tests hold — that nothing gets out of `mismatch` into a broadcastable state —
 * is a property of the application and not merely of a module nobody renders.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { prepare, verifySigned } from '../core/build';
import type { ChainSnapshot, FeeOption } from '../core/chain';
import { DemoWatcher, DEMO_ZPUB } from '../core/demo';
import type { Asset, Draft, VaultLink } from '../core/model';
import { parseAmount } from '../core/units';
import { reduce, START, type SessionEvent, type SessionState } from '../core/session';
import type { OwnAddresses, SwapOrder, SwapTransport } from '../core/swap';
import { demoSwapTransport } from '../core/demo';
import { transmit } from '../core/wire';
import { arrived, confirmed, refused } from '../design/haptics';

const watcher = new DemoWatcher();

export interface Store {
  /** One clock for the whole interface. */
  now: number;
  snapshot: ChainSnapshot;
  vault: VaultLink;
  session: SessionState;
  /** Which chain the current flow is about. */
  asset: Asset;

  setAsset(asset: Asset): void;
  send(event: SessionEvent): void;
  /** Build the transaction from what has been composed. Returns the problem,
   *  or null when it worked and the session moved on. */
  prepareDraft(): string | null;
  beginTransmit(): void;
  handOver(): void;
  readBack(): void;
  /** Offer bytes that came back from a camera — or, in this build, from the
   *  stand-in vault. Always goes through `verifySigned`. */
  offerSignature(raw: Uint8Array | null): void;
  broadcast(): void;

  /** The addresses a swap payout may be sent to, derived rather than typed.
   *  See core/swap.ts for why that distinction is the whole feature. */
  own: OwnAddresses;
  /** Whatever performs a swap provider's HTTP call. A fixture, in this build. */
  swapTransport: SwapTransport;
  /**
   * Turn a verified swap order into an ordinary payment.
   *
   * This is the join between the two halves of the feature. A swap deposit is
   * not special: it is a send to an address, and it goes through the same
   * compose, the same prepare, the same vault and the same confirmation screen
   * as any other. That is deliberate. The moment a swap gets its own quiet
   * path to a signature, the vault stops covering the part of a swap the vault
   * can actually cover.
   */
  depositForSwap(order: SwapOrder, from: Asset): void;

  pairVault(label: string): void;
  unpairVault(): void;
  /** Stop claiming a handoff is in progress. See `endSession`. */
  endSession(): void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside the provider');
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const [asset, setAsset] = useState<Asset>('BTC');
  const [session, dispatch] = useReducer(reduce, START);
  const [vault, setVault] = useState<VaultLink>({
    state: 'ready',
    pairedAt: Date.now() - 1000 * 60 * 60 * 26,
    lastSession: Date.now() - 1000 * 60 * 74,
    lastVerified: Date.now() - 1000 * 60 * 74,
    label: 'VAULT · iPhone 11',
  });
  const changeIndex = useRef(24);

  /* Twenty seconds is slow enough to cost nothing and fast enough that "Just
   * now" becomes "1m ago" while somebody is still looking at the screen. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const snapshot = useMemo(() => watcher.snapshot(now), [now]);

  const feeOption = useCallback(
    (key: string): FeeOption => {
      const options = snapshot.assets[asset].feeOptions;
      return options.find((option) => option.key === key) ?? options[1] ?? options[0]!;
    },
    [snapshot, asset],
  );

  const prepareDraft = useCallback((): string | null => {
    const parsed = parseAmount(session.compose.amountText, asset);
    if (!parsed.ok || parsed.atoms === undefined) return parsed.problem ?? 'Enter an amount.';

    const view = snapshot.assets[asset];
    const result = prepare({
      asset,
      recipient: session.compose.recipient.trim(),
      amount: parsed.atoms,
      rate: feeOption(session.compose.feeKey).rate,
      utxos: view.utxos,
      balance: view.spendable,
      zpub: DEMO_ZPUB,
      change: { index: changeIndex.current },
      now: Date.now(),
    });

    if (!result.ok) return result.problem;
    /* A new change address for the next payment. Reusing one is not a bug that
     * shows up on any screen, which is exactly why it has to be handled here:
     * every payment landing change on the same address publishes the link
     * between them to anybody reading the chain. */
    changeIndex.current += 1;
    dispatch({ type: 'prepared', draft: result.draft, at: Date.now() });
    return null;
  }, [session.compose, asset, snapshot, feeOption]);

  const beginTransmit = useCallback(() => {
    const draft: Draft | null = session.draft;
    if (!draft) return;
    dispatch({ type: 'transmit', transmission: transmit(draft, 'vault'), at: Date.now() });
    setVault((current) =>
      current.state === 'unpaired' ? current : { ...current, state: 'in-session' },
    );
  }, [session.draft]);

  const handOver = useCallback(() => dispatch({ type: 'handed-over', at: Date.now() }), []);
  const readBack = useCallback(() => dispatch({ type: 'read-back', at: Date.now() }), []);

  /**
   * Leaving a handoff without finishing it.
   *
   * `in-session` means codes are on a screen right now. Somebody who backs out
   * of the transmit screen, or discards the payment, is no longer in one, and
   * a wallet that goes on claiming a session is in progress until the next
   * signature arrives is telling the home screen a small lie for an
   * indefinite period.
   */
  const endSession = useCallback(() => {
    setVault((current) => (current.state === 'in-session' ? { ...current, state: 'ready' } : current));
  }, []);

  const offerSignature = useCallback(
    (raw: Uint8Array | null) => {
      const draft = session.draft;
      if (!draft) return;
      if (!raw) {
        refused();
        dispatch({
          type: 'failed',
          problem: 'The vault did not return a signature. Nothing was broadcast.',
          at: Date.now(),
        });
        /* A handoff that produced nothing is still a handoff that has ended.
         * Leaving the link in `in-session` here was the same bug as leaving it
         * there on a back button, one branch further down. */
        setVault((current) =>
          current.state === 'in-session' ? { ...current, state: 'ready', lastSession: Date.now() } : current,
        );
        return;
      }
      const verdict = verifySigned(draft, raw);
      if (verdict.ok) arrived();
      else refused();
      dispatch({ type: 'returned', verified: verdict, at: Date.now() });
      /* A session happened either way. It was only *verified* if what came
       * back was what went out, and the security screen shows those as two
       * different lines because they are two different facts. */
      setVault((current) =>
        current.state === 'unpaired'
          ? current
          : {
              ...current,
              state: 'ready',
              lastSession: Date.now(),
              lastVerified: verdict.ok ? Date.now() : current.lastVerified,
            },
      );
    },
    [session.draft],
  );

  const broadcast = useCallback(() => {
    const verified = session.verified;
    if (!verified || !verified.ok) return;
    dispatch({ type: 'broadcast', at: Date.now() });
    void watcher.broadcast(asset, verified.raw).then((result) => {
      if (result.ok && result.txid) {
        confirmed();
        dispatch({ type: 'published', txid: result.txid, at: Date.now() });
      } else {
        refused();
        dispatch({
          type: 'failed',
          problem: result.problem ?? 'No node accepted this transaction.',
          at: Date.now(),
        });
      }
    });
  }, [session.verified, asset]);

  /**
   * Where a swap pays out to.
   *
   * The first address the chain has not seen a payment to, which is the same
   * one the receive screen shows, derived from the account key the vault
   * handed over. Not typed and not remembered: a swap payout address is in no
   * transaction, so it appears on no vault screen, and deriving it is the only
   * check there is.
   */
  const own: OwnAddresses = useMemo(
    () => ({
      receive(target: Asset) {
        const addresses = snapshot.assets[target]?.addresses ?? [];
        const unused = addresses.find((entry) => !entry.used) ?? addresses[0];
        return unused?.address ?? null;
      },
    }),
    [snapshot],
  );

  const depositForSwap = useCallback(
    (order: SwapOrder, from: Asset) => {
      setAsset(from);
      dispatch({ type: 'reset' });
      dispatch({ type: 'recipient', value: order.depositAddress, source: 'scanned' });
      dispatch({ type: 'amount', value: String(order.depositAmount) });
    },
    [dispatch],
  );

  const store: Store = {
    now,
    snapshot,
    vault,
    session,
    asset,
    setAsset,
    send: dispatch,
    prepareDraft,
    beginTransmit,
    handOver,
    readBack,
    offerSignature,
    broadcast,
    own,
    swapTransport: demoSwapTransport,
    depositForSwap,
    pairVault: (label: string) =>
      setVault({
        state: 'ready',
        pairedAt: Date.now(),
        lastSession: Date.now(),
        lastVerified: null,
        label,
      }),
    unpairVault: () => setVault({ state: 'unpaired' }),
    endSession,
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
