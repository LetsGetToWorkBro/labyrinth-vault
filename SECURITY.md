# Security

## Reporting

Found something? Email **info@labyrinthwallet.com**. Please do not open a public
issue for anything exploitable; everything else is welcome in the tracker.

There is no bounty program. There is credit, gratitude, and a fix.

## Status, honestly

This repository is libraries, not an app, and **it has not been independently
audited**. The dependencies (the noble/scure cryptography family) have their
own audits; the code in this repository has tests, cross-checks against
implementations that share no code with it, and no outside review yet. Do not
hold funds you would miss with anything built on it.

## The threat model, in one table

| Threat | Defense | Where |
|---|---|---|
| Key theft over the network | There is no network code, enforced by a test that walks the source and a build that loads no DOM types | `test/no-network.test.ts` |
| Compromised companion sends a valid-but-hostile transaction | The confirmation screen; the vault renders everything and a person approves | `src/keys/psbt.ts` |
| PSBT lies about which output is change | Ownership re-derived from our own key, never read from the file; a false claim is fatal | `describePsbt` |
| PSBT hides the fee by omitting input values | Fatal; an unknowable fee is not displayable | `describePsbt` |
| PSBT requests SIGHASH_NONE / SINGLE / ANYONECANPAY | Fatal at describe time, and the signing call independently pins SIGHASH_ALL | `describePsbt`, `signPsbt` |
| UI describes one transaction and signs another | `signPsbt` requires the shown summary and checks its digest against the bytes | `signPsbt` |
| Misread camera frames assembling wrong bytes | Checksums fail closed; fuzzed with the property that success implies byte-exact payload | `test/fuzz.test.ts` |
| Hostile QR claims absurd sizes (memory DoS) | Caps on part counts and message sizes, on both wires; KDF ceilings checked before allocating | `envelope.ts`, `ur.ts`, `seal.ts` |
| Output paying a script with no readable address | Fatal when it carries money; the destination is what a person is meant to read, and there is none | `describePsbt` |
| Approval computed against a different keyring | Summary carries a `walletId`; `signPsbt` refuses a mismatch | `signPsbt` |
| A screen showing fewer destinations than the transaction pays | The wire carries every output; the screen renders one zone per payee, and a test fails if the model collapses to one | `src/bridge/summary.ts`, `test/app-wiring.test.ts` |
| Screen and reader disagreeing about a number | Every amount is formatted once, by `formatBtc`; a test fails if any Swift file converts satoshis itself | `src/bridge/summary.ts`, `test/app-wiring.test.ts` |
| Secrets left unwipeable in memory | Everything secret is a `Uint8Array`; strings are immutable and cannot be zeroed, so becoming text is an explicit `reveal*` call, and a test enforces it | `src/keys/monero.ts`, `test/no-network.test.ts` |
| Seed at rest | Argon2id + XChaCha20-Poly1305, parameters authenticated with the ciphertext | `src/keys/seal.ts` |
| Tuning weakening the vault | Calibration walks up from the default and can only strengthen | `calibrateKdf` |
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
- **Secrets that a person has to read.** A recovery phrase must become text to
  be written down, and a view key must become text to cross the wire. Those
  strings are immutable and therefore permanent for the life of the process.
  The design does not pretend otherwise; it narrows the surface to three
  functions with `reveal` in their names (`revealMnemonic`, `revealSecretHex`,
  `revealWallet`), so "where does a secret become permanent?" has a short,
  greppable answer, and a test fails if that list grows. Everything else stays
  in wipeable bytes: every wallet object, every seal, every signature.
- **Wiping of internal scratch buffers.** Intermediates are zeroed
  (`mnemonicFromEntropy`, `openFromMnemonic`, `deriveKey`), but a local buffer
  that nothing else can reach has no observable behavior, so unlike every
  other claim on this page it cannot be mutation-tested. Removing those calls
  breaks no test. It is kept by review, and it is listed here rather than
  counted among the things the suite proves.
- **Timing side channels on the vault.** The primitives are constant-time
  (noble); our encoding layers are not, and operate on data an attacker who
  could measure them would already have. An adversary positioned to time this
  offline device is an adversary who has already won by simpler means.

## Verifying this yourself

```sh
git clone https://github.com/LetsGetToWorkBro/labyrinth-vault
cd labyrinth-vault
npm ci        # installs exactly the lockfile, integrity-checked
npm test      # vault 407, wallet 84, Swift 12
npm run typecheck
```

The claims above are tests, not prose: delete a defense and the suite goes
red. Every one has been verified by mutation. Each guard was removed in turn,
the suite re-run, and the failure confirmed. That includes the guards added by
the most recent passes: the opaque-output refusal, the wallet binding, the
`yourNet` arithmetic, the calibration floor, the account validation, the
single-frame cap, the Monero container refusal, the byte-only passphrase and
the bundle digest the app checks before it evaluates a line of its engine.

That exercise is worth doing rather than assuming. One test in this suite
originally passed with the defense it was written for deleted. It guarded a
denial-of-service cap whose effect is invisible in the return value, so it was
rewritten to measure the work avoided instead, with a threshold taken from
measurement rather than taste. A test nobody has tried to break is a test of
unknown value.
