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

**Argon2id (RFC 9106)** because passphrases are guessable and the defense is
making each guess cost real memory, which is the resource a GPU farm cannot
fake. Defaults are 64 MiB, t=3, lanes=1, which is RFC 9106's second recommended
setting, which lands around a second on decade-old phones. Lanes stay at 1
because JavaScript runs them sequentially: raising it would cost the owner
time without costing an attacker anything.

**One set of parameters, not a calibrated one.** `calibrateKdf` exists in
`seal.ts` and walks memory upward from the default until a derivation costs
about a second, and nothing calls it: the bridge exposes a `calibrate` reply,
but `seal` takes no parameters across that bridge, so there is no path from a
measurement to a sealed blob. Every vault is sealed at the default above,
which is RFC 9106's second recommendation and is a fine answer rather than a
regression. It is written here because this document described calibration as
a live property for longer than it was one, and
`docs/native-primitives.md` carries the argument for what changing it would
now mean: the derivation is native and fast, so calibrating to a one-second
target would mean walking the memory parameter *up*, which is a real design
question and a separate piece of work.

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

**NFKD normalization** of the passphrase, the same rule BIP39 uses, so the
passphrase typed on one keyboard opens the vault sealed from another.

`passphraseToBytes` in `src/keys/seal.ts` is the one place text becomes bytes,
and `seal`/`unseal` take only bytes. A string cannot be wiped, and the
passphrase is the one secret a person types. The app normalizes in Swift, since
the text has to stop being text before it crosses into the engine, which makes
this the single behavior in the project implemented twice on purpose. Both
implementations are checked against `test/fixtures/primitives.json` rather than
against each other. A disagreement there would not fail loudly: it would
produce a vault that opens on the device that sealed it and on nothing else.

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
