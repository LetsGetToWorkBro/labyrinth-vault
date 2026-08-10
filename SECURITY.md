# Security

## Reporting

Found something? Email **info@labyrinth.vision**. Please do not open a public
issue for anything exploitable; everything else is welcome in the tracker.

There is no bounty programme. There is credit, gratitude, and a fix.

## Status, honestly

This repository is libraries, not an app, and **it has not been independently
audited**. The dependencies (the noble/scure cryptography family) have their
own audits; the code in this repository has tests, cross-checks against
implementations that share no code with it, and no outside review yet. Do not
hold funds you would miss with anything built on it.

## The threat model, in one table

| Threat | Defence | Where |
|---|---|---|
| Key theft over the network | There is no network code, enforced by a test that walks the source and a build that loads no DOM types | `test/no-network.test.ts` |
| Compromised companion sends a valid-but-hostile transaction | The confirmation screen; the vault renders everything and a person approves | `src/keys/psbt.ts` |
| PSBT lies about which output is change | Ownership re-derived from our own key, never read from the file; a false claim is fatal | `describePsbt` |
| PSBT hides the fee by omitting input values | Fatal; an unknowable fee is not displayable | `describePsbt` |
| PSBT requests SIGHASH_NONE / SINGLE / ANYONECANPAY | Fatal at describe time, and the signing call independently pins SIGHASH_ALL | `describePsbt`, `signPsbt` |
| UI describes one transaction and signs another | `signPsbt` requires the shown summary and checks its digest against the bytes | `signPsbt` |
| Misread camera frames assembling wrong bytes | Checksums fail closed; fuzzed with the property that success implies byte-exact payload | `test/fuzz.test.ts` |
| Hostile QR claims absurd sizes (memory DoS) | Caps on part counts and message sizes, on both wires; KDF ceilings checked before allocating | `envelope.ts`, `ur.ts`, `seal.ts` |
| Seed at rest | Argon2id + XChaCha20-Poly1305, parameters authenticated with the ciphertext | `src/keys/seal.ts` |
| Dependency compromise via version ranges | Every version exact-pinned; the transitive closure is walked by a test and must stay inside the audited family | `test/supply-chain.test.ts` |
| Broken build generating wrong keys | Self-test against outside vectors at every launch; nothing runs if it fails | `src/selftest.ts` |
| RNG failure at signing time | Deterministic nonces (RFC 6979) in the signer | `@scure/btc-signer` |

## What is explicitly out of scope

- **A person who approves without reading.** The screen is the boundary; no
  code substitutes for reading the destination.
- **The vault device compromised while unlocked.** An attacker running code on
  the vault with the passphrase has the keys. The airgap narrows how code gets
  there; it cannot make the device trustworthy against itself.
- **Memory forensics against a live process.** Secrets are wiped after use
  (`src/keys/wipe.ts`), and that file says plainly why JavaScript cannot make
  wiping a guarantee. Treat it as narrowing a window, not closing one.
- **Timing side channels on the vault.** The primitives are constant-time
  (noble); our encoding layers are not, and operate on data an attacker who
  could measure them would already have. An adversary positioned to time this
  offline device is an adversary who has already won by simpler means.

## Verifying this yourself

```sh
git clone https://github.com/LetsGetToWorkBro/labyrinth-vault
cd labyrinth-vault
npm ci        # installs exactly the lockfile, integrity-checked
npm test      # 244 tests, including the cross-implementation vectors
npm run typecheck
```

The claims above are tests, not prose: delete a defence and the suite goes
red. Several were verified by mutation — the change-swap check, the sighash
check, the KDF ceilings, the part-count caps and the approval digest were each
removed in turn to confirm tests actually fail.
