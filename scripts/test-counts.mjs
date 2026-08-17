/**
 * The three numbers in CLAUDE.md, checked against the three suites.
 *
 * ## Why this script exists
 *
 * CLAUDE.md documents a test count per suite, and says out loud what the
 * counts are for: "so that a suite quietly shrinking is visible, not as a
 * target". They were 1015 and 631 for long enough to be wrong by two hundred
 * tests, and the line admitting that is the failure that line exists to catch,
 * pointed at itself. Nothing checked them.
 *
 * ## Why not a test
 *
 * A test that knows its own suite's total would have to run the suite inside
 * itself, which is either a recursion or a second full run of everything on
 * every commit. So the totals come from the suites themselves: each of the
 * three vitest configs writes a JSON report as it runs, and this reads the
 * three reports. Nothing here runs a test.
 *
 * That means it is only meaningful after all three have run, which is exactly
 * the sequence "Before you commit" in CLAUDE.md already asks for, and exactly
 * what `.github/workflows/tests.yml` does on every push. A missing report is a
 * suite that has not been run, and this says so rather than passing.
 *
 * ## What it does not catch, stated rather than implied
 *
 * A report is refused when it covers fewer test files than the suite has, so
 * `vitest run one-file.test.ts` cannot be mistaken for a run. Nothing here
 * checks *freshness* beyond that: a full run, then an edit that adds a test to
 * an existing file, then this, and the answer is yesterday's. Deliberately not
 * solved with file timestamps, which would make a check about test counts fail
 * for reasons about filesystems. CI runs this immediately after the three
 * suites, in one job, which is where the guarantee actually comes from.
 *
 * ## Why it can write
 *
 * `--write` updates the numbers in place. A guard that can only refuse leaves
 * somebody editing the same figure in two files by hand, and the reason these
 * went stale in the first place is that keeping them right was manual.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A suite, where its report lands, and how each document names its number.
 *
 * The patterns are anchored on the surrounding words rather than on the digits
 * alone, because a bare number in a markdown file is every other number in it.
 * Each has exactly one capture group, which is the count.
 */
const SUITES = [
  {
    name: 'vault',
    report: '.counts/vault.json',
    tests: 'test',
    run: 'npm test',
    sites: [
      { file: 'CLAUDE.md', pattern: /(?<=# vault: )(\d+)(?= tests)/ },
      { file: 'docs/handoff.md', pattern: /(?<=\*\*)(\d+)(?= vault,)/ },
    ],
  },
  {
    name: 'companion',
    report: 'wallet/.counts/wallet.json',
    tests: 'wallet/test',
    run: 'cd wallet && npx vitest run',
    sites: [
      { file: 'CLAUDE.md', pattern: /(?<=# companion: )(\d+)(?= tests)/ },
      { file: 'docs/handoff.md', pattern: /(\d+)(?= companion,)/ },
    ],
  },
  {
    name: 'worker',
    report: 'worker/.counts/worker.json',
    tests: 'worker/test',
    run: 'cd worker && npm test',
    sites: [
      { file: 'CLAUDE.md', pattern: /(?<=# the Worker: )(\d+)(?= tests)/ },
      { file: 'docs/handoff.md', pattern: /(\d+)(?= Worker\.\*\*)/ },
    ],
  },
];

/** Every test file a suite has, however deep. */
function testFiles(dir, found = []) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) testFiles(join(dir, entry.name), found);
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(join(dir, entry.name));
  }
  return found;
}

/** What a suite reported, or why there is no answer. */
function counted(suite) {
  const path = join(root, suite.report);
  if (!existsSync(path)) {
    return { problem: `${suite.name}: no report at ${suite.report}. Run \`${suite.run}\` first.` };
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  /* `numTotalTests` rather than counting the assertions array: a skipped or
   * todo test is still a test the suite has, and a count that moved because
   * somebody skipped one should be visible rather than absorbed. */
  const total = report.numTotalTests;
  if (typeof total !== 'number' || total <= 0) {
    return { problem: `${suite.name}: ${suite.report} reports no tests, so it is not a report of a run.` };
  }
  if (report.numFailedTests > 0) {
    return { problem: `${suite.name}: that run had ${report.numFailedTests} failures, so its total is not a claim.` };
  }

  /* A report from `vitest run one-file.test.ts` is a real report of a real
   * run and a false answer to the question this script asks. It would read as
   * the suite shrinking by nine hundred tests, which is the exact alarm this
   * whole thing exists to raise, raised about nothing. So the report has to
   * cover every test file the suite has. */
  const ran = (report.testResults ?? []).length;
  const have = testFiles(suite.tests).length;
  if (ran !== have) {
    return {
      problem:
        `${suite.name}: that report covers ${ran} of ${have} test files, so it is from a partial run. ` +
        `Run \`${suite.run}\` before asking about the total.`,
    };
  }

  return { total };
}

const write = process.argv.includes('--write');
const problems = [];
const changes = [];
const totals = [];

for (const suite of SUITES) {
  const { total, problem } = counted(suite);
  if (problem) {
    problems.push(problem);
    continue;
  }
  totals.push(`${suite.name} ${total}`);

  for (const site of suite.sites) {
    const path = join(root, site.file);
    const text = readFileSync(path, 'utf8');
    const found = site.pattern.exec(text);
    if (!found) {
      problems.push(
        `${site.file} no longer states the ${suite.name} count anywhere this can find it. ` +
          `Either the sentence changed or the number went away; both need a look.`,
      );
      continue;
    }
    const documented = Number(found[1]);
    if (documented === total) continue;

    if (write) {
      writeFileSync(path, text.replace(site.pattern, String(total)));
      changes.push(`${site.file}: ${suite.name} ${documented} -> ${total}`);
    } else {
      problems.push(
        `${site.file} says the ${suite.name} suite has ${documented} tests and it has ${total}. ` +
          `Run \`node ${relative(process.cwd(), join(root, 'scripts/test-counts.mjs'))} --write\` ` +
          `if the change is deliberate.`,
      );
    }
  }
}

if (changes.length > 0) {
  for (const change of changes) console.log(change);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

console.log(`test counts agree: ${totals.join(', ')}`);
