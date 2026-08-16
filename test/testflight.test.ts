/*
 * The device plan covers every screen, or it says why not.
 *
 * `docs/testflight.md` is the only instruction a person with a phone gets, and
 * the three remaining gaps in this project all need a person with a phone. It
 * had gone quietly stale: an eleven-step plan ending at Bitcoin signing, whose
 * own "what this does not cover" section said the companion wallet "has never
 * been compiled" long after it had grown to sixty-nine modules and thirteen
 * screens. Somebody following it would have tested the Bitcoin path, reported
 * that it worked, and left the entire Monero surface untested *and believed
 * tested*, which is worse than leaving it untested and known.
 *
 * That is the same drift the verification ledger has a guard for, so this is
 * the same guard. Every screen in either app needs a decision recorded here:
 * either the phrase the plan uses to send somebody to it, or an explicit note
 * that it is not a step and why. A screen added without one fails this test,
 * which is the moment to ask whether a person should be told to look at it.
 *
 * What this cannot check is whether the plan's expectations are *right*. That
 * needs the phone.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const plan = readFileSync('docs/testflight.md', 'utf8');

/**
 * How the plan sends somebody to each screen.
 *
 * A phrase rather than a file name, because the plan speaks the language of
 * the device: "SETTINGS on the vault", not `Settings.swift`. `null` means the
 * screen is deliberately not its own step, with the reason beside it.
 */
const VAULT: Record<string, string | null> = {
  Launch: 'launch screen',
  Setup: 'setup walk',
  Unlock: 'passphrase screen',
  Scanner: 'camera on',
  Review: 'review screen',
  Signed: 'signed result',
  Export: 'EXPORT tab',
  Airgap: 'animated QR',
  KeyImages: 'KEY IMAGES on the vault',
  MoneroFileScreen: 'WHAT THIS FILE',
  MoneroReview: 'read the review screen properly',
  Settings: 'SETTINGS on the vault',
  RefusalScreen: 'refusal screen',
  // The tab bar every test starts from. There is nothing on it to get wrong
  // that a test of one of its destinations would not already find.
  Home: null,
  // The "how this is arranged" reading material. Test 20 covers the same
  // question for settings, and reading two prose screens is one instruction.
  Protocols: null,
};

const COMPANION: Record<string, string | null> = {
  Vault: 'VAULT screen',
  MoneroFile: 'MONERO FILE screen',
  KeyImages: 'Import key images',
  Send: 'Build a payment on the companion',
  Scan: 'Scan them back',
  Receive: 'Fund the stagenet address',
  Onboarding: '**Onboarding.**',
  Activity: '**Activity.**',
  Asset: '**Asset.**',
  Nodes: '**Nodes.**',
  CoinPicker: '**Coin picker.**',
  // The list the app opens on. Same reasoning as the vault's Home.
  Home: null,
  // Out of scope on purpose, and the plan says so: these talk to third-party
  // exchanges, which is a different trust question from an airgap.
  Swap: null,
  SwapStatus: null,
};

function screens(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length));
}

describe('the device test plan', () => {
  it('has a decision recorded for every vault screen', () => {
    const found = screens('ios/LabyrinthVault/Screens', '.swift');
    expect(found.length).toBeGreaterThan(10);
    const undecided = found.filter((name) => !(name in VAULT));
    expect(
      undecided,
      'these vault screens are in neither the plan nor its list of deliberate omissions',
    ).toEqual([]);
  });

  it('has a decision recorded for every companion screen', () => {
    const found = screens('wallet/src/screens', '.tsx');
    expect(found.length).toBeGreaterThan(10);
    const undecided = found.filter((name) => !(name in COMPANION));
    expect(
      undecided,
      'these companion screens are in neither the plan nor its list of deliberate omissions',
    ).toEqual([]);
  });

  it('actually says the phrases it claims to', () => {
    /* The other direction. Without this, the map above could keep claiming
     * coverage for a step somebody deleted. */
    const missing: string[] = [];
    for (const [app, map] of [['vault', VAULT], ['companion', COMPANION]] as const) {
      for (const [screen, phrase] of Object.entries(map)) {
        if (phrase !== null && !plan.includes(phrase)) missing.push(`${app}/${screen}: "${phrase}"`);
      }
    }
    expect(missing, 'the plan no longer contains these').toEqual([]);
  });

  it('leads with the two tests where a failure costs money', () => {
    /* Everything else in the plan is about whether the app works. These two
     * are about whether somebody's money is recoverable, and a plan that buries
     * them among twenty is a plan whose most important steps get skipped when
     * somebody runs out of evening. */
    expect(plan).toMatch(/restores in another wallet/);
    expect(plan).toMatch(/whether a real wallet imports a key-image export/);
  });

  it('names the gate, and what would lift it', () => {
    /* The plan is the only route to the evidence, so it has to say what the
     * evidence is: a transaction id and the node that took it. */
    expect(plan).toContain('MONERO_SEND_BROADCAST_VERIFIED');
    expect(plan).toMatch(/transaction id and the node/);
  });

  it('still admits what it does not cover', () => {
    /* This section is the one that went stale, by continuing to say the
     * companion had never been compiled. Its value is entirely in being
     * current, so it has to keep existing and keep naming real gaps. */
    expect(plan).toMatch(/## What this plan still does not cover/);
    expect(plan).toMatch(/Restoring a vault/);
    expect(plan).not.toMatch(/which has never been\s+compiled/);
  });
});
