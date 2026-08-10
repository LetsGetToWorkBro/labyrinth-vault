/**
 * The same claim the vault's libraries make, extended to the iOS shell.
 *
 * test/no-network.test.ts walks src/ and fails on anything that could open a
 * socket. The Swift code in ios/ ships on the phone that is supposed to have
 * no network path at all, so it gets the same treatment: a coarse walk over
 * the source that makes adding a networking API an argument in review rather
 * than an accident in a feature branch.
 *
 * Coarse on purpose, like its sibling. The point is not to catch a determined
 * author; it is that CI notices.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function swiftSources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftSources(path));
    else if (entry.name.endsWith('.swift')) out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

/* Everything on iOS that opens a network path, or hands data to something
 * that does. Word-boundary shaped so prose in comments ("no URLSession
 * anywhere") still trips it — in this codebase even mentioning one of these
 * as an identifier deserves a failing test and a sentence of justification. */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bURLSession\b/, what: 'URLSession' },
  { pattern: /\bimport\s+Network\b/, what: 'the Network framework' },
  { pattern: /\bNWConnection\b|\bNWListener\b/, what: 'Network.framework connections' },
  { pattern: /\bCFSocket\b|\bCFStreamCreatePair\b/, what: 'CoreFoundation sockets' },
  { pattern: /\bMultipeerConnectivity\b/, what: 'MultipeerConnectivity' },
  { pattern: /\bCoreBluetooth\b|\bCBCentralManager\b/, what: 'Bluetooth' },
  { pattern: /\bNEVPNManager\b|\bNetworkExtension\b/, what: 'NetworkExtension' },
  { pattern: /\bCloudKit\b|\bNSUbiquitous/, what: 'iCloud' },
  { pattern: /\bWKWebView\b|\bSFSafariViewController\b/, what: 'a web view' },
  { pattern: /\bUIApplication\.shared\.open\b/, what: 'opening external URLs' },
  { pattern: /\bUserNotifications\b|\bUNUserNotificationCenter\b/, what: 'push notifications' },
];

describe('the iOS shell has no network code in it', () => {
  const files = swiftSources('ios');

  it('found the source to check, so a passing run means something', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.path.includes('Review'))).toBe(true);
  });

  for (const { pattern, what } of FORBIDDEN) {
    it(`does not reach for ${what}`, () => {
      const guilty = files.filter((f) => pattern.test(f.text)).map((f) => f.path);
      expect(guilty, `${what} appears in these files`).toEqual([]);
    });
  }

  it('never constructs a refusal escape hatch', () => {
    /* The refusal screens are load-bearing UI: exactly one action. Guard the
     * words that would appear if someone added a second one. */
    const escapes = /(continue\s*anyway|i\s*understand\s*the\s*risk|override\s*refusal|sign\s*anyway)/i;
    const guilty = files.filter((f) => escapes.test(f.text)).map((f) => f.path);
    expect(guilty, 'a refusal escape hatch appears in these files').toEqual([]);
  });
});
