# The Labyrinth relay

One Worker, five routes, and a short list of things it refuses to do.

A swap is the only part of this product that talks to a stranger about coins
somebody owns. Done from the phone, it hands an exchange that person's IP
address next to two addresses they control. This Worker stands in the middle
so the exchange sees Cloudflare instead, and it holds the affiliate keys,
which cannot live on a device: a key compiled into a phone app is a published
key, and anyone who pulled it out of the binary could spend the identity it
represents.

## What it does

| Route | Method | Takes |
| --- | --- | --- |
| `/v1/quote` | POST | `provider`, `from`, `to`, `amount` |
| `/v1/create` | POST | the above, plus `payoutAddress` and `refundAddress` |
| `/v1/status` | GET | `provider`, `id` |
| `/v1/health` | GET | nothing, answers nothing about configuration |
| `/v1/node` | GET, POST | `host`, `path`: relays to a published public chain node |

## The chain nodes, which leak more than the swap did

Asking a public Esplora server about your addresses tells that server your
whole Bitcoin wallet: every address, at once, from one IP. The swap only ever
exposed a single trade. And broadcasting from the phone puts the address that
first announced a transaction next to the transaction, on either chain, which
is the ordinary way somebody is found. So `/v1/node` stands in front of both.

Two rules keep that from becoming its own problem:

**A node somebody runs themselves is never relayed.** The wallet decides this,
in `wallet/src/net/nodeproxy.ts`, because the wallet is the side that knows
whose machine it is. Traffic to a person's own node already goes somewhere
they trust over a network they control, and putting Labyrinth in that path
would take a private arrangement and hand it to a stranger. It is the
opposite of a privacy feature wearing the same word.

**Only the nodes this app suggests may be relayed.** Not any URL. The origin
comes from a table here and never from the caller, the path is taken as a
path and nothing else, and a test walks the escapes (`..`, encoded `..`,
`//host`, a scheme in the path) to prove the origin holds. A custom node that
is neither theirs nor suggested is reached directly, and the app says so
rather than quietly rerouting it.

It takes an **intent**, never a URL. The upstream request is built here by the
same functions the wallet uses, imported from `wallet/src/core/swap.ts`, so
the two cannot drift into disagreeing about what an Exolix rate call looks
like. A proxy that forwarded arbitrary URLs would be a free anonymiser for
whoever found it, and would be found.

It hands back what the exchange said, **unread**. It does not parse orders,
does not check payout addresses, and does not decide whether an order is
acceptable. `verifyOrder` runs in the wallet, against the request the wallet
built, because the wallet is the only party that knows what it asked for. A
proxy that verified on the app's behalf would be a proxy that could lie about
the result, and this one is never asked to.

## What it keeps

Nothing.

No logging, no database, no queue, no analytics binding. The one KV namespace
holds integers under keys that are `HMAC-SHA256(secret, window ‖ address)`,
truncated. The address is never written anywhere.

The HMAC matters, and a plain hash would not do: IPv4 is thirty-two bits, so
a bare SHA-256 of an address is reversible in seconds by anybody willing to
hash four billion inputs. The secret is what makes the bucket unguessable,
and it lives in the Worker's secrets rather than beside the counters. The
window is inside the HMAC as well, so the same caller lands in a different
bucket every minute and the counters cannot be assembled into a history of
one person's activity. Rotating `RATE_LIMIT_SECRET` forgets every bucket,
which is harmless and is the cheapest possible incident response.

None of that is policy. `test/worker.test.ts` walks this Worker's own source
on every run and fails the build on a `console.` call, a D1 binding, an
analytics write, or a `put` anywhere but the rate limiter. A promise about
logs that is not enforced by a test is a promise that lasts until the first
deadline.

## What it cannot promise

**It sees the request while it forwards it.** It has to: the affiliate key
has to be attached to a real trade, and a proxy cannot forward what it cannot
read. So "we store nothing" is true and provable, and "we could not see it if
we wanted to" is not. This file will not pretend otherwise.

The design that makes the second true is **Oblivious HTTP** (RFC 9458), and
it is not built yet. The shape of it, so the next person does not have to
rediscover it:

- A **relay**, run by somebody who is not us, receives the request and sees
  the caller's address but only ciphertext.
- This Worker becomes the **gateway**: it decrypts with an HPKE key, sees the
  trade, and sees only the relay's address.
- The exchange sees the gateway, as it does today.

No single party then holds both who and what. The client side is HPKE
(X25519 + HKDF-SHA256 + AES-128-GCM), and every primitive is already in the
`@noble` libraries the wallet ships; the work is the key configuration
endpoint, the encapsulation on the phone, and an agreement with a relay
operator. It is a project rather than a patch, which is why it is written
down here instead of half-built in the router.

## Deploying

```sh
cd worker
npm install
npx wrangler kv namespace create SWAP_LIMIT
```

Put the id it prints into `wrangler.toml`, then set the secrets. They never
appear in a file:

```sh
npx wrangler secret put EXOLIX_API_KEY
npx wrangler secret put GODEX_PUBLIC_KEY
npx wrangler secret put GODEX_AFFILIATE_ID
npx wrangler secret put RATE_LIMIT_SECRET
npx wrangler deploy
```

`RATE_LIMIT_SECRET` is any 32 or more bytes of randomness:
`openssl rand -hex 32`.

Both exchanges work without their keys, so the Worker runs unconfigured and
simply earns no affiliate credit. That is deliberate: a missing key is not an
outage, and a proxy that refused to serve until somebody finished the
paperwork would be a worse product for the person trying to trade.
