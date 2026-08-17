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
import { hotKeyImages } from '../src/core/hotimages';
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

/**
 * One top-level function out of a screen file.
 *
 * The guards below are about which of Send.tsx's faces reads what, and the
 * file holds six of them. A check over the whole file cannot tell the compose
 * step, which has no draft yet and so can only mean the selection, from the
 * review step, which has one and must ask about that instead. That is not a
 * hypothetical distinction: the version of the review guard this replaced
 * spelled out Compose's line, matched it, and passed while Review's was
 * wrong.
 *
 * The closing brace is found at column zero because every face in these files
 * is a top-level declaration. A nested one would need a real parser, and if
 * one ever appears this returns the empty string and the `toBeTruthy` below
 * fails rather than quietly matching nothing.
 */
function faceOf(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  if (start === -1) return '';
  const end = source.indexOf('\n}\n', start);
  return end === -1 ? '' : source.slice(start, end + 3);
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
    const sourceAt = source.indexOf('if (!canSignHere(source))');
    const gateAt = source.indexOf('const allowed = await gate();');
    /* Both floored, and that is the whole lesson of this guard. Bare, the
     * comparison passed when the airgap check was *deleted*: `indexOf` answers
     * -1 for something that is not there, and -1 is less than everything. A
     * guard that goes green when the line it is about disappears is worse than
     * no guard, because it is counted. */
    expect(sourceAt, 'the airgap check is gone from hotsign.ts').toBeGreaterThan(-1);
    expect(gateAt, 'the Face ID gate is gone from hotsign.ts').toBeGreaterThan(-1);
    expect(sourceAt).toBeLessThan(gateAt);
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
  const action = /const signOnThisDevice = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(store)?.[0] ?? '';

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

  it('offers the local route only for the account the payment was prepared from', () => {
    /* The question has to be about *this* payment, and three versions of it
     * have been wrong. `accounts.some((a) => a.signsHere)` asks whether any
     * account signs here, which on a phone watching a vault and a hot wallet
     * answers yes for both, so the vault's own payment was offered a SIGN ON
     * THIS PHONE button. Reading the selection fixed that until the selection
     * could move underneath a live draft: Send is a modal with `gestureEnabled`
     * and no focus listener, so dismissing it at review, tapping the hot
     * account and reopening rendered the local button over the vault
     * account's transaction. */
    const review = codeOnly(faceOf(send, 'Review'));
    expect(review, 'Review was not found in Send.tsx').toBeTruthy();
    expect(review).toMatch(
      /const account = store\.accounts\.find\(\(entry\) => entry\.id === store\.session\.account\)/,
    );
    expect(review, 'the selection decides again, and it moves under a draft').not.toMatch(
      /selectedAccount/,
    );
    expect(review).toMatch(/const signsHere = account\?\.signsHere === true/);
    expect(review, 'any-account is back, and it offers the wrong button').not.toMatch(
      /accounts\.some\(\(account\) => account\.signsHere\)/,
    );
    expect(review, 'the review screen must not decide this from the record').not.toMatch(
      /hot !== null|store\.hot/,
    );

    /* Compose is the same rule with the opposite answer, and it is here so
     * that nobody "fixes" it to match. Before `prepareDraft` runs there is no
     * `session.account` to read, so the selection is the only thing the
     * screen could mean. */
    const compose = codeOnly(faceOf(send, 'Compose'));
    expect(compose, 'Compose was not found in Send.tsx').toBeTruthy();
    expect(compose).toMatch(/entry\.id === store\.selectedAccount/);
  });

  it('leaves exactly one screen calling signOnThisDevice', () => {
    /* The store holds an in-flight ref that makes a second caller harmless,
     * and it is not the whole property. `SendSigning` documents at length that
     * it owns the prompt, and the review button calling the action as well
     * raised two Face ID prompts on every hot send: the dispatch commits the
     * step change while the first call is parked on the prompt, the signing
     * screen mounts, and the second prompt cancels the first. The button is a
     * transition now. This counts the doors rather than trusting the ref. */
    const callers: string[] = [];
    for (const entry of readdirSync('src/screens', { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const code = codeOnly(readFileSync(`src/screens/${entry.name}`, 'utf8'));
      if (/\bsignOnThisDevice\(/.test(code)) callers.push(entry.name);
    }
    expect(callers).toEqual(['SendSigning.tsx']);
  });

  it('signs for the account the payment was prepared from, and no other', () => {
    /* Two versions of this line have been wrong the same way.
     * `accounts.find((a) => a.signsHere)` asks whether *any* account signs
     * here, which answers yes for a vault account on a phone that also holds
     * a hot wallet. Reading the selection fixed that until the selection could
     * move under a live draft: Send is a modal with no focus listener, so a
     * visit to the accounts list mid-payment left SIGN ON THIS PHONE over the
     * vault account's transaction. The draft's own account is the only one of
     * the three that cannot drift. */
    const code = codeOnly(action);
    expect(action, 'signOnThisDevice not found').toBeTruthy();
    expect(code).toMatch(/accounts\.find\(\(account\) => account\.id === session\.account\)/);
    expect(code, 'the first signable account is back').not.toMatch(
      /accounts\.find\(\(account\) => account\.signsHere\)/,
    );
    expect(code, 'the selection decides again, and it moves under a draft').not.toMatch(
      /selectedAccount/,
    );
  });

  it('tells the transition table the truth, so its refusal is reachable', () => {
    /* `session.ts` refuses `sign-here` for an account that does not sign here,
     * and `docs/handoff.md` cites that as the second, independent place the
     * airgap is held. The only dispatcher passed the literal `true`, so the
     * check could never fire in the running app and its test asserted on a
     * value no code path constructed. */
    const code = codeOnly(action);
    expect(code).toMatch(/type: 'sign-here', signsHere: spending\.signsHere/);
    expect(code, 'the reducer is being told what it wants to hear').not.toMatch(
      /signsHere: true/,
    );
  });

  it('refuses in sentences rather than returning quietly', () => {
    /* A person who pressed a button and got nothing concludes the app is
     * broken. Both refusals here name what happened and what to do next. */
    const code = codeOnly(action);
    expect(code).toMatch(/no longer on this phone/);
    expect(code).toMatch(/Hand it to your vault to sign/);
  });

  it('routes a local signature through the same verifier the camera path takes', () => {
    /* The property `session.ts` holds: one route into a broadcastable state.
     * The store's signing action must end at the shared verification door,
     * where `verifySigned` runs, rather than dispatching `returned` itself. */
    const code = codeOnly(action);
    expect(action, 'signOnThisDevice not found in the store').toBeTruthy();
    expect(code).toMatch(/applySignature\(signed\.raw, 'here'\)/);
    expect(code, 'the local path must not mark its own work verified').not.toMatch(
      /type: 'returned'/,
    );
    /* And exactly one dispatch of `returned` in the whole store, so there is
     * one place the check can be skipped rather than two. */
    expect(codeOnly(store).match(/type: 'returned'/g) ?? []).toHaveLength(1);
  });

  it('leaves the vault link\'s audit trail to the vault', () => {
    /* LAST VERIFIED SESSION reads "the last time a signature came back from
     * the vault and matched the transaction this device had prepared". The hot
     * signer routing through the shared door stamped it for handoffs that
     * never happened, on exactly the two-account phone the multi-account work
     * exists for. */
    const apply = /const applySignature = useCallback\([\s\S]*?\n  \);/.exec(store)?.[0] ?? '';
    expect(apply, 'applySignature not found').toBeTruthy();
    const code = codeOnly(apply);
    expect(code).toMatch(/if \(origin !== 'vault'\) return;/);
    const guardAt = code.indexOf("if (origin !== 'vault') return;");
    const stampAt = code.indexOf('lastVerified:');
    expect(guardAt, 'the origin guard is gone').toBeGreaterThan(-1);
    expect(stampAt, 'the last-verified line is gone').toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(stampAt);
  });

  it('raises the prompt once per payment', () => {
    /* A second prompt over the first is how a signature gets authorized twice
     * and built once. Both callers are guarded: the screen does not ask twice
     * on its own, and the store answers only the first caller whatever
     * arrangement of screens reaches it. */
    const screen = codeOnly(signing);
    expect(screen).toMatch(/asked\.current/);
    expect(screen).toMatch(/if \(asked\.current\) return;/);

    const code = codeOnly(action);
    expect(code, 'a second caller raises a second Face ID prompt').toMatch(
      /if \(signingHere\.current\) return;/,
    );
    expect(code).toMatch(/signingHere\.current = true;/);
    expect(code, 'a refused prompt must be retryable').toMatch(
      /finally \{\s*signingHere\.current = false;/,
    );
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

describe('a hot Monero account computes its own key images', () => {
  /* The defect: a Monero coin is spendable only once the wallet holds its key
   * image, and the image book had exactly one writer, a payload scanned off a
   * vault. `moneroSpendable` filters to outputs an image covers, so a
   * phone-only wallet's spendable set was always empty and the refusal told it
   * to go and scan a vault it does not have. The signer was built, tested end
   * to end, and unreachable.
   *
   * A hot account does not need the trip: computing an image needs the spend
   * key, and on this account the spend key is here. That is exactly the
   * difference the airgap exists to create. */

  const XMR_SEED = 'ab'.repeat(32);

  it('refuses a vault account, and says where its images do come from', () => {
    /* First and absolute, the same order every other file in this feature
     * uses. A vault account's spend key is not here, so there is nothing to
     * compute from and a function that tried would fail confusingly or, worse,
     * succeed against the wrong keys. */
    const result = hotKeyImages('vault', hotRecord({ xmrSeed: XMR_SEED }), new Uint8Array([1]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/over the camera/);
  });

  it('refuses when the phone holds no Monero half', () => {
    const result = hotKeyImages('hot', hotRecord(), new Uint8Array([1]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/twenty-five words/);
  });

  it('parses the request rather than trusting bytes it made itself', () => {
    /* A local path that skipped the parse would be the one place the wire
     * format is not checked, which is where a format bug survives. */
    const result = hotKeyImages('hot', hotRecord({ xmrSeed: XMR_SEED }), new Uint8Array([9, 9, 9]));
    expect(result.ok).toBe(false);
  });

  it('goes through the same payload and the same door a vault does', () => {
    /* Writing images straight into the book would be shorter and would be a
     * second way in. `offerReply` refuses images for outputs this wallet has
     * not seen and keeps the book's accounting honest; a path that skipped it
     * is the path nobody tests against a real vault. */
    const source = codeOnly(readFileSync('src/core/hotimages.ts', 'utf8'));
    expect(source).toMatch(/encodeKeyImageReply/);
    expect(source, 'a local writer into the book is back').not.toMatch(/offerReply|new KeyImageBook/);

    const store = codeOnly(readFileSync('src/state/store.tsx', 'utf8'));
    expect(store).toMatch(/hotKeyImages\(account\.source, hot, request\.payload\)/);
    expect(store).toMatch(/watcher\.importKeyImages\(computed\.payload\)/);
  });

  it('wipes the wallet it opened, whatever happened', () => {
    const source = codeOnly(readFileSync('src/core/hotimages.ts', 'utf8'));
    expect(source).toMatch(/finally \{\s*\n?\s*wipeWallet\(wallet\)/);
  });
});
