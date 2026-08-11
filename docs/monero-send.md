# Monero sending: what is built, what is verified, and the one gate

This is the companion to `monero-sync.md`. Sync answers "what do I have"; this
answers "how do I spend it", and it is the harder half, because a spend is a
ring signature, a range proof, and a fistful of consensus rules rather than a
scan.

The short version: the whole path is built and tested, from the unsigned set
to the raw bytes a node relays, with every piece anchored to the chain where
an anchor exists: the range proof verifier to real mainnet proofs, the
serializer to real transaction ids, the prover and the assembly to those
anchors in turn. The one thing a test environment with no node cannot produce
is a live node accepting a fresh transaction, so the wallet refuses to
broadcast a Monero spend with real value on mainnet until a stagenet
acceptance has been recorded. Nothing about that gate is hidden.

## The division of labor

A Monero spend is signed by the airgapped vault, which holds the spend key and
has no network. It cannot choose decoys (that needs the chain) or price the fee
(that needs the node). So the online wallet does everything a view key can do,
hands an unsigned transaction set across the airgap, and the vault signs it.
This is monero-wallet-cli's cold-signing split, and it is the only arrangement
where the online device never touches a spend key.

**Online (`wallet/src/core/`):**

- `decoys.ts` chooses the ring: a gamma distribution over output age with the
  Monero Research Lab's parameters, so the real output looks like every other
  recent spend. Wrong decoys cost privacy, not money, and the network does not
  check them, so this is verifiable here and its failure mode is bounded.
- `monerospend.ts` selects coins, computes the fee from the transaction's
  estimated weight, and, the line that matters most, sends the change to the
  account's own address. There is no parameter for a change address, because
  the one time it would be set to something else is the one time money is lost.
- `moneroplan.ts` ties them to the node: fetch the distribution, build a ring
  per input, fetch the members, and assemble the unsigned set. It refuses a
  node that returns a different output at the real ring position than the one
  being spent.

**Offline (`src/keys/`):**

- `monerosign.ts` is CLSAG, the ring signature. It generates and verifies, it
  round-trips at every ring position and size, and every adversarial tamper
  (message, ring key, commitment, pseudo-out, response scalar, key image)
  breaks verification. Its domain constants are transcribed from Monero's
  `rctSigs.cpp`.
- `bulletproofplus.ts` verifies the range proof, and it is anchored the hard
  way: against three real Bulletproof+ proofs pulled from mainnet transactions,
  in `test/fixtures/bulletproof-plus.json`. It accepts every proof the network
  accepted and rejects the moment any field is disturbed, so it agrees with
  consensus about what a valid range proof is. The same file holds the
  **prover**, and the prover is never checked against itself: every proof it
  makes must satisfy the consensus-anchored verifier, over commitments built
  by the same `commit` the scan proves amounts with.
- `monerowire.ts` is the transaction wire format, anchored the same way: the
  serializer reproduces three real mainnet transaction ids byte for byte from
  their parsed fields, in `test/fixtures/monero-raw-tx.json`. The id is the
  Keccak of the serialized sections, so there is no partial credit; one byte
  wrong anywhere and the test fails. The same functions serialize a fresh
  spend, which is what makes "the node will parse it" a tested claim.
- `monerobuild.ts` is the final assembly: parse the unsigned set, re-prove
  every input from the vault's own keys (the one-time key must re-derive, the
  claimed amount must recommit to the on-chain commitment), build the outputs
  with their view tags and encrypted amounts, close the balance on the curve,
  prove the range, sign every ring, and emit the raw hex plus its id. The test
  then does what the network and the receiver would do to the bytes: re-parse
  them independently, check the money equation, re-verify every proof, and run
  the receiver's own scan, which finds the payment and decrypts the exact
  amount. The bridge exposes it as `moneroDescribe` and `moneroSign`, the same
  describe-then-approve contract the Bitcoin signer uses.

## Where a mistake loses money, and where it does not

Worth stating plainly, because "signing code" sounds like the dangerous part.
It is not the part that loses money.

- **A wrong signature or a wrong range proof is rejected by the network.** The
  transaction does not relay; the coins stay exactly where they were. An
  inconvenience, not a loss.
- **A wrong change address loses money**, irreversibly, and it looks like a
  successful send. That is ordinary arithmetic and a single address, both here
  in `monerospend.ts`, both tested to the piconero, both mutation-checked.
- **A wrong destination loses money**, and the defense is the same as Bitcoin's:
  the vault renders the destination and the amount, and a person approves them.
  No cryptography substitutes for reading that screen.

So the risk that the word "signing" evokes and the risk that actually exists
are different risks, and the actually-existing one is in the boring, tested,
integer part.

## The verification frontier, stated exactly

CLSAG round-trips and survives every tamper. But the Monero project ships no
fixed CLSAG vector, its own tests generate random keys and round-trip them,
so "round-trip plus adversarial plus constant-anchored" is as far as a test
environment reaches. The one thing it cannot establish is that a real monerod
accepts the bytes.

A complete broadcastable transaction also needs a **Bulletproof+ range proof**
over the output commitments. Verifying one is a few hundred lines of
inner-product-argument arithmetic whose Fiat-Shamir transcript must match the
network's exactly, and the only honest oracle for "exactly" is the chain
itself. So the verifier was not written blind: it is checked against real
mainnet proofs, and the transcription was corrected until it accepted them.
That work already paid for itself once. The generators are
`8 * fromfe(keccak(keccak(...)))`, two Keccak rounds because `rct::hash_to_p3`
hashes the argument that `get_exponent` had already hashed, and a verifier
written from the algorithm alone would have used one round, produced generators
that look perfectly valid, and rejected every real proof with no clue why. The
fixtures are the clue. The **prover** is written against that verifier, which
is the whole reason the verifier came first: a from-scratch Bulletproof+
verified only by round-trip against its own prover would be the "unverifiable
thing with no real blobs to check against" that this repository refused when
it put the chain scan on the JSON path instead of an epee decoder. Here the
order is reversed and the circle is broken: real chain proofs anchor the
verifier, and the verifier judges the prover.

The serializer got the same treatment. Reproducing three real transaction ids
from parsed fields proves the byte layout against consensus, and the assembly
test closes the loop from the other end: the receiver's own scan, run on the
emitted bytes, finds the output, matches the view tag, decrypts the amount,
and proves it against the commitment. What no test here can produce is a
node's acceptance of a whole fresh transaction, and that is the one claim
still marked unverified.

## The gate

`wallet/src/core/moneroreadiness.ts` holds one constant,
`MONERO_SEND_BROADCAST_VERIFIED`, and it is `false`. While it is false, the
wallet's broadcast chokepoint refuses a Monero spend on mainnet, with a
sentence that says why. It does **not** refuse to build a spend, sign one, or
broadcast one on stagenet or testnet, because that is exactly how the evidence
to lift the gate gets made.

The gate is a source constant, not a config flag, on purpose. A flag someone
can flip is a gate that gets flipped. The constant changes only in a commit
that also records the evidence: a stagenet transaction id, built by this code,
that a real node accepted. That commit is the one that fills in the section
below, and the test in `test/moneroplan.test.ts` is the tripwire that forces
the constant and the evidence to move together.

## Recorded live acceptances

_None yet._ When the first stagenet broadcast built by this code is accepted,
its transaction id and the node that accepted it go here, and the gate lifts in
the same commit.
