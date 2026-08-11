# Monero sync: how it works, and the one thing it cannot do

The wallet scans the Monero chain on the device. The node serves blocks and
never learns which outputs in them are yours. This document is what was decided
and why, and it ends with the honest limit, which is that a view key finds
money coming in and cannot see it going out.

## Why Bitcoin was easy and this was not

Bitcoin puts addresses on the chain. A light client asks a node "has anyone paid
this address", the node looks it up in an index it already maintains, and the
answer costs one request. That is what `wallet/src/net/esplora.ts` does.

Monero puts a one-time key on every output, and that key belongs to nobody in
particular until you do arithmetic with your view key. There is no index. There
is nothing to ask. Finding your outputs means taking every output in every block
since your wallet was born and testing each one.

The test itself is four operations, in `ownsOutput`. It uses
`generate_key_derivation` and `derive_public_key` from the vault, pinned to 120
published vectors each. The arithmetic was never the hard part. Getting the
blocks was.

## The fork, and which way it went

### Scan on the device (chosen)

Download blocks from a node, test every output here.

The node learns nothing about which outputs are yours. That is a better privacy
position than Bitcoin light clients can reach at all, and it is worth saying to
somebody choosing between the two chains inside this wallet.

### Use a light wallet server (rejected)

Hand your view key to a server, let it scan, ask it for your balance.

Fast, cheap, and what most light Monero wallets do. It also means the server
learns every payment you ever received, forever, because that is exactly what a
view key is for. The privacy advantage over Bitcoin disappears entirely, and it
disappears quietly, in an architecture diagram nobody reads.

If that path is ever taken it belongs behind a screen that says what it hands
over, in the same voice the swap screen uses about payout addresses, and it
should never be the default.

## How the scan actually gets its blocks

Not through `/get_blocks.bin`, which is the fast path and speaks epee portable
storage, a binary serialization format with no specification outside Monero's
own source. Writing a decoder for it with no real blobs to check against is
exactly the unverified work this repository refuses everywhere else.

So the scan uses the JSON surface instead: `get_block` for a height, then
`/get_transactions` with `decode_as_json` for its contents. That is slower,
more requests and more bytes, and it has three things going for it. It works on
every restricted public node. It can be tested here against recorded answers.
And it is correct.

When an epee decoder exists and has been checked against a real node, it
replaces those two calls in `wallet/src/net/monerod.ts` and nothing above that
line changes.

## Amounts, and why they are trustworthy without vectors

RingCT hides amounts behind a Pedersen commitment. The receiver recovers the
amount by decrypting eight bytes with a mask derived from the shared secret,
and Monero publishes no test vector for that step.

It does not need one. A recovered amount and its recomputed blinding factor
either rebuild the exact commitment sitting on the chain or they do not. So
every amount this wallet reports has been proved against real chain data at the
moment it was read, which is a stronger claim than a fixed vector makes. An
amount that fails the check is reported as unknown rather than as a number,
because a wrong amount looks exactly like a right one on a screen.

The commitment check rests on `rct::H`, Monero's second generator, and that one
is worth a paragraph because getting it wrong is easy and silent.

Everywhere else in Monero, turning bytes into a point means `hash_to_ec`:
Keccak, then the Elligator map in `ge_fromfe_frombytes_vartime`, then a
multiply by eight. **H does not use that.** H is Keccak of G's encoding read
directly as a point encoding by `ge_frombytes_vartime`, then multiplied by
eight. Monero's own unit test says so in a comment and warns that the trick
only works because that particular hash happens to decode. The Elligator
version produces a perfectly well-formed generator that no commitment on the
chain will ever verify against, which reads on screen as a wallet that finds
outputs worth nothing.

So `RCT_H` in `src/keys/monerocrypto.ts` is computed from the construction and
then checked, in `selfTest` and in the test suite, against the literal byte
array in monero-project's `rctTypes.h`. Both halves are load-bearing. Computing
it shows the constant is what the definition produces; comparing it shows this
code agrees with the network about which point that is.

## What it cannot do

**A view-only wallet cannot tell which of its outputs have been spent.**

This is not a gap that more code in this repository closes. Spending an output
publishes a key image, and computing the key image of your own output needs the
spend secret, which by design is not on the phone. So the wallet can list every
payment it ever received and cannot subtract the ones that have since gone.

Every wallet in this position solves it the same way: the spending wallet
exports its key images and the watching wallet imports them. The vault already
recognizes that file, `Monero key image export`, as one of the six wallet2
containers in `src/keys/monerotx.ts`. Wiring that round trip is the next piece
of work on this side of the product.

Until then the number is **received**, it is labeled received on every screen
that shows it, and it is never called a balance. A received total under the
word BALANCE would tell somebody who has spent money that they still have it.

`spendable` on the Monero view is zero, and not because the scan is behind.
Building a Monero spend needs key images and ring members, and this half of the
product has neither.

## What it costs, in practice

A scan walks a bounded number of blocks per refresh, currently two hundred, and
hands back where it got to. The app writes that height down, shows the
percentage, and picks the work up on the next pull to refresh. A person can put
the phone down without losing the run.

Coinbase outputs are skipped by default. Miner transactions are not in a
block's `tx_hashes`, so reading them costs one extra request per block including
the great majority that contain nothing else, and it only matters to somebody
pointing a mining pool at this wallet. It is an option rather than a decision.

## What is remembered between launches

The scan height and the node addresses, in one JSON file in the app's own
documents directory. Not the outputs a scan found: those are a list of
somebody's incoming payments and are exactly what the view key was protecting,
and they are cheap to find again given the height. Not any key.

Everything read back out of that file goes through the same validation as
something somebody typed. A stored node address is re-parsed by `parseNode`, a
stored height is bounds-checked, an unknown schema version is discarded rather
than migrated by guesswork. The point is less about somebody editing the file,
though on a jailbroken phone they could, and more that a file written by an
older build of this app is untrusted input in the same way and for the same
reasons.

`wallet/src/state/persist.ts` is where that lives, and it has no import from
`expo-file-system`, which is why its tests drive the real loading and saving
code under Node.
