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
/* The system share sheet, which is how a file leaves this app for another.
 * React Native's own, not a dependency: on iOS a `url` pointing at a file
 * opens the sheet with the file attached, which is the one thing needed. */
import { Share } from 'react-native';
import { nextChangeIndex, prepare, verifySigned } from '../core/build';
import { prepareMoneroDraft, verifySignedMonero } from '../core/monerodraft';
import { readStatus, type SwapOrder, type SwapStatus } from '../core/swap';
import type { PendingSwap } from '../core/swaptrack';
import type { ChainSnapshot, FeeOption } from '../core/chain';
import { DEMO_ZPUB } from '../core/demo';
import type { Asset, Draft, VaultLink } from '../core/model';
import { elide, parseAmount } from '../core/units';
import { reduce, START, type SessionEvent, type SessionState } from '../core/session';
import { forgetOutputDistribution } from '../core/moneroplan';
import type { OwnAddresses, SwapTransport } from '../core/swap';
import type { NodeConfig, NodeKind } from '../core/nodes';
import { openAccount, type ScanState } from '../core/moneroscan';
import { acceptAccount, wouldReplace, type Pairing } from '../core/pairing';
import { NodeWatcher, type MoneroStatus, type MoneroWatch, type RefreshResult, type WatcherNodes } from '../core/watcher';
import type { MoneroSource } from '../core/moneroscan';
import { Watchers, emptySnapshot, problemsFrom, resumeFrom, selected, type AccountKeys } from '../core/watchers';
import { demoSwapTransport, DEMO_XMR_ADDRESS, DEMO_XMR_VIEW_SECRET } from '../core/demo';
import { proxyTransport, swapConfigured } from '../net/swapproxy';
import { DEMO, standInAccountExport, standInKeyImages } from '../demo/standin';
import { restoreHeight, revealSecretHex } from '@vault/keys/monero';
import { receiveMoneroFile } from '../core/vaultfile';
import { saveVaultFile } from './vaultFileStore';
import { digestOf } from '@vault/airgap/envelope';
import { EMPTY, load, save, type Persisted } from './persist';
import { fileStore } from './fileStore';
import { keychainStore, spendingKeyStore } from './keychainStore';
import { clearPairing, loadPairing, savePairing } from './persistKeys';
import { forgetHot, loadHot, saveHot, watchOnlyFrom, type HotRecord } from '../core/keyvault';
import { accountsFrom, type Account } from '../core/accounts';
import { signHere as signWithHotKeys } from '../core/hotsign';
import { hotKeyImages } from '../core/hotimages';
import { nativeGate } from './biometrics';
import { transmit, Transmission } from '../core/wire';
import { arrived, confirmed, refused } from '../design/haptics';

/**
 * There is no node until somebody sets one.
 *
 * The constant every other wallet ships with an address in it. This one is
 * empty and stays empty: picking a node for everybody is picking who gets to
 * watch everybody's addresses, and it is a decision this app makes on screen
 * rather than in a source file. With nothing set the app watches nothing and
 * says so: empty views, a stale snapshot, and a home screen that offers the
 * way out rather than a number.
 */
const NO_NODES: WatcherNodes = { btc: null, xmr: null };

/**
 * What is remembered between launches, and where.
 *
 * Two stores, split by sensitivity. Node addresses and the scan height go in
 * a plain JSON file (`state/persist.ts`): they are configuration, readable by
 * the person auditing what this app keeps. The keychain holds two things, and
 * it is worth naming both rather than only the older one: the paired
 * watch-only keys (`state/persistKeys.ts`), which cannot spend and are still
 * the watching half of somebody's finances, and this phone's own spending
 * keys (`core/keyvault.ts`), which are a seed. Anything that says this app
 * stores no secret is describing the build before that landed.
 *
 * Not remembered anywhere: the Monero outputs a scan found and the key images
 * that cover them. Both are lists about the person rather than the chain, and
 * neither belongs on the networked device's disk. Recovering them is a scan
 * from the birth height rather than a resume, which is slow and correct: the
 * position on disk is not resumed across a launch precisely because the
 * findings that go with it did not survive one.
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
   *  or null when it worked and the session moved on. Asynchronous because a
   *  Monero draft is planned against the node (decoys, ring members, fee);
   *  Bitcoin resolves immediately. */
  prepareDraft(): Promise<string | null>;
  beginTransmit(): void;
  handOver(): void;
  readBack(): void;
  /** Offer bytes that came back from a camera — or, in this build, from the
   *  stand-in vault. Always goes through `verifySigned`. */
  offerSignature(raw: Uint8Array | null): void;
  broadcast(): void;

  /** Which nodes are set. Null on both means nothing can be fetched. */
  nodes: WatcherNodes;
  /** True while a refresh is in flight, for the one spinner in the app. */
  refreshing: boolean;
  /** What went wrong on the last refresh, per asset, in sentences. */
  nodeProblems: { asset: Asset; problem: string }[];
  refresh(): Promise<void>;
  setNode(kind: NodeKind, config: NodeConfig | null): void;
  /** How far the selected account's Monero scan has got, or null before it has
   *  run. Per account, because two accounts scan two different sets of blocks
   *  and one shared number would report one account's progress under the
   *  other's name. */
  moneroStatus: MoneroStatus | null;
  /** True once what was stored has been read, so a screen can say so. */
  restored: boolean;
  /**
   * Throw away everything on disk and start the Monero scan again.
   *
   * Wanted for two different reasons that happen to want the same button: a
   * scan that somehow got ahead of itself, and somebody handing the phone on.
   *
   * It clears the file and nothing else, and the difference matters now that
   * this app can hold a seed: the keychain keeps the spending keys and the
   * paired watching keys, and neither is touched here. `forgetHotKeys` is the
   * one that forgets a wallet. Somebody handing the phone on needs both, so
   * this is not the wipe it used to be able to claim to be.
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
  depositForSwap(order: SwapOrder, from: Asset, toId: string): void;
  /** The one swap this wallet is minding, restored across relaunches. */
  pendingSwap: PendingSwap | null;
  /** The last status the provider gave for it, and when it was asked. */
  swapCheck: { status: SwapStatus; at: number } | null;
  /** Ask the provider where the pending swap is. Pull, never poll. */
  refreshSwap(): Promise<void>;
  /** Forget the pending swap. The provider keeps its own records. */
  dismissSwap(): void;

  /** What the vault handed over, or null before any pairing. */
  pairing: Pairing | null;
  /**
   * The Bitcoin account key of the *selected* account.
   *
   * Named for the selection because that is what it is. It was called
   * `accountKey`, and the vault screen read it under the heading THIS
   * PAIRING, so with a vault paired and the wallet on this phone selected
   * that row printed this phone's own zpub as though the vault had sent it.
   * A pairing's key is `pairing.btc.zpub` and nothing else.
   */
  selectedAccountKey: string | null;
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

  /**
   * A wallet2 file the vault sent, caught and waiting to be written.
   *
   * Held rather than saved on arrival, because a scan that drops files into a
   * directory on its own is a scan with a side effect nobody asked for. Null
   * until a `key-image-export` arrives over the camera.
   */
  moneroFileWaiting: { what: string; filename: string; bytes: number } | null;
  /** Write the waiting file and hand it to the share sheet. */
  saveMoneroFile(): Promise<{ ok: boolean; note: string }>;

  /**
   * Everything this wallet watches, vault accounts and hot ones alike.
   *
   * Derived rather than stored, from the pairing and the hot record, so there
   * is no third place for the truth about what exists to drift. An empty list
   * is a real state with a screen attached: see `NOTHING_WATCHED`.
   */
  accounts: Account[];
  /**
   * Which account every other screen is about.
   *
   * The app looks at one account at a time rather than summing them, because a
   * vault account and an account on this phone are different wallets with
   * different security properties, and one number over both would hide the
   * only distinction this product exists to make. Null only when there are no
   * accounts at all.
   */
  selectedAccount: string | null;
  /** Look at a different account. Ignored for an id that does not exist. */
  selectAccount(id: string): void;

  /**
   * This wallet's own spending keys, or null when it holds none.
   *
   * Null is the ordinary state and stays the ordinary state: a wallet paired
   * to a vault never needs this, and `canSignHere` refuses a vault account
   * whatever is stored here. See core/keyvault.ts, which is written as a
   * security document because that is what it is.
   */
  hot: HotRecord | null;
  /**
   * Write a record to the keychain.
   *
   * Called at the end of creation, and only after the words have been shown:
   * `core/backup.ts` holds that ordering in a transition table, so this
   * function is the effect rather than the rule.
   */
  keepHot(record: HotRecord): Promise<void>;
  /**
   * Forget the spending keys on this device.
   *
   * `forget` rather than `delete`, the same word `keyvault.ts` chose and for
   * the same reason: the coins stay on the chain and the words on paper still
   * restore them. A screen that says "delete wallet" invites somebody to
   * believe they destroyed something they did not.
   */
  forgetHotKeys(): Promise<void>;

  /**
   * Sign the current draft with this phone's own keys.
   *
   * The whole of the hot path between review and a signature, where the vault
   * path has a walk across a room. It asks Face ID, signs, and then puts what
   * it produced through the *same* `offerSignature` a camera would: there is
   * one gate into a broadcastable state and this does not add a second.
   *
   * Refuses for a vault account, twice over. `core/session.ts` has no
   * transition for it and `core/hotsign.ts` checks `canSignHere` before it
   * reads anything, so the airgap survives both a new button and a new caller.
   */
  signOnThisDevice(): Promise<void>;

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
  /**
   * How many change addresses this session has used beyond what the scan has
   * seen, per account.
   *
   * An offset rather than an index, and that is the fix to a defect that lost
   * money in the only way this app can lose it: silently. It used to be
   * `useRef(24)`, an absolute index chosen before the scanner existed.
   * `discover.ts` walks the change branch from zero and stops after
   * `GAP_LIMIT` consecutive unused addresses, so 1/24 was never queried, and
   * because 0..23 were never used the gap never reset. Every change output the
   * app ever made stayed outside the scan window, on every rescan, forever.
   * The coins were real and the vault signed them happily, since `psbt.ts`
   * scans to depth 200 and recognized the change as its own.
   *
   * So the index comes from the scan now, the way the receive address already
   * did, and this only covers the gap between a draft and the refresh that
   * would notice it: two payments composed back to back must not land change
   * on one address, because that publishes the link between them to anybody
   * reading the chain.
   */
  const changeAhead = useRef<Record<string, number>>({});

  /* Twenty seconds is slow enough to cost nothing and fast enough that "Just
   * now" becomes "1m ago" while somebody is still looking at the screen. */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const [nodes, setNodes] = useState<WatcherNodes>(NO_NODES);
  const [refreshing, setRefreshing] = useState(false);
  /* The same fact as `refreshing`, readable inside the callback rather than a
   * render later. State is what the spinner reads; this is what the re-entry
   * check reads, because a second call arriving before React commits would see
   * the old `false`. */
  const inFlight = useRef(false);
  const [nodeProblems, setNodeProblems] = useState<RefreshResult['problems']>([]);
  const [moneroScans, setMoneroScans] = useState<Persisted['moneroScans']>({});
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);
  const [swapCheck, setSwapCheck] = useState<{ status: SwapStatus; at: number } | null>(null);
  /* One entry per account rather than one for the app.
   *
   * It used to be a single value written for whichever account was selected,
   * which put `selectedAccount` in `refresh`'s dependency list, which made
   * tapping an account on the accounts screen fire a full network refresh of
   * every account: tip height, address walk, per-address history, a Monero
   * scan pass, a key image query, a fee estimate and prices, for one line of
   * progress. Keyed here, the selection is a read rather than a fetch. */
  const [moneroStatuses, setMoneroStatuses] = useState<Record<string, MoneroStatus>>({});
  /* A wallet2 file caught over the camera, and the bytes behind it.
   *
   * Two holders on purpose. The state is what a screen renders and is
   * deliberately only a description — what it is, what it will be called, how
   * big; the ref holds the bytes, which no view has any business re-rendering
   * over. A key image export names every output this account owns, so it is
   * kept in exactly one place and dropped as soon as it is written. */
  const [moneroFileWaiting, setMoneroFileWaiting] =
    useState<{ what: string; filename: string; bytes: number } | null>(null);
  const pendingFile = useRef<{ filename: string; bytes: Uint8Array } | null>(null);
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
  const scanStarts = useRef<Record<string, ScanState>>({});
  /*
   * The positions this process actually produced, as opposed to the ones read
   * off disk. Only these are safe to resume from, because only these have the
   * findings that go with them still in memory.
   *
   * Keyed by the account's Monero address, and that is the point rather than a
   * detail. The account ids are role names: `accounts.ts` hard-codes 'hot' and
   * 'vault', so forgetting a wallet and restoring a different one, or
   * unpairing and pairing a different vault, puts a second wallet under an id
   * that already has a position recorded against it. Keyed by id, the new
   * wallet inherited the old one's height and resumed millions of blocks late
   * with a progress bar reading caught up. An address cannot be inherited.
   */
  const sessionScans = useRef<Record<string, ScanState>>({});
  /* Bumped when the stored scans are thrown away, so the memo that reads them
   * actually recomputes. Without it FORGET EVERYTHING STORED cleared a ref
   * that nothing re-read: the same watcher objects carried the same positions,
   * and the app's own documented remedy for "a scan that got ahead of itself"
   * did nothing but wipe the node configuration. */
  const [scanGeneration, setScanGeneration] = useState(0);

  /* Which account the interface is looking at, as asked for rather than as
   * resolved. `selected` turns it into one that exists; keeping the raw wish
   * means switching to an account, forgetting it, and adding it back lands
   * somebody where they were. */
  const [wantedAccount, setWantedAccount] = useState<string | null>(null);

  const keysStorage = useMemo(() => keychainStore(), []);
  const spendingStorage = useMemo(() => spendingKeyStore(), []);

  /* What this wallet can sign for itself. Read at launch beside the pairing,
   * because a screen that offers to back up a wallet has to know whether there
   * is one before it renders rather than after. */
  const [hot, setHot] = useState<HotRecord | null>(null);

  useEffect(() => {
    let current = true;
    void loadHot(spendingStorage).then((result) => {
      /* A record that fails to parse loads as nothing, the same rule the node
       * file and the pairing follow. The words on paper are what restores a
       * wallet; a half-read record would derive addresses from a seed that is
       * not the seed and then report zero for money that is there. */
      if (current && result.ok) setHot(result.record);
    });
    return () => { current = false; };
  }, [spendingStorage]);

  useEffect(() => {
    let current = true;
    void Promise.all([load(storage), loadPairing(keysStorage)]).then(([stored, paired]) => {
      if (!current) return;
      scanStarts.current = stored.moneroScans;
      setMoneroScans(stored.moneroScans);
      setPendingSwap(stored.pendingSwap);
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
    void save(storage, { ...EMPTY, nodes, moneroScans, pendingSwap });
  }, [restored, storage, nodes, moneroScans, pendingSwap]);

  /**
   * The Bitcoin account key in effect: the paired one, else the published
   * demo key in a dev build, else nothing. Nothing means the send flow
   * refuses to prepare and the vault screen says to pair, which are the
   * right two consequences of that state.
   */
  /*
   * The watch-only half of whatever this phone holds its own keys for.
   *
   * Derived rather than stored, and memoized on the record so it is not a key
   * schedule per render. `watchOnlyFrom` opens both wallets, reads an account
   * key and a view key, and closes them; what it hands back cannot spend.
   */
  const hotWatch = useMemo(() => (hot === null ? null : watchOnlyFrom(hot)), [hot]);

  /* What exists, for every screen that used to ask "is this app paired". The
   * stand-in flag is passed rather than read inside `accountsFrom`, so that
   * module stays testable under Node and free of the demo import. It is what
   * keeps the list honest in a development build, where the watcher really is
   * pointed at BIP84's published account. */
  const accounts = useMemo(
    () => accountsFrom(pairing, hot, DEMO && pairing === null && hot === null),
    [pairing, hot],
  );

  /**
   * Every account's watching keys, one entry per account.
   *
   * This used to resolve to a single account key and a single Monero account,
   * with a pairing beating a hot record and the accounts screen printing a
   * sentence on whichever one lost. Both are watched now: the precedence is
   * gone, and so is the sentence.
   *
   * A Monero account is opened here rather than in `watchers.ts` because
   * `openAccount` is what proves the view key belongs to the address, and an
   * account that fails that check is dropped rather than watched. Finding
   * nothing with the wrong keys is indistinguishable from finding nothing with
   * the right ones.
   */
  const accountKeys = useMemo<AccountKeys[]>(() => {
    const openMonero = (
      keys: { address: string; view: string; birth: number | null } | null,
      id: string,
      /* Where the spend key for this account is, which is not something the
       * watcher can work out from a view key: both kinds of account are
       * watched the same way and only this says which one is being watched.
       * Every custody sentence under a Monero balance is derived from it. */
      source: MoneroSource,
    ): MoneroWatch | null => {
      if (!keys) return null;
      const opened = openAccount(keys.address, keys.view);
      if (!opened.ok) return null;
      /* An account with no stated birth starts a week back rather than at the
       * tip. Starting late means silently never seeing payments that arrived
       * first, which reads as money that did not turn up. */
      const birth = keys.birth ?? restoreHeight();
      /*
       * Resume only where the findings survived, which across a launch they do
       * not, and only where the blocks in between were really walked.
       *
       * `NodeWatcher.found` is in memory by design: a list of somebody's
       * incoming payments on disk is exactly what the view key was protecting.
       * The height was persisted anyway, so a relaunch resumed past every
       * funded block with an empty output set and reported a balance of zero,
       * under a caveat that says "this total is what arrived". Rescanning that
       * account also could not recover it, because the key image request is
       * built from the outputs the scan found.
       *
       * `resumeFrom` in `watchers.ts` is both halves of that rule, extracted so
       * the three cases can be tested without a React tree.
       */
      const stored = scanStarts.current[id];
      const resumable = sessionScans.current[opened.account.address];
      return { account: opened.account, scan: resumeFrom(birth, stored, resumable), source };
    };

    const out: AccountKeys[] = [];
    if (pairing !== null) {
      out.push({
        id: 'vault',
        zpub: pairing.btc?.zpub ?? null,
        monero: openMonero(
          pairing.xmr
            ? { address: pairing.xmr.address, view: pairing.xmr.view, birth: pairing.xmr.birth }
            : null,
          'vault',
          'vault',
        ),
      });
    }
    if (hotWatch !== null) {
      out.push({
        id: 'hot',
        zpub: hotWatch.zpub,
        monero: openMonero(
          hotWatch.xmr
            ? {
                address: hotWatch.xmr.address,
                view: hotWatch.xmr.view,
                /* Already a block height. `watchOnlyFrom` converts, because the
                 * record stores a creation time in milliseconds and this field
                 * is in blocks, six orders of magnitude apart. */
                birth: hotWatch.xmr.birth,
              }
            : null,
          'hot',
          'hot',
        ),
      });
    }
    if (DEMO && pairing === null && hot === null) {
      out.push({
        id: 'standin',
        zpub: DEMO_ZPUB,
        monero: openMonero(
          { address: DEMO_XMR_ADDRESS, view: revealSecretHex(DEMO_XMR_VIEW_SECRET), birth: null },
          'standin',
          /* The stand-in is a vault, imitated. Its whole purpose is to render
           * the paired screens in a dev build, so it has to say the paired
           * sentence. */
          'vault',
        ),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, pairing, hotWatch, hot, scanGeneration]);

  /**
   * One watcher per account.
   *
   * Rebuilt when the nodes change, which also throws away every previous
   * snapshot. That is correct: a balance from a different node is not a
   * balance from this one, and showing it while the new one loads would be
   * showing somebody a number from a source they just stopped trusting.
   *
   * An account whose keys are unchanged keeps its watcher across a rebuild of
   * the list, because the list is one memo over the whole array and making a
   * wallet on this phone otherwise reset the *vault* account's found outputs
   * and key image book to empty. Both are memory-only by design, so that was a
   * vault account's spendable Monero going to zero, and a physical QR round
   * trip to repeat, for an action about a different account.
   */
  const carried = useRef<{ nodes: WatcherNodes; generation: number; watchers: Watchers } | null>(null);
  const watchers = useMemo(() => {
    const previous = carried.current;
    /* Carried only when nothing that invalidates a watcher has changed. A new
     * node means a new set, for the reason above. A bumped generation means
     * somebody asked for the scans to be thrown away, and reusing a watcher
     * would hand them back the position they just cleared. */
    const carry =
      previous && previous.nodes === nodes && previous.generation === scanGeneration
        ? previous.watchers
        : null;
    const next = new Watchers(nodes, accountKeys, Date.now(), carry);
    carried.current = { nodes, generation: scanGeneration, watchers: next };
    return next;
  }, [nodes, accountKeys, scanGeneration]);

  /* Which account the interface is looking at. Resolved through `selected`
   * rather than read straight out of state, so forgetting the account somebody
   * was looking at lands them on one that exists rather than on a screen
   * rendering a balance for a wallet that is gone. */
  const selectedAccount = selected(accounts.map((account) => account.id), wantedAccount);
  const watcher = watchers.watcherFor(selectedAccount);

  /** The Bitcoin account key of one account, for the screen that shows it and
   *  for `prepare`, which builds change addresses from it. */
  const accountKeyOf = (id: string | null): string | null =>
    accountKeys.find((entry) => entry.id === id)?.zpub ?? null;

  /* `NodeWatcher.snapshot` takes no clock: it hands back the value the last
   * refresh built. `now` stays in the dependency list because the interface
   * around it renders relative times from the same tick. */
  const snapshot = useMemo(
    () => watcher?.snapshot() ?? emptySnapshot(now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [watcher, now, fetched],
  );

  /**
   * Refresh every account, not only the one on screen.
   *
   * The alternative, refreshing what is being looked at, makes the other
   * account's balance a thing that only updates when somebody happens to visit
   * it. That is how a wallet shows a stale number on the accounts list and
   * nobody notices for a week.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (watchers.ids().length === 0) return;
    /* One pass at a time. Pull to refresh, an arriving key image payload and
     * the effect below can all ask within a few hundred milliseconds of each
     * other, and two passes over the same watcher walk the same blocks twice
     * against somebody's node for one answer. */
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const results = await watchers.refreshAll(Date.now());
      setNodeProblems(
        problemsFrom(results, (id) => accounts.find((a) => a.id === id)?.label ?? id),
      );
      /* Written down after every pass, including one that failed part way.
       * `scan` leaves the height on the block it did not finish, so storing it
       * resumes rather than skips, and not storing it would redo the blocks
       * that did succeed. Kept per account, because two accounts scan two
       * different sets of blocks for two different view keys. */
      const positions: Record<string, ScanState> = {};
      const byAddress: Record<string, ScanState> = {};
      const statuses: Record<string, MoneroStatus> = {};
      for (const keys of accountKeys) {
        const progress = watchers.watcherFor(keys.id)?.moneroProgress();
        if (!progress) continue;
        positions[keys.id] = progress.scan;
        statuses[keys.id] = progress;
        /* The same object under two keys on purpose: the id is what goes to
         * disk, the address is what a rebuilt watcher is allowed to resume
         * from, and `resumeFrom` compares them by identity to establish that
         * the outputs found alongside this height are still in memory. */
        const address = keys.monero?.account.address;
        if (address) byAddress[address] = progress.scan;
      }
      scanStarts.current = { ...scanStarts.current, ...positions };
      sessionScans.current = { ...sessionScans.current, ...byAddress };
      setMoneroScans((current) => ({ ...current, ...positions }));
      setMoneroStatuses((current) => ({ ...current, ...statuses }));
      /*
       * A hot account computes its own key images, because its spend key is
       * here. Without this the coins are found and never become spendable:
       * `moneroSpendable` filters to outputs an image covers, and the only
       * writer of the book was a payload scanned off a vault. A phone-only
       * wallet was told to go and scan a vault it does not have.
       *
       * Done after the scan rather than on a button, because there is nothing
       * for a person to decide: the keys are already here and the trip a vault
       * needs is the thing this account does not have to make.
       */
      if (hot !== null) {
        for (const account of accounts) {
          if (!account.signsHere) continue;
          const watcher = watchers.watcherFor(account.id);
          const request = watcher?.keyImageRequest();
          if (!watcher || !request || !request.ok || !request.payload) continue;
          const computed = hotKeyImages(account.source, hot, request.payload);
          if (computed.ok) watcher.importKeyImages(computed.payload);
        }
      }

      /* The scan has now seen whatever the last drafts spent, so the derived
       * change index is authoritative again and the in-session offset would
       * only push new change further past the gap. */
      changeAhead.current = {};
    } finally {
      inFlight.current = false;
      setRefreshing(false);
      setFetched((count) => count + 1);
    }
  }, [watchers, accountKeys, accounts, hot]);

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

  const prepareDraft = useCallback(async (): Promise<string | null> => {
    const parsed = parseAmount(session.compose.amountText, asset);
    if (!parsed.ok || parsed.atoms === undefined) return parsed.problem ?? 'Enter an amount.';

    if (asset === 'XMR') {
      /* Planned against the node: decoys from the real distribution, coins
       * from the scan plus the vault's key images, the node's fee estimate.
       * The uniform source is the platform CSPRNG; decoy choice is a privacy
       * property, and Math.random would be a privacy property built on a
       * PRNG nobody chose for it. */
      if (!(watcher instanceof NodeWatcher)) {
        return 'A Monero payment needs a real node. The demo watcher cannot plan one.';
      }
      const uniform = () => {
        const word = new Uint32Array(1);
        crypto.getRandomValues(word);
        return word[0]! / 0x100000000;
      };
      const materials = watcher.moneroSpendMaterials(uniform);
      if (!materials.ok) return materials.problem;
      const planned = await prepareMoneroDraft(materials.materials, {
        recipient: session.compose.recipient.trim(),
        amount: parsed.atoms,
        multiplier: feeOption(session.compose.feeKey).rate,
        now: Date.now(),
      });
      if (!planned.ok) return planned.problem;
      dispatch({ type: 'prepared', draft: planned.draft, account: selectedAccount, at: Date.now() });
      return null;
    }

    const view = snapshot.assets[asset];
    const result = prepare({
      asset,
      recipient: session.compose.recipient.trim(),
      amount: parsed.atoms,
      rate: feeOption(session.compose.feeKey).rate,
      utxos: view.utxos,
      balance: view.spendable,
      zpub: accountKeyOf(selectedAccount) ?? '',
      change: {
        index: nextChangeIndex(
          snapshot.assets.BTC.addresses,
          selectedAccount === null ? 0 : changeAhead.current[selectedAccount] ?? 0,
        ),
      },
      now: Date.now(),
    });

    if (!result.ok) return result.problem;
    /* A new change address for the next payment. Reusing one is not a bug that
     * shows up on any screen, which is exactly why it has to be handled here:
     * every payment landing change on the same address publishes the link
     * between them to anybody reading the chain. Cleared on the next refresh,
     * once the scan has seen what this draft spent. */
    if (selectedAccount !== null) {
      changeAhead.current[selectedAccount] = (changeAhead.current[selectedAccount] ?? 0) + 1;
    }
    dispatch({ type: 'prepared', draft: result.draft, account: selectedAccount, at: Date.now() });
    return null;
  }, [session.compose, asset, snapshot, feeOption, selectedAccount, watcher]);

  const beginTransmit = useCallback(() => {
    const draft: Draft | null = session.draft;
    if (!draft) return;
    dispatch({ type: 'transmit', transmission: transmit(draft, 'vault'), at: Date.now() });
    setVault((current) =>
      current.state === 'unpaired' ? current : { ...current, state: 'in-session' },
    );
  }, [session.draft]);

  /* True from the moment this device starts signing until it has finished.
   * See `signOnThisDevice`: two callers, one prompt. */
  const signingHere = useRef(false);

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

  /**
   * The one door into a broadcastable state, and the one place a handoff is
   * recorded.
   *
   * `origin` splits two jobs that used to be one function. Verification is the
   * same for both paths and deliberately so: a signature this phone made goes
   * through the same `verifySigned` as one that came back over a camera, and
   * there is exactly one dispatch of `returned` in this file.
   *
   * The vault link's audit trail is *not* the same for both. LAST VERIFIED
   * SESSION on the vault screen reads "the last time a signature came back
   * from the vault and matched the transaction this device had prepared", and
   * the hot signer routing through this function stamped that line for
   * handoffs that never happened. On a phone holding both kinds of account,
   * which is the arrangement the multi-account work exists for, the only
   * on-device record of when the airgap was actually exercised moved every
   * time somebody spent from the hot wallet. So the bookkeeping belongs to the
   * camera path alone.
   */
  const applySignature = useCallback(
    (raw: Uint8Array | null, origin: 'vault' | 'here') => {
      const draft = session.draft;
      if (!draft) return;
      /* The account the draft was built for, not the one on screen. The two
       * differ the moment somebody visits the accounts list mid-payment, and
       * the key image book resolved off the selection sent a legitimate vault
       * signature into terminal `mismatch`. */
      const paying = watchers.watcherFor(session.account);
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
        if (origin === 'vault') {
          setVault((current) =>
            current.state === 'in-session' ? { ...current, state: 'ready', lastSession: Date.now() } : current,
          );
        }
        return;
      }
      const verdict =
        draft.asset === 'XMR' && paying instanceof NodeWatcher
          ? verifySignedMonero(draft, raw, paying.moneroImagesFor(draft.spentKeys ?? []))
          : verifySigned(draft, raw);
      if (verdict.ok) arrived();
      else refused();
      dispatch({ type: 'returned', verified: verdict, at: Date.now() });
      if (origin !== 'vault') return;
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
    [session.draft, session.account, watchers],
  );

  /** Bytes from a camera, or from the stand-in vault. The vault path, so this
   *  is what moves the link's last-session and last-verified lines. */
  const offerSignature = useCallback(
    (raw: Uint8Array | null) => applySignature(raw, 'vault'),
    [applySignature],
  );

  /**
   * Sign here, for an account whose keys are on this phone.
   *
   * Reads the source off the accounts list rather than from "is there a hot
   * record", because those are different questions and only one of them is the
   * airgap rule. A phone holding a seed while watching a vault answers yes to
   * the second and must still answer no for the vault's account.
   */
  const signOnThisDevice = useCallback(async (): Promise<void> => {
    const draft = session.draft;
    if (!draft || hot === null) return;

    /*
     * One prompt per payment, however many callers there are.
     *
     * There are two: the review screen's button, and the mount effect of the
     * screen that button navigates to. The button dispatches `sign-here`
     * synchronously before its first await, React commits the step change
     * while this call is parked on the Face ID prompt, and the signing screen
     * mounts and asks again. Not a race: it happened on every hot send. The
     * second prompt cancels the first, the first call dispatches `failed`, and
     * the authorization the person actually gave is dropped at a step that no
     * longer accepts it, leaving them on "Nothing was signed."
     *
     * A ref rather than a step check, because the callback's dependencies hold
     * the draft reference and the second invocation reads a stale `session`.
     * Cleared in the `finally` below, so a refused prompt can be retried.
     */
    if (signingHere.current) return;

    /*
     * The account this payment was prepared for, and only that one.
     *
     * Two earlier versions of this line were wrong in the same direction.
     * `accounts.find((a) => a.signsHere)` asks whether *any* account signs
     * here, which on a phone watching a vault and a hot wallet answers yes for
     * both. Reading the selection instead fixed that until the selection could
     * move underneath a live draft: Send is a modal with no focus listener, so
     * visiting the accounts list mid-payment and coming back offered SIGN ON
     * THIS PHONE over the vault account's transaction. The draft carries its
     * account now, and that is what decides.
     */
    const spending = accounts.find((account) => account.id === session.account);
    if (!spending) {
      dispatch({
        type: 'failed',
        problem:
          'The account this payment was prepared for is no longer on this phone, so nothing here can sign it. ' +
          'Start the payment again from an account you still have.',
        at: Date.now(),
      });
      return;
    }

    /* The real answer, not a literal. The transition table refuses `sign-here`
     * for an account that does not sign here, and it can only do that if it is
     * ever told about one: passing `true` from the only dispatcher made the
     * second, independent check a decoration. */
    dispatch({ type: 'sign-here', signsHere: spending.signsHere, at: Date.now() });
    if (!spending.signsHere) {
      dispatch({
        type: 'failed',
        problem:
          'This payment is from an account paired to your vault, so its keys are not on this phone. ' +
          'Hand it to your vault to sign.',
        at: Date.now(),
      });
      return;
    }

    signingHere.current = true;
    try {
      const signed = await signWithHotKeys({
        source: spending.source,
        record: hot,
        draft,
        gate: nativeGate(spending.source, `Sign this ${draft.asset} payment`),
        /* The platform CSPRNG, the same source the decoy selection above draws
         * from. Passed in rather than reached for inside the signer, so the
         * signer can be run against a fixed input in a test. */
        scalars: (count) =>
          Array.from({ length: count }, () => {
            const bytes = new Uint8Array(32);
            crypto.getRandomValues(bytes);
            return bytes;
          }),
      });

      if (!signed.ok) {
        refused();
        dispatch({ type: 'failed', problem: signed.problem, at: Date.now() });
        return;
      }

      /* Through the same door a camera's bytes go through. `applySignature`
       * runs `verifySigned`, and a signature this device made gets no more
       * credit than one that arrived from across a room: `here` is what keeps
       * it off the vault link's audit trail. */
      applySignature(signed.raw, 'here');
    } finally {
      signingHere.current = false;
    }
  }, [session.draft, session.account, hot, accounts, applySignature]);

  const broadcast = useCallback(() => {
    const verified = session.verified;
    const draft = session.draft;
    if (!verified || !verified.ok || !draft) return;
    /*
     * The chain this payment is on, read from the payment.
     *
     * It used to read the app-wide chain chip, which every neighbor in this
     * file already knew better than to do. Send is a modal with a swipe
     * gesture, so somebody could leave the ready screen, change the chip on
     * Home, come back and press BROADCAST: a Monero transaction would go to
     * the Bitcoin node, and the mainnet Monero gate, which is keyed to the
     * same chip, would not run at all.
     */
    const asset = draft.asset;
    /* And the account it spends from, for the same reason `applySignature`
     * resolves one: the selection is not the payment. */
    const paying = watchers.watcherFor(session.account);
    if (!paying) {
      /* Checked before the transition, not after. Dispatching `broadcasting`
       * and then returning left the session in a step with no `back` and a
       * disabled button, pinned there until the app was relaunched with a
       * signed transaction stranded behind it. */
      refused();
      dispatch({
        type: 'failed',
        problem:
          'This wallet is not watching the account this payment came from, so it has no node to publish it to. ' +
          'Set a node for that account and try again.',
        at: Date.now(),
      });
      return;
    }
    dispatch({ type: 'broadcast', at: Date.now() });
    /* The signed transaction names its network and its id; the chokepoint
     * gates on the first and returns the second, since monerod's reply
     * carries no id of its own. */
    const options =
      asset === 'XMR' ? { network: verified.network ?? 'mainnet', txid: verified.txid } : undefined;
    void paying.broadcast(asset, verified.raw, options).then((result) => {
      if (result.ok && result.txid) {
        confirmed();
        /* Lock the spent coins until the scan confirms them, so a second
         * payment started before the next refresh cannot double-spend. */
        const spent = draft.spentKeys;
        if (asset === 'XMR' && spent && paying instanceof NodeWatcher) {
          paying.markMoneroPending(spent);
        }
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
  }, [session.verified, session.draft, session.account, watchers]);

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

      /* A second, different key for a chain that is already paired is a
       * substitution, and it is refused rather than merged. Scanned during any
       * open camera, including the signature read-back mid-handoff, the old
       * behavior swapped the account every receive address derives from while
       * the vault screen went on showing the original device and date. */
      const replacing = wouldReplace(current, accepted);
      if (replacing.replaces) {
        return {
          ok: false,
          note:
            `This is a different ${replacing.chain === 'btc' ? 'Bitcoin' : 'Monero'} account from the one ` +
            `already paired. This wallet is watching ${elide(replacing.was, 10, 6)} and that code carries ` +
            `${elide(replacing.now, 10, 6)}. Forget the current vault first if you mean to replace it.`,
        };
      }

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

      if (kind === 'XMRFILE') {
        /* One of Monero's own wallet files, coming back. The vault writes
         * exactly one of these — the key image export — and this phone is the
         * only device in the room holding both a camera and a filesystem, so
         * it is the courier. `receiveMoneroFile` decides what it is and what
         * to say; nothing is written until somebody taps. */
        const incoming = receiveMoneroFile(payload);
        if (!incoming.ok || !incoming.filename) {
          setMoneroFileWaiting(null);
          pendingFile.current = null;
          return { ok: false, note: incoming.note };
        }
        pendingFile.current = { filename: incoming.filename, bytes: payload };
        setMoneroFileWaiting({
          what: incoming.what ?? 'a Monero wallet file',
          filename: incoming.filename,
          bytes: payload.length,
        });
        return { ok: true, note: incoming.note };
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

  /**
   * Write the waiting file and offer it onwards.
   *
   * The share sheet rather than a path a person has to go and find: the file
   * exists to be imported by another wallet, and every step between "the vault
   * answered" and "the other wallet has it" is a step somebody gives up on.
   */
  const saveMoneroFile = useCallback(async (): Promise<{ ok: boolean; note: string }> => {
    const waiting = pendingFile.current;
    if (!waiting) return { ok: false, note: 'There is no file waiting to be saved.' };
    try {
      const saved = saveVaultFile(waiting.filename, waiting.bytes);
      await Share.share({ url: saved.uri, title: saved.name });
      /* Dropped once it has been handed on. The file is still in the cache
       * for the share sheet to have taken, and this wallet stops holding a
       * list of every output the account owns in memory. */
      pendingFile.current = null;
      setMoneroFileWaiting(null);
      return {
        ok: true,
        note: `Saved as ${saved.name}. Import it in the wallet that scanned these outputs.`,
      };
    } catch {
      /* A share sheet somebody dismissed is not a failure worth a red line,
       * but a write that did not happen is. Both land here and neither is
       * distinguishable from the other without guessing, so the sentence
       * claims only what is certain. */
      return { ok: false, note: 'That file was not saved. There may be no room on this device.' };
    }
  }, []);

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

  /**
   * The swap network, chosen once.
   *
   * A deployed relay means the real one; no relay means the fixture. Decided
   * from configuration rather than from a flag somebody has to remember to
   * flip, so that filling in SWAP_PROXY is the whole act of going live and
   * the screen's own honesty note follows from the same fact.
   */
  const swapNetwork = useMemo(() => (swapConfigured() ? proxyTransport() : demoSwapTransport), []);

  /**
   * The session's events, with one thing hung off `reset`.
   *
   * `reset` is every way out of a payment: the screen closing, DISCARD, a
   * finished broadcast. The Monero send path caches the chain's output
   * distribution, which is about nineteen megabytes of numbers at mainnet
   * scale, because downloading it again on every Review tap was measured at
   * 20.6 MB of JSON under a twelve-second abort. The cache is keyed on the
   * node, so this is not a correctness fix: a node change cannot serve a
   * stale answer. It is the difference between holding that array while
   * somebody is paying and holding it until the next block, on a phone.
   *
   * `depositForSwap` dispatches its own `reset` and deliberately does not
   * come through here: it is resetting in order to start a payment, not to
   * leave one, and dropping the cache there would buy a re-download of the
   * thing the person is about to review.
   */
  const send = useCallback((event: SessionEvent) => {
    if (event.type === 'reset') forgetOutputDistribution();
    dispatch(event);
  }, []);

  const depositForSwap = useCallback(
    (order: SwapOrder, from: Asset, toId: string) => {
      setAsset(from);
      dispatch({ type: 'reset' });
      dispatch({ type: 'recipient', value: order.depositAddress, source: 'scanned' });
      dispatch({ type: 'amount', value: String(order.depositAmount) });
      /* The memory that makes readStatus callable later: provider, order id,
       * the two sides as quoted. One at a time - a new swap replaces the old
       * record, and the provider stays the authority on every order. */
      setPendingSwap({
        provider: order.provider,
        id: order.id,
        fromId: from.toLowerCase(),
        toId,
        fromAmount: order.depositAmount,
        toAmount: order.toAmount,
        createdAt: Date.now(),
      });
      setSwapCheck(null);
    },
    [dispatch],
  );

  const refreshSwap = useCallback(async () => {
    if (!pendingSwap) return;
    const status = await readStatus(swapNetwork, pendingSwap.provider, pendingSwap.id);
    setSwapCheck({ status, at: Date.now() });
  }, [pendingSwap]);

  /**
   * Forget where an account's scan got to, because the account is gone.
   *
   * `forgetHotKeys` and `unpairVault` clear keys and pairing and used to touch
   * neither of the scan maps. The ids are role names, hard-coded in
   * `accounts.ts` as 'hot' and 'vault', so forget-then-restore and
   * unpair-then-pair-a-different-vault both put a second wallet under an id
   * that already had a position recorded against it. `sessionScans` is keyed
   * by Monero address so it cannot be inherited at all; this clears the rest,
   * so nothing stale is written back to disk under the new account's name or
   * shown as its scan progress.
   */
  const forgetScanFor = useCallback((id: string, address: string | null) => {
    const starts = { ...scanStarts.current };
    delete starts[id];
    scanStarts.current = starts;
    if (address !== null) {
      const live = { ...sessionScans.current };
      delete live[address];
      sessionScans.current = live;
    }
    setMoneroScans((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setMoneroStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const dismissSwap = useCallback(() => {
    setPendingSwap(null);
    setSwapCheck(null);
  }, []);

  const store: Store = {
    now,
    snapshot,
    vault,
    session,
    asset,
    setAsset,
    send,
    prepareDraft,
    beginTransmit,
    handOver,
    readBack,
    offerSignature,
    broadcast,
    own,
    swapTransport: swapNetwork,
    depositForSwap,
    pendingSwap,
    swapCheck,
    refreshSwap,
    dismissSwap,
      nodes,
    refreshing,
    nodeProblems,
    refresh,
    setNode: (kind: NodeKind, config: NodeConfig | null) => {
      /* The cached output distribution belongs to the node it came from, and
       * it knows that: a changed node cannot be served a stale answer. What
       * it cannot do on its own is let go, so a person who tries three Monero
       * nodes would be holding the first one's twenty megabytes until the
       * next block. */
      if (kind === 'monerod') forgetOutputDistribution();
      setNodes((current) => (kind === 'esplora' ? { ...current, btc: config } : { ...current, xmr: config }));
    },
    moneroStatus: selectedAccount === null ? null : moneroStatuses[selectedAccount] ?? null,
    restored,
    forgetStored: () => {
      scanStarts.current = {};
      sessionScans.current = {};
      setMoneroScans({});
      setMoneroStatuses({});
      /* The bump is what makes the rest of this line do anything. The memo
       * that reads `scanStarts` depends on the accounts, not on the ref, so
       * clearing the ref alone left every watcher holding the position it was
       * built with and the scan carried on from where it was. */
      setScanGeneration((count) => count + 1);
      setNodes(NO_NODES);
      /* Including the twenty megabytes of chain the send path had cached.
       * FORGET EVERYTHING STORED means the node configuration is gone, so
       * nothing can ever ask for that answer again. */
      forgetOutputDistribution();
      void storage.clear();
    },
    pairing,
    selectedAccountKey: accountKeyOf(selectedAccount),
    acceptWirePayload,
    keyImageFrames,
    syncStandInKeyImages,
    moneroFileWaiting,
    saveMoneroFile,
    accounts,
    selectedAccount,
    selectAccount: setWantedAccount,
    signOnThisDevice,
    hot,
    keepHot: async (record: HotRecord) => {
      /* Written before the state moves, so a keychain that refuses leaves the
       * app agreeing with the keychain. The other order gives a wallet that
       * shows a funded account until it is relaunched, which is the worst
       * possible time to find out nothing was saved. */
      await saveHot(spendingStorage, record);
      setHot(record);
    },
    forgetHotKeys: async () => {
      await forgetHot(spendingStorage);
      /* Before the record goes, because the Monero address is how this
       * account's scan position is found. See `forgetScanFor`. */
      forgetScanFor('hot', hotWatch?.xmr?.address ?? null);
      setHot(null);
    },

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
      forgetScanFor('vault', pairing?.xmr?.address ?? null);
      setVault({ state: 'unpaired' });
    },
    endSession,
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
