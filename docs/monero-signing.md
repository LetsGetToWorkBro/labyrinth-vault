# Monero signing: what exists, and what is between here and there

The vault holds Monero keys today. It makes a seed, derives the spend and view
keys, encodes the address, prints the twenty-five word phrase, and exports a
watch-only view. What it cannot do is spend, and this document is the honest
account of why. "Coming soon" is not an engineering statement, and the gap is
four distinct pieces of work rather than one.

The short version: the primitives are built and checked against Monero's own
test vectors. The container format and the signature scheme are not built, and
neither is being guessed at.

## What is built

`src/keys/monerocrypto.ts` implements the six operations every Monero
transaction rests on, and `test/monerocrypto.test.ts` checks all six against
720 vectors taken verbatim from monero-project's `tests/crypto/tests.txt`, the
file their own unit tests read. 120 vectors each:

| Operation | What it is for |
| --- | --- |
| `hash_to_scalar` | Every derived scalar. Keccak, then reduction into the group. |
| `generate_key_derivation` | The Diffie-Hellman step that finds your own outputs. |
| `derive_public_key` | The one-time address an output was really paid to. |
| `derive_secret_key` | Its private half, which only the spender can compute. |
| `hash_to_point` | `ge_fromfe_frombytes_vartime`, the map onto the curve. |
| `generate_key_image` | The value that stops an output being spent twice. |

Five of those six are compositions of Keccak, scalar arithmetic and ed25519
group operations, all of which come from audited libraries. The sixth,
`ge_fromfe_frombytes_vartime`, has no audited implementation anywhere. It is an
Elligator-style map that predates the standard hash-to-curve constructions and
exists only in Monero's `crypto-ops.c`. It is transcribed by hand in this
repository, which is precisely why the Monero project's own vectors for it,
with nothing wrapped around them, are in the test suite.

`src/keys/monerotx.ts` recognizes Monero's own file formats by name. All six
magic strings from `src/wallet/wallet2.cpp`:

- `Monero unsigned tx set`: the file a watching wallet writes for an offline
  signer. This is the one that matters.
- `Monero signed tx set`: what comes back.
- `Monero multisig unsigned tx set`: the same, for multisig.
- `Monero key image export`: which of your outputs are already spent.
- `Monero multisig export`: multisig information exchange.
- `Monero output export`: which outputs you own.

Each literal in wallet2.cpp ends in a version byte. That byte is deliberately
not part of the match: a file from a newer Monero should still be *named*
rather than reported as unrecognised bytes. The version seen and the version
this code was written against are both reported.

Each entry carries two booleans, and they are two rather than one because they
move for different reasons.

- **`readable`** is whether this build can open the container and describe
  what is inside it. It is true for `Monero unsigned tx set` and false for the
  other five, and it moves as readers get written. When this document was
  first drafted it was false for everything.
- **`signable`** is whether the vault will produce a signature over one. It is
  false for all six and is not waiting on work. See "It reads and does not
  sign" below: the obstacle is not a missing reader, it is that the file is
  the sending wallet's account of its own transaction.

Recognition is not a feature for its own sake. Consider the alternative: a
signing device tells somebody their perfectly good `unsigned_monero_tx` "is not
a transaction", and they go off to re-export a file that was never wrong, or
conclude the app is broken. Naming the file says what it is and what the vault
will do with it.

## Done since this document was written: CryptoNight, and the key-image export

Two of the four layers below are no longer open, and they are struck through
rather than deleted because the reasoning that put them there was right and is
worth keeping next to what changed.

**CryptoNight is built, and not by implementing it.** `vendor/cryptonight` is
Monero's own C at tag v0.18.5.1, byte-pinned the same way the Argon2 reference
is, reached from the engine through a host function the way Argon2id is. The
objection below still stands word for word: four extra hash functions, none in
the audited dependency set, all in the path of a file that holds money. The
answer was that none of them got implemented. `docs/native-primitives.md` has
the argument, which is that CryptoNight has four test vectors and no
specification outside Monero's source, so a second implementation would have
been checked by nothing.

**The key-image export blob is built.** `src/keys/moneroexport.ts` writes and
reads the file `wallet2::export_key_images` writes: the plaintext magic, the
8-byte IV, ChaCha20 under the CryptoNight-derived key, and the 64-byte
signature. Inside it, the offset, the two account public keys, and one
32-byte key image with a 64-byte ring signature each.

That last part is the thing to notice, because layer 2 below predicted
otherwise. **The key-image export does not use Boost at all.** It is
hand-rolled fixed-width concatenation in `wallet2.cpp:13895`; no varints, no
archive, no class-version tracking. It was never between here and the payload
that makes a watch-only balance correct. That was worth finding out before
writing an archive reader nobody needed yet.

**And the Boost problem is smaller than layer 2 below says, for the
transaction set too.** That section was written from the assumption that
`unsigned_tx_set` is a Boost archive. Reading `wallet2.cpp` rather than
assuming:

- `dump_tx_to_str` writes with `binary_archive<true>` (line 7678). That is
  Monero's *own* serialization framework, not Boost: varints and fixed-width
  fields, defined by source in `src/serialization/`, with no object tracking,
  no pointers and no class-version registry.
- `parse_unsigned_tx_from_str` (line 7712) reaches Boost only for version
  `\003`, and only when `m_load_deprecated_formats` is set, which is off by
  default. The current prefix is `"Monero unsigned tx set\005"`.
- Every other `boost::archive` in that file is the **wallet cache**, which is
  a local file and not an airgap payload at all.

So the remaining work is a reader for Monero's own binary archive, which is a
much more tractable thing than matching Boost's behavior: it has a written
form in the source rather than only an implementation. Layer 2 below is left
in place because the reasoning about *why* matching a library by behavior is
bad was sound; it was pointed at the wrong library.

`test/moneroexport.test.ts` holds the TypeScript to a fixture generated by
Monero's own `crypto.cpp` and `chacha.c`, with the RNG stubbed to a counter so
the signatures are reproducible. That generator is committed at `oracle/` and
regenerates the fixture on demand, so the numbers can be re-derived rather than
believed. Meanwhile
`ios/LabyrinthVaultKDFTests/CryptoNightVectorTests.swift` holds the vendored C
to the same fixture's chacha key. Neither language is the other's oracle.

## Done since: the archive and the unsigned set

`src/keys/binaryarchive.ts` reads Monero's own serialization format, and
`src/keys/monerounsigned.ts` reads an `unsigned_tx_set` out of it, envelope
included. `oracle/src/unsignedtxset.cpp` includes `wallet/wallet2.h` and
serializes the real `wallet2::unsigned_tx_set`, so no struct layout is
transcribed anywhere; the fixture carries both the bytes Monero wrote and a
description of what went in, and the test turns the first into the second.

Two encodings in that format are invisible from the header and both were wrong
in the first draft:

- a `std::tuple` writes a leading count, exactly as a pair writes its `2`;
- an unsigned integer wider than a byte is a **varint** inside a container,
  pair or tuple, and **fixed-width** as a struct field. `tx_source_entry::amount`
  and `tx_destination_entry::amount` are the same type with different
  encodings, eleven lines apart in the same header.

The oracle caught both. A reader checked only against itself would not have.

**It reads and does not sign, and that is not a staging post.** Reading a
construction plan and building a transaction from one are different jobs. The
second needs a confirmation screen that re-derives every destination from the
vault's own keys before anybody is asked to approve anything, because the file
is the *sender's* description of their own transaction and a watch-only wallet
that lied about a destination produces a file that outlines beautifully.
`outlineTx` is arithmetic over a claim and its own source says so.

## Done since: the screen that shows it

A reader nothing can reach is not a capability, and for one commit that is
what this was: the engine could open an `unsigned_tx_set` and the app still
answered every wallet2 file with a blanket refusal. Three things closed that.

- **A wire kind.** `XMRFILE` in `src/airgap/envelope.ts` carries one of
  Monero's own files, byte for byte, to be read. It is deliberately not
  `XMRUNSIGNED`, which is this project's own request format and the only thing
  the vault signs. A payload arriving on it has been assembled and checksummed,
  which is what makes describing it possible at all: `scan` sees one frame and
  `describe` is the Bitcoin transaction reader, so both of those still refuse.
- **A host function.** `moneroFile` in `src/bridge/host.ts` requires an
  unlocked vault, opens the container, and answers with what the file says.
  A file it will not open is still an answer rather than a failure: the reply
  names the file and carries the reason, because "this is a Monero unsigned
  transaction set and it belongs to a different wallet" is more use than a
  blank refusal, and there is no fail-closed decision resting on it.
- **A screen.** `ios/LabyrinthVault/Screens/MoneroFile.swift`, reached by its
  own route. It says what the file is, what it claims, whose claim that is,
  and that the vault will not sign it. The design constraints are written at
  the top of that file and guarded in `test/app-wiring.test.ts`: no lever that
  signs, no hold, no use of the app's one green (which on the confirmation
  screens means "the vault re-derived this and it matched"), the caveat placed
  above the figures rather than under them, and a route that touches neither
  end of the signing path.

The last point on that screen is the one that keeps it from being a dead end:
it names the route that does work, which is to start the payment in the
Labyrinth wallet and let the vault check it before anybody approves anything.

## What is not built

Two layers, in the order they have to be built.

### ~~1. CryptoNight (`cn_slow_hash`)~~ (vendored, see above)

The contents of every file above are encrypted, and the key comes from
`crypto::generate_chacha_key`, which is `crypto::cn_slow_hash`, Monero's
original proof-of-work function, over the relevant secret key, looped
`kdf_rounds` times.

CryptoNight is not a hash function anybody would choose for a key derivation
today; it is there for historical reasons and it is load-bearing regardless.
Implementing it means:

- a 2 MiB scratchpad and roughly half a million memory-hard rounds;
- an AES round function (the raw round, not a mode);
- Keccak with the full 1600-bit state exposed, not just a 256-bit digest;
- **four additional hash functions**: Blake-256, Groestl-256, JH-256 and
  Skein-256, one of which is selected by the low bits of the state to produce
  the final result.

That is four hash functions this repository does not have, none of them
available in the audited dependency set it restricts itself to, all of them in
the path of decrypting a file that holds money. Until this exists, the
container cannot be opened at all.

### 2. Boost's portable binary archive (only for the deprecated `\003` form)

**Read the correction above first.** This section applies to version `\003`
of the unsigned transaction set, which current Monero will not even load
unless `m_load_deprecated_formats` is turned on. The current `\005` form uses
Monero's own `binary_archive`, and the paragraph below is kept because its
argument about matching a library by behavior is the right argument, aimed at
the wrong target.

Inside the encryption is a C++ object graph serialized by
`boost::archive::portable_binary_oarchive`. It is not a documented wire format
with a specification to implement against; it is defined by the behavior of a
particular library, including its class-version tracking, its object tracking,
and its handling of pointers and containers.

Writing a reader for it means matching an implementation, and the way to know
you have matched it is differential testing against real archives, which needs a
Monero wallet producing them.

### 3. The `unsigned_tx_set` structure

What the archive holds: `tx_construction_data` for each transaction, meaning
sources with their ring members and real-output index, destinations, the change
address, subaddress indices, extra, unlock time and the RCT config, plus the
transfer details the signer needs.

This layer is readable from wallet2's headers and is the least uncertain of the
four. It is also useless without layers 1 and 2.

### 4. CLSAG and Bulletproofs+

The signing itself, which is two separate cryptographic constructions:

- **CLSAG**, the ring signature scheme in use since Monero v12. It proves that
  one of the ring members is yours and that the key image is the right one for
  it, without saying which member.
- **Bulletproofs+**, the range proof that shows every output amount is in range
  without revealing it.

Both must produce output the network accepts. Both are the kind of code where a
subtle error is not a rejected transaction but a leak: a range proof that
reveals an amount, a ring signature that narrows the anonymity set, a key image
that links two spends that were meant to be unlinkable.

**Both of these now exist here, and this section is kept because the reasoning
still applies to what is left.** `clsagSign` and `clsagVerify` are in
`src/keys/monerosign.ts`; `proveBulletproofPlus` and `verifyBulletproofPlus`
are in `src/keys/bulletproofplus.ts`. The prover is checked against the
verifier, and the verifier against real proofs taken off the chain, which is
the arrangement that makes a second implementation of somebody else's
cryptography defensible at all.

What is *not* done is the differential test: generating a set with a real
Monero wallet, signing it here, and having a daemon accept the result. The
wallet2 container is no longer on that list in the reading direction (see
"Done since", above); writing a `signed_monero_tx` back into one is, and is
not started. The correction worth carrying forward is that the plaintext of
these containers is **not** Boost.Serialization.
`save_tx` and `sign_tx` use Monero's own `binary_archive`
(`wallet2.cpp:7703`, `:8016`), and the key image export uses no archive at all,
just fixed-width concatenation written by hand (`:13933-13946`). That was
recorded wrongly here and in `src/keys/monerotx.ts` for some time, and it
pointed at a Boost reader nobody needs.

## Why this is where it stops

The requirement this repository holds itself to is that anything which can lose
money is checked against an implementation that is not ours. For layers 1 to 4
that means differential testing against a real Monero wallet or daemon:
generating an unsigned set, signing it here, and having Monero accept the
result.

That is not possible in the environment this was written in, and shipping
unverified signing code and calling it done would be the exact failure this
project exists to avoid: a well-formed transaction that is subtly wrong, which
looks identical to a correct one right up until it costs somebody their
privacy or their coins.

So: the floor is laid and it is checked. The rest is named rather than
half-built.

## The order of work, when it resumes

1. ~~CryptoNight~~. Done, by vendoring Monero's C rather than writing a
   second implementation. Checked against `tests/hash/tests-slow.txt`.
2. ~~The key-image export blob~~. Done, and it turned out to need no archive
   reader at all: the format is fixed-width concatenation.
3. ~~A reader for Monero's own `binary_archive`~~. Done, in
   `src/keys/binaryarchive.ts`, against archives that Monero's own
   `binary_archive<true>` wrote.
4. ~~`unsigned_tx_set` parsing on top of it~~. Done, in
   `src/keys/monerounsigned.ts`, including the
   `encrypt_with_view_secret_key` envelope around it, so a whole file reads
   end to end. It does **not** sign one; see below.
5. ~~A way for a person to see any of that~~. Done: the `XMRFILE` wire kind,
   `moneroFile` on the bridge, and a read-only screen. Listed as its own step
   because it was briefly skipped, and a reader with no route to it is
   indistinguishable from no reader at all.
6. CLSAG and Bulletproofs+, tested against the Monero project's own vectors and
   then end to end against a daemon on testnet, then stagenet, before anything
   touches mainnet.

Step 6 also needs the thing the Bitcoin side already has: a confirmation screen
that shows what is actually being signed, re-derived from the vault's own keys
rather than read from the file. That is the security, and it does not come free
with the signature.
