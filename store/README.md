# Store metadata

The words that go in the App Store listing, kept next to the code they describe
rather than typed into a web form and forgotten.

One directory per app. Each holds the fields App Store Connect asks for, one
file per field, named for the field, so a diff shows exactly what changed in a
listing and a review rejection can be answered by editing a file rather than by
remembering what was there.

Character limits are Apple's and they are hard limits, so `test/store.test.ts`
checks them. A description truncated at 4000 characters by a web form is a
description whose last sentence is missing.

`review-notes.md` is the one nobody thinks of and the one that decides how a
review goes. Both apps need explaining: one has no network and does nothing on
its own, the other opens on a screen that says it is watching nothing, because
it would rather show that than a fixture balance. A reviewer who has to guess
at either will reject.

The listings make claims about custody, and custody changed once already
without them. `test/store.test.ts` now reads `wallet/src/core/keyvault.ts`
before it reads the wallet's description, so a sentence here that the code
stopped supporting fails the suite instead of reaching Apple.
