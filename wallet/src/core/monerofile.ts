/**
 * Handing the vault one of Monero's own wallet files, to be read.
 *
 * ## Why this exists at all
 *
 * The vault can open an `unsigned_monero_tx` and say what is in it. Nothing
 * could give it one. The reader, the wire kind (`XMRFILE`), the bridge
 * function and the screen were all built on the vault side and the payload had
 * no sender, which is the same defect as a screen nothing can navigate to,
 * arrived at from the other end.
 *
 * This is the sender. It takes bytes that came off a disk — Feather and the
 * Monero GUI both write these when they prepare a transaction for a cold
 * signer — and turns them into frames the vault's camera reads.
 *
 * ## What it is not
 *
 * It is not a step towards this wallet signing anything, and it is not a
 * second way to spend Monero. This wallet has its own request format,
 * `XMRUNSIGNED`, which is shaped so the vault can re-derive every destination
 * from its own keys before a person is asked to approve; that is the path that
 * ends in a signature. A wallet2 file cannot be checked that way, so the round
 * trip here ends at reading, and both screens say so.
 *
 * The check that keeps those apart is not in this file: the vault refuses to
 * sign any wallet2 container, whatever arrives and whatever this says about
 * it. What this file adds is that somebody is told *before* walking across the
 * room, rather than after.
 *
 * ## One implementation of the container format
 *
 * `readContainer` comes from the vault's own `src/keys/monerotx.ts`, through
 * the `@vault/*` path both halves share. That matters more here than it looks:
 * the wallet's judgement about which files are worth showing has to be the
 * same judgement the vault makes when it sees one, or this screen sends people
 * on trips that end in a refusal.
 */

import { digestOf } from '@vault/airgap/envelope';
import { readContainer } from '@vault/keys/monerotx';
import { Transmission, FRAME_BYTES, FRAME_MS } from './wire';

/**
 * The largest file this will animate.
 *
 * The wire's own cap is `MAX_PARTS` (2048) at 400 bytes a frame, which is over
 * 800 KB and roughly a quarter of an hour of animation. That is a limit
 * against a hostile header rather than a useful one for a person: nobody holds
 * a phone at another phone for fifteen minutes. 64 KB is about 160 frames and
 * 35 seconds a pass, which is already at the edge of what somebody will do,
 * and a `tx_construction_data` for an ordinary payment is a few kilobytes.
 *
 * A file past this is refused with its size rather than truncated, because a
 * truncated payload assembles into nothing at the far end and the failure
 * would surface as "the codes did not add up".
 */
export const MAX_FILE_BYTES = 64 * 1024;

export interface MoneroFileOffer {
  ok: boolean;
  /** Plain words for the file, from the container's magic. */
  what?: string;
  /** How many frames it will take, so the screen can say how long a pass is. */
  frames?: number;
  /** Roughly how long one full pass takes, in seconds, rounded up. */
  seconds?: number;
  /** Why this file is not worth showing the vault. */
  problem?: string;
}

/**
 * Look at the bytes and decide whether the vault would get anything from them.
 *
 * Pure, and separated from the screen for the usual reason: every refusal here
 * is a sentence somebody reads instead of walking across a room, and sentences
 * that decide things belong where a test can read them too.
 */
export function offerMoneroFile(bytes: Uint8Array): MoneroFileOffer {
  if (bytes.length === 0) return { ok: false, problem: 'That file is empty.' };

  const container = readContainer(bytes);
  if (!container) {
    return {
      ok: false,
      problem:
        "That is not one of Monero's wallet files. The vault reads an unsigned transaction set, " +
        'which Feather and the Monero GUI write as `unsigned_monero_tx` when they prepare a ' +
        'payment for an offline signer.',
    };
  }

  if (!container.readable) {
    /* Refused here rather than at the vault, which would also refuse it. The
     * vault's answer is a screen naming the file and stopping; getting that
     * answer costs a walk to a drawer and a minute of holding two phones. The
     * flag comes from the vault's own module, so the two cannot disagree
     * about which files are worth the trip. */
    return {
      ok: false,
      what: container.what,
      problem:
        `That is ${container.what}. The vault has no reader for it, so showing it would only ` +
        'get the file named back at you. It reads an unsigned transaction set.',
    };
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      what: container.what,
      problem:
        `That file is ${Math.round(bytes.length / 1024)} KB, and this animates up to ` +
        `${MAX_FILE_BYTES / 1024} KB. Past that the codes take longer to play than anyone will ` +
        'hold a phone still for.',
    };
  }

  const frames = Math.max(1, Math.ceil(bytes.length / FRAME_BYTES));
  return {
    ok: true,
    what: container.what,
    frames,
    seconds: Math.ceil((frames * FRAME_MS) / 1000),
  };
}

/**
 * The frames themselves, once the offer says the file is worth showing.
 *
 * Split from `offerMoneroFile` so a screen can decide what to say before it
 * decides what to draw, and so the refusal path never builds an encoder it
 * will not use. Returns null on exactly the files the offer refuses, so a
 * caller that skips the offer still cannot animate one.
 */
export function moneroFileTransmission(bytes: Uint8Array): Transmission | null {
  if (!offerMoneroFile(bytes).ok) return null;
  return new Transmission(bytes, 'XMRFILE', 'labyrinth', digestOf(bytes));
}
