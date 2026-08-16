# Which wallets this works with, and how that was established

Every row here was read out of the wallet's own source at the commit named at
the bottom. None of it is from documentation, a support page or a forum post,
and that is not pedantry: this project shipped a button labeled
"SPARROW · ELECTRUM" on a BC-UR wire for several builds, and Electrum has never
read BC-UR. The documentation would not have caught it. The source did, in
about a minute.

## The signing round trip, Bitcoin

A wallet builds an unsigned PSBT, the vault signs it, the wallet takes it back
and broadcasts. Both directions have to work or the pairing is decorative.

| Wallet | Vault reads its PSBT | Vault hands the signature back as | Animated |
| --- | --- | --- | --- |
| Sparrow | BC-UR, BBQr | `ur:crypto-psbt`, `ur:psbt`, BBQr | yes |
| Electrum | base43, base64, hex | **base43, one static code** | **no** |
| Coldcard Q | BBQr | **BBQr** | yes |
| BlueWallet | BC-UR, BBQr | `ur:crypto-psbt`, BBQr | yes |
| Nunchuk | BC-UR, BBQr | `ur:crypto-psbt`, BBQr | yes |
| Keystone, Passport | BC-UR | `ur:crypto-psbt` | yes |
| Cake | `ur:psbt` only | `ur:psbt` | yes |

Three formats, no overlap between them, and the bolded cells are the ones that
were missing until the change that added this file.

**Electrum has no BC-UR of any kind.** Not a missing registry type: there is no
`crypto-psbt`, no fountain decoder, no bytewords anywhere in the tree. Its
whole camera surface is `Transaction.to_qr_data`, which base43-encodes the PSBT
into a single QR, and `convert_raw_tx_to_hex`, which on the way in tries hex,
then base64 if it starts `cHNidP`, then base43. Because there is no animated
form, a PSBT larger than one QR cannot reach Electrum by camera at all. The
vault shows a refusal on that screen rather than a code nothing will scan.

**Coldcard has no BC-UR either.** It reads BBQr, which is Coinkite's own
format: an eight-character header and a base32 body, animated, and readable
also by Sparrow, Nunchuk and BlueWallet. Of the three formats it reaches the
most wallets; UR is offered first only because those wallets' own documentation
points people at UR.

## The other half: the empty field Electrum needs

Getting the bytes across is not the same as getting them accepted. Electrum
would parse the vault's finalized PSBT, show the transaction, and refuse to
call it complete, so no Broadcast button appeared.

    def is_complete(self) -> bool:
        if self.script_sig is not None and self.witness is not None:
            return True

`PartialTxInput.is_complete`. For a native segwit input there is no scriptSig,
so `@scure/btc-signer` omits `PSBT_IN_FINAL_SCRIPTSIG` entirely, and Electrum
reads an absent key as "not signed yet" no matter what the witness holds.
Electrum's own finalizer sets that field to empty and writes it, so an empty
0x07 is what every Electrum-signed PSBT already carries.

`src/keys/finalscriptsig.ts` adds it. It changes no signature and no
transaction id, and `test/finalscriptsig.test.ts` asserts exactly that. This
was a defect on the file and hex paths too, so it was never really about QR
codes.

## Pairing, Bitcoin

Setting up the watch-only side, which is a different problem with a different
answer per wallet.

| Wallet | How it takes the account |
| --- | --- |
| Sparrow, Nunchuk, BlueWallet, Bitcoin Core | **output descriptor**, scanned or pasted |
| Keystone, Passport, Sparrow, BlueWallet | `ur:crypto-account`, scanned |
| Electrum | **output descriptor**, or the zpub, pasted |
| Labyrinth wallet | this project's own `ACCOUNT` frames |

The export screen offers three wires now. The third is a BIP-380 output
descriptor:

    wpkh([73c5da0a/84h/0h/0h]xpub6CatWdiZ.../<0;1>/*)#qf45pmyh

A zpub says which keys and nothing else. It does not say the script type, the
derivation path, or which seed the keys belong to, so a watch-only wallet has
to guess all three, and a wrong guess is a wallet full of addresses nobody can
spend from. The descriptor states all of it, carries a checksum that catches a
mistyped paste, and needs no registry support and no fountain decoder: it is a
string, so any wallet that reads a QR at all reads this one, and any wallet
with a text field takes it typed.

That last property is why it matters most for Electrum, which has no BC-UR of
any kind. The zpub still shows as text beside it, because pasting a master
public key is Electrum's oldest route and some people will want it.

`test/descriptor.test.ts` checks every checksum against Electrum's own
`DescriptorChecksum`, and the finished descriptors were fed back to Electrum's
`parse_descriptor`, which read them as WPKH with origin `m/84h/0h/0h`. The
seed in the fixture is BIP-39's test vector, so the account key is BIP-84's
published one and `73c5da0a` is the fingerprint every wallet reports for it.

## Monero

Cake and Feather both read the same four `xmr-*` UR types over the same
`wallet2` payload, which is what makes them a standard rather than one app's
habit. `docs/monero-signing.md` has the detail.

### The two artifacts a person holds

[docs/verification.md](verification.md) is the ledger this belongs to.

The compatibility that matters most is not a wire format. It is the address on
the screen and the twenty-five words on the paper, and both are now checked
against Monero's own encoders rather than against this repository's own
decoders.

`oracle/src/address.cpp` calls `get_account_address_as_str`,
`get_account_integrated_address_as_str`, `hw::device::get_subaddress` and
`ElectrumWords::bytes_to_words`, over three secrets on all three networks.
`test/fixtures/monero-address.json` is what it said.

| checked against Monero | why it matters |
| --- | --- |
| the deterministic view secret | a different rule makes a different wallet out of the same words |
| the standard address, on all three networks | a wrong one is money nobody can spend |
| subaddresses at five indices | the same, and (0, 0) is a special case an implementation can lose |
| integrated addresses | the vault does not write them but is shown them, and must not call a real one invalid |
| the twenty-five English words | a phrase that restores nowhere else is not a backup |

Before this, all of it was round trips: this repository encoding and then
decoding its own output. The single exception was `KNOWN_ADDRESS`, the Monero
project's donation address, which anchors *parsing* one mainnet address.

It found one defect, latent but real. `subaddressKeys` at index (0, 0) returned
`a·B` where Monero returns `a·G`: the main spend key beside a subaddress-style
view key, a pair belonging to no address at all. It never reached a device -
the function has no caller in `src/`, so the bundler drops it and the shipped
engine does not contain it - and the test covering it asserted the same wrong
rule in as many words. It was waiting for the first caller that walked indices
from zero to build a list.

One thing this deliberately does not do is fabricate a spend. The vault holds
one wallet and shows one address; the subaddress code exists because the vault
must *send* to somebody else's subaddress and must recognize its own. That
these encode the way Monero encodes is the whole claim.

## What is not claimed

- **Multisig with Coldcard, or with anything.** The vault signs single-sig
  BIP84 and nothing else. This is a standing boundary rather than a gap
  waiting to be filled: multisig is a different security model, because change
  has to be verified against a script instead of against a key, and a
  confirmation screen that cannot do that is worse than no multisig at all.
  Every descriptor this vault emits is `wpkh(...)`, there is no code path that
  could produce `wsh(sortedmulti(...))`, and a guard in
  `test/app-wiring.test.ts` sweeps the whole tree to keep it that way.
- **Coldcard's microSD and NFC paths.** Camera only.
- **BBQr's `Z` encoding.** The vault emits `2`, uncompressed base32, which the
  spec explicitly permits a sender to choose. It *reads* `2` and `H` and
  refuses `Z`, because implementing DEFLATE here would mean a new dependency
  or several hundred lines whose bugs would look exactly like a camera
  misread.
- **That any of this has been run against the physical devices.** It has been
  run against their code: Electrum's own `convert_raw_tx_to_hex` and
  `tx_from_any` accept the vault's frames and reconstruct the same txid, and
  Coinkite's own BBQr `join_qrs` reassembles them. `test/wallet-wires.test.ts`
  pins the vectors that came out of that. A real Coldcard Q and a real phone
  camera are still the last mile, and `docs/testflight.md` is where that gets
  written down once somebody has done it.

## Sources

Read at these commits. Re-check them before trusting a row that matters.

| Project | Commit |
| --- | --- |
| Electrum | `a94e460b50bc5afc334ca0d6feead47d3b50539f` |
| Coldcard firmware | `4e7755b5057d2d45fbc16ba5f7fc63107f0c7e2b` |
| BlueWallet | `e242791752cb79f8372305472abf3623523e2465` |
| BBQr reference and spec | `github.com/coinkite/BBQr`, `bbqr.info` |
| Monero | `v0.18.5.1` |
