# What is checked against whom

This project reimplements other people's formats. Monero's key derivation, its
ring signatures, its range proofs, its file formats, its address encoding, its
seed phrase; Electrum's descriptor checksum and base43; Coinkite's BBQr; the
BC-UR wires four other wallets animate. Every one of those is a claim that
somebody else's software will accept what this one produces.

A claim like that has exactly one honest form of evidence, and it is not a
test written here.

## The rule

**A round trip proves an encoder and a decoder agree. It proves nothing about
the format.**

This repository already knew that in one place. `README.md` says it about the
airgap wires, in as many words:

> Interop cannot be tested by round-tripping our own encoder through our own
> decoder, because a wrong word table or a swapped pair of random draws passes
> that happily and is silently unreadable by everybody else.

The rule was right and it was applied to one subsystem. Everywhere else, the
tests were round trips, and three real defects were living in the gap. All
three were found within a week of pointing upstream's own code at ours, and
none of them was found by any of the 900-odd tests that were already passing.

So the rule generalizes: **wherever this repository holds both halves of a
format, the tests will drift toward round trips, and round trips prove
nothing.** The remedy is to ask upstream. `oracle/` is where the asking
happens, and this file is the ledger of what has been asked.

## What it found

A ledger that only lists green rows is not evidence, so these go first.

| what | where it was | what it would have cost |
| --- | --- | --- |
| CLSAG hashed `C_offset` in the wrong slot of the aggregation vector, and hashed the unscaled `D` where Monero hashes `D·(1/8)` | `clsagSign`, mirrored exactly in `clsagVerify` | every Monero spend refused by the network on broadcast, with a bare failure and nothing to debug |
| `subaddressKeys` returned `a·B` at index (0, 0) where Monero returns `a·G` | `monerocrypto.ts`, mirrored in the test that covered it | nothing yet: no caller in `src/`, so the bundler drops it. It was waiting for the first caller that walked indices from zero |
| a `wallet2` file format claimed to be written that nothing could reach | `monerotx.ts` said "this vault writes this one" of a path with no screen and no bridge function | a documented capability that did not exist |

The first two are the same shape: a prover and a verifier, or an encoder and a
decoder, making the same mistake and agreeing perfectly. The second one had a
test asserting the wrong rule outright, with a confident comment explaining it.

## The ledger

Every row is a claim about somebody else's software, and the witness column is
what that software said. Nothing in this table is checked by this repository
against itself.

### Monero

| the claim | the outside witness | recorded in |
| --- | --- | --- |
| the six curve operations a transaction rests on | 720 vectors verbatim from `tests/crypto/tests.txt` | `monero-crypto.json` |
| `ge_fromfe_frombytes_vartime`, transcribed by hand from `crypto-ops.c` | 120 of those vectors, in isolation: no hashing before, no cofactor after | `monero-crypto.json` |
| view tags | `derive_view_tag` vectors from the same file | `view-tag.json` |
| the CryptoNight KDF | Monero's four official vectors in `tests/hash/tests-slow.txt`, run by `build.sh --check` against the same C the app ships | `vendor/cryptonight`, `CryptoNightVectorTests.swift` |
| addresses, subaddresses, integrated addresses, the twenty-five words | `get_account_address_as_str`, `get_account_integrated_address_as_str`, `hw::device::get_subaddress`, `ElectrumWords::bytes_to_words` | `monero-address.json` |
| the key-image export file's bytes | Monero's own `crypto.cpp` and `chacha.c` writing the same file | `monero-keyimages.json` |
| that its records pass the gate an importer applies | `crypto::check_ring_signature` on every record, `crypto::check_signature` on the envelope | `monero-keyimages.json` |
| that a real wallet imports the file, and puts each record where the offset says | `tools::wallet2::import_key_images`, on a watch-only wallet | `monero-import-key-images.json` |
| the `unsigned_tx_set` layout | Monero's own `binary_archive` serializing the real struct | `monero-unsigned-tx-set.json` |
| CLSAG, byte for byte | `rct::proveRctCLSAGSimple` with the RNG stubbed to a counter | `monero-clsag.json` |
| that our CLSAG verifies | `rct::verRctCLSAGSimple` over a signature we made | `monero-clsag.json` |
| the Bulletproof+ verifier | real mainnet proofs, which it had to be corrected until it accepted | `bulletproof-plus.json` |
| the Bulletproof+ prover | `rct::verRctSemanticsSimple` over a proof we made | `monero-verify-tx.json` |
| the transaction byte layout | three real mainnet transactions, whose ids our serializer reproduces | `monero-raw-tx.json` |
| that a transaction we build deserializes, and to the same id and weight | `parse_and_validate_tx_from_blob`, `get_transaction_hash`, `get_transaction_weight` | `monero-verify-tx.json` |
| that a transaction we build passes consensus verification | `rct::verRctSemanticsSimple` and `rct::verRctNonSemanticsSimple` | `monero-verify-tx.json` |

### Bitcoin

| the claim | the outside witness | recorded in |
| --- | --- | --- |
| BIP39, BIP32 and BIP84 derivation | BIP84's own published test vector, phrase and account key | `test/bitcoin.test.ts` |
| output descriptors and their checksums | Electrum's `DescriptorChecksum`, and its `parse_descriptor` reading ours back | `descriptors.json` |
| base43, the only wire Electrum's camera reads | Electrum's own `base_encode` | `wallet-wires.json` |
| BBQr frames | Coinkite's own `join_qrs` reassembling ours into the original PSBT | `wallet-wires.json` |
| the signature itself | `@scure/btc-signer`, which is not this repository, and Electrum reconstructing the same txid | `wallet-wires.json` |

### The wires and the storage

| the claim | the outside witness | recorded in |
| --- | --- | --- |
| BC-UR bytewords, the CBOR subset, the registry types, the fountain code | `@ngraveio/bc-ur`, the reference implementation | `ur-vectors.json` |
| Argon2id, XChaCha20-Poly1305, Keccak | the Argon2 reference C via `argon2-cffi`, libsodium, the published Keccak vectors | `primitives.json` |

## The harnesses

`oracle/` builds Monero at one pinned commit and asks it questions.

| harness | what it asks |
| --- | --- |
| `cryptonight.c` | `cn_slow_hash` at variant 0, checked against Monero's four official vectors |
| `keyimage.cpp` | writes a key-image export with Monero's crypto, and verifies its own records |
| `unsignedtxset.cpp` | serializes the real `wallet2::unsigned_tx_set` through Monero's archive |
| `importkeyimages.cpp` | links `wallet2.cpp` and imports a file **we** wrote |
| `clsag.cpp` | signs with `proveRctCLSAGSimple`, and verifies a signature **we** made |
| `verifytx.cpp` | runs the daemon's own verifiers over a transaction **we** built |
| `address.cpp` | encodes addresses and seed phrases with Monero's own encoders |

The last four run in the direction that matters: this repository writes and
Monero judges. The first three have Monero write and this repository match.
Both are worth having, and only the first kind existed until recently.

`oracle/btc.sh` does the same for Bitcoin, against Electrum and Coinkite's BBQr
reference at their own pinned commits.

## Two checks, and both are needed

The fixtures are committed, so `npm test` reads them without a compiler:

    npm test

That proves **this repository still produces what upstream said**. It does not
prove upstream still says it. For that:

    ./oracle/build.sh --check && node oracle/emit.mjs --check
    ./oracle/btc.sh && node oracle/btc-emit.mjs --check

which rebuilds every fixture from upstream's own source at the pinned commit
and diffs it against the tree. It is deliberately not part of `npm test`: it
needs a Monero checkout, a C++ toolchain and several minutes, and a suite with
a heavy optional step is a suite people learn to skip.

Several of the fixtures are also *rebuilt* by `npm test` rather than merely
read: the key-image files, the CLSAG, the whole transaction. A verdict about
bytes nobody can reproduce is a verdict a later change silently inherits, so
the suite re-derives the bytes each verdict was given to and requires them to
come out identical.

## What has no outside witness

Two kinds, and the difference matters.

**Ours by design.** Nobody else implements these, so there is nobody to ask.
The LV1 airgap envelope, the `ACCOUNT` and `XMR*` payloads, and the encrypted
storage format in `seal.ts` are this project's own. Both halves ship together
and are versioned together, which is what makes a round trip an adequate test
*here* and nowhere else. `docs/airgap-protocol.md` and
`docs/storage-format.md` write them down so a second implementation would be
possible.

**Genuinely untested, and stated as such.**

- **No running daemon has accepted a broadcast.** Everything a node decides
  from the bytes is now verified; everything it decides from chain state is
  not: that ring members exist and are old enough, that key images are unspent,
  that the fee clears the dynamic minimum.
  `MONERO_SEND_BROADCAST_VERIFIED` in `wallet/src/core/moneroreadiness.ts` is
  `false` and refuses a mainnet Monero spend while it is.
  `docs/monero-send.md` has the detail and the plan.

  This one is blocked on a network rather than on work. Every public Monero RPC
  endpoint reachable from a development container here resets the connection,
  mainnet and stagenet, on 443 and on the usual ports, while ordinary web hosts
  answer normally. `wallet/scripts/stagenet-send.ts` is written for somebody on
  a normal network and now finds its own coins, so the remaining human step is
  a funded stagenet address and one command.
- **No physical device.** The oracle proves bytes; it cannot prove a Coldcard
  Q's camera resolves a QR on an iPhone's screen, or that a scan finishes in a
  kitchen. `docs/testflight.md` is where that gets written once somebody has
  done it.
- **No real Cake or Feather has imported a file.** `wallet2` is the library
  all of them are built on and it is the code that decides, but it is not the
  application, and the transfers it held were put in memory by a harness.

None of these is waiting on cleverness. Two want hardware and one wants a
funded stagenet wallet.
