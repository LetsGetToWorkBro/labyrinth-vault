/**
 * A QR code as a grid of booleans, and a note about who computes it.
 *
 * The Reed-Solomon, the mask scoring and the version tables come from the
 * `qrcode` package rather than from this repository. That is a different
 * decision than the vault makes about its dependencies, and the difference is
 * the point of the whole architecture: the vault ships six audited
 * cryptography packages and a test that walks the transitive closure to keep
 * it that way, because the vault holds keys. This application already imports
 * React Native, which is several hundred packages before a line of ours runs.
 * Pretending otherwise by hand-rolling an error-correcting code here would be
 * theatre.
 *
 * What is ours is everything above the grid: the geometry, the quiet zone, the
 * eyes, the way the modules are drawn and animated. A QR code is the most
 * user-facing surface in this product — it is the wire — and it deserves to be
 * designed rather than dropped in as a black box PNG. So the maths comes from
 * a library and the drawing is `QrCanvas.tsx`.
 *
 * ## Error correction level, and why it is not the highest
 *
 * H recovers from 30% damage and costs about 60% more modules than M. More
 * modules at the same physical size means smaller modules, and the failure
 * mode this wire actually has is not damage — nothing is going to scratch a
 * phone screen mid-animation — it is a camera that cannot resolve the modules
 * at all, on an old phone, at arm's length, in a kitchen. Against that, M with
 * fat modules beats H with fine ones every time.
 *
 * The exception is the deliberately small codes: an address, or a pairing
 * code, gets read once by a person who can move closer, and there a higher
 * level costs nothing worth having. Those pass `level: 'Q'`.
 */

import { create, type QRCode } from 'qrcode';

export type Level = 'L' | 'M' | 'Q' | 'H';

export interface Matrix {
  /** Modules per side, not counting the quiet zone. */
  size: number;
  /** Row-major, `size * size` long. True is dark. */
  dark: boolean[];
  version: number;
  /** True for the three finder patterns and their separators, so the renderer
   *  can draw those as one shape rather than as forty-nine little squares. */
  isFinder(x: number, y: number): boolean;
}

/**
 * Build the grid.
 *
 * Throws only on a payload too large for version 40, which the wire's own
 * frame size (400 bytes) makes unreachable — the frames are cut to fit before
 * they ever arrive here. The check stays because "unreachable" is a claim
 * about today's constant.
 */
export function toMatrix(text: string, level: Level = 'M'): Matrix {
  const code: QRCode = create(text, { errorCorrectionLevel: level });
  const size = code.modules.size;
  const data = code.modules.data;
  const dark: boolean[] = new Array(size * size);
  for (let i = 0; i < size * size; i++) dark[i] = data[i] === 1;

  return {
    size,
    dark,
    version: code.version,
    isFinder(x: number, y: number) {
      const inBox = (originX: number, originY: number) =>
        x >= originX && x < originX + 7 && y >= originY && y < originY + 7;
      return inBox(0, 0) || inBox(size - 7, 0) || inBox(0, size - 7);
    },
  };
}

/** Is this module dark? Out of bounds is light, so callers can look around
 *  edges when deciding how to round a corner. */
export function at(matrix: Matrix, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return false;
  return matrix.dark[y * matrix.size + x] ?? false;
}
