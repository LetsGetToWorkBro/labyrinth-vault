# The wallet, reviewed against its own threat model

A pass over `wallet/` asking one question: what can actually go wrong for
somebody using this, and what does the code do about it. Written because the
request was "make sure the wallet has the same state of the art security as
the vault", and the honest answer to that request begins by disagreeing with
its premise.

## The premise, first

**The two apps should not have the same security, because they do not hold the
same thing.** The vault holds keys and the wallet holds public information.
Every hardening measure that matters to the vault is either irrelevant here or
already answered by the architecture.

What the wallet can hold: an extended public key, a Monero view key,
addresses, balances, unspent outputs, fee estimates, prices, history. Every
one of those is public information. None can move a coin.

What it can never hold: a private key. There is no screen that imports one, no
field that would accept one, and no field in `src/core/model.ts` with anywhere
to put one. That is not a mitigation, it is the shape of the product, and it
is why the keys are on the other phone.

So **nobody's tokens can be stolen by compromising this app's storage**, which
is what "state of the art security" usually means. The things that can go
wrong here are different, and three of them are real.

## What can actually go wrong

Ranked by how much it would cost the person it happened to.

### 1. A payment goes to the wrong place

The wallet builds transactions and broadcasts them. It cannot sign, so it
cannot pay anyone by itself, and the vault renders every destination in full
before a human approves it. That is the boundary and it holds.

The gap is the return trip: signed bytes come back through a camera into an
app that has a network. `verifySigned` in `src/core/build.ts` compares what
came back against the intent recorded before the vault ever saw it, and a
mismatch is terminal. `src/core/session.ts` has no transition out of
`mismatch` into a state that can broadcast, and `test/session.test.ts` throws
every event in the vocabulary at it to prove there is no path. The screen has
no "broadcast anyway" button because there is no state for one to lead to.

**Status: as good as this can be made from inside the app.** A guarantee made
of structure rather than of a warning.

### 2. The swap payout address, which nothing can check

Covered at length in `wallet/README.md` and unchanged by this review. A swap
involves three addresses and the vault only ever sees one of them. The
mitigations are that the payout address is *derived* rather than accepted when
the wallet watches that coin, so there is no field to paste an attacker's
address into, and that `verifyOrder` refuses an order that does not match the
request, returning no order at all rather than a flagged one.

**Status: the residual risk is real, named on screen, and structural.** It is
the one place the vault cannot fully cover, and the app says so every time.

### 3. Privacy, which is the thing a watch-only wallet is actually for

A light client tells whichever node it uses every address in the account. That
is inherent to light clients, and the fix is running your own node, which the
nodes screen presents as the ordinary option rather than the advanced one.

**This is where the review found a bug.**

## Found: a public host could pass as a node on your own network

`parseNode` in `src/core/nodes.ts` permits plain `http` only to a local
address, for the obvious reason: http across the internet hands every address
in the wallet to anyone on the path, which is precisely what choosing your own
node was meant to avoid.

The local test was a prefix match. `/^10\./` against the hostname, plus the
same for `192.168.` and `172.16-31.`. Those match a *string*, and `10.evil.com`
is an ordinary public domain that starts with `10.`:

    ACCEPTED  http://10.evil.com:18081
    ACCEPTED  http://192.168.evil.com:18081
    ACCEPTED  http://172.16.attacker.net:18081

Somebody persuaded to type one of those as their node gets an unencrypted
connection to an attacker's server carrying every address they own, obtained
from the one screen in the app whose entire purpose is deciding who gets to
watch them.

A private address is a number in a range, so the check now parses the number:
four decimal octets, each in range, then the range test. Names are handled
separately and both are safe by construction, since `localhost` resolves to
loopback by definition and `.local` is reserved for mDNS and cannot be
registered publicly. Link-local (169.254) was added while the arithmetic was
being written.

`wallet/test/net.test.ts` now covers both directions: the lookalikes are
refused, and every address that really is private is still accepted, including
the four sitting immediately outside RFC 1918's boundaries where an off-by-one
would turn a public address into a trusted one.

## Found: two Info.plist keys the node feature needs and did not have

The same class as the vault's `TextEncoder` bug. Both are cases where the
feature works everywhere except on a real device.

**App Transport Security blocks plain http by default.** The wallet
deliberately supports `http://192.168.x.x:18081`, which is the whole "run your
own node" path, and iOS would have refused every one of those connections.
Fixed with `NSAllowsLocalNetworking`, which permits exactly local addresses
and does *not* open arbitrary loads. `NSAllowsArbitraryLoads` would have
worked too and would have been the wrong fix: it turns off the check for
everything, to solve a problem that only exists for the local case.

**iOS 14 and later require a usage description for local network access.**
Without `NSLocalNetworkUsageDescription` the connection fails, and on some
versions the app is terminated for the missing string. Added, and worded to
say what is true: the wallet never searches the network and talks to nothing
on it that the person did not name.

Neither would have shown up in the test suite, because a test suite runs where
ATS does not. They would have shown up as "self-hosted nodes just do not work"
in a TestFlight report, and the workaround people would have found is the
public HTTPS node, which is the privacy loss the whole screen exists to
prevent.

## Checked and found sound

- **Storage.** `keychainStore.ts` uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, with
  both halves of that choice argued in the file. There are no keys in it; the
  pairing it holds is a public key and a view key. Node addresses and the scan
  height live in a plain file, correctly, because they are not secret.
- **Everything read back is revalidated.** `persist.ts` puts a stored node
  address back through `parseNode`, the same door a typed one comes through,
  and bounds-checks a stored height. A tampered preferences file cannot
  introduce a node that the UI would have refused, which is exactly the bug
  the local-address fix above would otherwise have been re-introducible
  through.
- **No logging of anything.** Not one `console.log` in `src/`.
- **The stand-in signer is gated on `__DEV__`**, which Metro sets false in a
  release bundle, and `standin.ts` notes that the default falls closed where
  `__DEV__` is undefined.
- **Credentials, queries and fragments in a node URL are refused**, so nothing
  smuggles a token through the address field into logs and screenshots.
- **The privacy manifest is four empty lists** and `test/shipping.test.ts`
  checks each emptiness against the code rather than trusting the plist.

## The dependency tree, which is the real residual risk

371 packages, 27 direct. That is React Native, and it is several hundred
packages before a line of ours runs. It cannot be fixed by adding anything;
**it is the reason the keys are on the other device**, and it is why the
wallet lives in its own package rather than under the vault's, whose six
audited cryptography dependencies have a test walking the transitive closure
to keep the number at six.

`npm audit --omit=dev` reports 21 advisories resolving to three roots:
`image-size` (two denial-of-service parsers) and `uuid` (a missing bounds
check). All three arrive through `@expo/prebuild-config` and run at build time
on a developer's machine, not on anybody's phone. They are worth clearing on
the next Expo bump and they are not a reason to hold a release.

## What was deliberately not added

The request mentioned pulling in security libraries from GitHub. Named here so
the decision is visible rather than silently skipped.

- **Jailbreak detection.** Defeated by the thing it detects, and every
  implementation is a list of paths that goes stale. It would mean a new
  dependency with filesystem access, which is a larger risk than the one it
  addresses, in an app holding no secrets.
- **Screenshot and screen-recording blocking.** The wallet displays public
  information. Blocking screenshots of a receive address mostly stops people
  saving their own address.
- **Certificate pinning.** Incoherent here: the person chooses their own node,
  which is the entire design of the nodes screen. There is no certificate to
  pin to.
- **Anti-debugging and obfuscation.** Both work against an attacker who has
  already got code running on the device, at which point a watch-only app has
  nothing left to protect. This project is open source; obfuscating it would
  mean giving up the property that every claim can be checked, in exchange for
  slowing down somebody reading a bundle that has no secrets in it.

The pattern in all four: they are measures for an app that holds keys. This
app does not hold keys, and the effort is better spent on the node client,
which is what stands between a tester and a wallet that shows their own money.
