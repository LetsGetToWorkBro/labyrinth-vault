# The sealed vault format

What a secret looks like when it is at rest, and why every byte of the layout
is where it is. Implemented in `src/keys/seal.ts`; this is the specification a
second implementation could be written from.

## The construction

```
passphrase ──Argon2id──▶ 32-byte key ──XChaCha20-Poly1305──▶ sealed blob
```

Two primitives, both boring on purpose, both checked in the tests against
implementations that share no code with ours: Argon2id against the reference C
implementation, the AEAD against libsodium.

## The layout

```
offset  size  field
0       3     magic "LVS"
3       1     version, currently 1
4       1     Argon2id passes (t)
5       4     Argon2id memory in KiB, big-endian (m)
9       1     Argon2id lanes (p)
10      16    salt
26      24    nonce
50      ...   XChaCha20-Poly1305 ciphertext, 16-byte tag at the end
```

The first 50 bytes are the header, and **the whole header is the associated
data** of the AEAD. That is the load-bearing decision: the KDF parameters, the
version, the salt and the nonce are covered by the same authentication tag as
the ciphertext, so a file whose header has been edited fails the tag check
rather than being obeyed. The test suite flips every byte of a sealed blob,
one at a time, and asserts each flip fails.

## Decisions, with reasons

**Argon2id (RFC 9106)** because passphrases are guessable and the defence is
making each guess cost real memory, which is the resource a GPU farm cannot
fake. Defaults are 64 MiB, t=3, lanes=1 — RFC 9106's second recommended
setting, which lands around a second on decade-old phones. Lanes stay at 1
because JavaScript runs them sequentially: raising it would cost the owner
time without costing an attacker anything.

**Calibration on the device** (`calibrateKdf`) rather than constants tuned on
a laptop: memory is walked upward until unsealing costs about a second on the
phone that will actually do it.

**Floors** (8 MiB, t≥1) because the header being authenticated protects
against forged weak parameters but not against our own future code sealing
weakly by accident.

**Ceilings** (512 MiB, t≤64, p≤4) because Argon2id allocates what the header
asks for *before* any authentication can happen. A hostile file claiming a
4 GiB memory cost would take the phone down at the moment of opening it; the
ceiling is enforced on the claim, before the allocation.

**XChaCha20-Poly1305** for its 24-byte nonce, big enough to draw at random
without birthday arithmetic. Salt and nonce are both drawn fresh per seal, so
the derived key itself is fresh per seal and nonce reuse cannot arise.

**NFKD normalisation** of the passphrase, the same rule BIP39 uses, so the
passphrase typed on one keyboard opens the vault sealed from another.

**No empty passphrases.** A caller wanting device-only protection generates a
random passphrase and keeps it in the platform keystore. That makes "the
keystore is the only lock" an explicit decision instead of an empty string
nobody meant.

## Properties, stated as promises

- A wrong passphrase and a damaged file produce the *same* error, on purpose.
  Distinguishing them is an oracle for an attacker and no help to the owner.
- Two seals of the same secret under the same passphrase share no bytes an
  observer can correlate.
- There is no recovery path in the format. The seed phrase on paper is the
  recovery path.
- Opening returns the parameters the blob was sealed under, so an app can
  offer "re-seal stronger" when a device upgrade allows it.
