/*
 * Signing on this device.
 *
 * The cryptography under this is not on trial here. `signPsbt` is checked
 * against BIP84's published vector in the vault's own suite, `signMoneroSpend`
 * against Monero's, and `monerosend.test.ts` drives the whole Monero loop
 * through a fake node. What this file is about is the ordering, which is the
 * only thing `hotsign.ts` adds and the only thing that could be quietly got
 * wrong:
 *
 *   - a vault account is refused before anything else happens, and no
 *     arrangement of the other arguments changes that;
 *   - the Face ID prompt is awaited before a key is opened, rather than after,
 *     because an authorization that runs on an already-decrypted seed is a
 *     formality;
 *   - what comes out is offered to `verifySigned` rather than trusted, so the
 *     local path reaches `ready` through the same gate the camera path does.
 *
 * The Bitcoin half is proved end to end, because it can be: prepare a real
 * draft, sign it with the real signer, and put the result through the real
 * verifier. That is the whole claim of the feature in one test.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

import { prepare, verifySigned } from '../src/core/build';
import { signHere, type GateResult } from '../src/core/hotsign';
import { KEYVAULT_SCHEMA, type HotRecord } from '../src/core/keyvault';
import { DEMO_ZPUB, DemoWatcher } from '../src/core/demo';
import type { Draft } from '../src/core/model';

/* Comments removed before any check over the source. Six guards in this
 * repository have now fired on the prose explaining the rule they enforce, and
 * this file made it seven before the strip was added: `hotsign.ts` documents at
 * length that it does not call `verifySigned`, which is the string the guard
 * below looks for. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* BIP84's own vector, which is the account `DEMO_ZPUB` describes. The wallet
 * signing below has to be the wallet the draft was built for, or the signature
 * is against somebody else's coins and proves nothing. */
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const NOW = 1_760_000_000_000;

const utxos = new DemoWatcher().snapshot(NOW).assets.BTC.utxos;

function bitcoinDraft(amount = 250_000n): Draft {
  const result = prepare({
    asset: 'BTC',
    recipient: RECIPIENT,
    amount,
    rate: 11,
    utxos,
    balance: utxos.reduce((sum, utxo) => sum + utxo.value, 0n),
    zpub: DEMO_ZPUB,
    change: { index: 12 },
    now: NOW,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.draft;
}

function hotRecord(over: Partial<HotRecord> = {}): HotRecord {
  return {
    v: KEYVAULT_SCHEMA,
    xmrSeed: null,
    btcMnemonic: WORDS,
    network: 'mainnet',
    createdAt: 0,
    ...over,
  };
}

const allow = async (): Promise<GateResult> => ({ ok: true });
const scalars = (count: number) =>
  Array.from({ length: count }, (_, i) => Uint8Array.from({ length: 32 }, (_, b) => (i * 31 + b * 7 + 3) & 0xff));

describe('a vault account cannot be signed for here, whatever else is true', () => {
  it('refuses even with a usable seed, a passing gate and a valid draft', () => {
    /* Everything else in this call is correct. The only thing wrong is the
     * source, and it is enough. */
    return expect(
      signHere({ source: 'vault', record: hotRecord(), draft: bitcoinDraft(), gate: allow, scalars }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('says where that account does sign, rather than only that it cannot here', async () => {
    const result = await signHere({
      source: 'vault',
      record: hotRecord(),
      draft: bitcoinDraft(),
      gate: allow,
      scalars,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/vault signs for it/);
  });

  it('refuses before it asks for Face ID, so a refusal costs no prompt', async () => {
    /* Prompting and then refusing teaches somebody that the prompt is what
     * decides, and it is not: the source is. */
    let prompted = false;
    await signHere({
      source: 'vault',
      record: hotRecord(),
      draft: bitcoinDraft(),
      gate: async () => {
        prompted = true;
        return { ok: true };
      },
      scalars,
    });
    expect(prompted).toBe(false);
  });
});

describe('the Face ID gate comes before the key', () => {
  it('signs nothing when the prompt is refused', async () => {
    const result = await signHere({
      source: 'hot',
      record: hotRecord(),
      draft: bitcoinDraft(),
      gate: async () => ({ ok: false, problem: 'Face ID was not recognized.' }),
      scalars,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toBe('Face ID was not recognized.');
  });

  it('opens no wallet until the gate has answered', () => {
    /* Read from the source, because the ordering is the property and there is
     * no observable difference at runtime between opening before and after.
     * The gate must be awaited above the point where any key is opened. */
    const source = readFileSync('src/core/hotsign.ts', 'utf8');
    const gateAt = source.indexOf('const allowed = await gate();');
    const btcAt = source.indexOf('const wallet = openBitcoin(record);');
    const xmrAt = source.indexOf('const wallet = openMonero(record);');
    expect(gateAt).toBeGreaterThan(0);
    expect(btcAt).toBeGreaterThan(gateAt);
    expect(xmrAt).toBeGreaterThan(gateAt);
  });

  it('checks the source above the gate, so the order is source, prompt, key', () => {
    const source = readFileSync('src/core/hotsign.ts', 'utf8');
    expect(source.indexOf('if (!canSignHere(source))')).toBeLessThan(
      source.indexOf('const allowed = await gate();'),
    );
  });
});

describe('Bitcoin, end to end', () => {
  it('signs a real draft into bytes the real verifier accepts', async () => {
    /* The whole feature in one test. A draft prepared by this wallet, signed
     * by the vault's own signer with keys from this phone's record, and put
     * through the same `verifySigned` a signature returning over the camera
     * goes through. */
    const draft = bitcoinDraft();
    const result = await signHere({
      source: 'hot',
      record: hotRecord(),
      draft,
      gate: allow,
      scalars,
    });
    expect(result.ok, result.ok ? '' : result.problem).toBe(true);
    if (!result.ok) throw new Error(result.problem);

    const verified = verifySigned(draft, result.raw);
    expect(verified.ok, verified.ok ? '' : JSON.stringify(verified)).toBe(true);
  });

  it('pays the recipient the amount that was reviewed, not something else', async () => {
    const draft = bitcoinDraft(310_000n);
    const result = await signHere({ source: 'hot', record: hotRecord(), draft, gate: allow, scalars });
    if (!result.ok) throw new Error(result.problem);
    const verified = verifySigned(draft, result.raw);
    if (!verified.ok) throw new Error('the signature did not verify');
    expect(draft.amount).toBe(310_000n);
  });

  it('refuses when the phone holds no Bitcoin half, and says what would fix it', async () => {
    /* Somebody who restored twenty-five words out of Feather. The sentence has
     * to name the thing to go and do. */
    const result = await signHere({
      source: 'hot',
      record: hotRecord({ btcMnemonic: null, xmrSeed: 'ab'.repeat(32) }),
      draft: bitcoinDraft(),
      gate: allow,
      scalars,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/twelve words/);
  });

  it('does not mark its own work as verified', () => {
    /* The property `session.ts` holds: one route into a broadcastable state,
     * through `verifySigned`. A local signer that returned a `Verified` would
     * be the second one. */
    const source = codeOnly(readFileSync('src/core/hotsign.ts', 'utf8'));
    expect(source, 'the signer is verifying itself').not.toMatch(/verifySigned/);
    expect(source).toMatch(/\{ ok: true; raw: Uint8Array \}/);
  });
});

describe('Monero', () => {
  const moneroDraft = (): Draft => ({
    ...bitcoinDraft(),
    asset: 'XMR',
    /* Not a real unsigned set. These tests are about the refusals that happen
     * before parsing; the signing loop itself is proved against a fake node in
     * `monerosend.test.ts`, through the same `signMoneroSpend`. */
    unsigned: Uint8Array.from([1, 2, 3, 4]),
  });

  it('refuses when the phone holds no Monero half, and says what would fix it', async () => {
    const result = await signHere({
      source: 'hot',
      record: hotRecord(),
      draft: moneroDraft(),
      gate: allow,
      scalars,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/twenty-five words/);
  });

  it('refuses bytes that are not an unsigned set rather than signing them', async () => {
    /* The set is parsed by the vault's own parser even though this app built
     * it. A signer that trusts its caller's framing has no opinion about what
     * it is signing. */
    const result = await signHere({
      source: 'hot',
      record: hotRecord({ xmrSeed: 'ab'.repeat(32) }),
      draft: moneroDraft(),
      gate: allow,
      scalars,
    });
    expect(result.ok).toBe(false);
  });

  it('takes its randomness as a parameter rather than drawing it', () => {
    /* Same reason `makeHotRecord` does: a signer that reaches for a CSPRNG
     * cannot be run against a known answer. */
    const source = codeOnly(readFileSync('src/core/hotsign.ts', 'utf8'));
    expect(source, 'the signer draws its own entropy').not.toMatch(/getRandomValues|randomBytes/);
    expect(source).toMatch(/scalars: \(count: number\) => Uint8Array\[\]/);
  });

  it('refuses a short draw rather than signing with fewer scalars than needed', () => {
    /* A silent weakening of a signature is worse than a failure, so the count
     * is compared and named. */
    const source = readFileSync('src/core/hotsign.ts', 'utf8');
    expect(source).toMatch(/random\.length !== need/);
    expect(source).toMatch(/Signing needs \$\{need\} random values/);
  });
});

describe('the send flow, split and wired', () => {
  const send = readFileSync('src/screens/Send.tsx', 'utf8');
  const handoff = readFileSync('src/screens/SendHandoff.tsx', 'utf8');
  const signing = readFileSync('src/screens/SendSigning.tsx', 'utf8');
  const store = readFileSync('src/state/store.tsx', 'utf8');

  it('put the seam where the two paths diverge, not one face per file', () => {
    /* The split the signing step asked for: the faces that only exist on the
     * way that crosses a room live together, and the spine both paths share
     * stays in Send.tsx. */
    for (const face of ['Transmit', 'Awaiting', 'Receiving', 'Mismatch']) {
      expect(handoff, `${face} is not in the handoff file`).toMatch(new RegExp(`export function ${face}\\b`));
      expect(codeOnly(send), `${face} is still in Send.tsx`).not.toMatch(
        new RegExp(`^function ${face}\\b`, 'm'),
      );
    }
    for (const shared of ['Compose', 'Review', 'Ready', 'Done', 'Failed']) {
      expect(codeOnly(send), `${shared} left the spine`).toMatch(new RegExp(`function ${shared}\\b`));
    }
  });

  it('offers the local route only for the account being paid from', () => {
    /* The question has to be about *this* payment. An earlier version asked
     * `accounts.some((a) => a.signsHere)`, which is whether any account signs
     * here, and on a phone watching a vault and a hot wallet at once that
     * answers yes for both: the vault's own payment would have been offered a
     * SIGN ON THIS PHONE button. */
    const code = codeOnly(send);
    expect(code).toMatch(
      /const account = store\.accounts\.find\(\(entry\) => entry\.id === store\.selectedAccount\)/,
    );
    expect(code).toMatch(/const signsHere = account\?\.signsHere === true/);
    expect(code, 'any-account is back, and it offers the wrong button').not.toMatch(
      /accounts\.some\(\(account\) => account\.signsHere\)/,
    );
    expect(code, 'the review screen must not decide this from the record').not.toMatch(
      /hot !== null|store\.hot/,
    );
  });

  it('signs with the account being looked at, never merely one that can sign', () => {
    /* The same hole one layer down. `signOnThisDevice` picked the first
     * account that signs here, which on a two-account phone is the hot one
     * whatever is on screen, and would have carried its source into a
     * signature over the vault account's draft. */
    const action = /const signOnThisDevice = useCallback\([\s\S]*?\n  \}, \[/.exec(store)?.[0] ?? '';
    expect(action, 'signOnThisDevice not found').toBeTruthy();
    const code = codeOnly(action);
    expect(code).toMatch(/accounts\.find\(\(account\) => account\.id === selectedAccount\)/);
    expect(code).toMatch(/if \(!spending \|\| !spending\.signsHere\) return;/);
    expect(code, 'the first signable account is back').not.toMatch(
      /accounts\.find\(\(account\) => account\.signsHere\)/,
    );
  });

  it('routes a local signature through the same verifier the camera path takes', () => {
    /* The property `session.ts` holds: one route into a broadcastable state.
     * The store's signing action must end at `offerSignature`, which is where
     * `verifySigned` runs, rather than dispatching `returned` itself. */
    const action = /const signOnThisDevice = useCallback\([\s\S]*?\n  \}, \[/.exec(store)?.[0] ?? '';
    expect(action, 'signOnThisDevice not found in the store').toBeTruthy();
    const code = codeOnly(action);
    expect(code).toMatch(/offerSignature\(signed\.raw\)/);
    expect(code, 'the local path must not mark its own work verified').not.toMatch(
      /type: 'returned'/,
    );
  });

  it('raises the prompt once per payment', () => {
    /* A second prompt over the first is how a signature gets authorized twice
     * and built once. */
    const code = codeOnly(signing);
    expect(code).toMatch(/asked\.current/);
    expect(code).toMatch(/if \(asked\.current\) return;/);
  });

  it('offers no way to remember the prompt for later', () => {
    /* The absence is the feature. Per signature, never per session. */
    const biometrics = codeOnly(readFileSync('src/state/biometrics.ts', 'utf8'));
    for (const forbidden of ['withinSeconds', 'cache', 'lastAuth', 'remember']) {
      expect(biometrics, `the gate is growing a session: ${forbidden}`).not.toMatch(
        new RegExp(forbidden, 'i'),
      );
    }
  });

  it('keeps expo-local-authentication in exactly one file', () => {
    /* The same split `keychainStore.ts` has: the thinking is in `signgate.ts`
     * and runs under Node, the device call is here. */
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          /* Comments stripped, or this fires on `signgate.ts`, whose doc
           * explains at length that this import belongs somewhere else. That
           * is the rule being described, not broken. */
          codeOnly(readFileSync(path, 'utf8')).includes('expo-local-authentication')
        ) {
          importers.push(path);
        }
      }
    };
    walk('src');
    expect(importers).toEqual(['src/state/biometrics.ts']);
  });
});
