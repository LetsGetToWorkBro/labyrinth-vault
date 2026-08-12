// src/encoding.js
// UTF-8, written out, because the vault's runtime does not come with it.
//
// ## Why this file exists
//
// `TextEncoder` and `TextDecoder` are WHATWG Encoding, not part of the
// JavaScript language. Node has them as globals, every browser has them, and
// `src/platform.d.ts` said as much and listed the runtimes it had checked.
// JavaScriptCore embedded in an iOS app was not on that list, and it is a bare
// ECMAScript engine: no DOM, no Web APIs, no Encoding.
//
// So the first build that ever reached a device stopped on its own launch
// gate with `ReferenceError: Can't find variable: TextEncoder`, having touched
// no key. That is the gate working. It is also a bug that no test on Linux
// could have found, because the tests ran where the global happened to exist.
//
// ## Why it is installed unconditionally
//
// The obvious form is `if (typeof TextEncoder === 'undefined')`, so that Node
// keeps the native one and only the phone gets this. That reintroduces the
// exact fault it is fixing: the tests would exercise one implementation and
// the device another, and any difference between them would be invisible until
// somebody held a phone. One implementation, everywhere, tested.
//
// `test/encoding.test.ts` checks it against Node's native implementation over
// the cases where a hand-written UTF-8 codec goes wrong: astral-plane
// characters, lone surrogates, the NFKD forms a passphrase can contain, and
// every boundary between byte lengths.
//
// This is plain JavaScript rather than TypeScript because it is prepended to
// the bundle as a banner, ahead of every module. Module-level code runs on
// import, and `const EXP_DOMAIN = new TextEncoder().encode('bulletproof_plus')`
// in `src/keys/bulletproofplus.ts` is exactly that, so the polyfill cannot be
// something the graph imports: it has to already be there.

function encodeUTF8(input) {
  const text = String(input ?? '');
  // Worst case is four bytes per code unit; trimmed at the end.
  const out = new Uint8Array(text.length * 4);
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    /* A lone surrogate is not a character and has no UTF-8 encoding. WHATWG
     * says to emit U+FFFD rather than to throw, and matching that matters:
     * the alternative is a passphrase screen that crashes on a half-typed
     * emoji. */
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;

    if (code < 0x80) {
      out[at++] = code;
    } else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    }
  }
  return out.slice(0, at);
}

/**
 * The WHATWG UTF-8 decoder, state machine and all.
 *
 * The obvious version reads a lead byte, decides how wide the sequence is,
 * consumes that many, and rejects overlong forms afterwards. It is wrong in a
 * way a round trip never shows, and the differential test against Node caught
 * it on the first run: for the overlong pair `C0 80` it emitted one U+FFFD
 * where the reference emits two.
 *
 * The reason is that `C0` and `C1` are not lead bytes at all. No valid UTF-8
 * begins with them, so `C0` is one error on its own and the `80` after it is a
 * second, a stray continuation. The obvious version treated `C0` as a
 * two-byte lead, swallowed the `80` with it, and reported a single failure.
 *
 * That difference is not cosmetic. Error counts are how a caller tells "one
 * mangled character" from "several bytes of something else", and the whole
 * reason to write this codec rather than guess at one is that the phone and
 * the tests must agree byte for byte. So this follows the specification's own
 * algorithm: a lead byte sets how many continuations are needed *and* the
 * range the next byte must fall in, which is what makes overlong forms,
 * encoded surrogates and out-of-range code points impossible to express
 * rather than something to detect afterwards. A byte outside that range ends
 * the sequence with one U+FFFD and is then reconsidered as a fresh lead.
 */
function decodeUTF8(input) {
  if (input === undefined || input === null) return '';
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input);
  let out = '';
  let code = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (needed === 0) {
      if (byte <= 0x7f) {
        out += String.fromCharCode(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        code = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0; // no overlong three-byte forms
        if (byte === 0xed) upper = 0x9f; // no encoded surrogates
        needed = 2;
        code = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90; // no overlong four-byte forms
        if (byte === 0xf4) upper = 0x8f; // nothing past U+10FFFF
        needed = 3;
        code = byte & 0x07;
      } else {
        // 0x80..0xC1 and 0xF5..0xFF can never begin a sequence.
        out += '�';
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      code = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      out += '�';
      i--; // reconsider this byte as a lead
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    code = (code << 6) | (byte & 0x3f);
    seen++;
    if (seen !== needed) continue;
    if (code > 0xffff) {
      const rest = code - 0x10000;
      out += String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
    code = 0;
    needed = 0;
    seen = 0;
  }
  // A sequence still open at the end of the input is one error.
  if (needed !== 0) out += '�';
  return out;
}

globalThis.TextEncoder = function TextEncoder() {};
globalThis.TextEncoder.prototype.encode = function (input) {
  return encodeUTF8(input);
};
globalThis.TextDecoder = function TextDecoder(label) {
  const name = String(label ?? 'utf-8').toLowerCase();
  if (name !== 'utf-8' && name !== 'utf8' && name !== 'unicode-1-1-utf-8') {
    /* Only UTF-8 is implemented, and asking for anything else should say so
     * rather than silently returning mojibake. Nothing in this codebase asks
     * for another encoding; this is here so that the day something does, it
     * fails at the call rather than in the output. */
    throw new RangeError('TextDecoder: only utf-8 is supported in this build');
  }
};
globalThis.TextDecoder.prototype.decode = function (input) {
  return decodeUTF8(input);
};
