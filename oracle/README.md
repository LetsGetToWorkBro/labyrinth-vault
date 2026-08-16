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
| `build.sh` | shallow-clones that Monero, compiles it, builds the harnesses |
| `emit.mjs` | runs the harnesses and writes (or checks) the fixtures |
| `src/keyimage.cpp` | the key-image export blob, through `wallet2`'s own calls |
| `src/unsignedtxset.cpp` | a real `unsigned_tx_set`, through Monero's own binary archive |
| `src/importkeyimages.cpp` | hands our finished file to the real `wallet2::import_key_images` |
| `src/clsag.cpp` | a CLSAG from `rct::proveRctCLSAGSimple`, and its verdict on ours |
| `src/verifytx.cpp` | a whole transaction of ours, through the daemon's own verifiers |
| `src/cryptonight.c` | `cn_slow_hash` at variant 0, from upstream |
| `src/rng-counter.c` | replaces Monero's RNG with a byte counter |
| `src/mlock-stub.cpp` | `epee::mlocker`, which only pins pages against swap |
| `src/unreachable.c` | the CryptonightR JIT and RandomX, which abort if reached |
| `src/wallet-unreachable.cpp` | the same for the wallet link: RandomX, the JIT, one daemon accessor |
| `src/shim/boost/…` | fourteen lines, so `warnings.h` resolves |
| `btc.sh` | clones Electrum and Coinkite's BBQr at their pinned commits |
| `btc-emit.mjs` | runs both against our code and writes (or checks) the Bitcoin fixtures |

The five stub files are ours and are the only code here that Monero did not
write. Each one exists so that a piece of upstream these harnesses never
execute does not have to be linked; none of them stands in the path of a
number that ends up in a fixture. Both `unreachable` files abort rather than
returning something plausible, so a wrong guess about what is reachable fails
loudly at the line instead of quietly in a fixture.

## The wallet harness runs in the other direction

Everything else here has Monero write and this repository match. `--check`
passes when our bytes are Monero's bytes.

`importkeyimages` is the reverse, and it is the one that matches what a person
actually does with the file. It links `wallet2.cpp` itself, builds a watch-only
wallet, and hands it a key-image export that **this repository's TypeScript
wrote**. The judge is `tools::wallet2::import_key_images` and the thing being
judged is our output.

That closes a claim byte comparison cannot reach. `import_key_images` pairs
record n with `m_transfers[n + offset]`, by position, and nothing in the file
names an output. A file whose records are in the wrong order is still well
formed, still fully signed, and still wrong: every signature in it verifies,
against outputs the importing wallet is not holding at those positions. The
fixture records what wallet2 did with the right order and with four wrong ones.

Linking `wallet2.cpp` is a much heavier build than the header-only path the
other harnesses take: about a hundred translation units and a few minutes, plus
the host packages `PINNED.json` lists. `build.sh` checks for those and names
them before it starts. Objects are cached in `.work/wobj`, so a second run is
quick.

One thing to know about the accepting outcome. Given a file that checks out,
`import_key_images` gets past every offline gate and then asks a daemon which
of the images are already spent. There is no daemon, so the call ends in
`no_connection_to_daemon`, and that is the good result: reaching the network
means everything decidable offline was decided in the file's favour, and the
wallet's transfers have already been written. So the fixture records those
transfers, which is the actual evidence. Not "nothing objected" but "record n
landed on transfer n plus offset".

## What linking the wallet was actually worth

`importkeyimages` was the reason to take on the heavy build. `clsag` and
`verifytx` came almost free once `rctSigs.cpp` was compiling, and they are the
ones that found something.

The Monero project ships no fixed CLSAG vector: its own tests generate random
keys, sign, and verify. So `clsagSign` and `clsagVerify` in this repository
were each other's only witness, and they shared two mistakes in the
aggregation hash. A prover and a verifier that share a mistake agree perfectly:
the round trip was green, every tamper case passed, the whole suite passed, and
the signatures would have been refused by the network.

`clsag sign` asks `rct::proveRctCLSAGSimple` for the vector that does not
exist, with the RNG stubbed so it is reproducible, and hands the same counter
bytes to the TypeScript. `clsag verify` runs `rct::verRctCLSAGSimple` over a
signature the TypeScript made, which is the direction that matters. `verifytx`
does the same for a whole transaction, through `parse_and_validate_tx_from_blob`,
`verRctSemanticsSimple` and `verRctNonSemanticsSimple`.

Two habits are worth copying from this. The harnesses run **negative** cases as
well as positive ones, because "Monero accepted it" is only interesting beside
"and here is what Monero refuses". And `verifytx` takes `VERIFYTX_LOG=1`,
because both verifiers say why they refused at log level 1 and then discard it;
without that, a rejection is a wall. The first rejection it printed was my own
harness forgetting that the key image is reconstructed rather than
deserialized, not the code under test.

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

It needs a Monero checkout and a C++ toolchain with boost headers, and the
wallet harness needs several minutes on top. A suite that fetched half a
gigabyte of upstream C++ on every run is a suite people learn to skip, and a
check that gets skipped is worse than one that is honestly manual.

`test/oracle.test.ts` runs instead, and checks the things that actually drift:
that `PINNED.json` and `vendor/cryptonight/MANIFEST.json` name the same Monero,
that every harness file still exists, that each fixture still says where it came
from, and that the build sets the same `NO_AES` the vendored copy is compiled
with, because a fixture measured against a code path the app never runs is not
measuring the app.

It does one thing more for the import fixture. That fixture is a set of
verdicts about specific bytes, so the suite rewrites those bytes from the
recorded seed, outputs, order, offset and randomness and requires them to come
out identical. Without that, a later change to the writer would inherit an
answer that was given to a different file.

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

Nothing in here reaches a physical device or a running network. The oracle
proves our bytes match what Electrum, Coldcard's reference and Monero compute,
that Monero's own wallet imports our key-image export, and that Monero's own
consensus verifiers accept a transaction we built. It cannot prove a Coldcard
Q's camera resolves the QR on an iPhone's screen, and it cannot prove a daemon
relayed anything: everything a node decides from chain state -- that the ring
members exist and are old enough, that the key images are unspent, that the fee
clears the minimum -- is outside what any of this reaches.
`docs/testflight.md` is where the device half gets written down once somebody
has done it, and the gate in `wallet/src/core/moneroreadiness.ts` is where the
network half stays honest.

Nor does it reach a real wallet's user interface. `importkeyimages` is
`wallet2`, which is the library Cake, Feather and `monero-wallet-cli` are all
built on, and it is the code that decides whether an import succeeds. It is not
those applications, and it is running against transfers this harness put in
memory rather than transfers a wallet found on the chain.
