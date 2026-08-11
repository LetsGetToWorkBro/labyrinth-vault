# The interaction prototype

A runnable spec for the vault's interface, in plain HTML/CSS/JS. Open
`index.html` from disk: it makes no network requests of any kind, which is
not a demo constraint but the product: the app this specifies runs on a phone
with its radios off.

This is not the shipping front end (that is the iOS shell in `ios/`, which
follows this prototype screen for screen). It exists because the behaviors
that carry the security are interactions, and interactions have to be felt to
be reviewed:

- the confirmation screen's scroll gate: STOP / VERIFY / SIGN, where the
  signing route does not open until the whole document has passed your eyes;
- hold-to-sign, where releasing early does not sign and says so;
- frame acquisition that fills out of order, because that is how the fountain
  code actually behaves;
- the three refusal states, each with exactly one button.

Arrow keys walk the deck; the index rail lists every screen. The left rail
and the deck-walking are review affordances, not part of the product.
