/**
 * The app icons, drawn from the app's own geometry.
 *
 * ## Why this is a script and not two PNGs somebody exported
 *
 * The labyrinth is not decoration in this product. `wallet/src/design/geometry.ts`
 * generates it, `test/geometry.test.ts` asserts its properties, and the send
 * flow draws a payment's progress along it. An icon exported by hand from a
 * drawing tool is a *second* labyrinth, and it starts being subtly the wrong
 * one the first time the geometry is tuned.
 *
 * So the icon calls `spiral()`. The same function, through the same bundler
 * the tests use. If the mark changes, the icon changes, and `npm test` fails
 * until the committed PNGs are regenerated. That is the same arrangement as
 * the engine bundle and its digest, for the same reason.
 *
 * ## Why it rasterizes by hand
 *
 * There is no image library here and adding one to draw eight rectangles would
 * be a poor trade. The geometry is axis-aligned by construction, which the
 * geometry file goes out of its way to guarantee, so every stroke is a
 * rectangle and rasterizing one is a loop. Anti-aliasing comes from
 * supersampling: draw at four times the target and box-filter down, which for
 * axis-aligned edges is exact rather than approximate.
 *
 * PNG encoding is zlib plus four chunks, and zlib is in Node.
 *
 * ## Two icons, deliberately different
 *
 * The vault and the wallet are two apps that will sit next to each other on a
 * home screen and must never be confused: one holds keys and one does not.
 * They share the mark and invert the palette. The vault is bone on void, the
 * offline half, dark. The wallet is void on bone, the everyday half, light.
 * Same geometry, opposite weights, unmistakable at 60 points.
 *
 *   node scripts/make-icons.mjs
 */

import { build } from 'esbuild';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// The geometry, from the app rather than from a copy of it.

const compiled = await build({
  entryPoints: ['wallet/src/design/geometry.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { markSpiral } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

// ---------------------------------------------------------------------------
// A canvas, which is a flat RGB byte array and two drawing routines.

const SS = 4; // supersample factor

function canvas(size, background) {
  const pixels = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3] = background[0];
    pixels[i * 3 + 1] = background[1];
    pixels[i * 3 + 2] = background[2];
  }
  return { size, pixels };
}

function fillRect(target, x0, y0, x1, y1, color) {
  const left = Math.max(0, Math.round(Math.min(x0, x1)));
  const right = Math.min(target.size, Math.round(Math.max(x0, x1)));
  const top = Math.max(0, Math.round(Math.min(y0, y1)));
  const bottom = Math.min(target.size, Math.round(Math.max(y0, y1)));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const at = (y * target.size + x) * 3;
      target.pixels[at] = color[0];
      target.pixels[at + 1] = color[1];
      target.pixels[at + 2] = color[2];
    }
  }
}

/** One stroke of the path, as a rectangle, because every segment is axis-aligned. */
function stroke(target, a, b, width, color) {
  const half = width / 2;
  if (Math.abs(a[1] - b[1]) < 1e-6) {
    fillRect(target, Math.min(a[0], b[0]) - half, a[1] - half, Math.max(a[0], b[0]) + half, a[1] + half, color);
  } else if (Math.abs(a[0] - b[0]) < 1e-6) {
    fillRect(target, a[0] - half, Math.min(a[1], b[1]) - half, a[0] + half, Math.max(a[1], b[1]) + half, color);
  } else {
    /* Unreachable while `spiral()` keeps its promise, and worth failing on
     * rather than drawing wrong: a diagonal here means the geometry changed
     * shape and the icon would silently stop matching the app. */
    throw new Error(`the path is not axis-aligned: ${a} to ${b}`);
  }
}

/** Box-filter down by SS. Exact for axis-aligned edges. */
function downsample(big, factor) {
  const size = big.size / factor;
  const out = canvas(size, [0, 0, 0]);
  const area = factor * factor;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const at = ((y * factor + dy) * big.size + x * factor + dx) * 3;
          r += big.pixels[at];
          g += big.pixels[at + 1];
          b += big.pixels[at + 2];
        }
      }
      const at = (y * size + x) * 3;
      out.pixels[at] = Math.round(r / area);
      out.pixels[at + 1] = Math.round(g / area);
      out.pixels[at + 2] = Math.round(b / area);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG. Signature, IHDR, IDAT, IEND.

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(target) {
  const { size, pixels } = target;
  /* One filter byte per scanline, filter type 0. The images are flat color
   * over a hard-edged line, so deflate does the work and a smarter filter
   * would buy nothing. */
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The two marks.

const VOID = [0x05, 0x05, 0x06];
const BONE = [0xf3, 0xf0, 0xe9];

/**
 * Draw the labyrinth centered in a square.
 *
 * `inset` is the margin as a fraction of the icon. iOS rounds the corners and
 * the home screen crowds them, so the mark sits well inside its own tile: this
 * is the same instinct as the geometry file's note about surviving at 14
 * points, applied at the other end of the scale.
 *
 * The density is not a parameter. It used to be, defaulted to a number that
 * was not the one `markPath` uses, so the icon on the home screen and the mark
 * in the navigation bar were the same drawing at two slightly different
 * densities. Nobody would name the difference and everybody would feel it.
 * `markSpiral` is now the only way to get this shape.
 */
function mark({ size, background, ink, inset = 0.17, weight = 0.026 }) {
  const target = canvas(size, background);
  const box = size * (1 - inset * 2);
  const points = markSpiral(box);
  const offset = size * inset;
  const width = size * weight;
  for (let i = 1; i < points.length; i++) {
    const a = [points[i - 1][0] + offset, points[i - 1][1] + offset];
    const b = [points[i][0] + offset, points[i][1] + offset];
    stroke(target, a, b, width, ink);
  }
  return target;
}

function render(spec, target) {
  const big = mark({ ...spec, size: spec.size * SS, weight: spec.weight });
  return downsample(big, SS);
}

function emit(path, image) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png(image));
  return `${path}  ${image.size}x${image.size}`;
}

/* 1024 is all Xcode and Expo need: both generate the rest from a single
 * source, and shipping fifteen hand-sized PNGs is fifteen things that can
 * disagree with each other. */
const ICON = 1024;

const vault = render({ size: ICON, background: VOID, ink: BONE }, 'vault');
const wallet = render({ size: ICON, background: BONE, ink: VOID }, 'wallet');

/* The splash mark is the same geometry on the same ground, drawn lighter and
 * smaller: a launch screen is a held breath, not a second logo. */
const walletSplash = render(
  { size: ICON, background: BONE, ink: VOID, inset: 0.32, weight: 0.017 },
  'splash',
);

const written = [
  emit('ios/LabyrinthVault/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png', vault),
  emit('wallet/assets/icon.png', wallet),
  emit('wallet/assets/splash-icon.png', walletSplash),
];

/* The asset catalog entry Xcode needs beside the image. Written here rather
 * than committed by hand so the two cannot disagree about the filename. */
writeFileSync(
  'ios/LabyrinthVault/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json',
  JSON.stringify(
    {
      images: [{ filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
      info: { author: 'scripts/make-icons.mjs', version: 1 },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  'ios/LabyrinthVault/Resources/Assets.xcassets/Contents.json',
  JSON.stringify({ info: { author: 'scripts/make-icons.mjs', version: 1 } }, null, 2) + '\n',
);

for (const line of written) console.log(line);
