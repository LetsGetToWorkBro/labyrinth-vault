/**
 * Playing a transmission, as a hook.
 *
 * Three screens animate frames at a vault now — the send flow's transmit step,
 * the key image round trip, and the Monero file reader — and the first two had
 * the same eight lines copied. Extracting them is not tidying: the copies had
 * drifted into a shape with a bug in it, and the bug was invisible precisely
 * because it looked like the other copy.
 *
 * ## The bug the copies share
 *
 * They seed their state with `useState(() => transmission?.current() ?? '')`.
 * A `useState` initializer runs once, on the first render, and never again —
 * so a screen whose transmission arrives *later*, or changes, keeps rendering
 * the old first frame until the interval next fires. On the two existing
 * screens the transmission is present from the first render and the defect
 * never surfaced. On a screen where a person picks a file, it is present from
 * the first render exactly never: the QR would be blank for 220ms and then
 * start, or, worse, show the previous file's frame after a second pick.
 *
 * So the frame is seeded in the effect, which runs whenever the transmission
 * changes, and the interval only advances from there.
 *
 * ## Why the timer is an interval and not an animation frame
 *
 * The cadence is deliberately slow — see `core/wire.ts` — because the receiver
 * is a phone camera in a kitchen. A requestAnimationFrame loop would redraw
 * sixty times a second to change the picture four and a half times, and every
 * one of those redraws is a QR code being rasterized.
 */

import { useEffect, useState } from 'react';
import { FRAME_MS, type Transmission } from '../core/wire';

export interface FrameStatus {
  frame: number;
  total: number;
  laps: number;
}

const IDLE: FrameStatus = { frame: 1, total: 1, laps: 0 };

export function useFrames(
  transmission: Transmission | null,
  intervalMs: number = FRAME_MS,
): { frame: string; status: FrameStatus } {
  const [frame, setFrame] = useState('');
  const [status, setStatus] = useState<FrameStatus>(IDLE);

  useEffect(() => {
    if (!transmission) {
      /* Cleared rather than left standing. A stale code on a screen that no
       * longer has a payload is a code somebody could still scan. */
      setFrame('');
      setStatus(IDLE);
      return;
    }
    setFrame(transmission.current());
    setStatus(transmission.status());
    const timer = setInterval(() => {
      setFrame(transmission.advance());
      setStatus(transmission.status());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [transmission, intervalMs]);

  return { frame, status };
}
