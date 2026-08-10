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

  pairVault(label: string): void;
  unpairVault(): void;

  /** Fresh receiving address for the asset, advancing the gap. */
  freshAddress(asset: Asset): { address: string; path: string | null };

  /** Transient confirmation, shown once and forgotten. */
  flash: string | null;
  say(message: string): void;
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
    label: 'VAULT · iPhone 11',
  });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeIndex = useRef(24);

  /* Twenty seconds is slow enough to cost nothing and fast enough that "Just
   * now" becomes "1m ago" while somebody is still looking at the screen. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const snapshot = useMemo(() => watcher.snapshot(now), [now]);

  const say = useCallback((message: string) => {
    setFlash(message);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1800);
  }, []);

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
      zpub: DEMO_ZPUB,
      change: { address: '', index: changeIndex.current },
      now: Date.now(),
    });

    if (!result.ok) return result.problem;
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
        return;
      }
      const verdict = verifySigned(draft, raw);
      if (verdict.ok) arrived();
      else refused();
      dispatch({ type: 'returned', verified: verdict, at: Date.now() });
      setVault((current) =>
        current.state === 'unpaired' ? current : { ...current, state: 'ready', lastSession: Date.now() },
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
    pairVault: (label: string) =>
      setVault({ state: 'ready', pairedAt: Date.now(), lastSession: Date.now(), label }),
    unpairVault: () => setVault({ state: 'unpaired' }),
    freshAddress: (which: Asset) => watcher.nextAddress(which),
    flash,
    say,
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
