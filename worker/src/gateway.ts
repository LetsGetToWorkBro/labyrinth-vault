/**
 * The Oblivious HTTP gateway.
 *
 * This is the half of RFC 9458 that runs on our side. A relay operated by
 * somebody who is not us receives the phone's request, sees its IP address
 * and a blob it has no key for, and forwards the blob here. This Worker
 * decrypts it, serves it through the ordinary routes, and seals the answer
 * back. What changes is who knows what:
 *
 *   - the relay knows the address and not the trade,
 *   - this gateway knows the trade and not the address,
 *   - the exchange or the node knows neither, as before.
 *
 * The claim that follows is stronger than the one the plain proxy could make,
 * and it is worth being precise about the difference. The plain proxy's
 * promise is "we do not write anything down", which is a promise. This one is
 * "we are not told", which is an arrangement. The first survives exactly as
 * long as everybody who ever deploys this Worker keeps their word. The second
 * does not depend on that.
 *
 * ## What it costs, stated plainly
 *
 * Rate limiting by caller. Inside an oblivious request every caller wears the
 * relay's address, so counting by address would put every user of the relay
 * into one bucket and hand any single one of them the power to lock out the
 * rest. The counter therefore applies to the relay, generously, and per-person
 * limiting is simply gone. That is the price of not knowing who is calling,
 * and there is no version of this where we both cannot identify somebody and
 * can meter them.
 *
 * ## Keys
 *
 * The secret is configured, not generated, because a key that a Worker made
 * up at start would differ between isolates and change under every deploy,
 * and clients would encrypt to a key nobody holds. Configuration is a list so
 * that rotation is possible: the first entry is the one advertised to clients,
 * and every entry is accepted for decryption, so a key can be retired after
 * the clients holding it have stopped using it rather than at the instant it
 * is replaced.
 */

import {
  KEM_X25519_HKDF_SHA256,
  publicKeyOf,
} from '../../wallet/src/net/ohttp/hpke';
import {
  SUPPORTED,
  encodeKeyList,
  openRequest,
  sealResponse,
  type KeyConfig,
} from '../../wallet/src/net/ohttp/ohttp';
import {
  decodeRequest,
  encodeResponse,
  type BResponse,
} from '../../wallet/src/net/ohttp/bhttp';

export const REQUEST_MEDIA_TYPE = 'message/ohttp-req';
export const RESPONSE_MEDIA_TYPE = 'message/ohttp-res';
export const KEYS_MEDIA_TYPE = 'application/ohttp-keys';

export interface GatewayKey {
  keyId: number;
  secret: Uint8Array;
}

const fromHex = (text: string): Uint8Array => {
  const clean = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('a gateway key must be 32 bytes of hex');
  return Uint8Array.from(clean.match(/../g)!.map((b) => parseInt(b, 16)));
};

/**
 * `id:hex` entries, comma separated, newest first.
 *
 * A malformed entry throws rather than being skipped. A gateway that quietly
 * ignored the key it could not parse would advertise the next one down and
 * start refusing every request encrypted to the key it was supposed to be
 * using, which is an outage that looks like a client bug.
 */
export function parseKeys(configured: string | undefined): GatewayKey[] {
  if (!configured?.trim()) return [];
  return configured.split(',').map((entry) => {
    const [id, hex] = entry.split(':');
    const keyId = Number.parseInt((id ?? '').trim(), 10);
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) {
      throw new Error('a gateway key id must be a number from 0 to 255');
    }
    return { keyId, secret: fromHex(hex ?? '') };
  });
}

/** What the client fetches: the advertised key, in the published format. */
export function keyConfigsFor(keys: GatewayKey[]): KeyConfig[] {
  return keys.map((key) => ({
    keyId: key.keyId,
    kemId: KEM_X25519_HKDF_SHA256,
    publicKey: publicKeyOf(key.secret),
    algorithms: [SUPPORTED],
  }));
}

export function keyListResponse(keys: GatewayKey[]): Response {
  return new Response(encodeKeyList(keyConfigsFor(keys)), {
    headers: {
      'Content-Type': KEYS_MEDIA_TYPE,
      /* Cacheable, and it has to be. A key configuration every client fetches
       * fresh is a key configuration that could be served differently to one
       * of them, and a client that is alone in holding some key is a client
       * that can be recognized by the request it sends. Long, public, and the
       * same for everybody is the privacy-preserving answer here, which is the
       * opposite of the no-store the rest of this Worker uses. */
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * A decrypted request, ready to be served, and what is needed to seal the
 * answer to the same client.
 */
export interface Encapsulated {
  request: Request;
  context: ReturnType<typeof openRequest>['context'];
  enc: Uint8Array;
}

/**
 * Decrypt, and turn the binary HTTP inside into a `Request` the router can
 * serve.
 *
 * Every failure here is a thrown error and the caller turns all of them into
 * the same flat refusal. A gateway that distinguished "no such key id" from
 * "that did not decrypt" would be answering questions about which keys exist
 * for anybody willing to ask, and it has no reason to.
 */
export function openEncapsulated(keys: GatewayKey[], body: Uint8Array, origin: string): Encapsulated {
  if (body.length < 1) throw new Error('empty');
  const keyId = body[0]!;
  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (!key) throw new Error('unknown key');

  const opened = openRequest(key.secret, key.keyId, body);
  const inner = decodeRequest(opened.request);

  /* The authority in the encapsulated request is not trusted as a
   * destination. Only its path and method are used, against this Worker's own
   * origin, so an encapsulated request cannot be a way to make the gateway
   * fetch somewhere of the sender's choosing. The relay in front of it is not
   * a party this design trusts, and neither is whoever wrote the plaintext. */
  const url = new URL(inner.path, origin);
  const headers = new Headers();
  for (const [name, value] of inner.headers) {
    /* Hop-by-hop and length fields belong to the outer connection, not to a
     * message that was carried inside another one. */
    if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name)) continue;
    headers.set(name, value);
  }

  const method = inner.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && inner.body.length > 0;
  return {
    request: new Request(url.toString(), {
      method,
      headers,
      ...(hasBody ? { body: inner.body } : {}),
    }),
    context: opened.context,
    enc: opened.enc,
  };
}

/** The router's answer, sealed back to the client that asked. */
export async function sealAnswer(opened: Encapsulated, answer: Response): Promise<Response> {
  const headers: [string, string][] = [];
  for (const [name, value] of answer.headers) {
    /* The outer response carries its own framing, and repeating the inner
     * length or encoding would describe bytes that are no longer there. */
    if (['content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) continue;
    headers.push([name, value]);
  }
  const inner: BResponse = {
    status: answer.status,
    headers,
    body: new Uint8Array(await answer.arrayBuffer()),
  };
  const sealed = sealResponse(opened.context, opened.enc, encodeResponse(inner));
  return new Response(sealed, {
    /* Always 200 on the outside, whatever happened inside. The status of the
     * real answer is part of what the relay is not supposed to learn, and a
     * gateway that returned 404 in the clear when the inner route was missing
     * would be describing the traffic it is meant to be hiding. */
    status: 200,
    headers: {
      'Content-Type': RESPONSE_MEDIA_TYPE,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
