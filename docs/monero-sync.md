# Monero sync: the fork in the road

The wallet can talk to a monerod node today. It can read the height, read the
fee estimate, and broadcast a signed transaction. What it cannot do is tell you
your balance, and the reason is worth writing down because the fix is a product
decision rather than an afternoon of work.

## Why Bitcoin was easy and this is not

Bitcoin puts addresses on the chain. A light client asks a node "has anyone
paid this address", the node looks it up in an index it already maintains, and
the answer costs one request. That is what `src/net/esplora.ts` does, and it is
why the Bitcoin side of this wallet is finished.

Monero puts a one-time key on every output, and that key belongs to nobody in
particular until you do arithmetic with your view key. There is no index. There
is nothing to ask. Finding your outputs means taking every output in every
block since your wallet was born and testing each one.

The test itself is four operations and it is already written, in
`ownsOutput`. It uses `generate_key_derivation` and `derive_public_key` from
the vault, which are pinned to 120 published vectors each. The arithmetic is
not the hard part and never was.

The hard part is getting the blocks.

## The two ways, and what each costs

### Scan on the device

Download blocks from a node and test every output locally.

The node serves blocks and learns nothing about which of them are yours. That
is a genuinely better privacy position than Bitcoin light clients can reach at
all, and it is worth saying to somebody choosing between the two chains inside
this wallet.

What it costs: `/get_blocks.bin` speaks epee portable storage, a binary
serialization format with no specification outside Monero's own source. Writing
a decoder for it is the work. Then a phone has to scan every block since the
wallet's birth height, which for a wallet created a year ago is a few hundred
thousand blocks, and that is minutes of work on a device that would rather be
asleep.

### Use a light wallet server

Hand your view key to a server, let it scan, ask it for your balance.

Fast, cheap, and the thing every light Monero wallet does. It also means the
server learns every payment you have ever received, forever, because that is
exactly what a view key is for. The privacy advantage over Bitcoin disappears
entirely, and it disappears quietly, in an architecture diagram nobody reads.

## Where this leaves the wallet

Neither is wired. The Monero view carries the node's height, which is real, and
a balance of zero which is labeled as not-yet-scanned rather than presented as
an amount. A zero that is labeled is honest. A zero that is not is a wallet
telling somebody their money is gone.

This is the gate on external TestFlight for the Monero half. The Bitcoin half
is done and can be tested against a real node today.

## The recommendation

Scan on the device, with a birth height so a new wallet does not walk the whole
chain, and an explicit warning if somebody restores an old seed.

It is more work and it is the only one of the two that keeps the property that
made Monero worth supporting here. A wallet that ships the light server path
because it is easier has quietly become a worse privacy product than the
Bitcoin side of the same app, which would be an odd thing for this repository
to do.

If the light server path is ever taken, it belongs behind a screen that says
what it hands over, in the same voice the swap screen uses about payout
addresses, and it should never be the default.
