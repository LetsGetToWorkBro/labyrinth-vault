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
import type { NodeConfig, NodeKind } from '../core/nodes';
import { openAccount, type ScanState } from '../core/moneroscan';
import { acceptAccount, type Pairing } from '../core/pairing';
import { NodeWatcher, type MoneroStatus, type RefreshResult, type WatcherNodes } from '../core/watcher';
import { demoSwapTransport, DEMO_XMR_ADDRESS, DEMO_XMR_VIEW_SECRET } from '../core/demo';
import { DEMO, standInAccountExport, standInKeyImages } from '../demo/standin';
import { restoreHeight, revealSecretHex } from '@vault/keys/monero';
import { digestOf } from '@vault/airgap/envelope';
import { EMPTY, load, save, type Persisted } from './persist';
import { fileStore } from './fileStore';
import { keychainStore } from './keychainStore';
import { clearPairing, loadPairing, savePairing } from './persistKeys';
import { transmit, Transmission } from '../core/wire';
import { arrived, confirmed, refused } from '../design/haptics';

const demoWatcher = new DemoWatcher();

/**
 * There is no node until somebody sets one.
 *
 * The constant every other wallet ships with an address in it. This one is
 * empty and stays empty: picking a node for everybody is picking who gets to
 * watch everybody's addresses, and it is a decision this app makes on screen
 * rather than in a source file. With nothing set the app shows the fixture and
 * says `DEMO DATA` at the top of the home screen.
 */
const NO_NODES: WatcherNodes = { btc: null, xmr: null };

/**
 * What is remembered between launches, and where.
 *
 * Two stores, split by sensitivity. Node addresses and the scan height go in
 * a plain JSON file (`state/persist.ts`): they are configuration, readable by
 * the person auditing what this app keeps. The paired watch-only keys go in
 * the device keychain (`state/persistKeys.ts`): they cannot spend, and they
 * are still the watching half of somebody's finances.
 *
 * Not remembered anywhere: the Monero outputs a scan found and the key images
 * the vault computed. Both are lists about the person rather than the chain,
 * both are cheap to recover (resume the scan; rescan one QR), and neither
 * belongs on the networked device's disk.
 */

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

  /** Which nodes are set. Null on both means the fixture is showing. */
  nodes: WatcherNodes;
  /** True while a refresh is in flight, for the one spinner in the app. */
  refreshing: boolean;
  /** What went wrong on the last refresh, per asset, in sentences. */
  nodeProblems: { asset: Asset; problem: string }[];
  refresh(): Promise<void>;
  setNode(kind: NodeKind, config: NodeConfig | null): void;
  /** How far the Monero chain scan has got, or null before it has run. */
  moneroStatus: MoneroStatus | null;
  /** True once what was stored has been read, so a screen can say so. */
  restored: boolean;
  /**
   * Throw away everything on disk and start the Monero scan again.
   *
   * Wanted for two different reasons that happen to want the same button: a
   * scan that somehow got ahead of itself, and somebody handing the phone on.
   * Nothing secret is stored, so this is a convenience rather than a wipe, and
   * it does not claim to be one.
   */
  forgetStored(): void;

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

  /** What the vault handed over, or null before any pairing. */
  pairing: Pairing | null;
  /** The Bitcoin account key in use, for the one screen that shows it. */
  accountKey: string | null;
  /**
   * Accept a payload that arrived over the camera, dispatched by its kind.
   *
   * The scan screen assembles and verifies; this decides. ACCOUNT pairs,
   * XMRKEYIMAGES lands in the watcher's book, TXSIGNED goes through the same
   * `verifySigned` gate as everything else. The note is a sentence for the
   * screen, in either direction.
   */
  acceptWirePayload(kind: string, payload: Uint8Array): { ok: boolean; note: string };
  /**
   * The XMROUTPUTS frames to show a vault, or why there are none.
   *
   * Null until a scan has found outputs, because a request listing nothing is
   * a trip across the room for nothing.
   */
  keyImageFrames(): Transmission | null;
  /** The demo round trip: outputs to the stand-in, images back. DEMO only. */
  syncStandInKeyImages(): { ok: boolean; note: string };

  /** Pair with the stand-in vault. DEMO only; the real path is the camera. */
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
  /* In a dev build the vault link starts as the fixture, because the screens
   * after pairing are the ones being designed. A release build starts
   * unpaired and stays that way until a real ACCOUNT payload is scanned or a
   * stored pairing loads. */
  const [vault, setVault] = useState<VaultLink>(() =>
    DEMO
      ? {
          state: 'ready',
          pairedAt: Date.now() - 1000 * 60 * 60 * 26,
          lastSession: Date.now() - 1000 * 60 * 74,
          lastVerified: Date.now() - 1000 * 60 * 74,
          label: 'VAULT · iPhone 11',
        }
      : { state: 'unpaired' },
  );
  const [pairing, setPairing] = useState<Pairing | null>(null);
  /* Mirrors `pairing` for reads inside the same tick. Scanning the Bitcoin
   * export right after the Monero one lands two accepts before React commits
   * the first, and merging against the committed state would drop a chain. */
  const pairingRef = useRef<Pairing | null>(null);
  const changeIndex = useRef(24);

  /* Twenty seconds is slow enough to cost nothing and fast enough that "Just
   * now" becomes "1m ago" while somebody is still looking at the screen. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const [nodes, setNodes] = useState<WatcherNodes>(NO_NODES);
  const [refreshing, setRefreshing] = useState(false);
  const [nodeProblems, setNodeProblems] = useState<RefreshResult['problems']>([]);
  const [moneroScan, setMoneroScan] = useState<Persisted['moneroScan']>(null);
  const [moneroStatus, setMoneroStatus] = useState<MoneroStatus | null>(null);
  /* Bumped after every refresh so the snapshot below is recomputed. The
   * watcher holds the data and hands back the same object until something
   * fetches; a counter is what tells React that something did. */
  const [fetched, setFetched] = useState(0);

  const storage = useMemo(() => fileStore(), []);
  /**
   * False until the file has been read, and the reason it exists.
   *
   * The saving effect below runs whenever the nodes change, and on the first
   * render they are `NO_NODES` because nothing has been loaded yet. Without
   * this flag that first render writes an empty file over a real one, and the
   * app forgets its node every launch while appearing to have storage. The
   * bug is quiet, it only happens on a cold start, and it is the whole reason
   * this is a separate piece of state rather than a check for empty nodes.
   */
  const [restored, setRestored] = useState(false);
  /* Where a stored scan gets handed to a freshly built watcher. A ref rather
   * than state because the watcher must not be rebuilt every time the scan
   * advances: that would throw away the outputs it has found and restart the
   * scan, forever, on every refresh. */
  const scanStart = useRef<ScanState | null>(null);

  const keysStorage = useMemo(() => keychainStore(), []);

  useEffect(() => {
    let current = true;
    void Promise.all([load(storage), loadPairing(keysStorage)]).then(([stored, paired]) => {
      if (!current) return;
      scanStart.current = stored.moneroScan;
      setMoneroScan(stored.moneroScan);
      setNodes(stored.nodes);
      if (paired) {
        pairingRef.current = paired;
        setPairing(paired);
        setVault({
          state: 'ready',
          pairedAt: paired.pairedAt,
          lastSession: null,
          lastVerified: null,
          label: paired.label,
        });
      }
      setRestored(true);
    });
    return () => { current = false; };
  }, [storage, keysStorage]);

  useEffect(() => {
    if (!restored) return;
    void save(storage, { ...EMPTY, nodes, moneroScan });
  }, [restored, storage, nodes, moneroScan]);

  /**
   * The Bitcoin account key in effect: the paired one, else the published
   * demo key in a dev build, else nothing. Nothing means the send flow
   * refuses to prepare and the vault screen says to pair, which are the
   * right two consequences of that state.
   */
  const accountKey = pairing?.btc?.zpub ?? (DEMO ? DEMO_ZPUB : null);

  /**
   * The account the Monero scan is for: the paired one, else the demo one.
   *
   * The demo fallback is a real account with a real view key, so what the
   * scanner does against a real node is the real thing rather than a
   * rehearsal. It is also empty, so a correct scan of it finds nothing,
   * which is why `openAccount` checks the view key belongs to the address:
   * without that, finding nothing would be indistinguishable from being
   * pointed at the wrong keys.
   */
  const moneroWatch = useMemo(() => {
    const source = pairing?.xmr
      ? { address: pairing.xmr.address, view: pairing.xmr.view, birth: pairing.xmr.birth }
      : DEMO
        ? { address: DEMO_XMR_ADDRESS, view: revealSecretHex(DEMO_XMR_VIEW_SECRET), birth: null }
        : null;
    if (!source) return null;
    const opened = openAccount(source.address, source.view);
    if (!opened.ok) return null;
    /* A wallet with no stored progress starts at its birth height, and a
     * demo wallet with no stated birth starts a week back rather than at the
     * tip. Starting late means silently never seeing payments that arrived
     * first, which reads as money that did not turn up. */
    const birth = source.birth ?? restoreHeight();
    const stored = scanStart.current;
    /* A stored scan from a different (earlier) pairing must not skip this
     * account's early blocks: resume only from at or after this birth. */
    const scanFrom = stored && stored.birth >= birth ? stored : { birth, height: birth };
    return { account: opened.account, scan: scanFrom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, pairing]);

  /**
   * The watcher, which is the fixture until a node is set and the node after.
   *
   * Rebuilt when the nodes change, which also throws away the previous
   * snapshot. That is correct: a balance from a different node is not a
   * balance from this one, and showing it while the new one loads would be
   * showing somebody a number from a source they just stopped trusting.
   */
  const watcher = useMemo(() => {
    if (!nodes.btc && !nodes.xmr) return demoWatcher;
    return new NodeWatcher(nodes, accountKey, undefined, Date.now(), moneroWatch);
  }, [nodes, accountKey, moneroWatch]);

  const snapshot = useMemo(
    () => watcher.snapshot(now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watcher, now, fetched],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!(watcher instanceof NodeWatcher)) return;
    setRefreshing(true);
    try {
      const result = await watcher.refresh(Date.now());
      setNodeProblems(result.problems);
      /* Written down after every pass, including one that failed part way.
       * `scan` leaves the height on the block it did not finish, so storing it
       * resumes rather than skips, and not storing it would redo the blocks
       * that did succeed. */
      const progress = watcher.moneroProgress();
      setMoneroStatus(progress);
      if (progress) setMoneroScan(progress.scan);
    } finally {
      setRefreshing(false);
      setFetched((count) => count + 1);
    }
  }, [watcher]);

  /* One refresh when a node is set, and none on a timer. Polling a node every
   * thirty seconds is a wallet telling somebody's node operator exactly when
   * that phone is awake, forever, for a number that changes a few times a
   * month. Pull to refresh is the whole strategy. */
  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      zpub: accountKey ?? '',
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
  }, [session.compose, asset, snapshot, feeOption, accountKey]);

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

  /**
   * A pairing, wherever the payload came from.
   *
   * Merging rather than replacing: the vault exports one chain at a time, and
   * scanning the Bitcoin key after the Monero one is completing a pairing,
   * not starting over.
   */
  const acceptPairing = useCallback(
    (payload: Uint8Array, label: string): { ok: boolean; note: string } => {
      const accepted = acceptAccount(payload);
      if (!accepted.ok) return { ok: false, note: accepted.problem };

      const current = pairingRef.current;
      const merged: Pairing = {
        btc: accepted.chain === 'btc' ? accepted.btc : current?.btc ?? null,
        xmr: accepted.chain === 'xmr' ? accepted.xmr : current?.xmr ?? null,
        label: current?.label ?? label,
        pairedAt: current?.pairedAt ?? Date.now(),
      };
      pairingRef.current = merged;
      setPairing(merged);
      void savePairing(keysStorage, merged);
      setVault((current) =>
        current.state === 'unpaired'
          ? { state: 'ready', pairedAt: merged.pairedAt, lastSession: null, lastVerified: null, label: merged.label }
          : current,
      );
      return {
        ok: true,
        note:
          accepted.chain === 'btc'
            ? 'Bitcoin account key accepted. The first address matches what this wallet derives.'
            : 'Monero view key accepted. It belongs to the address beside it.',
      };
    },
    [keysStorage],
  );

  const acceptWirePayload = useCallback(
    (kind: string, payload: Uint8Array): { ok: boolean; note: string } => {
      if (kind === 'ACCOUNT') return acceptPairing(payload, 'Labyrinth Vault');

      if (kind === 'XMRKEYIMAGES') {
        if (!(watcher instanceof NodeWatcher)) {
          return { ok: false, note: 'Key images need a Monero node set first, so there is a scan to apply them to.' };
        }
        const outcome = watcher.importKeyImages(payload);
        if (!outcome.ok) return { ok: false, note: outcome.problem ?? 'That reply could not be read.' };
        void refresh();
        const parts = [`${outcome.added} key image${outcome.added === 1 ? '' : 's'} imported.`];
        if (outcome.unknown > 0) parts.push(`${outcome.unknown} named outputs this wallet has not seen and were dropped.`);
        if (outcome.refusedByVault > 0) parts.push(`The vault refused ${outcome.refusedByVault}.`);
        return { ok: true, note: parts.join(' ') };
      }

      if (kind === 'TXSIGNED') {
        offerSignature(payload);
        return { ok: true, note: 'Signature received. It goes through the same verification as everything else.' };
      }

      if (kind === 'PSBT' || kind === 'XMRUNSIGNED' || kind === 'XMROUTPUTS') {
        return {
          ok: false,
          note: 'That is a payload this wallet sends, not one it reads. Point the vault at this phone, not the other way around.',
        };
      }
      return { ok: false, note: 'This wallet does not know what to do with that payload.' };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acceptPairing, watcher, refresh],
  );

  const keyImageFrames = useCallback((): Transmission | null => {
    if (!(watcher instanceof NodeWatcher)) return null;
    const request = watcher.keyImageRequest();
    if (!request.ok) return null;
    return new Transmission(request.payload, 'XMROUTPUTS', 'labyrinth', digestOf(request.payload));
  }, [watcher]);

  const syncStandInKeyImages = useCallback((): { ok: boolean; note: string } => {
    if (!DEMO) return { ok: false, note: 'The stand-in exists only in a development build.' };
    if (!(watcher instanceof NodeWatcher)) {
      return { ok: false, note: 'Set a Monero node first, so there is a scan to sync.' };
    }
    const request = watcher.keyImageRequest();
    if (!request.ok) return { ok: false, note: request.problem };
    const reply = standInKeyImages(request.payload);
    if (!reply) return { ok: false, note: 'The stand-in could not answer that request.' };
    return acceptWirePayload('XMRKEYIMAGES', reply);
  }, [watcher, acceptWirePayload]);

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
      nodes,
    refreshing,
    nodeProblems,
    refresh,
    setNode: (kind: NodeKind, config: NodeConfig | null) =>
      setNodes((current) => (kind === 'esplora' ? { ...current, btc: config } : { ...current, xmr: config })),
    moneroStatus,
    restored,
    forgetStored: () => {
      scanStart.current = null;
      setMoneroScan(null);
      setMoneroStatus(null);
      setNodes(NO_NODES);
      void storage.clear();
    },
    pairing,
    accountKey,
    acceptWirePayload,
    keyImageFrames,
    syncStandInKeyImages,
    /* The demo pairing runs the stand-in's export through the same
     * acceptance path a scanned one takes, so the button exercises the real
     * checks rather than flipping a flag. */
    pairVault: (label: string) => {
      const btc = standInAccountExport('btc');
      const xmr = standInAccountExport('xmr');
      if (btc) acceptPairing(btc, label);
      if (xmr) acceptPairing(xmr, label);
      if (!btc && !xmr) {
        /* Release build: the stand-in refused, and pairing is the camera. */
        return;
      }
      setVault((current) =>
        current.state === 'unpaired'
          ? current
          : { ...current, label, lastSession: current.lastSession ?? Date.now() },
      );
    },
    unpairVault: () => {
      pairingRef.current = null;
      setPairing(null);
      void clearPairing(keysStorage);
      setVault({ state: 'unpaired' });
    },
    endSession,
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
