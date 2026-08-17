# The wallet, reviewed against its own threat model

A pass over `wallet/` asking one question: what can actually go wrong for
somebody using this, and what does the code do about it. Written because the
request was "make sure the wallet has the same state of the art security as
the vault", and the honest answer to that request begins by disagreeing with
its premise.

## The premise, first, and it has changed since this was written

This review was written against a wallet that held no key, and it said so at
length: no screen imports one, no field accepts one, so nobody's coins can be
stolen by compromising this app's storage. **That premise is now false for
half of the accounts this app can hold**, and the paragraphs that rested on it
have been rewritten rather than quietly deleted, because the reasoning is what
a reader needs and the reasoning is what changed.

**There are two kinds of account now, and only one of them is watch-only.**

*An account paired from a vault* holds exactly what the old premise described:
an extended public key, a Monero view key, addresses, balances, unspent
outputs, fee estimates, prices, history. All public, none of it able to move a
coin. `canSignHere` takes the account's source and nothing else, so this half
cannot sign for such an account whatever else the phone happens to be holding.
That invariant survived every attempt to break it and it is the one thing this
product cannot survive getting wrong.

*An account made or restored on this phone* holds a seed, in the iOS keychain
at `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and signs here behind a Face ID check per
signature. `core/keyvault.ts` is the whole of that decision and reads as a
security document because it is one.

**So the two apps still should not have the same security, but the reason is
smaller than it was.** It is no longer "there is nothing here to steal". It is
"what is here is protected by the device rather than by something you know,
and that is a real reduction, stated on the screen where somebody chooses to
use it". Anything worth more than a phone belongs on the other half. Every
measure below that was declined on the grounds that this app holds no secrets
has been re-argued on that footing.

## What can actually go wrong

Ranked by how much it would cost the person it happened to. The first is new
and it is first because it is the one that ends with somebody's coins gone.

### 0. The phone is taken while it is unlocked, with a seed on it

This is the whole threat model for an account made on this phone, and it is
worth stating plainly because the keychain does not address it: the device is
in exactly the state the keychain is waiting for. `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
answers a stolen backup, a lifted disk image and a restore onto another phone.
It does not answer a phone somebody is holding, unlocked.

What answers it is `core/signgate.ts`: a biometric check per signature, never
per session, because a session-long unlock is a phone that signs anything for
as long as somebody keeps it awake. The same gate stands in front of the
screen that displays the recovery words, which is the more valuable of the
two: a seed read is every future signature, on any device, forever, and a
gate on signing alone would guard the smaller thing.

**What is honestly not answered:** no passphrase protects that seed. The vault
takes an Argon2id derivation at 64 MiB because it is opened rarely and
deliberately; a wallet is opened ten times a day, and friction of that size
produces four-character passphrases, which look like protection in a
screenshot and are not. Shipping the vendored Argon2id C into a React Native
build that `expo prebuild --clean` regenerates is the real upgrade, and it is
work rather than a wall. Until somebody does it, the honest sentence is the
one the app itself uses: this is for the balance you carry.

**Status: the gap is named, the mitigation is proportionate, and the product
says so out loud rather than in a document.** That last part is the part that
was missing when this feature landed, and it is why the store listing, the
privacy policy and the marketing site were all corrected in one pass.

### 1. A payment goes to the wrong place

The wallet builds transactions and broadcasts them. For an account paired
from a vault it cannot sign, so it cannot pay anyone by itself, and the vault
renders every destination in full before a human approves it. That is the
boundary and it holds. For an account made on this phone there is no second
screen and no second person: the review screen in this app is the only place
the destination is read, which is the trade that account kind is, and it is
why the amounts it is meant for are small.

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

### 3. Privacy, which is what a wallet watching a chain leaks by existing

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

## Found: the check ran on a URL parser that is a different program on a phone

Worse than the one above, and found by asking what the fix depended on.

`parseNode` called `new URL()`. React Native ships its own, in
`Libraries/Blob/URL.js`, and it is a handful of regular expressions rather
than the WHATWG algorithm. Its hostname pattern stops at the class
`[^:/?#]`, which does not contain a backslash, and WHATWG treats a backslash
as a path separator for http. Measured against that file rather than assumed:

    http://evil.com\@10.0.0.5/
      WHATWG (Node, and iOS networking)  ->  evil.com
      React Native                       ->  10.0.0.5

The disagreement lands exactly on the local-address check. On a device that
string parses as a private address, passes as local, is stored, and is then
handed to a networking stack that resolves `evil.com` and opens an
unencrypted connection to it carrying every address in the wallet. Nothing in
the suite could see it, because the suite runs on Node, where the same string
parses the safe way.

So `nodes.ts` parses the address itself now, in about thirty lines, and
`hostOf` is exported so that nothing else reaches for `new URL()` to answer
the same question. `routeFor` in `net/nodeproxy.ts`, which decides whether
traffic is relayed, was the other caller and now shares the parser.

The test is not a list of bad inputs, because the next trick is not on the
list. It is an invariant: for any address, the parser either refuses or names
the same host the platform will actually connect to. Where the two could
differ, the address does not get in.

That invariant immediately earned itself. It failed on `http://0x0a000005/`,
which WHATWG rewrites to `10.0.0.5` and a regular expression reads as a name,
so the app would have called a host by one name and connected to another. The
host rule now requires either a dotted quad or a final label beginning with a
letter, which removes every numeric form WHATWG would rewrite.

Reverting the parser to React Native's shape makes the test fail with the
original attack string, which is the check that the guard is real.

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

- **Storage, in two items that are not allowed to become one.**
  `keychainStore.ts` uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY` for both, with each
  half of that choice argued in the file. `labyrinth-pairing` holds a vault's
  public key and view key; `labyrinth-spending-keys` holds this wallet's own
  seed. Separate names, deliberately: sharing an item would make unpairing a
  vault delete a seed, which is a wipe wearing the word "unpair". Node
  addresses and the scan height live in a plain file, correctly, because they
  are not secret.
- **The seed never becomes a string that outlives its use.** `keyvault.ts`
  hands out an opened wallet and wipes it, the same discipline `src/keys/`
  holds itself to, and the screen that shows the words puts the biometric gate
  in front of deriving them at all rather than in front of drawing them: the
  sheet that calls `phrasesFor` is not mounted until the gate has answered.
- **Everything read back is revalidated.** `persist.ts` puts a stored node
  address back through `parseNode`, the same door a typed one comes through,
  and bounds-checks a stored height. A tampered preferences file cannot
  introduce a node that the UI would have refused, which is exactly the bug
  the local-address fix above would otherwise have been re-introducible
  through.
- **No logging of anything.** Not one `console.log` in `src/`. That matters
  more now than it did when this line was first written: a debug print in the
  send path would be printing against an account whose key is on the phone.
- **The stand-in signer is gated on `__DEV__`**, which Metro sets false in a
  release bundle, and `standin.ts` notes that the default falls closed where
  `__DEV__` is undefined.
- **Credentials, queries and fragments in a node URL are refused**, so nothing
  smuggles a token through the address field into logs and screenshots.
- **The privacy manifest is four empty lists** and `test/shipping.test.ts`
  checks each emptiness against the code rather than trusting the plist.

## The dependency tree, which is the real residual risk

634 packages, 34 direct, 566 of them in the production tree. That is React
Native, and it is several hundred packages before a line of ours runs. It
cannot be fixed by adding anything, and it is why the wallet lives in its own
package rather than under the vault's, whose six audited cryptography
dependencies have a test walking the transitive closure to keep the number at
six.

**This is the argument for the vault, and it did not stop being one when this
app grew a seed of its own.** A dependency tree this size is an
unauditable-by-one-person surface, sitting on the same device as an account's
recovery phrase. That is exactly why the paired account cannot be signed for
here and why the phone-made one is documented as being for smaller amounts.
The number above is the reason the sentence "anything worth more than a phone
belongs on the other half" is a design constraint and not modesty.

Audit the runtime tree, and know what "runtime" means in this package.
`npm audit --omit=dev` was the command this section quoted, and until this pass
it skipped `qrcode`, which `src/qr/matrix.ts` imports unconditionally and five
registered screens render: it was declared in `devDependencies` while running
on the phone. It is a `dependency` now, so the command and the sentence mean
the same thing again.

Measured after that move: three advisories, flagging 21 packages, from two
roots. `image-size` has two denial-of-service parsers and reaches the tree
through `metro`; `uuid` has a missing buffer bounds check and reaches it
through `xcode`. Both of those are build tooling that runs on a developer's
machine rather than code on anybody's phone, which is why they are worth
clearing on the next Expo bump and are not a reason to hold a release. Rerun
the command rather than trusting this paragraph: the numbers are a measurement
with a date on it, and the reason they are written out is so that a changed
number is visible rather than silent.

## What was deliberately not added

The request mentioned pulling in security libraries from GitHub. Named here so
the decision is visible rather than silently skipped.

Each of these was originally declined on one sentence: this app holds no
secrets, so there is nothing here for the measure to protect. That sentence
died with the hot account, so each is re-argued below on the footing that half
the accounts on this phone do have a seed behind them. The conclusions have
not changed. The reasons have.

- **Jailbreak detection.** Still no. It is defeated by the thing it detects,
  every implementation is a list of paths that goes stale, and it would mean a
  new dependency with filesystem access. What changed is that there is now
  something to lose, so the honest version of the argument is a comparison
  rather than a dismissal: a jailbroken phone with a seed on it is genuinely
  worse than a jailbroken phone without one, and a check the attacker controls
  the answer to does not make it better. The measure that does is the one
  already taken, which is that the amounts this account kind is for are small
  and the app says so.
- **Screenshot and screen-recording blocking.** Yes, for one screen, and it is
  the screen this argument used to be able to ignore. A receive address is
  public and blocking a screenshot of it mostly stops people saving their own
  address. The recovery words are not public, and a screen recorder running
  while somebody writes down 25 words is the whole loss. `Backup.tsx` gating
  the reveal behind Face ID is the answer this repository has; a
  `screenCaptureDidChange` observer over that screen is a real improvement and
  is not yet built. Named here rather than declined.
- **Certificate pinning.** Still incoherent, for the unchanged reason: the
  person chooses their own node, which is the entire design of the nodes
  screen, so there is no certificate that is ours to pin.
- **Anti-debugging and obfuscation.** Still no, and the argument survives
  intact because it never rested on there being no secrets. Both work against
  an attacker who already has code running on the device, which is a lost
  position whatever is in the keychain. This project is open source, and
  obfuscation would trade the property that every claim can be checked for a
  delay in reading a bundle whose logic is published anyway.

The pattern that survives: three of the four are measures against an attacker
who has already won, and buying them with a new dependency or with
unverifiability is a bad trade at any custody model. The one that changed
sides is the screen recorder, because there is now a screen worth recording.
