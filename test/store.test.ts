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
        /* The vault also carries its privacy policy, which is not a Connect
         * form field but a URL the form demands; keeping the document here
         * keeps it versioned next to the claims it repeats. The wallet gets
         * one when it is submitted: its policy will differ (it talks to
         * nodes), and writing it early would mean guessing. */
        /* Both apps carry their privacy policy now. It is not a Connect form
         * field but a URL the form demands, and keeping the document here
         * versions it next to the claims it repeats. The wallet's waited until
         * it had a domain to host it and a network story worth being exact
         * about; it has both now. */
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
    const description = read('store/wallet/description.txt');
    expect(description).toMatch(/DEMO DATA/);
    expect(description).toMatch(/no (chain client|node)/i);
    // And the screen it promises says it too.
    expect(readFileSync('wallet/src/screens/Home.tsx', 'utf8')).toMatch(/DEMO DATA/);
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
    const send = readFileSync('wallet/src/screens/Send.tsx', 'utf8');
    expect(send).toMatch(/\{DEMO && \(/);
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
    /* They are two apps and they will be read side by side. The vault holds
     * keys and the wallet does not, and that is the sentence a person needs
     * to come away with. */
    expect(read('store/wallet/description.txt')).toMatch(/never seen a private key/i);
    expect(read('store/vault/description.txt')).toMatch(/does not watch the chain/i);
  });
});
