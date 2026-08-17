/**
 * Writing the keys down, and the rule that nothing may hold keys nobody wrote.
 *
 * ## Why this is a module and not a screen
 *
 * `keyvault.ts` can make a record and store one, and until this file existed
 * `makeHotRecord` had no caller on purpose: a wallet that generates a seed
 * before there is any way to write it down is a wallet that can lose money it
 * was handed thirty seconds earlier, and no amount of later polish undoes
 * that. So the ordering is the feature, and an ordering that lives in a screen
 * is an ordering somebody reorders while moving a button.
 *
 * ## The rule, and where it is enforced
 *
 * **A new record is not saved until its words have been shown.** Not "the
 * button is disabled until", which is a fact about a screen: `keep` is refused
 * by the transition table when the words have not been revealed, so there is
 * no state a button could lead to. Same shape as `session.ts` holding
 * `mismatch` terminal, and for the same reason.
 *
 * The ordering also decides which way a crash fails. Saving first and showing
 * second means a phone that dies in between holds a seed with no backup, which
 * is the failure this whole ordering exists to prevent. Showing first and
 * saving second means a phone that dies in between has shown somebody the
 * words to a wallet that was never stored: they hold a valid backup of an
 * empty wallet, which restores. One of those is a loss and the other is a
 * shrug, so the shrug is the one this code arranges to have.
 *
 * ## Why the words are derived rather than held
 *
 * `phrasesFor` re-derives from the record every time it is asked, and the
 * Monero wallet it opens to do so is wiped before it returns. The alternative,
 * carrying the words alongside the record, means the most dangerous string in
 * the application lives in whatever state a screen keeps and for however long
 * that screen is mounted. Deriving costs a key schedule and buys a lifetime
 * that is exactly one function call long.
 */

import { revealMnemonic, wipeWallet } from '@vault/keys/monero';
import { openMonero, type HotRecord } from './keyvault';

/**
 * The words for a record, one list per chain it actually holds.
 *
 * Null rather than an empty array for a chain that is not there, because an
 * empty list of words and no wallet at all are different things and a screen
 * has to say which. Somebody who restored twenty-five words out of Feather has
 * no Bitcoin half, and a heading over nothing would read as a wallet whose
 * backup went missing.
 */
export interface Phrases {
  /** Twenty-five words, or null when this record holds no Monero keys. */
  monero: string[] | null;
  /** Twelve words, or null when this record holds no Bitcoin keys. */
  bitcoin: string[] | null;
}

export function phrasesFor(record: HotRecord): Phrases {
  let monero: string[] | null = null;
  const wallet = openMonero(record);
  if (wallet !== null) {
    monero = revealMnemonic(wallet);
    /* Opened to read one thing and closed immediately. The caller gets words
     * and never gets the wallet, so there is no object holding a spend secret
     * that a screen could keep by accident. */
    wipeWallet(wallet);
  }

  const bitcoin = record.btcMnemonic === null ? null : record.btcMnemonic.split(' ');

  return { monero, bitcoin };
}

/**
 * How many words a person has to write down, for a screen that wants to say so
 * before it shows them.
 *
 * Worth stating up front rather than after the reveal: "thirty-seven words on
 * paper" is a different plan for the next five minutes than "a phrase", and
 * somebody who learns the size only once the words are on screen is somebody
 * who starts writing on the back of a receipt.
 */
export function wordCount(phrases: Phrases): number {
  return (phrases.monero?.length ?? 0) + (phrases.bitcoin?.length ?? 0);
}

// ------------------------------------------------------------------ creating

/**
 * Where a new wallet has got to.
 *
 * Three steps and one direction. `drawn` holds a record that exists only in
 * memory; `shown` is the same record after the words have been on screen;
 * `kept` is after it reached the keychain. The record is identical throughout:
 * what changes is what is known about the person holding the phone.
 */
export type CreationStep = 'drawn' | 'shown' | 'kept';

export interface Creation {
  step: CreationStep;
  /** The record itself, unsaved until `kept`. */
  record: HotRecord;
}

export type CreationEvent =
  /** The words were actually put on screen, not merely offered. */
  | { type: 'revealed' }
  /** Write it to the keychain. Refused before `revealed`. */
  | { type: 'keep' };

/** A record that exists nowhere but here, until somebody reads its words. */
export function beginCreation(record: HotRecord): Creation {
  return { step: 'drawn', record };
}

/**
 * The transition table, and the one refusal in it.
 *
 * `keep` from `drawn` returns the state unchanged. Not an error and not a
 * throw: a caller that asks to save too early has a bug in its sequencing, and
 * the useful behavior is for the wallet to stay unsaved rather than for the
 * app to fall over in the middle of key generation. `mayKeep` is how a screen
 * asks the question in advance, and `test/backup.test.ts` walks every event
 * against every step to hold the shape.
 */
export function creationReduce(state: Creation, event: CreationEvent): Creation {
  switch (event.type) {
    case 'revealed':
      /* Idempotent, because hold-to-reveal fires this on every press and a
       * person reads a thirty-seven word backup in more than one sitting. */
      return state.step === 'drawn' ? { ...state, step: 'shown' } : state;
    case 'keep':
      return state.step === 'shown' ? { ...state, step: 'kept' } : state;
  }
}

/**
 * Whether this record may be written to the keychain yet.
 *
 * Its own function so a test can assert the answer for a `drawn` state is no,
 * whatever `creationReduce` grows into later. The convenience this forbids is
 * "save it now so we do not lose it if the app is killed", which sounds like
 * care and is the exact failure: the thing worth not losing is the paper, and
 * the keychain copy is what makes the paper feel optional.
 */
export function mayKeep(state: Creation): boolean {
  return state.step === 'shown';
}

/** Whether creation is over and the record is stored. */
export function isKept(state: Creation): boolean {
  return state.step === 'kept';
}

/**
 * What the screen's primary control should say, given where creation is.
 *
 * Here rather than in the screen because the refusal is the interesting half
 * and a sentence is what the house style asks a refusal to be. A disabled
 * button with no explanation teaches somebody that the app is broken; a
 * disabled button that says why teaches them what to do next.
 */
export function creationHint(state: Creation): string {
  switch (state.step) {
    case 'drawn':
      return 'Reveal the words and write them down. Nothing is saved on this phone until you have.';
    case 'shown':
      return 'Keep this wallet on this phone. The words you just wrote down are the only other copy.';
    case 'kept':
      return 'Saved. The words on your paper are the only way back if this phone is lost.';
  }
}

// ----------------------------------------------------------------- restoring

/**
 * What a restore is about to do to what is already stored.
 *
 * Read before the restore rather than reported after it, because the case that
 * matters is somebody restoring a Monero phrase onto a phone that already
 * holds a Bitcoin one. `withRestored` keeps the other chain, and this is how a
 * screen says so *before* the tap rather than leaving a person to wonder
 * whether they just wrote over half their wallet.
 */
export function restoreEffect(existing: HotRecord | null, chain: 'xmr' | 'btc'): string {
  if (existing === null) {
    return chain === 'xmr'
      ? 'This phone holds no spending keys. It will hold a Monero wallet.'
      : 'This phone holds no spending keys. It will hold a Bitcoin wallet.';
  }

  const held = chain === 'xmr' ? existing.xmrSeed : existing.btcMnemonic;
  const other = chain === 'xmr' ? existing.btcMnemonic : existing.xmrSeed;
  const thisChain = chain === 'xmr' ? 'Monero' : 'Bitcoin';
  const otherChain = chain === 'xmr' ? 'Bitcoin' : 'Monero';

  if (held !== null) {
    /* The one genuinely destructive case in this flow, and the only place this
     * app overwrites key material. Naming the chain twice is deliberate: a
     * person who misread which phrase they pasted needs the sentence to
     * disagree with what they expected. */
    return other === null
      ? `This replaces the ${thisChain} wallet already on this phone. If you have not written its words down, they are gone.`
      : `This replaces the ${thisChain} wallet already on this phone and leaves the ${otherChain} one alone. If you have not written the old ${thisChain} words down, they are gone.`;
  }

  return other === null
    ? `This phone holds no spending keys. It will hold a ${thisChain} wallet.`
    : `This adds a ${thisChain} wallet. The ${otherChain} wallet already on this phone is left alone.`;
}
