/**
 * The camera, as the three states a screen has to draw and one way to feed it.
 *
 * `Scan` is the airgap's inbound half. Every frame from a vault arrives
 * through this module, gets handed to the vault's own collector, and is
 * refused unless the assembled payload matches its digest. That path had no
 * test that ran it, because nothing could deliver a frame.
 *
 * `scan()` here is that delivery: it calls whatever `onBarcodeScanned` the
 * mounted `CameraView` was given. A test can therefore hand the screen a
 * vault's frames one at a time, or hand it frames from two different
 * transmissions and watch it refuse.
 *
 * Two of `BarcodeScanningResult`'s fields, not all of them. The real one also
 * carries `cornerPoints`, `bounds` and an Android-only `raw`, all of which are
 * documented as sometimes absent and none of which anything here reads. Adding
 * them would be inventing plausible geometry, which is worse than not having
 * it: a screen that started reading `bounds` would be tested against numbers
 * this file made up. If one ever does, it fails on `undefined` rather than
 * passing on fiction, which is the direction to be wrong in.
 *
 * Permission is a state machine with three positions, and the first one is
 * null: the hook returns `[null, request]` before it has asked the system.
 * `Scan` draws an empty screen for exactly that frame, and a stand-in that
 * started at "granted" would never render it.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';

export interface Permission {
  granted: boolean;
  canAskAgain: boolean;
  status: 'granted' | 'denied' | 'undetermined';
}

const GRANTED: Permission = { granted: true, canAskAgain: true, status: 'granted' };
const DENIED: Permission = { granted: false, canAskAgain: true, status: 'denied' };

let initial: Permission | null = GRANTED;
let onRequest: Permission = GRANTED;

export function reset(): void {
  initial = GRANTED;
  onRequest = GRANTED;
  readers.length = 0;
}

/**
 * The permission a screen sees before and after it asks.
 *
 * `undefined` for `at` is the un-asked state the hook really starts in.
 */
export function permission(state: { at?: Permission | null; afterAsking?: Permission }): void {
  if ('at' in state) initial = state.at ?? null;
  if (state.afterAsking) onRequest = state.afterAsking;
}

export const allowed = GRANTED;
export const refused = DENIED;

export function useCameraPermissions(): [Permission | null, () => Promise<Permission>] {
  const [held, setHeld] = useState<Permission | null>(initial);
  const request = useCallback(async () => {
    setHeld(onRequest);
    return onRequest;
  }, []);
  return [held, request];
}

type Scanned = (result: { data: string; type: string }) => void;

/** Every *currently mounted* camera's frame handler, in mount order. */
const readers: Scanned[] = [];

/** Hand the mounted camera a QR payload. */
export function scan(data: string): void {
  const reader = readers[readers.length - 1];
  if (reader === undefined) {
    throw new Error('nothing is reading the camera: no CameraView with onBarcodeScanned is mounted');
  }
  reader({ data, type: 'qr' });
}

/** Whether a camera is mounted at all, which is the question a test asks when
 *  it wants to know a screen got past its permission gate. */
export function reading(): boolean {
  return readers.length > 0;
}

export function CameraView({
  onBarcodeScanned,
  ...rest
}: Record<string, unknown> & { onBarcodeScanned?: Scanned }): ReactElement {
  /*
   * Registered in an effect, with the cleanup, so `readers` means what it
   * says.
   *
   * The first version pushed during render and never removed, which made
   * `reading()` answer "has a camera ever been mounted in this process". That
   * is the same answer as the truth right up until a test asks the question
   * after unmounting one, and then it is silently wrong in the direction that
   * passes. `Scan`'s handler is a `useCallback` over the store, so it is also
   * a new function on every store update: push-only meant the list grew for
   * the life of a test.
   *
   * The effect runs before any test can call `scan()`, because `mount` creates
   * inside `act`, which is the same reason it was safe to do during render and
   * is not a reason to keep doing it there.
   */
  useEffect(() => {
    if (!onBarcodeScanned) return undefined;
    readers.push(onBarcodeScanned);
    return () => {
      const at = readers.indexOf(onBarcodeScanned);
      if (at >= 0) readers.splice(at, 1);
    };
  }, [onBarcodeScanned]);

  const Host = 'CameraView' as unknown as (props: Record<string, unknown>) => ReactElement;
  return <Host {...rest} />;
}
