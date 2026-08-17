/**
 * The listing, against Apple's limits and against the truth.
 *
 * Two kinds of check, and the second is the one that matters.
 *
 * The limits are Apple's and they are hard. A subtitle of 31 characters is not
 * a subtitle that gets shortened, it is a form that will not submit, found at
 * the end of a release rather than at the start of one. Cheap to check here.
 *
 * The rest is about the listing telling the truth. A description is a promise
 * made to somebody deciding whether to trust an app with money, and it is
 * written months before the build it ships beside. The two claims most likely
 * to go quietly false are the vault's "no network code" and the wallet's "the
 * numbers are fixtures", so both are checked against the code rather than
 * against a memory of the code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { codeOnly } from './support/source';

const read = (path: string) => readFileSync(path, 'utf8').trim();

/** App Store Connect's limits, per field. */
const LIMITS: Record<string, number> = {
  'name.txt': 30,
  'subtitle.txt': 30,
  'promotional-text.txt': 170,
  'keywords.txt': 100,
  'description.txt': 4000,
  'whats-new.txt': 4000,
};

describe('both listings are complete and fit', () => {
  for (const app of ['vault', 'wallet']) {
    describe(app, () => {
      const dir = `store/${app}`;

      it('has every field App Store Connect asks for', () => {
        /* Both apps carry their privacy policy. It is not a Connect form
         * field but a URL the form demands, and keeping the document here
         * versions it next to the claims it repeats. The wallet's waited
         * until it had a domain to host it and a network story worth being
         * exact about; it has both now. */
        const extras = ['review-notes.md', 'privacy-policy.md'];
        const present = readdirSync(dir).sort();
        expect(present).toEqual([...Object.keys(LIMITS), ...extras].sort());
      });

      for (const [file, limit] of Object.entries(LIMITS)) {
        it(`${file} fits in ${limit} characters`, () => {
          const text = read(`${dir}/${file}`);
          expect(text.length, `${dir}/${file} is ${text.length} characters`).toBeLessThanOrEqual(limit);
          expect(text.length, `${dir}/${file} is empty`).toBeGreaterThan(0);
        });
      }

      it('keeps keywords comma separated with no wasted spaces', () => {
        /* Apple counts the spaces. A hundred characters is not many and a
         * space after every comma is a keyword thrown away. */
        const keywords = read(`${dir}/keywords.txt`);
        expect(keywords).not.toMatch(/, /);
        expect(keywords.split(',').length).toBeGreaterThan(5);
      });

      it('has review notes, which is the field that decides how a review goes', () => {
        const notes = read(`${dir}/review-notes.md`);
        expect(notes.length).toBeGreaterThan(400);
        // Both apps need the reviewer told how to exercise them without a
        // second device, because neither is usable alone by default.
        expect(notes).toMatch(/without a second device/i);
        expect(notes).toMatch(/camera permission/i);
        expect(notes).toMatch(/encryption/i);
      });
    });
  }
});

describe('the listings say what the code does', () => {
  it("the vault's no-network claim is the one the source guard enforces", () => {
    const description = read('store/vault/description.txt');
    expect(description).toMatch(/NO NETWORK CODE/);
    /* The same claim is a test that walks the source on every run. If that
     * test were ever deleted, this one would still pass, so the point here is
     * narrower and still worth making: the guard file exists and the listing
     * is not claiming something nothing checks. */
    expect(existsSync('test/no-network.test.ts')).toBe(true);
  });

  it('the vault claims Monero signing only while the engine exports it', () => {
    /* This guard used to point the other way: the listing said "cannot
     * spend" while the layers docs/monero-signing.md names were unbuilt.
     * They are built now — CLSAG signing over an unsigned set, tested in
     * test/host-monerosign.test.ts — so the listing says so, and what this
     * checks is that the claim and the capability stay attached: if
     * `moneroSign` ever leaves the bridge, the sentence claiming it has to
     * leave the listing in the same commit. */
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host).toMatch(/moneroSign:\s*guarded\(/);
    const whatsNew = read('store/vault/whats-new.txt');
    expect(whatsNew).toMatch(/Monero unsigned sets/);
  });

  it('the demo walk the listing sells is the one the scanner offers', () => {
    /* The description tells a person they can try the flow with nothing but
     * this app. That is a screen, not a sentence: the lever has to exist,
     * and it has to be labeled a demo on the way in. */
    const description = read('store/vault/description.txt');
    expect(description).toMatch(/demo transaction/i);
    const scanner = readFileSync('ios/LabyrinthVault/Screens/Scanner.swift', 'utf8');
    expect(scanner).toMatch(/WALK A DEMO TRANSACTION/);
    const notes = read('store/vault/review-notes.md');
    expect(notes).toMatch(/WALK A DEMO TRANSACTION/);
  });

  it('the wallet says its numbers are fixtures, in the listing and on screen', () => {
    /* This guard read `Home.tsx` raw, and by the time anybody looked the only
     * two occurrences of DEMO DATA in that file were a block comment and a JSX
     * comment, both explaining that the chip had been deleted. It is the
     * strip-comments-first failure running in the direction nobody checks for:
     * green instead of red, a guard reporting that a notice is on a screen by
     * reading the sentence that says it was taken off one.
     *
     * So the on-screen half is now asked of the screens as a set, over code,
     * and it names where the notice ended up rather than where it used to be.
     * The listing promises a person will be told when a number is a fixture;
     * the check is that some screen still tells them. */
    const description = read('store/wallet/description.txt');
    expect(description).toMatch(/DEMO DATA/);

    const screens = readdirSync('wallet/src/screens')
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => ({ name, code: codeOnly(readFileSync(`wallet/src/screens/${name}`, 'utf8')) }));
    expect(screens.length, 'the screens directory moved').toBeGreaterThan(5);

    const showing = screens.filter((screen) => /DEMO DATA/.test(screen.code)).map((s) => s.name);
    expect(showing, 'the listing promises a DEMO DATA notice and no screen renders one').not.toEqual([]);
  });

  it('a wallet watching nothing says so rather than dressing a fixture up as a balance', () => {
    /* The other half of the same decision, and the reason the chip left. A
     * warning label over a balance loses to the balance, and a screenshot of
     * the pair is indistinguishable from a screenshot of money. Home now
     * returns early into its own screen. If that early return goes and a
     * fixture comes back to the hero, the listing's account of what a person
     * sees before they set a node is wrong again. */
    const home = codeOnly(readFileSync('wallet/src/screens/Home.tsx', 'utf8'));
    expect(home, 'Home no longer branches on watching nothing').toMatch(/watchingNothing\(/);
    expect(home, 'the empty state screen is gone from Home').toMatch(/<NothingYet\b/);
  });

  it('the wallet claims a Monero scan only while the scanner exists', () => {
    /* This guard pointed the other way for months: the listing said scanning
     * was not finished while `core/moneroscan.ts` walked blocks, proved
     * amounts against their commitments and settled spends through the key
     * image book, all under test. The listing says so now, and this holds the
     * claim and the capability together the same way the vault's Monero
     * guard does: if the scan or the round trip ever leaves the code, the
     * sentences selling them have to leave the listing in the same commit. */
    const scanner = readFileSync('wallet/src/core/moneroscan.ts', 'utf8');
    expect(scanner).toMatch(/export async function scan\(/);
    const watcher = readFileSync('wallet/src/core/watcher.ts', 'utf8');
    expect(watcher).toMatch(/importKeyImages\(/);
    const description = read('store/wallet/description.txt');
    expect(description).toMatch(/scans on the device/i);
    expect(description).toMatch(/key image round trip/i);
    const notes = read('store/wallet/review-notes.md');
    expect(notes).toMatch(/scans on the device/i);
  });

  it('the wallet prices nothing it has no price for', () => {
    /* The listing says a dollar figure appears only when a price is actually
     * known. That is a claim about the screens: `centsPerUnit` is zero until
     * the relay answers, zero means unknown, and a screen that rendered it
     * anyway would print "$0.00" under somebody's actual money. The gate is
     * `hasPrice`, and the components every fiat line goes through have to ask
     * it. */
    const units = readFileSync('wallet/src/core/units.ts', 'utf8');
    expect(units).toMatch(/export function hasPrice/);
    const money = readFileSync('wallet/src/components/money.tsx', 'utf8');
    expect(money).toMatch(/if \(!hasPrice\(centsPerUnit\)\) return null;/);
    const home = readFileSync('wallet/src/screens/Home.tsx', 'utf8');
    expect(home).toMatch(/hasPrice\(/);
  });

  it('the price the wallet does show came through the relay, never a service the phone asks', () => {
    /* The listing sells the arrangement: the relay asks the price source and
     * serves every client one cached answer, so the source sees a server on a
     * timer and never a person. Held together the usual way: the claim in the
     * listing, the client that only speaks to the relay, the Worker module
     * with the pinned host and the cache, and the watcher wiring that reads
     * the same deployment string the swap does. */
    const description = read('store/wallet/description.txt');
    expect(description).toMatch(/cached answer/i);
    const client = readFileSync('wallet/src/net/prices.ts', 'utf8');
    expect(client).toMatch(/\/v1\/price/);
    const worker = readFileSync('worker/src/prices.ts', 'utf8');
    expect(worker).toMatch(/PRICE_CACHE_MS/);
    expect(worker).toMatch(/api\.coingecko\.com/);
    const watcher = readFileSync('wallet/src/core/watcher.ts', 'utf8');
    expect(watcher).toMatch(/swapConfigured\(\) && !ownNodesOnly\(nodes\) \? live\(SWAP_PROXY\) : null/);
    /* And the exception the arrangement carries: the owner running only their
     * own nodes asks Labyrinth for nothing, prices included. The watcher
     * skips (the line above), and the Nodes screen says so where the person
     * made that choice. */
    const nodesScreen = readFileSync('wallet/src/screens/Nodes.tsx', 'utf8');
    expect(nodesScreen).toMatch(/price lookups are skipped/i);
  });

  it('the wallet review notes explain the stand-in before a reviewer finds it', () => {
    /* A signer using a published seed, discovered by a reviewer who was not
     * told, is a rejection. Told in advance, it is a demonstration. */
    const notes = read('store/wallet/review-notes.md');
    expect(notes).toMatch(/STAND-IN VAULT/);
    expect(notes).toMatch(/BIP84/);
    expect(notes).toMatch(/compiled out/);
  });

  it('the stand-in is compiled out where the listing says it is', () => {
    /* The review notes and the description both tell a reviewer the stand-in
     * signer is not in a release build. That is a claim about the code, so it
     * is checked against the code: the signer refuses unless `DEMO`, and the
     * screen renders its controls only under `DEMO` — a button that stayed on
     * screen while the signer behind it returned null would be a dead control
     * in the shipping build, which is the thing the notes promise is gone. */
    const standin = readFileSync('wallet/src/demo/standin.ts', 'utf8');
    expect(standin).toMatch(/export const DEMO =[^\n]*__DEV__/);
    expect(standin).toMatch(/if \(!DEMO\) return null;/);
    /* Found rather than named. This asserted `Send.tsx` by filename until the
     * send flow was split and the vault handoff moved to `SendHandoff.tsx`,
     * at which point the guard was testing where a component lived rather than
     * whether it was gated. What matters is that the controls exist behind the
     * flag somewhere, and the loop below covers everywhere. */
    const gated = readdirSync('wallet/src/screens').filter((screen) =>
      /\{DEMO && \(/.test(readFileSync(`wallet/src/screens/${screen}`, 'utf8')),
    );
    expect(gated, 'no screen renders the stand-in controls under the DEMO flag').not.toEqual([]);
    /* Every screen that offers a stand-in lever gates it the same way, or a
     * release build grows a button that acts on nothing. The grep is for the
     * label because that is what a person would tap: a STAND-IN control in a
     * screen that never reads the DEMO flag is the regression. */
    for (const screen of readdirSync('wallet/src/screens')) {
      const code = readFileSync(`wallet/src/screens/${screen}`, 'utf8');
      if (/STAND-IN/.test(code)) {
        expect(code, `${screen} offers a stand-in control without the DEMO gate`).toMatch(
          /import \{[^}]*\bDEMO\b[^}]*\} from '\.\.\/demo\/standin'/,
        );
      }
    }
  });

  it('both privacy policies are served at the URL the runbook tells you to paste', () => {
    /* App Store Connect demands a privacy-policy URL per app and a reviewer
     * follows it. Neither URL served a policy until `site/scripts/render-policies.mjs`,
     * and the failure was quiet rather than loud: `not_found_handling` is
     * `single-page-application`, so an unmatched path answers 200 with the
     * marketing page. A reviewer would have landed on the landing page and
     * concluded there was no policy, with nothing reporting an error.
     *
     * Three things have to agree, and this holds them together: the route the
     * build writes, the URL `docs/shipping.md` says to paste, and the file
     * that route is rendered from. Any one of them moving alone is a dead
     * link that looks alive. */
    const renderer = readFileSync('site/scripts/render-policies.mjs', 'utf8');
    const shipping = read('docs/shipping.md');
    for (const [app, route] of [['vault', 'vault/privacy'], ['wallet', 'privacy']] as const) {
      const entry = new RegExp(
        `source:\\s*'store/${app}/privacy-policy\\.md',\\s*route:\\s*'${route}'`,
      );
      expect(renderer, `the renderer does not emit /${route} from store/${app}`).toMatch(entry);
      expect(
        shipping,
        `docs/shipping.md does not tell the ${app} submitter to paste labyrinthwallet.com/${route}`,
      ).toMatch(new RegExp(`labyrinthwallet\\.com/${route}\\b`));
    }
    /* And the build has to actually run it, or the routes exist only here. */
    const build = JSON.parse(readFileSync('site/package.json', 'utf8')).scripts.build;
    expect(build, 'site build does not render the policies').toMatch(/render-policies\.mjs/);
  });

  it('the privacy policy does not describe a protection this build does not have', () => {
    /* The policy explains the swap proxy and Oblivious HTTP, and both are real
     * arrangements with real code behind them. Neither is switched on: the
     * proxy address is an empty string and the relay list is empty, because a
     * relay run by the same company as the gateway would be theatre and no
     * other operator is agreed yet.
     *
     * A privacy policy is the one document where a reader takes the
     * description as the product, so the rule this repository already applies
     * in `worker/README.md` applies hardest here: say which arrangement is
     * actually in force rather than describing the better one. The policy
     * carries that sentence now, and this holds the two together.
     *
     * Note which direction it fails in. The day either one is switched on,
     * this test fails and points at a paragraph that has just become wrong in
     * the other direction, which is the only moment anybody would think to
     * reread it. */
    const policy = read('store/wallet/privacy-policy.md');
    if (!/Oblivious HTTP|routed through a proxy/.test(policy)) return;

    const proxyOff = /export const SWAP_PROXY = ''/.test(
      readFileSync('wallet/src/net/swapproxy.ts', 'utf8'),
    );
    const relaysOff = /export const RELAYS: Relay\[\] = \[\]/.test(
      readFileSync('wallet/src/net/oblivious.ts', 'utf8'),
    );
    expect(
      proxyOff && relaysOff,
      'the swap proxy or the relay list is configured now, so the policy paragraph saying neither is in force has to be rewritten before this check can go',
    ).toBe(true);
    expect(
      policy,
      'the policy describes the proxy and Oblivious HTTP without saying that neither is switched on in this build',
    ).toMatch(/Neither is in force in this release/);
  });

  it('neither listing promises something the other app does', () => {
    /* They are two apps and they will be read side by side, and this guard
     * spent the hot-spending work pointing the wrong way.
     *
     * It required the wallet's listing to say it had "never seen a private
     * key". That sentence stopped being true when `keyvault.ts` started
     * storing an `xmrSeed` and a `btcMnemonic` and `Restore.tsx` became the
     * screen that accepts one. The suite therefore failed for anybody who
     * corrected the copy and passed while the copy was false, about a document
     * rendered to labyrinthwallet.com/privacy and handed to App Store Connect.
     * A guard that has to be defeated to tell the truth is worse than no
     * guard.
     *
     * What is true is the distinction, not the denial: a vault-paired account
     * is watch-only on the phone forever, an account made on the phone keeps
     * its seed in the keychain, and the vault does not watch the chain. So the
     * listing has to draw that line, and it may not redraw the old one. */
    const wallet = read('store/wallet/description.txt');
    expect(wallet, 'the wallet listing does not say a paired account is watch-only').toMatch(
      /watch-only here, forever|watch-only[^.]{0,40}forever/i,
    );
    expect(wallet, 'the wallet listing does not admit a seed is kept on the phone').toMatch(
      /recovery phrase is kept|keychain/i,
    );
    expect(
      wallet,
      'the wallet listing is denying it holds a key again; it holds one, and two federal filings say so',
    ).not.toMatch(/never seen a private key|holds no (private )?keys?\b|no seed phrase/i);
    expect(read('store/vault/description.txt')).toMatch(/does not watch the chain/i);
  });
});

/**
 * The BIS encryption self-classification report.
 *
 * The vault encrypts a seed at rest, which puts it in scope of the US export
 * regulations as a mass market item under ECCN 5D992.c, and the whole of the
 * resulting obligation is one annual CSV emailed to two federal addresses.
 * Supplement No. 8 to Part 742 fixes its shape exactly: twelve columns whose
 * header line must match "without alteration or variation", five permitted
 * ECCNs, two authorization types, forty-nine item type descriptors, and a
 * prohibition on the comma appearing anywhere except between fields.
 *
 * A form with that many fixed values is a form somebody fills in once and
 * gets subtly wrong, and the failure arrives as a parse error at an agency
 * rather than as a message to the filer. So it is checked here, where it is
 * cheap, against the values the rest of the repository already commits to.
 *
 * The format was six columns before 2010 and is twelve now, which is the
 * specific way this goes wrong: a template copied from a blog post is six
 * wide and looks perfectly reasonable.
 */
describe('the export self-classification report is shaped the way the regulation requires', () => {
  const REPORT = 'store/bis/self-classification-report.csv';

  /** Supplement No. 8 to Part 742, paragraph (b)(3), verbatim. */
  const HEADER =
    'PRODUCT NAME,MODEL NUMBER,MANUFACTURER,ECCN,AUTHORIZATION TYPE,ITEM TYPE,' +
    'SUBMITTER NAME,TELEPHONE NUMBER,E-MAIL ADDRESS,MAILING ADDRESS,' +
    'NON-U.S. COMPONENTS,NON-U.S. MANUFACTURING LOCATIONS';

  /** Paragraph (a)(4). The subparagraph belongs in prose, not in this field. */
  const ECCNS = ['5A002', '5B002', '5D002', '5A992', '5D992'];
  /** Paragraph (a)(5), plus the escape the regulation itself allows. */
  const AUTHORIZATIONS = ['ENC', 'MMKT', 'OTHER'];
  /** Paragraph (a)(6). All forty-nine, so a plausible invention fails. */
  const ITEM_TYPES = [
    'access point', 'cellular', 'computer', 'computer forensics',
    'cryptographic accelerator', 'data backup and recovery', 'database',
    'disk / drive encryption', 'distributed computing', 'e-mail communications',
    'fax communications', 'file encryption', 'firewall', 'gateway',
    'intrusion detection', 'key exchange', 'key management', 'key storage',
    'link encryption', 'local area networking (LAN)',
    'metropolitan area networking (MAN)', 'modem',
    'network convergence or infrastructure n.e.s.', 'network forensics',
    'network intelligence', 'network or systems management (OAM / OAM&P)',
    'network security monitoring',
    'network vulnerability and penetration testing', 'operating system',
    'optical networking', 'radio communications', 'router',
    'satellite communications', 'short-range wireless n.e.s.',
    'storage area networking (SAN)', '3G / 4G / LTE / WiMAX',
    'trusted computing', 'videoconferencing',
    'virtual private networking (VPN)', 'voice communications n.e.s.',
    'voice over Internet protocol (VoIP)', 'wide area networking (WAN)',
    'wireless local area networking (WLAN)',
    'wireless personal area networking (WPAN)', 'commodities n.e.s.',
    'components n.e.s.', 'software n.e.s.', 'test equipment n.e.s.', 'OTHER',
  ];

  const lines = read(REPORT).split('\n');
  const rows = lines.slice(1).map((line) => line.split(','));

  it('has the header the regulation dictates, to the character', () => {
    expect(lines[0], 'the header line has been altered').toBe(HEADER);
  });

  it('describes at least one item', () => {
    /* An empty report would pass every check below by having nothing to
     * check, which is the shape a guard takes when it stops guarding. */
    expect(rows.length).toBeGreaterThan(0);
  });

  it('gives every row exactly twelve fields and leaves none blank', () => {
    /* The comma trap. A mailing address written the way anybody writes one —
     * "123 Example Street, Portland, OR" — turns one row into three fields
     * too many, and the regulation forbids the comma anywhere except between
     * fields for exactly this reason. It fails at the agency, not here,
     * unless it fails here. */
    for (const [index, row] of rows.entries()) {
      expect(row.length, `row ${index + 1} does not have twelve fields, so a value contains a comma`).toBe(12);
      for (const [field, value] of row.entries()) {
        expect(value.trim(), `row ${index + 1} field ${field + 1} is blank`).not.toBe('');
      }
    }
  });

  it('uses only the values the regulation permits', () => {
    for (const [index, row] of rows.entries()) {
      expect(row[0]!.length, `row ${index + 1}: product name is over 50 characters`).toBeLessThanOrEqual(50);
      expect(row[1]!.length, `row ${index + 1}: model number is over 50 characters`).toBeLessThanOrEqual(50);
      expect(row[2]!.length, `row ${index + 1}: manufacturer is over 50 characters`).toBeLessThanOrEqual(50);
      expect(ECCNS, `row ${index + 1}: ${row[3]} is not a permitted ECCN for this field`).toContain(row[3]);
      expect(AUTHORIZATIONS, `row ${index + 1}: ${row[4]} is not a permitted authorization type`).toContain(row[4]);
      expect(ITEM_TYPES, `row ${index + 1}: ${row[5]} is not one of the forty-nine descriptors`).toContain(row[5]);
      expect(['YES', 'NO'], `row ${index + 1}: non-US components must be YES or NO`).toContain(row[10]);
    }
  });

  it('says the same thing about encryption that the apps tell Apple', () => {
    /* This guard was two sentences of stale comment over an assertion that
     * could only ever pass.
     *
     * It read `ios/project.yml` raw and required
     * `ITSAppUsesNonExemptEncryption: true` to be in it. That key has not been
     * in the manifest for some time: it is quoted inside the `#` block
     * explaining why it was taken out, after four uploads were rejected
     * against it. So the only thing satisfying this assertion was the prose
     * about its own removal, and rewording that paragraph would have failed a
     * test about a federal filing. `test/shipping.test.ts` holds the manifest
     * half correctly, over stripped comments and in the other direction.
     *
     * The comment was stale in the other direction too: it said the wallet
     * "is deliberately not listed at all", which stopped being true when the
     * companion started storing a seed and grew its own row.
     *
     * What is left here is the half this file can actually check: both apps
     * hold key material, so both are in the report, and every row claims mass
     * market. */
    const named = rows.map((row) => row[0]);
    expect(named, 'the vault is not in the report it is the reason for').toContain('Labyrinth Vault');
    expect(named, 'the companion stores a seed and is not in the report').toContain('Labyrinth Wallet');
    expect(rows.every((row) => row[4] === 'MMKT'), 'a row claims something other than mass market').toBe(true);

    /* And the manifest guard this one used to duplicate badly still exists,
     * so deleting it does not silently leave the plist unchecked. */
    expect(
      readFileSync('test/shipping.test.ts', 'utf8'),
      'nothing checks the export compliance key in the manifest any more',
    ).toMatch(/ITSAppUsesNonExemptEncryption/);
  });

  it('does not claim to be filed while it still has blanks in it', () => {
    /* The guard this file exists for. `store/vault/review-notes.md` told
     * Apple's reviewer that the self-classification report "is filed" while
     * it did not exist, which is a statement to a reviewer about a federal
     * filing. Whatever the documents say about this report has to track
     * whether it is actually fit to send. */
    const unfilled = rows.some((row) => row.some((value) => value.includes('TO BE COMPLETED')));
    /* Only the two documents that are pasted into App Store Connect. The
     * runbook and store/bis/README.md both discuss this filing at length,
     * including quoting the sentence that was wrong, and a guard that reads
     * the account of a mistake as the mistake is the seventh of its kind in
     * this repository. What a reviewer is told is the thing worth holding. */
    const claims = [
      'store/vault/review-notes.md',
      'store/wallet/review-notes.md',
    ].filter(
      (path) =>
        existsSync(path) &&
        /(report|filing)\s+(is|has been|was)\s+filed/i.test(read(path)),
    );

    if (unfilled) {
      expect(claims, 'a document says the report is filed while the report has blanks in it').toEqual([]);
    }
  });
});
