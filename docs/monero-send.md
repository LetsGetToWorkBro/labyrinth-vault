# Monero sending: what is built, what is verified, and the one gate

This is the companion to `monero-sync.md`. Sync answers "what do I have"; this
answers "how do I spend it", and it is the harder half, because a spend is a
ring signature, a range proof, and a fistful of consensus rules rather than a
scan.

The short version: the pieces that authorize a spend and the pieces that could
*lose* money are built and tested. The last mile, a from-scratch Bulletproof+
range proof accepted by a real node, is not, and cannot be from a test
environment with no node, so the wallet refuses to broadcast a Monero spend
with real value on mainnet until a live acceptance has been recorded. Nothing
about that gate is hidden.

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
over the output commitments. Generating one is a few hundred lines of
inner-product-argument arithmetic whose Fiat-Shamir transcript must match the
network's exactly, and the only oracle for "exactly" is a live node. A
from-scratch Bulletproof+ verified only by round-trip against its own prover is
precisely the "unverifiable thing with no real blobs to check against" that
this repository refused when it put the chain scan on the JSON path instead of
an epee decoder. Writing it blind and shipping it behind a sign button would be
the same mistake wearing a different hat, so it is not written blind.

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
