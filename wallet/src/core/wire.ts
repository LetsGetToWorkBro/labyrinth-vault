/**
 * Talking to the vault, which means drawing on a screen and hoping.
 *
 * There is no channel here. The wallet cannot address the vault, cannot ask it
 * to repeat anything, and cannot tell whether it is even in the room. It can
 * put a QR code on the glass, and a person can point a camera at it. That is
 * the whole protocol, and every design decision in this file follows from it.
 *
 * The encoder is the vault's (`src/airgap/envelope.ts`), imported rather than
 * reimplemented, for the reason set out in `core/addresses.ts`: a second
 * implementation of a wire format is a slow-motion interoperability failure.
 * Same frames, same digest, same refusals, one file.
 *
 * ## Two wires, and why the wallet picks
 *
 * The vault speaks its own frame format (`LV1:PSBT:…`, which names the payload
 * kind so a device can refuse what it does not understand) and it speaks
 * BC-UR (`ur:crypto-psbt/…`, which Sparrow, Electrum, Keystone and Cupcake all
 * animate). The scanner on the far end reads both off one camera loop without
 * being told which.
 *
 * So the wallet chooses by destination, not by preference: Labyrinth frames to
 * a Labyrinth vault, because they carry the payload kind; BC-UR to anything
 * else, because it is the only thing anything else reads. A user who signs
 * with Sparrow on a laptop is not doing something exotic and should not have
 * to find a setting.
 *
 * ## Pacing
 *
 * The animation is not a progress bar. Every frame is offered over and over,
 * in a loop, because the receiver may have started filming halfway through and
 * has no way to say so. The loop is what makes the scan finish; the frame
 * counter is there to tell a person that something is happening, and that is
 * all it is for.
 *
 * The cadence is deliberately slower than it could be. A phone camera at 30fps
 * can in principle read a code shown for 60ms; in a kitchen at night, held by
 * a person who is also holding another phone, it cannot. 220ms is roughly four
 * and a half frames a second, which reads reliably on hardware old enough to
 * be a vault. The whole premise of the product is a phone somebody stopped
 * using, so the wire is tuned for the worst camera, not the best.
 */

import { encodeParts, type PayloadKind } from '@vault/airgap/envelope';
import { encodeUr, UR_PSBT, type UrEncoder } from '@vault/airgap/ur';
import type { Draft } from './model';

/** Which of the two wires a transmission uses. */
export type WireFormat = 'labyrinth' | 'ur';

/** How long one frame stays on the glass, in milliseconds. See above. */
export const FRAME_MS = 220;

/** Bytes per frame. The vault's default, restated here only so that the
 *  estimate this file makes for the UI cannot drift away from the encoder. */
export const FRAME_BYTES = 400;

function kindFor(draft: Draft): PayloadKind {
  return draft.asset === 'BTC' ? 'PSBT' : 'XMRUNSIGNED';
}

/**
 * A payload, already cut into frames, with a cursor.
 *
 * Written as a class holding an index rather than as a generator, because the
 * view layer re-renders on a timer and needs to ask "what should be on screen
 * right now" from the outside, repeatedly, without owning the sequence.
 */
export class Transmission {
  readonly format: WireFormat;
  readonly kind: PayloadKind;
  readonly total: number;
  readonly digest: string;
  private readonly frames: string[];
  private readonly ur: UrEncoder | null;
  private cursor = 0;
  private laps = 0;
  /* The frame on the glass right now. Held, because for BC-UR "the next
   * frame" and "the current frame" are different questions and the encoder
   * only answers the first: every call to `nextPart()` mixes a new fountain
   * frame. Asking it twice in one tick, which a re-render does, would skip
   * one. So the answer is computed once per advance and remembered. */
  private frame: string;

  constructor(payload: Uint8Array, kind: PayloadKind, format: WireFormat, digest: string) {
    this.format = format;
    this.kind = kind;
    this.digest = digest;
    if (format === 'labyrinth') {
      this.frames = encodeParts(kind, payload, FRAME_BYTES);
      this.ur = null;
      this.total = this.frames.length;
    } else {
      /* BC-UR after the first pass is a fountain: every frame is a mixture of
       * fragments, so there is no fixed list to cycle and no "frame 3" to go
       * back to. The encoder is asked for the next one each time, forever, and
       * `total` is the count of the first, plain pass — which is what a person
       * watching wants to know ("about forty of these") and not a length. */
      this.frames = [];
      this.ur = encodeUr(UR_PSBT, payload, 200);
      this.total = this.ur.seqLength;
    }
    this.frame = this.ur ? this.ur.nextPart() : (this.frames[0] ?? '');
  }

  /** What is on the glass right now. Idempotent: ask as often as a render
   *  needs to, and the answer does not change until `advance`. */
  current(): string {
    return this.frame;
  }

  /** Move on. Returns the frame that is now current. */
  advance(): string {
    this.cursor += 1;
    if (this.frames.length > 0 && this.cursor % this.frames.length === 0) this.laps += 1;
    this.frame = this.ur ? this.ur.nextPart() : (this.frames[this.cursor % this.frames.length] ?? '');
    return this.frame;
  }

  /** For the counter under the code. One-based, because it is read by people. */
  status(): { frame: number; total: number; laps: number } {
    return {
      frame: this.frames.length > 0 ? (this.cursor % this.frames.length) + 1 : this.cursor + 1,
      total: this.total,
      laps: this.laps,
    };
  }

  /** Roughly how long one full pass takes, for the "about 9 seconds" line. */
  passSeconds(): number {
    return Math.max(1, Math.round((this.total * FRAME_MS) / 1000));
  }
}

/**
 * Cut a draft into frames for a particular kind of signer.
 *
 * `to` is the honest name for the parameter: this is a choice about who is
 * going to be holding the camera, not about which encoding is nicer.
 */
export function transmit(draft: Draft, to: 'vault' | 'other-wallet' = 'vault'): Transmission {
  const format: WireFormat = to === 'vault' ? 'labyrinth' : 'ur';
  if (to === 'other-wallet' && draft.asset !== 'BTC') {
    /* BC-UR's Monero story is Cupcake's, and the type name it uses for a
     * wallet2 payload is not something this repository has verified against a
     * real device. Sending one under `crypto-psbt` would be a lie about what
     * the bytes are. Labyrinth frames name their kind, so they can carry it
     * honestly; anything else has to wait until there is something to check
     * against. */
    return new Transmission(draft.unsigned, kindFor(draft), 'labyrinth', draft.digest);
  }
  return new Transmission(draft.unsigned, kindFor(draft), format, draft.digest);
}

/**
 * How many frames a payload will take, before building anything.
 *
 * Used on the review screen, which says "about 40 codes, nine seconds" before
 * a person commits to standing there holding two phones. Knowing that up front
 * is the difference between a protocol and a surprise.
 */
export function frameEstimate(bytes: number): { frames: number; seconds: number } {
  const frames = Math.max(1, Math.ceil(bytes / FRAME_BYTES));
  return { frames, seconds: Math.max(1, Math.round((frames * FRAME_MS) / 1000)) };
}
