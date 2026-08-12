# Labyrinth Wallet privacy policy

Labyrinth Wallet is the watch-only half of a two-device wallet. It holds no
private key and has no account, no cloud, and no telemetry. What it does do is
talk to a Bitcoin or Monero node, and, if you use the swap feature, to a
currency exchange, and those conversations are not private by magic. This
policy is about being exact about which ones happen, what each one reveals, and
who is on the other end, because a wallet that is vague about that is a wallet
asking to be trusted rather than checked.

## What the app holds

Watch-only material only: a Bitcoin account extended public key (zpub), a
Monero primary address and private *view* key, the addresses derived from
them, and the balances and history read from a node. None of it can spend.
There is no seed phrase, no spend key, and no screen that would accept one.
Signing happens on your separate airgapped vault, never here.

Nothing secret is stored at rest, because there is no secret to store. The
only things kept between launches are your chosen node addresses, how far a
Monero scan has progressed, and the details of a single swap that is still in
flight. That file contains no key and no address that identifies you; it is
kept in the app's own storage, never synced to iCloud or to us.

## What talking to a node reveals

This is the honest cost of any light wallet, and the app says so on the screen
where you choose a node rather than only here. When the wallet asks a public
node about your addresses, that node learns those addresses are of interest to
whoever is asking, and learns their IP address; asked about several in a row,
it can tie them together as one wallet. Broadcasting a transaction tells the
node which address announced it first.

Because of that, **there is no default node baked into this app.** You choose
one, and running your own, which reveals these things only to a machine you
already control, is presented as the ordinary choice, not the advanced one.
Nothing is sent to any node until you have set one.

## What the swap feature reveals

Swapping one coin for another means talking to an exchange, and an exchange
you talk to from a phone learns your IP address next to the trade. The wallet
does not pretend otherwise; the swap screen states it before you start.

When a swap is available in a build, requests are routed through a proxy that
Labyrinth operates so that the exchange sees that proxy rather than your phone.
That proxy is built to keep nothing: it has no database, no logs, and no
analytics, and the one counter it does keep for rate limiting is keyed by an
irreversible HMAC of an address rather than the address itself. This is a
structural property enforced by an automated test over the proxy's source, not
a promise about intentions. Where an independent relay is configured, requests
are additionally sent under Oblivious HTTP (RFC 9458), so that the party who
sees your address cannot read the request and the party who reads the request
cannot see your address.

**Neither is in force in this release.** Read the paragraph above as the
arrangement, not as what is running today: no proxy address is set in this
build and no relay operator is agreed, so the swap screen serves its figures
from a fixture and says so on the screen, and nothing about a swap reaches any
exchange from this version. If a later build sets the proxy but still has no
relay, the proxy stands between you and the exchange and Oblivious HTTP does
not apply. The app states which of the arrangements is actually in force rather
than describing the best one, and so does this document.

The exchange itself is a third party with its own policy, and what it does with
an order it has filled is between you and it. The wallet hands the exchange
only what a swap requires: the two coins, the amount, and the addresses the
payout and any refund go to.

## The camera

The camera reads the signed transaction back from your vault, as QR codes on
its screen, when you choose to scan. It is the only channel between the two
devices. Images are processed on device and discarded; nothing is captured,
stored, or transmitted.

## What we collect

Nothing. There is no analytics, crash reporting, advertising, or tracking
framework in the app, and its privacy manifest declares no tracking, no
collected data types, and no required-reason API use. We run the swap proxy
and, when you use it, a node relay of the public nodes the app suggests; both
are built to forward and forget, and neither is a place your activity comes to
rest. We have no account system and no way to identify you. If you email us, we
see your email, and that is the only data path we control.

## Changes

If any of the above changes, this policy changes first, and the app's privacy
manifest, the proxy's retention tests, and the source guards that keep these
statements true have to change with it, in public, since the application is
open source.

Contact: info@labyrinthwallet.com · https://labyrinthwallet.com/privacy
