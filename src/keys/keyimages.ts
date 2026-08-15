/**
 * Key images: the one computation a watching wallet cannot do, done here.
 *
 * ## Why this file exists
 *
 * The companion wallet scans the chain with the view key and finds every
 * output this account was ever paid. What it cannot do is tell which of those
 * outputs have since been spent, because a Monero spend is identified on the
 * chain by a *key image*, and computing the key image of an output takes the
 * spend secret. That key lives here, on the device with no network, and it is
 * not going anywhere.
 *
 * So the computation comes to the key instead of the key going to the
 * computation. The wallet sends the outputs it found across the airgap, this
 * file computes one key image per output, and the wallet takes the images back
 * and watches the chain for them. Every Monero wallet pair in existence does
 * this dance; monero-wallet-cli calls it `export_key_images` and the vault
 * already recognizes that file's magic in `monerotx.ts`.
 *
 * ## What a key image reveals, stated before any code
 *
 * A key image is designed to be unlinkable: the network sees `x·H(P)` and can
 * tell two spends of the same output apart from two spends of different
 * outputs, while learning nothing about which output either was. Handing the
 * *set* of your key images to your own wallet costs you nothing against the
 * network. It does mean the wallet, and anything that compromises the wallet,
 * can recognize your spends on sight, which is exactly the power the wallet
 * needs to show a balance and exactly why the view key was already the price
 * of being the online half. Nothing new is conceded here that the ACCOUNT
 * export did not already concede.
 *
 * What is genuinely irreversible: a key image, once computed, links to its
 * output for anyone who has both and knows they go together. That is why the
 * reply lists images beside the one-time keys they belong to and travels only
 * over the same one-way optical wire as everything else.
 *
 * ## The check before the arithmetic
 *
 * Every requested output is re-derived before anything is computed: the vault
 * runs the same ownership test the wallet ran, from its own keys, and refuses
 * any output that does not derive to the claimed one-time key. Without that
 * check, a compromised wallet could ask for the key image of an arbitrary
 * point, and while no attack via that is known against these parameters, the
 * request would be answered blind. This device does not do arithmetic on
 * numbers somebody else chose without proving what they are first.
 */

import { exportKeyImageBlob, type ExportOutput } from './moneroexport';
import {
  deriveSecretKey,
  derivePublicKey,
  generateKeyDerivation,
  generateKeyImage,
} from './monerocrypto';
import { fromHex, toHex, type Wallet as MoneroWallet } from './monero';
import { wipe } from './wipe';

/** Bumped only if the shape changes in a way an old reader would misread. */
export const KEYIMAGE_VERSION = 1;

/** One output the wallet found and wants the key image for. */
export interface OutputRef {
  /** The transaction public key, from the transaction's `extra`. Hex. */
  tx: string;
  /** The output's position in its transaction, part of the derivation. */
  index: number;
  /** The one-time public key on the output. The claim to be verified. */
  key: string;
}

export interface KeyImageRequest {
  v: number;
  chain: 'xmr';
  outputs: OutputRef[];
  /**
   * Where these outputs start in the *requesting* wallet's own transfer list.
   *
   * Meaningless to this project's own wire, where the reply is matched to the
   * request by one-time key, and load-bearing for the wallet2 export file,
   * where it is not. `import_key_images` walks `m_transfers[i + offset]` and
   * pairs each entry by position, so a file whose order does not match the
   * importing wallet's is a file that pairs images with the wrong outputs.
   *
   * It fails loudly rather than quietly: each record carries a ring signature
   * over its own one-time key, so a mispaired entry fails
   * `check_ring_signature` and the import throws. That is the property that
   * makes shipping this defensible at all — the failure is "signature check
   * failed", not a wrong balance.
   *
   * Absent means zero, which is what `export_key_images(all=true)` means.
   */
  offset?: number;
}

/** One answer: the output's one-time key and the image that spends it. */
export interface KeyImageEntry {
  key: string;
  image: string;
}

export interface KeyImageReply {
  v: number;
  chain: 'xmr';
  images: KeyImageEntry[];
  /** Outputs that did not verify as this wallet's, echoed so the far side can
   *  say so rather than silently having fewer images than outputs. */
  refused: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The most outputs one request may carry.
 *
 * The wire itself caps a payload at ~800 KB, which would be tens of thousands
 * of outputs; this cap is much lower because every entry below costs this
 * device four curve operations, and a hostile payload should not be able to
 * buy minutes of computation on a battery with one scan. A real wallet's
 * output count is in the hundreds; anyone with more batches.
 */
export const MAX_OUTPUTS = 2000;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * An array entry as something safe to read fields off.
 *
 * `JSON.parse` happily produces `[null]`, and `null['tx']` is a TypeError
 * rather than the sentence this parser promises. Anything that is not an
 * object becomes an empty one, so its fields read as `undefined` and fall
 * through the ordinary checks below into an ordinary refusal. The alternative
 * is an exception thrown out of a function whose whole contract is to refuse
 * in words — and on the wallet side of this file there is no outer net to
 * turn that back into one.
 */
function fields(entry: unknown): Record<string, unknown> {
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
}

/**
 * Read a request, or say what is wrong with it.
 *
 * Strict for the usual reason: everything arriving over the wire is untrusted,
 * and a malformed entry refused here is a sentence on a screen, while one
 * refused deeper down is an exception inside arithmetic.
 */
export function parseKeyImageRequest(
  bytes: Uint8Array,
): { ok: true; request: KeyImageRequest } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, problem: 'That is not a key image request.' };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, problem: 'That is not a key image request.' };
  }
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return { ok: false, problem: 'That request is not about Monero.' };
  if (typeof raw['v'] !== 'number' || raw['v'] < 1 || raw['v'] > KEYIMAGE_VERSION) {
    return { ok: false, problem: 'That request is from a different version of the wallet.' };
  }
  if (!Array.isArray(raw['outputs']) || raw['outputs'].length === 0) {
    return { ok: false, problem: 'That request lists no outputs.' };
  }
  if (raw['outputs'].length > MAX_OUTPUTS) {
    return { ok: false, problem: `One request carries at most ${MAX_OUTPUTS} outputs.` };
  }

  const outputs: OutputRef[] = [];
  for (const entry of raw['outputs']) {
    const output = fields(entry);
    const tx = typeof output['tx'] === 'string' ? output['tx'].toLowerCase() : '';
    const key = typeof output['key'] === 'string' ? output['key'].toLowerCase() : '';
    const index = output['index'];
    if (!HEX64.test(tx) || !HEX64.test(key)) {
      return { ok: false, problem: 'An output in that request does not carry two 32-byte keys.' };
    }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10_000) {
      return { ok: false, problem: 'An output in that request has an index that is not one.' };
    }
    outputs.push({ tx, index, key });
  }
  /* Optional, because this project's own wire has never needed one and every
   * request written before this field existed is still valid. A present value
   * has to be a real index; a junk one is refused rather than floored to zero,
   * because zero is a *claim* about where these sit in somebody's wallet. */
  const rawOffset = raw['offset'];
  if (rawOffset !== undefined
      && (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0
          || rawOffset > 1_000_000)) {
    return { ok: false, problem: 'That request has a transfer offset that is not one.' };
  }
  /* Carried only when it was sent, rather than materialised as a zero. A
   * request that said nothing about where these sit in somebody's wallet and
   * one that said "at the beginning" are different statements, and the round
   * trip has to preserve which was made. `keyImageFileFor` reads an absent
   * offset as zero at the point of use, which is what
   * `export_key_images(all=true)` means. */
  return {
    ok: true,
    request: {
      v: raw['v'],
      chain: 'xmr',
      outputs,
      ...(rawOffset === undefined ? {} : { offset: rawOffset as number }),
    },
  };
}

/**
 * Compute the key images, proving ownership of each output first.
 *
 * The chain of operations per output, all from `monerocrypto.ts` and all
 * pinned to the Monero project's own vectors:
 *
 *   1. `generate_key_derivation` of the tx public key and our view secret,
 *      the same shared secret the sender computed;
 *   2. `derive_public_key` with the output index and our spend public: this
 *      must equal the one-time key the request claims, or the output is not
 *      ours and the entry is refused;
 *   3. `derive_secret_key` with the spend secret: the private key of that
 *      one-time address, which exists for the duration of this loop and is
 *      wiped before the function returns;
 *   4. `generate_key_image` of the pair.
 *
 * An entry that fails is refused individually rather than failing the batch:
 * one stray output in a request of three hundred should cost one line in the
 * reply, not the whole trip across the airgap.
 */
export function computeKeyImages(wallet: MoneroWallet, request: KeyImageRequest): KeyImageReply {
  const images: KeyImageEntry[] = [];
  const refused: string[] = [];

  for (const output of request.outputs) {
    let oneTimeSecret: Uint8Array | null = null;
    try {
      const derivation = generateKeyDerivation(fromHex(output.tx), wallet.viewSecret);
      const derived = toHex(
        derivePublicKey(derivation, output.index, fromHex(wallet.spendPublic)),
      );
      if (derived !== output.key) {
        /* The claimed one-time key does not derive from this wallet's keys at
         * that position. Either the wallet scanned with different keys than
         * this vault holds, or the request was tampered with. Both deserve a
         * refusal, not arithmetic. */
        refused.push(output.key);
        continue;
      }
      oneTimeSecret = deriveSecretKey(derivation, output.index, wallet.spendSecret);
      images.push({
        key: output.key,
        image: toHex(generateKeyImage(fromHex(output.key), oneTimeSecret)),
      });
    } catch {
      refused.push(output.key);
    } finally {
      if (oneTimeSecret) wipe(oneTimeSecret);
    }
  }

  return { v: KEYIMAGE_VERSION, chain: 'xmr', images, refused };
}

/** The bytes to put on the wire, as an XMRKEYIMAGES payload. */
export function encodeKeyImageReply(reply: KeyImageReply): Uint8Array {
  return encoder.encode(JSON.stringify(reply));
}

/** The bytes to put on the wire, as an XMROUTPUTS payload. The wallet calls
 *  this; it lives here so both directions of the format are one file. */
export function encodeKeyImageRequest(request: KeyImageRequest): Uint8Array {
  return encoder.encode(JSON.stringify(request));
}

/**
 * Read a reply, on the wallet side.
 *
 * The important check is the last one: every image must be beside a one-time
 * key, both 32 bytes of hex, and the caller then matches keys against outputs
 * it actually found. An image for a key the wallet never saw is dropped by the
 * caller, so a corrupted or hostile reply can at worst fail to mark a spend,
 * never invent one.
 */
export function parseKeyImageReply(
  bytes: Uint8Array,
): { ok: true; reply: KeyImageReply } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, problem: 'That is not a key image reply.' };
  }
  if (!value || typeof value !== 'object') return { ok: false, problem: 'That is not a key image reply.' };
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return { ok: false, problem: 'That reply is not about Monero.' };
  if (typeof raw['v'] !== 'number' || raw['v'] < 1 || raw['v'] > KEYIMAGE_VERSION) {
    return { ok: false, problem: 'That reply is from a different version of the vault.' };
  }
  if (!Array.isArray(raw['images'])) return { ok: false, problem: 'That reply lists no images.' };

  const images: KeyImageEntry[] = [];
  for (const entry of raw['images']) {
    const image = fields(entry);
    const key = typeof image['key'] === 'string' ? image['key'].toLowerCase() : '';
    const value = typeof image['image'] === 'string' ? image['image'].toLowerCase() : '';
    if (!HEX64.test(key) || !HEX64.test(value)) {
      return { ok: false, problem: 'An entry in that reply is not a key and an image.' };
    }
    images.push({ key, image: value });
  }
  const refused = Array.isArray(raw['refused'])
    ? raw['refused'].filter((entry): entry is string => typeof entry === 'string' && HEX64.test(entry))
    : [];
  return { ok: true, reply: { v: raw['v'], chain: 'xmr', images, refused } };
}

// ---------------------------------------------------------------------------
// The same answer, as the file every other Monero wallet imports

/**
 * How many bytes of platform randomness `keyImageFileFor` needs for `n`
 * outputs.
 *
 * One 32-byte scalar per ring signature, then eight bytes of IV, then one more
 * scalar for the signature over the whole envelope. Stated by the side that
 * owns the formula, the same arrangement `signingRandomCount` has, so the
 * Swift that draws the bytes never re-derives the count and cannot drift from
 * it.
 */
export function keyImageFileRandomBytes(outputs: number): number {
  return (outputs + 1) * 32 + 8;
}

export interface KeyImageFileResult {
  ok: boolean;
  /** `Monero key image export`, exactly as `wallet2::export_key_images` writes it. */
  file?: Uint8Array;
  /** How many outputs are in it. */
  answered?: number;
  /** One-time keys that did not prove as this wallet's, and got no record. */
  refused?: string[];
  problem?: string;
}

/**
 * Build the file Cake, Feather and `monero-wallet-cli` import.
 *
 * ## Why this is a separate function from `computeKeyImages`
 *
 * They answer the same question for two different readers, and the difference
 * is not cosmetic. `computeKeyImages` produces a list of `(one-time key, key
 * image)` pairs on this project's own wire, where the far side matches each
 * image to its output *by key*, so order carries no meaning and the ephemeral
 * secret can be wiped the moment the image exists.
 *
 * `import_key_images` matches **by position**: it walks `m_transfers[i +
 * offset]` and pairs the i-th record with it. So the file needs the outputs in
 * the importing wallet's own order, it needs `offset` to say where they start,
 * and each record carries a ring signature over that output's one-time key —
 * which means the ephemeral secret has to live a little longer, until the
 * signature is made.
 *
 * Ordering is the requester's responsibility and it fails loudly when it is
 * wrong: a mispaired record fails `check_ring_signature` on the far side and
 * the import throws "signature check failed". A wrong balance is not among the
 * outcomes, which is the property that makes offering this defensible.
 *
 * ## What leaves this function
 *
 * Bytes. Every ephemeral secret is derived, used, and wiped inside it, on
 * every path including the throwing one. There is deliberately no version that
 * returns the secrets for a caller to assemble, because that would be a
 * function whose return value is spend authority for an output, one `print`
 * away from a log.
 *
 * ## Refusals
 *
 * Ownership is re-proved per output exactly as `computeKeyImages` does it, and
 * an output that does not derive is refused rather than answered. Unlike the
 * own-wire reply, a refusal here also means the file is **shorter than the
 * request**, which shifts every later record's position — so a request with
 * any refusal in it cannot produce a positionally-correct file at all. It is
 * refused whole rather than shipped short. Losing one output would move all
 * the ones after it, and the far side would pair them with the wrong
 * transfers; that is exactly the failure the signatures catch, and there is no
 * reason to build a file that is known in advance to fail.
 */
export function keyImageFileFor(
  wallet: MoneroWallet,
  request: KeyImageRequest,
  random: Uint8Array,
): KeyImageFileResult {
  const need = keyImageFileRandomBytes(request.outputs.length);
  if (random.length !== need) {
    return { ok: false, problem: `Exporting ${request.outputs.length} key images needs exactly ${need} bytes of randomness.` };
  }

  const outputs: ExportOutput[] = [];
  const refused: string[] = [];
  try {
    for (const output of request.outputs) {
      let oneTimeSecret: Uint8Array | null = null;
      try {
        const derivation = generateKeyDerivation(fromHex(output.tx), wallet.viewSecret);
        const derived = toHex(derivePublicKey(derivation, output.index, fromHex(wallet.spendPublic)));
        if (derived !== output.key) {
          refused.push(output.key);
          continue;
        }
        oneTimeSecret = deriveSecretKey(derivation, output.index, wallet.spendSecret);
        outputs.push({
          oneTimeKey: fromHex(output.key),
          oneTimeSecret,
          /* Passed in rather than recomputed inside the writer, which is how
           * `ExportRequest` is shaped: one place derives, one place
           * serializes. It is the same value `computeKeyImages` puts on this
           * project's own wire, from the same two inputs. */
          keyImage: generateKeyImage(fromHex(output.key), oneTimeSecret),
        });
        oneTimeSecret = null; // owned by `outputs` now, and wiped in the finally below
      } catch {
        refused.push(output.key);
      } finally {
        if (oneTimeSecret) wipe(oneTimeSecret);
      }
    }

    if (refused.length > 0) {
      return {
        ok: false,
        refused,
        problem:
          `${refused.length} of ${request.outputs.length} outputs did not prove as this wallet's. ` +
          'A key image file is matched by position on the far side, so one missing record moves ' +
          'every record after it. It is refused whole rather than exported short.',
      };
    }

    const nonces: Uint8Array[] = [];
    for (let i = 0; i <= outputs.length; i++) nonces.push(random.subarray(i * 32, (i + 1) * 32));
    const iv = random.subarray((outputs.length + 1) * 32);

    const file = exportKeyImageBlob({
      viewSecret: wallet.viewSecret,
      spendPublic: fromHex(wallet.spendPublic),
      outputs,
      nonces,
      iv,
      offset: request.offset ?? 0,
    });
    return { ok: true, file, answered: outputs.length, refused: [] };
  } catch (error) {
    /* The one expected throw is `chachaKeyFor` refusing on a build with no
     * CryptoNight, and its sentence names that. Anything else is unforeseen
     * and still must not escape: this is reached from a bridge that promises
     * not to throw. */
    return { ok: false, problem: String((error as Error)?.message ?? error) };
  } finally {
    for (const output of outputs) wipe(output.oneTimeSecret);
  }
}
