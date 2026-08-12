# The swap, and the one thing standing between it and real money

Written down because the swap is finished and switched off, which is an
unusual state to come back to and an easy one to misread. Nothing below is a
plan. It is a record of where the work stopped and what the next person has to
do, which is less than it looks.

## Where it actually stands

The whole chain is built, tested and wired end to end:

```
Swap screen
  quoteAll        both exchanges, in parallel, unavailable pairs skipped
  createOrder     bounds, expiry, then the order
  verifyOrder     refuses rather than guesses (see below)
  depositForSwap  hands the deposit to the send flow, remembers the order
Send screen
  the ordinary send path, the vault signs, the wallet broadcasts
SwapStatus
  polls the provider, survives an app restart via the stored record
```

**Only the network is a fixture.** `demoSwapTransport` answers in the shape a
real exchange answers in, so every check around it is the real check. There is
no half-built code path here and no scaffolding to remove.

## Going live is one string

`SWAP_PROXY` in `wallet/src/net/swapproxy.ts` is `''`.

That empty string is load-bearing rather than a placeholder. `swapConfigured()`
reads it, the store picks the fixture when it is blank and the relay when it is
not, and the swap screen's DEMO DATA notice appears and disappears from the
same fact. There is deliberately no second flag: a second thing to remember is
a build that ships half-connected.

So the sequence is:

1. **Deploy the Worker.** From `worker/`:

   ```sh
   npm install
   npx wrangler kv namespace create SWAP_LIMIT
   ```

   Put the printed id into `wrangler.toml`, then:

   ```sh
   npx wrangler secret put EXOLIX_API_KEY
   npx wrangler secret put GODEX_PUBLIC_KEY
   npx wrangler secret put GODEX_AFFILIATE_ID
   npx wrangler secret put RATE_LIMIT_SECRET      # openssl rand -hex 32
   npx wrangler deploy
   ```

   Leave `OHTTP_KEYS` unset. That is the privacy path and it stays off; see
   `worker/README.md` for what it is and why it waits on a relay operator.

   Both exchanges answer without their keys, so a missing affiliate key is not
   an outage. It only means no affiliate credit.

2. **Check it.** `curl https://<host>/v1/health` answers `{"ok":true}`.

3. **Fill in `SWAP_PROXY`** with that host. Nothing else.

4. **Swap 0.001 BTC to XMR**, on real money, and watch it the whole way. That
   is the only test that counts, because everything before it is a test of the
   shapes rather than of the exchanges' behavior.

## Why it is not our fault, concretely

The claim is narrow and worth restating exactly. **Every failure this code can
have is a refusal before money moves, not a wrong trade after.**

`verifyOrder` in `core/swap.ts` refuses an order that:

- came from a different exchange than the one asked
- recorded a different payout address than the one given
- has a deposit address of the wrong shape for the coin being sent
- names back a different coin or a different network on either side
- uses the same address for deposit and payout
- is for a different amount than the one requested
- pays out a wildly different number than the quote (`RATE_TOLERANCE`)
- has no id to track it by

Fields a provider does not echo are recorded as *unchecked*, never as
agreement. Godex names the coins back and not the networks, and the screen
says so rather than implying a check that did not happen.

`amountWithinQuote` refuses before the order exists, on the minimum, the
maximum, and the payout floor. That last one is the easy one to miss:
`minAmount` is what must be sent, `withdrawMin` is what must arrive, and a
trade can clear the first and fail the second after the deposit has landed.

An unknown provider status maps to `unknown`, never to `failed`. Saying a swap
failed when the exchange said something unrecognized would be us inventing bad
news about somebody's money.

## What live testing found, and what it means for the next round

Every adapter had only been tested against fixtures somebody wrote, which can
only confirm what was already believed. One afternoon of querying the real
endpoints found three wrong things:

- Godex was being asked for a **fixed** rate while Exolix was asked for a
  floating one, and the screen ranked the two against each other by payout.
- Godex issues a **`rate_uuid`** and honors the quoted rate only for an order
  carrying it back. Nothing carried it, so every order would have been
  repriced at creation and refused by our own drift check.
- Godex publishes **`rate_expired_at`** and it was ignored.

All three are fixed, and the real response bodies are in `wallet/test/swap.test.ts`
under "anchored to what the exchanges actually answered".

**The lesson for whatever is added next: query the endpoint before writing the
adapter.** A fixture written from documentation tests the documentation.

## Still open

- **A real swap has never run.** Everything above is shapes. Step 4.
- **Exolix affiliate key** status unconfirmed; Godex key is in hand.
- **The privacy path is built and off.** OHTTP is complete and verified against
  RFC 9180, 9292 and 9458, and waits only on a relay operator who is not us.
  `worker/README.md` and `wallet/src/net/oblivious.ts` carry the reasoning.
