/**
 * Key images on the wallet side: asking for them, keeping them, using them.
 *
 * ## The problem this solves
 *
 * The scan (`moneroscan.ts`) finds every output this account was ever paid and
 * cannot tell which have since been spent, because spends are named on the
 * chain by key images and computing one takes the spend secret, which is in
 * the vault. Until the images arrive, the honest number is *received*.
 *
 * This file is the other half of the round trip. It builds the `XMROUTPUTS`
 * payload listing what the scan found, reads the `XMRKEYIMAGES` reply the
 * vault animates back, and keeps the book that turns received into a balance:
 * an output whose key image has appeared on an input somewhere in the chain is
 * an output that is gone.
 *
 * The formats themselves are imported from the vault (`keys/keyimages.ts`),
 * for the standing reason: a second implementation of a wire format is a
 * slow-motion interoperability failure.
 *
 * ## What a hostile or corrupted reply can and cannot do
 *
 * `offerReply` accepts an image only for a one-time key the scan actually
 * found. An image for an unknown key is counted and dropped. So the worst a
 * bad reply can do is fail to mark something spent, which overstates the
 * balance in exactly the way the received total already did, and is corrected
 * by the next honest import. It cannot invent a spend, and it cannot make an
 * output disappear that the chain says exists.
 *
 * What it deliberately does not do: verify that an image is *correct* for its
 * key. That takes either the spend secret or the ring-signature proof wallet2
 * bundles into its export file, and this reply crossed a wire whose far end is
 * the vault — the device this entire product treats as the root of trust. A
 * wrong image from a genuine vault means a spend goes undetected and the
 * balance reads high; the caveat under the number says the images' provenance
 * for exactly this reason.
 *
 * ## Nothing here is persisted
 *
 * The book lives in memory, like the found outputs it annotates. Key images
 * written to disk would be a list that links every spend this account ever
 * makes to it, sitting in a file, on the networked device. The heights are
 * persisted because they are about the chain; the book is about the person,
 * and it is cheap to import again.
 */

import {
  encodeKeyImageRequest,
  parseKeyImageReply,
  KEYIMAGE_VERSION,
  type OutputRef,
} from '@vault/keys/keyimages';
import type { Atoms } from './model';
import { outputKey, type Received } from './moneroscan';

/**
 * The outputs the scan found, as the payload the vault wants.
 *
 * Deduplicated by one-time key, which is unique per output by construction:
 * the same output found twice by overlapping scans is one line, and the vault
 * does its curve arithmetic once.
 */
export function buildOutputsRequest(
  found: readonly Received[],
): { ok: true; payload: Uint8Array; outputs: number } | { ok: false; problem: string } {
  const byKey = new Map<string, OutputRef>();
  for (const entry of found) {
    byKey.set(entry.key, { tx: entry.txPublicKey, index: entry.index, key: entry.key });
  }
  if (byKey.size === 0) {
    return { ok: false, problem: 'The scan has not found any outputs to ask about yet.' };
  }
  return {
    ok: true,
    outputs: byKey.size,
    payload: encodeKeyImageRequest({ v: KEYIMAGE_VERSION, chain: 'xmr', outputs: [...byKey.values()] }),
  };
}

export interface ImportOutcome {
  ok: boolean;
  problem: string | null;
  /** Images accepted: their key was one the scan found. */
  added: number;
  /** Images dropped: the reply named a key this wallet never saw. */
  unknown: number;
  /** Outputs the vault itself refused to answer for. */
  refusedByVault: number;
}

/**
 * What the wallet knows about its own key images.
 *
 * Three sets, and the distinctions carry the feature:
 *
 *   - **imported**: one-time key to image, from the vault's reply.
 *   - **spent**: images seen spending, either on an input during the scan or
 *     in the node's answer to `is_key_image_spent`.
 *   - **settled**: images whose history has been checked once. An imported
 *     image starts unsettled, because the spend may have happened in a block
 *     the scan walked *before* the image existed here; settling is the one
 *     backward look, and everything after is caught live by the walk.
 */
export class KeyImageBook {
  private readonly imported = new Map<string, string>();
  private readonly spentImages = new Set<string>();
  private readonly settled = new Set<string>();

  /** Accept a vault reply, keeping only images for outputs in `known`. */
  offerReply(payload: Uint8Array, known: ReadonlySet<string>): ImportOutcome {
    const parsed = parseKeyImageReply(payload);
    if (!parsed.ok) return { ok: false, problem: parsed.problem, added: 0, unknown: 0, refusedByVault: 0 };

    let added = 0;
    let unknown = 0;
    for (const entry of parsed.reply.images) {
      if (!known.has(entry.key)) {
        unknown += 1;
        continue;
      }
      if (this.imported.get(entry.key) !== entry.image) {
        this.imported.set(entry.key, entry.image);
        this.settled.delete(entry.image);
        added += 1;
      }
    }
    return {
      ok: true,
      problem: null,
      added,
      unknown,
      refusedByVault: parsed.reply.refused.length,
    };
  }

  /** Every image this wallet should watch the chain for. */
  watch(): ReadonlySet<string> {
    return new Set(this.imported.values());
  }

  /** Images imported but never yet checked against history. */
  unsettled(): string[] {
    return [...this.imported.values()].filter((image) => !this.settled.has(image));
  }

  markSpent(images: readonly string[]): void {
    for (const image of images) this.spentImages.add(image.toLowerCase());
  }

  markSettled(images: readonly string[]): void {
    for (const image of images) this.settled.add(image.toLowerCase());
  }

  /** Is the output with this one-time key known to be spent? */
  isSpent(oneTimeKey: string): boolean {
    const image = this.imported.get(oneTimeKey);
    return image !== undefined && this.spentImages.has(image);
  }

  /** Does this one-time key have an image yet? */
  hasImage(oneTimeKey: string): boolean {
    return this.imported.has(oneTimeKey);
  }

  /** The image for this one-time key, when the vault has answered for it. */
  imageFor(oneTimeKey: string): string | null {
    return this.imported.get(oneTimeKey) ?? null;
  }

  /** How many outputs have an image, of the keys given. */
  coverage(known: ReadonlySet<string>): number {
    let covered = 0;
    for (const key of known) if (this.imported.has(key)) covered += 1;
    return covered;
  }

  size(): number {
    return this.imported.size;
  }
}

export interface Settled {
  /** Received minus everything known spent, over outputs with known amounts. */
  balance: Atoms;
  /** Outputs known spent whose amounts were known and subtracted. */
  spentCount: number;
  spentTotal: Atoms;
  /** Outputs known spent whose amount was never proved, so nothing could be
   *  subtracted. The caveat has to carry these: the balance reads high by
   *  exactly what they were worth. */
  spentUnknown: number;
  /** Outputs with no image yet. The balance treats them as unspent, which is
   *  the received-total assumption on a smaller set. */
  uncovered: number;
}

/**
 * Received, minus what the book says is gone.
 *
 * The same deduplication as `totalReceived`, because the input is the same
 * accumulated scan findings, and adding one output twice is doubling money.
 */
export function settle(found: readonly Received[], book: KeyImageBook): Settled {
  const seen = new Map<string, Received>();
  for (const entry of found) seen.set(outputKey(entry), entry);

  let balance = 0n;
  let spentTotal = 0n;
  let spentCount = 0;
  let spentUnknown = 0;
  let uncovered = 0;

  for (const entry of seen.values()) {
    if (book.isSpent(entry.key)) {
      if (entry.amount === null) spentUnknown += 1;
      else {
        spentTotal += entry.amount;
        spentCount += 1;
      }
      continue;
    }
    if (!book.hasImage(entry.key)) uncovered += 1;
    if (entry.amount !== null) balance += entry.amount;
  }

  return { balance, spentCount, spentTotal, spentUnknown, uncovered };
}
