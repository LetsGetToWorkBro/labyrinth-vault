/**
 * Counting a caller without keeping them.
 *
 * A rate limit needs to recognize the same caller twice in a minute. The
 * obvious way is to key a counter by IP address, which is what the sibling
 * project does, and it means the store holds a list of everyone who used the
 * service in the last two minutes. For a proxy whose entire purpose is that
 * an exchange never learns who is trading, keeping that list here would move
 * the problem rather than solve it.
 *
 * So the key is `HMAC-SHA256(secret, window ‖ address)`, truncated, and the
 * address itself is never written anywhere.
 *
 * Why an HMAC and not a plain hash: IPv4 is thirty-two bits. A bare SHA-256
 * of an address is reversible by anybody willing to hash four billion inputs,
 * which is seconds of laptop time, so a plain digest would be the address in
 * a costume. The secret is what makes the mapping unguessable, and it lives
 * in the Worker's secrets rather than beside the counters.
 *
 * The window is inside the HMAC on purpose. Buckets from different minutes
 * are unlinkable even to somebody holding the secret and the store: the same
 * caller produces a different key every window, so the counters cannot be
 * assembled into a history of one person's activity. What remains readable is
 * exactly what a rate limit needs, "this opaque bucket has seen four requests
 * in the current minute", and nothing that survives the minute.
 *
 * Rotating the secret forgets every bucket. That is harmless, and it is the
 * cheapest possible incident response.
 *
 * ## The ceiling is approximate, and by how much
 *
 * `checkLimit` reads a counter, decides, and writes the counter back. KV is
 * eventually consistent and there is no compare-and-set, so requests that
 * arrive together all read the same number and all write one more than it: a
 * burst of concurrency `c` gets through at roughly `limit + c` rather than
 * `limit`. Written down because the next person sizing
 * `OHTTP_CREATE_LIMIT_PER_MINUTE` will otherwise size against a number this
 * file does not enforce, and finding that out from an exchange is expensive.
 *
 * It is left this way rather than fixed because of what is being protected.
 * This limiter guards an affiliate key's request quota, not anybody's money,
 * and it already declares itself expendable one function down by failing open
 * when the store is missing. Per-address bucketing hands a distributed
 * adversary fresh buckets by design, so an exact counter would not stop the
 * attack the overshoot suggests it might. Cloudflare's own RateLimit binding
 * would count atomically and is the fix if this ever has to be tight; the
 * honest state today is a ceiling that is a ceiling to within a burst, and a
 * sizing decision made with that in view.
 */

const WINDOW_SECONDS = 60;

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

/**
 * The opaque bucket for this caller in this window.
 *
 * Exported for the test that proves the address does not appear in it, which
 * is the property the whole file exists for.
 */
export async function bucketKey(secret: string, address: string, window: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${window}:${address}`));
  /* Half the digest is 128 bits, which is far more than enough to keep two
   * callers out of one bucket and keeps the KV key short. */
  const bytes = new Uint8Array(mac).slice(0, 16);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Count one request against the caller's bucket.
 *
 * Fails open when there is no store or no secret. A proxy that stops serving
 * because its counter is unavailable has turned a courtesy into an outage,
 * and the thing being protected here is an affiliate key's request quota, not
 * anybody's money.
 */
export async function checkLimit(
  store: KVNamespace | undefined,
  secret: string | undefined,
  address: string,
  limit: number,
  now: number,
): Promise<LimitResult> {
  if (!store || !secret || limit <= 0) {
    return { allowed: true, remaining: limit, limit, resetSeconds: 0 };
  }
  const seconds = Math.floor(now / 1000);
  const window = Math.floor(seconds / WINDOW_SECONDS);
  const resetSeconds = (window + 1) * WINDOW_SECONDS - seconds;

  const key = `rl:${await bucketKey(secret, address, window)}`;
  const current = Number((await store.get(key, 'text')) ?? '0');
  const used = Number.isFinite(current) ? current : 0;

  if (used >= limit) return { allowed: false, remaining: 0, limit, resetSeconds };

  /* Two windows of TTL so a bucket cannot outlive the minute it describes by
   * more than one more. Nothing here is worth keeping longer, and a counter
   * that lingers is a counter somebody could ask about. */
  await store.put(key, String(used + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  return { allowed: true, remaining: Math.max(0, limit - used - 1), limit, resetSeconds };
}
