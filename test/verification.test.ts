/*
 * The verification ledger stays true, or this fails.
 *
 * `docs/verification.md` is the one place that says, for every format this
 * repository reimplements, whose software agreed with it. That makes it the
 * document a reviewer reads first, which makes it the document most worth
 * keeping honest: a ledger that has drifted is worse than no ledger, because
 * it is read as current.
 *
 * The guards here are the ones that catch drift rather than the ones that
 * restate prose:
 *
 *   - a fixture may not exist without saying where it came from, and it may
 *     not exist without a row in the ledger. Adding a fixture and forgetting
 *     to record its witness is how the ledger silently stops being complete;
 *   - an oracle harness may not exist without a row either, for the same
 *     reason and because the harnesses are the only thing that produces new
 *     witnesses;
 *   - every file the ledger points at has to be there;
 *   - the section recording what the oracle *found* has to keep naming the
 *     defects. A ledger of green rows is not evidence, and the temptation to
 *     tidy away the failures is exactly what would make it one.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const LEDGER = 'docs/verification.md';
const doc = readFileSync(LEDGER, 'utf8');

describe('the verification ledger', () => {
  it('states the rule it exists to enforce', () => {
    /* The one sentence the last three findings all came from. If it goes, the
     * document is a list of files rather than an argument. */
    expect(doc).toMatch(/round trip proves an encoder and a decoder agree/i);
    expect(doc).toMatch(/proves nothing about\s+the format/i);
  });

  it('accounts for every fixture in the tree', () => {
    const fixtures = readdirSync('test/fixtures').filter((f) => f.endsWith('.json'));
    expect(fixtures.length).toBeGreaterThan(10);
    const missing = fixtures.filter((f) => !doc.includes(f));
    expect(missing, 'these fixtures have no row saying who witnessed them').toEqual([]);
  });

  it('accounts for every oracle harness', () => {
    /* The stub files are ours and witness nothing, so they are not claims and
     * do not belong in the ledger. Everything else asks upstream a question
     * and its answer ends up in a fixture. */
    const OURS = new Set([
      'rng-counter.c',
      'unreachable.c',
      'wallet-unreachable.cpp',
      'mlock-stub.cpp',
    ]);
    const harnesses = readdirSync('oracle/src')
      .filter((f) => /\.(c|cpp)$/.test(f) && !OURS.has(f));
    expect(harnesses.length).toBeGreaterThan(5);
    const missing = harnesses.filter((f) => !doc.includes(f));
    expect(missing, 'these harnesses have no row in the ledger').toEqual([]);
  });

  it('points only at files that exist', () => {
    /* Two kinds of backticked name are unambiguously ours and are checked: a
     * path with a directory in it, and a bare `.json`, which in this document
     * is always a fixture.
     *
     * A bare source filename is deliberately not checked, because the document
     * names Monero's files the same way it names ours - `crypto-ops.c` and
     * `wallet2.cpp` sit in the same sentences as `clsag.cpp` - and a guard
     * that demanded every one of them exist here would be asserting that
     * upstream's source tree is ours. The harness names are covered from the
     * other direction anyway, by the test above, which reads the directory and
     * requires the document to mention each file. */
    const backticked = [...doc.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|tsx|c|cpp|sh|mjs|json|md|swift))`/g)]
      .map((m) => m[1]!);
    const claimed = [...new Set(backticked)]
      .filter((p) => p.includes('/') || p.endsWith('.json'))
      .map((p) => (p.includes('/') ? p : `test/fixtures/${p}`));
    expect(claimed.length).toBeGreaterThan(15);
    const gone = claimed.filter((p) => !existsSync(p));
    expect(gone, 'the ledger points at files that are not there').toEqual([]);
  });

  it('keeps naming what the oracle found', () => {
    /* Three defects, and each one is the evidence that the rest of the table
     * is worth reading. The first two are the load-bearing ones: a prover and
     * a verifier that shared a mistake, and an encoder and a test that shared
     * one. */
    expect(doc).toMatch(/## What it found/);
    expect(doc).toMatch(/C_offset/);
    expect(doc).toMatch(/mirrored exactly in `clsagVerify`/);
    expect(doc).toMatch(/subaddressKeys/);
    expect(doc).toMatch(/a·B/);
  });

  it('is honest about the gate, and the gate agrees', () => {
    /* The one claim in the whole project that money depends on and that no
     * amount of byte checking can close. If the ledger stops naming it, or the
     * constant moves, this is the tripwire. */
    expect(doc).toContain('MONERO_SEND_BROADCAST_VERIFIED');
    const gate = readFileSync('wallet/src/core/moneroreadiness.ts', 'utf8');
    expect(gate).toContain('MONERO_SEND_BROADCAST_VERIFIED');
    /* Whichever way the constant reads, the ledger has to say the same thing.
     * `test/moneroplan.test.ts` is what forces the constant and the recorded
     * evidence to move together; this only forces the prose to keep up. */
    const live = /MONERO_SEND_BROADCAST_VERIFIED\s*=\s*true/.test(gate);
    expect(doc.includes('is\n  `false`') || doc.includes('is `false`'), 'the ledger describes the gate as false')
      .toBe(!live);
  });

  it('separates what is ours by design from what is simply untested', () => {
    /* The distinction that keeps the last section from reading as an excuse.
     * Nobody else implements the LV1 wire, so a round trip is the right test
     * for it; a daemon accepting a broadcast is a real gap with a real plan. */
    expect(doc).toMatch(/## What has no outside witness/);
    expect(doc).toMatch(/Ours by design/);
    expect(doc).toMatch(/Genuinely untested/);
  });
});

describe('every fixture says where it came from', () => {
  /* Generalized from the check in test/oracle.test.ts, which only covered the
   * ones oracle/PINNED.json claims. A fixture without provenance is a number
   * somebody has to believe, which is the thing oracle/README.md exists to
   * make impossible. */
  const fixtures = readdirSync('test/fixtures').filter((f) => f.endsWith('.json'));

  for (const name of fixtures) {
    it(`${name} names its source`, () => {
      const value = JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8')) as {
        note?: string;
        source?: unknown;
      };
      const provenance = [
        typeof value.note === 'string' ? value.note : '',
        typeof value.source === 'string' ? value.source : JSON.stringify(value.source ?? ''),
      ].join(' ');
      expect(provenance.length, `${name} has neither a note nor a source`).toBeGreaterThan(20);
      /* Naming somebody: an upstream project, a wallet, a reference
       * implementation, a block explorer, or the harness that asked one. */
      expect(
        provenance,
        `${name} does not say whose answer it is`,
      ).toMatch(/monero|electrum|bbqr|coinkite|bc-ur|argon2|libsodium|keccak|oracle\/|xmrchain|BIP/i);
    });
  }
});
