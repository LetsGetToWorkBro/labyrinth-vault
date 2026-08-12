# The Labyrinth relay

One Worker, seven routes, and a short list of things it refuses to do.

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
| `/v1/ohttp-keys` | GET | nothing, answers with this gateway's public keys |
| `/v1/gateway` | POST | an encapsulated request, which is any of the above, encrypted |

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
like. A proxy that forwarded arbitrary URLs would be a free anonymizer for
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

## The oblivious door

Everything above describes a Worker that **sees the request while it forwards
it**. It has to: the affiliate key has to be attached to a real trade, and a
proxy cannot forward what it cannot read. So "we store nothing" is true and
provable, and "we could not see it if we wanted to" is a different sentence
entirely. The first is a promise. It holds exactly as long as everybody who
ever deploys this Worker keeps it.

**Oblivious HTTP** (RFC 9458) replaces the promise with an arrangement, and it
is built. The same routes are reachable a second way:

- A **relay**, run by somebody who is not us, receives the request. It sees
  the caller's address and a blob it has no key for.
- This Worker is the **gateway**. It decrypts with an HPKE key, serves the
  request through the exact same router, and sees the relay's address where
  the caller's would have been.
- The exchange or the node sees the gateway, as before.

No single party holds both who and what.

### How it is verified

Not by round-tripping against itself, which a wrong implementation does
perfectly well. Three RFCs, three sets of published vectors:

| Layer | Where | Checked against |
| --- | --- | --- |
| HPKE | `wallet/src/net/ohttp/hpke.ts` | RFC 9180 A.1, every intermediate value |
| Binary HTTP | `wallet/src/net/ohttp/bhttp.ts` | RFC 9292 Figure 8, byte for byte |
| Encapsulation | `wallet/src/net/ohttp/ohttp.ts` | RFC 9458 Appendix A, byte for byte |

`worker/test/gateway.test.ts` then drives the real wallet client through a
stand-in relay into this router, and reads the bytes the relay held to check
that no coin, chain, address or route name appears anywhere in them.

### The relay has to be somebody else

This is the part that is easy to get wrong while appearing to do everything
right. The gateway runs on Cloudflare. **A relay that also runs on Cloudflare
puts both halves inside one company**, and the protocol goes through every
motion for no gain. The relay must be a different operator on different
infrastructure.

Until one is agreed, `RELAYS` in `wallet/src/net/oblivious.ts` is empty and
the client does not use this path. An empty list is the honest state; a list
containing our own address would be theatre. The app says which of the two
arrangements is actually in force rather than describing the better one.

### What it costs

**Rate limiting by person.** Inside an oblivious request every caller wears
the relay's address, so counting by address would put every user of the relay
in one bucket and let any one of them lock out the rest. The counter applies
to the relay instead, generously, and per-person limiting is simply gone.
There is no version of this where we both cannot identify somebody and can
meter them.

This is the designed trade, not an oversight. RFC 9458 6.2.2 puts the
obligation where the information is: a gateway that exempts a relay from
ordinary limits "might want to ensure that the relay applies a rate-limiting
policy that is acceptable to the server", and "might choose to authenticate
the relay to enable the higher rate." Two consequences follow, and only one of
them is discharged:

- **Done.** What can be counted without knowing whose it is, is. The *route*
  is visible to the gateway while the caller is not, and creating an order is
  the only route that writes something durable at a stranger under our
  affiliate key, so it has a ceiling of its own well under the relay's
  (`OHTTP_CREATE_LIMIT_PER_MINUTE`). The refusal is sealed like any other
  answer, because a 429 in the clear would tell the relay which request was an
  order. This does trade one failure for another: a single abuser can eat the
  relay's whole order budget and get honest people a 429. That is the better
  failure, since a 429 is a minute old and recoverable while an affiliate key
  flagged for abuse breaks swaps for everybody until a human negotiates a new
  one.
- **Owed.** Per-person limiting at the relay, and authenticating the relay so
  that `/v1/gateway` is not open to the whole internet, are both terms for the
  operator agreement that does not exist yet. Neither can be built here: the
  first needs the addresses this gateway deliberately cannot see, and the
  second needs an operator to authenticate.

What is deliberately *not* built is the third option the same RFC section
describes: signalling abuse back to the relay. A gateway that answered
differently depending on what it decrypted would let a relay acting on those
signals deanonymize the client, which is the failure this whole design exists
to prevent. Every refusal here is the same shape for that reason.

**Replay is possible.** The gateway is stateless, so a relay could send the
same ciphertext twice. For a quote or a node call that is noise. For an order
it would create a duplicate at the exchange, which the wallet never sees,
never verifies, and never funds, so it costs the exchange a row and costs the
user nothing. Closing it would mean this Worker keeping a record of every
request it had already seen, which is a worse trade than the one it prevents.

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
npx wrangler secret put OHTTP_KEYS
npx wrangler deploy
```

`RATE_LIMIT_SECRET` is any 32 or more bytes of randomness:
`openssl rand -hex 32`.

`OHTTP_KEYS` is `id:hex` entries, comma separated, newest first. Generate one
with `openssl rand -hex 32` and paste it as `1:<that hex>`. To rotate, put the
new key first and leave the old one in the list until the clients holding it
have stopped using it, then drop it:

```
2:<new hex>,1:<old hex>
```

The first entry is the one advertised at `/v1/ohttp-keys`; every entry is
still accepted for decryption. Leaving `OHTTP_KEYS` unset turns the oblivious
door off, and both it and the key endpoint answer 404 rather than pretending.

Both exchanges work without their keys, so the Worker runs unconfigured and
simply earns no affiliate credit. That is deliberate: a missing key is not an
outage, and a proxy that refused to serve until somebody finished the
paperwork would be a worse product for the person trying to trade.
