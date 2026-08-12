# The BIS encryption self-classification report

The vault encrypts a seed at rest, which makes it a controlled encryption item
under the US Export Administration Regulations. It qualifies as mass market
under ECCN 5D992.c, and the whole of the resulting obligation is one annual
CSV emailed to two addresses. This directory holds that CSV, the reasoning
behind every value in it, and the traps that are specific to this format.

`self-classification-report.csv` is the file that gets sent. It is not ready
to send: four fields say `TO BE COMPLETED` and only you can fill them.

## When it is actually due, which is later than we thought

The runbook used to say this was needed before the Store. That is wrong, and
wrong in your favor.

The obligation attaches to *exports made during a calendar year*, and the
report is due by **1 February of the following year**. BIS states it plainly:
"No self-classification report is required if no exports or reexports of
applicable items were made during the calendar year." Nothing has shipped, so
nothing is reportable yet.

So the sequence is: ship the vault, then file by 1 February of the next year,
then file every year after that. **It does not block submission or review.**

Two reasons it is written now anyway. The first is that a form is much cheaper
to fill in while the facts are fresh than eleven months later. The second is
that `store/vault/review-notes.md` told Apple's reviewer the report "is filed",
which was not true, and the way to stop a document drifting from the facts is
usually to make the facts easy to check.

## Why only the vault is listed

The two apps have different true answers, and `docs/shipping.md` argues that
out at length. In short: the vault encrypts a seed for confidentiality, and
the wallet is watch only and has no secret in it to protect. The vault's
Info.plist answers `ITSAppUsesNonExemptEncryption: true` and the wallet's
answers false, and this report has to agree with those two declarations,
because they are the same claim made to two agencies.

If you would rather take the conservative view that any app doing TLS is a
5D992.c mass market item, add a second row for the wallet with the same
company fields. That view is defensible and costs nothing but a line. What is
not defensible is a report that disagrees with the Info.plist.

## Every field, and why it says what it says

The twelve columns are fixed by Supplement No. 8 to Part 742. The first line
of the file must match them "without alteration or variation".

| Field | Value | Why |
| --- | --- | --- |
| PRODUCT NAME | `Labyrinth Vault` | The name it is distributed under. 50 characters or less. |
| MODEL NUMBER | `vision.labyrinth.vault` | The regulation permits `N/A`, but it asks for the product as "typically distinguished in inventory, catalogs, marketing brochures". For an iOS app that is the bundle identifier: it is the thing that distinguishes this product from every other one in the store, and it does not change with the version. |
| MANUFACTURER | `SELF` | The regulation's own word for "you made it". |
| ECCN | `5D992` | Only five values are permitted here: 5A002, 5B002, 5D002, 5A992, 5D992. **Not `5D992.c`.** The subparagraph is right in the prose and wrong in this field. |
| AUTHORIZATION TYPE | `MMKT` | Mass market under 742.15(b)(1), as opposed to `ENC` under License Exception ENC. |
| ITEM TYPE | `key storage` | One of forty-nine fixed descriptors. This is the closest to what the controlled functionality actually is: the product stores a key, encrypted, and that is the confidentiality function that puts it in scope. `key management` is the defensible alternative and `file encryption` is a weaker third. Do not invent a descriptor; `OTHER` exists if none fit, and one does. |
| SUBMITTER NAME | **yours** | A single point of contact, identical on every row. The person BIS would call. |
| TELEPHONE NUMBER | **yours** | Same. |
| E-MAIL ADDRESS | `info@labyrinthwallet.com` | The address already published in both privacy policies and in SECURITY.md, so a reviewer, a researcher and BIS all reach the same inbox. Change it if the submitter should be reached elsewhere. |
| MAILING ADDRESS | **yours** | See the comma trap below. This one bites everybody. |
| NON-U.S. COMPONENTS | `YES` | One answer for the whole submission. Answered yes because the six cryptography dependencies are the noble and scure libraries, whose principal author works outside the United States. **Confirm this rather than inherit it**: it is a judgment about where the components originate, the answer here is the honest reading, and it costs nothing. `YES` is not a problem, it is a description. |
| NON-U.S. MANUFACTURING LOCATIONS | `NONE` | Software with no manufacturing footprint. If the company has non-US offices where development happens, list them, separated by spaces rather than commas. |

## The comma trap

> "Because of .csv file format requirements, the only permitted use of a comma
> is as the necessary separator between line entries. You may not use a comma
> for any other reason in your encryption self-classification report."

Mailing addresses have commas in them. Yours almost certainly does. Write it
without them:

    123 Example Street Suite 4 Portland OR 97201 USA

Not `123 Example Street, Suite 4, Portland, OR 97201`. The second one turns
one row into five fields too many, and the parse fails at the other end
rather than at yours. `test/store.test.ts` fails the build if a comma appears
inside any field, which is the only reason this note is short.

The same applies to the item type list and to any company name containing
`, Inc.` or `, LLC`. Write it as `Example Inc` or `Example LLC`.

## How to send it

Once the four fields are filled in, email the `.csv` as an attachment to both:

- `crypt-supp8@bis.doc.gov`
- `enc@nsa.gov`

There is no portal, no account, and no acknowledgment to wait for. Keep the
sent message; it is the record that you filed.

A cover message is not required and one sentence is plenty:

> Subject: Encryption self-classification report for [entity name]
>
> Attached is the annual encryption self-classification report under
> Supplement No. 8 to Part 742 for calendar year [YYYY], covering one mass
> market item classified 5D992.c.

## What this obligation is not

- **No CCATS and no license.** 5D992.c mass market needs neither. People
  reach for CCATS because the encryption rules used to require far more; they
  were relaxed, and this report is the whole of what is left.
- **No `ITSEncryptionExportComplianceCode`.** That Info.plist key is for apps
  that went through CCATS. It stays empty. `project.yml` sets it to `""`
  deliberately.
- **Not a one-off.** It repeats every year by 1 February for anything exported
  in the previous calendar year. If nothing changed, BIS accepts a
  confirmation of no change or a resubmission of the previous report.
- **France** has a separate declaration for encryption products distributed
  there. Apple's export questionnaire asks about it directly, and it is not
  part of this filing.

## Sources

The format changed after 2010: the supplement then required six columns and
now requires twelve, and a template found in an old blog post will be six
wide and rejected. These were read rather than remembered.

- [15 CFR Part 742, Supplement No. 8 (Cornell LII)](https://law.cornell.edu/cfr/text/15/appendix-Supplement_No_8_to_part_742)
  for the twelve column headers, the permitted ECCN values, the two
  authorization types and the forty-nine item type descriptors.
- [BIS, Annual Self-Classification Report](https://www.bis.gov/learn-support/encryption-controls/annual-self-classification)
  for the two email addresses, the 1 February deadline, the calendar-year
  reporting period, and the rule that no report is required for a year with
  no exports.

Neither of us is your export counsel. Everything above is the regulation read
carefully, and the parts that are judgment rather than transcription are
marked as judgment.
