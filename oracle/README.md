# The oracle: Monero's own crypto, so the fixtures can be re-derived

Several of this repository's Monero fixtures are numbers that came out of
Monero's C++ rather than out of anything here: the CryptoNight vectors, every
ring signature in the key-image export, the finished encrypted blob. That is
the right way to test a format nobody else specifies, and it has one obvious
weakness. A number you cannot regenerate is a number you have to believe.

This directory is how to regenerate them.

```sh
# Monero
./oracle/build.sh --check        # fetch the pinned Monero, build, run its own vectors
node oracle/emit.mjs --check     # rebuild the key-image fixture and diff against the tree

# Bitcoin
./oracle/btc.sh                  # fetch Electrum and the BBQr reference, at their pins
node oracle/btc-emit.mjs --check # rebuild both Bitcoin fixtures and diff
```

`--check` changes nothing. It should print that the fixtures reproduce exactly.
If it does not, something moved, and re-pinning before understanding what is
the one thing not to do.

## Why it is committed

It was not, and it should have been. The rig lived in a git-ignored scratch
directory, and when the working container was recycled it went with it: the
Monero checkout, the harnesses, the build recipe, all of it. Everything
downstream still worked, because the fixtures were committed, but for a while
the only thing standing behind "these came from Monero" was a sentence in a
comment.

That is the failure mode this directory exists to close. The fixtures are the
answer; this is the working.

## What is here

| file | what it is |
| --- | --- |
| `PINNED.json` | which Monero, and which fixtures come from it |
| `build.sh` | shallow-clones that Monero, compiles it, builds both harnesses |
| `emit.mjs` | runs the harnesses and writes (or checks) the fixtures |
| `src/keyimage.cpp` | the key-image export blob, through `wallet2`'s own calls |
| `src/cryptonight.c` | `cn_slow_hash` at variant 0, from upstream |
| `src/rng-counter.c` | replaces Monero's RNG with a byte counter |
| `src/mlock-stub.cpp` | `epee::mlocker`, which only pins pages against swap |
| `src/unreachable.c` | the CryptonightR JIT and RandomX, which abort if reached |
| `src/shim/boost/…` | fourteen lines, so `warnings.h` resolves |
| `btc.sh` | clones Electrum and Coinkite's BBQr at their pinned commits |
| `btc-emit.mjs` | runs both against our code and writes (or checks) the Bitcoin fixtures |

The four stub files are ours and are the only code here that Monero did not
write. Each one exists so that a piece of upstream that this harness never
executes does not have to be linked; none of them stands in the path of a
number that ends up in a fixture.

## The RNG stub is not a shortcut

It is the thing that makes any of this possible.

`generate_signature` and `generate_ring_signature` draw a nonce at random. Two
*correct* implementations of the same signature scheme, handed the same
message and the same key, produce different bytes. So there is no fixture to
write and nothing for the TypeScript to be compared against. Replacing the RNG
with a counter makes the C reproducible, and the same counter bytes are handed
to `src/keys/moneroexport.ts` as nonces. That is what turns "both look
plausible" into "these are the same 356 bytes".

It also means: nothing this harness produces is secret, and no key in
`emit.mjs` should ever be used for anything. They are test vectors.

## Why it does not run in `npm test`

It needs a Monero checkout and a C++ toolchain with boost headers. A suite that
fetched half a gigabyte of upstream C++ on every run is a suite people learn to
skip, and a check that gets skipped is worse than one that is honestly manual.

`test/oracle.test.ts` runs instead, and checks the things that actually drift:
that `PINNED.json` and `vendor/cryptonight/MANIFEST.json` name the same Monero,
that every harness file still exists, that each fixture still says where it came
from, and that the build sets the same `NO_AES` the vendored copy is compiled
with, because a fixture measured against a code path the app never runs is not
measuring the app.

## The Bitcoin half is not quite the same shape

`descriptors.json` is entirely Electrum's: every checksum is the output of its
`DescriptorChecksum`, and every finished descriptor is fed back through its
`parse_descriptor` before the file is written. Copying their answers is the
whole job.

`wallet-wires.json` is not, and the difference matters. Its `electrumBase43`
is Electrum's output, but its `bbqrFrames` are **ours**. What makes those worth
anything is not that they look like BBQr, it is that Coinkite's own `join_qrs`
reassembles them into the original PSBT. So `btc-emit.mjs` hands our frames to
their decoder and exits non-zero if they are refused. A regenerator that copied
the reference's frames instead would produce a fixture that tests nothing, and
`test/oracle.test.ts` checks that this one does not.

## What still is not covered

Nothing in here reaches a physical device. The oracle proves our bytes match
what Electrum, Coldcard's reference and Monero compute; it cannot prove a
Coldcard Q's camera resolves the QR on an iPhone's screen.
`docs/testflight.md` is where that gets written down once somebody has done it.
