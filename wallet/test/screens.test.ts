/*
 * The rules the screens hold, which no other file can hold for them.
 *
 * This package has no render harness: nothing here mounts a component, drives
 * a navigator or observes an effect. That is a real gap and it is written down
 * in the audit rather than papered over. What is left that is worth enforcing
 * is the class of defect this repository keeps finding on the way to a crash
 * or a false sentence, and every one of those is visible in the source:
 *
 *   - an index into a list the app ships empty, dereferenced during render,
 *     with no error boundary anywhere above it
 *   - an import of a module method that throws the moment it is called
 *   - a sentence about where somebody's keys are, printed unconditionally on
 *     a phone that now holds two kinds of account
 *
 * Every check strips comments first. Five guards in this repository have now
 * fired on the prose explaining the rule they enforce, and a guard that fails
 * on its own documentation teaches people to delete the documentation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Comments removed, so a guard never fires on its own documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A phrase pattern that does not care where the source wrapped it.
 *
 * Every sentence on these screens is prose inside JSX, so it is broken across
 * lines wherever the indentation put the break, and a break moves whenever a
 * word is added. A guard written against one wrapping is a guard that stops
 * looking the next time somebody reflows a paragraph, which is the quietest
 * way a rule in this repository has died. Proved rather than assumed: the
 * first version of the onboarding check missed its own sentence because a
 * newline landed between "only" and "thing".
 */
function phrase(text: string, flags = ''): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/ +/g, '\\s+'), flags);
}

/** Every screen, as source, keyed by the name a failure should name. */
function screens(): { path: string; code: string }[] {
  return readdirSync('src/screens')
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => {
      const path = join('src/screens', name);
      return { path, code: codeOnly(readFileSync(path, 'utf8')) };
    });
}

describe('a screen never dereferences an address the wallet has not derived yet', () => {
  /* W-H5. `Receive.tsx` opened with
   *
   *     const address = addresses.find((e) => !e.used) ?? addresses[0]!
   *
   * and read `address.address` three times during render. The list is empty
   * until a refresh writes it, and the app ships with no node set, so the
   * first-run sequence (pair, tap RECEIVE) threw. There is no error boundary
   * in `wallet/`, so the throw takes the whole tree with it.
   *
   * The permanent version of the same crash is worse: an account whose
   * `chains` hold only Monero, on a screen whose chips were a hardcoded BTC
   * and XMR defaulting to BTC. That one has a node set, a finished scan and a
   * correct balance on screen, and still cannot open RECEIVE. */

  it('finds the screens, so a pass means something', () => {
    const found = screens();
    expect(found.length).toBeGreaterThan(15);
    expect(found.some((entry) => entry.path.endsWith('Receive.tsx'))).toBe(true);
  });

  it('never asserts an index into an address list is present', () => {
    /* The narrow rule rather than a ban on every `!`, because the two other
     * assertions in `src/screens/` index constants that provably have the
     * element (a three-entry fee table, a non-empty provider list). An
     * address list is the one that ships empty. */
    const guilty: string[] = [];
    for (const { path, code } of screens()) {
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (/addresses\s*\[[^\]]*\]\s*!/.test(line)) guilty.push(`${path}:${i + 1}`);
      });
    }
    expect(guilty, 'an empty address list is a render-time throw, not a type error').toEqual([]);
  });

  it('tolerates the empty list wherever it does index one', () => {
    /* The other half, and the one a fix for the first would walk straight
     * into: deleting the `!` and reading `.address` off the result is the same
     * crash with the assertion gone. So an index into an address list may be
     * followed by `?.` or `??` and by nothing else that reads through it. */
    const guilty: string[] = [];
    for (const { path, code } of screens()) {
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (/addresses\s*\[[^\]]*\]\s*[.!]/.test(line)) guilty.push(`${path}:${i + 1}`);
      });
    }
    expect(guilty, 'index an address list and then handle it being absent').toEqual([]);
  });

  it('offers only the chains the selected account actually holds', () => {
    /* A pairing that exported a Monero view key and no Bitcoin key has
     * `chains: ['XMR']`. A chip for the other one leads to a screen that can
     * never have an address on it, whatever the node does. */
    const receive = codeOnly(readFileSync('src/screens/Receive.tsx', 'utf8'));
    expect(receive).toMatch(/account\.chains\.includes\(which\)/);
    expect(
      receive,
      'the chips are a hardcoded pair again',
    ).not.toMatch(/\(\['BTC', 'XMR'\] as const\)\.map/);
  });

  it('names which of the reasons there is no address, rather than saying there is none', () => {
    /* "No address yet" is true of a wallet waiting on its first refresh and
     * true of a Monero-only account asked for a Bitcoin address, and those
     * want opposite things from a person. A dead end that cannot say which is
     * the shape this app spends its refusals avoiding. */
    const receive = codeOnly(readFileSync('src/screens/Receive.tsx', 'utf8'));
    expect(receive).toMatch(/NO NODE IS SET/);
    expect(receive).toMatch(/HAS NO \$\{chain\.toUpperCase\(\)\} KEY/);
    expect(receive).toMatch(/NOTHING IS BEING WATCHED/);
    /* And each one has somewhere to go. An empty state with no lever on it is
     * an apology. */
    expect(receive).toMatch(/onNodes/);
    expect(receive).toMatch(/onAccounts/);
  });
});

describe('nothing reaches for a filesystem method that throws the moment it is called', () => {
  /* W-H10. `MoneroFile.tsx` imported the whole of `expo-file-system` and
   * called `readAsStringAsync`. In 57.0.2 that export is a deprecation stub
   * whose entire body is `throw errorOnLegacyMethodUse(...)`. There is no
   * platform branch and no fallback: every file a person picked was answered
   * with "That file could not be read off this device", which blames the file
   * for the app's bug, and one of the two ways an `unsigned_monero_tx` reaches
   * the vault was dead on device.
   *
   * `tsc --noEmit` cannot see it. The declaration exists and is merely
   * `@deprecated`, so the call type-checks and only the runtime knows.
   *
   * The forbidden list is read out of the installed module rather than
   * transcribed here, for the reason `docs/verification.md` gives about
   * somebody else's format: a list of ours agreeing with itself proves nothing
   * about what upstream deprecated next. */

  /** Every name expo-file-system's own legacy shim throws from. */
  function legacyNames(): string[] {
    const shim = readFileSync('node_modules/expo-file-system/src/legacyWarnings.ts', 'utf8');
    const names = (shim.match(/^export (?:async )?(?:function|const) ([A-Za-z0-9_]+)/gm) ?? []).map(
      (line) => line.slice(line.lastIndexOf(' ') + 1),
    );
    return names;
  }

  function walk(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, found);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
    return found;
  }

  it('knows which names throw, so a pass means something', () => {
    const names = legacyNames();
    expect(names.length, 'the legacy shim moved or was renamed upstream').toBeGreaterThan(8);
    expect(names).toContain('readAsStringAsync');
  });

  it('imports no legacy name from the bare module', () => {
    const forbidden = legacyNames();
    const guilty: string[] = [];
    for (const path of walk('src')) {
      const code = codeOnly(readFileSync(path, 'utf8'));
      for (const clause of code.match(/import\s*\{([^}]*)\}\s*from\s*'expo-file-system'/g) ?? []) {
        for (const name of forbidden) {
          if (new RegExp(`\\b${name}\\b`).test(clause)) guilty.push(`${path}: ${name}`);
        }
      }
    }
    expect(guilty, 'these throw at runtime; use File, Directory or Paths').toEqual([]);
  });

  it('never takes the whole module as a namespace, which hides every one of them', () => {
    /* A namespace import is how this one survived review: the call site reads
     * `FileSystem.readAsStringAsync`, which looks like the modern API and is
     * not, and no import line names anything a reader could recognize. Naming
     * what is used puts the choice in the diff. */
    const guilty: string[] = [];
    for (const path of walk('src')) {
      const code = codeOnly(readFileSync(path, 'utf8'));
      if (/import\s*\*\s*as\s+\w+\s*from\s*'expo-file-system'/.test(code)) guilty.push(path);
    }
    expect(guilty, 'import the names you use').toEqual([]);
  });

  it('reads the picked file through the API the rest of the app already uses', () => {
    const screen = codeOnly(readFileSync('src/screens/MoneroFile.tsx', 'utf8'));
    expect(screen).toMatch(/new File\(asset\.uri\)\.bytesSync\(\)/);
    /* And the base64 decoder that only existed to undo the legacy hop is
     * gone with it. A helper with no caller is a helper somebody restores a
     * caller for. */
    expect(screen, 'the base64 hop outlived the API that needed it').not.toMatch(/bytesFromBase64/);
  });
});

/*
 * Custody, said conditionally, on every screen that says it.
 *
 * W-H13. Seven screens stated vault custody unconditionally, for an account
 * this phone can spend from: a WATCH-ONLY chip and "PRIVATE KEYS NEVER ENTER
 * THIS DEVICE" on the screen a person holds up while being paid, "KEY HELD
 * HERE: VIEW KEY ONLY" over a spend secret in this phone's keychain, "it is
 * the only thing that can spend your money" on the first screen anybody reads.
 *
 * These are falsifiable statements about where somebody's keys are, printed at
 * the moment they decide how much money to trust the app with. The guard that
 * existed for this class read `Vault.tsx`'s SecurityScreen and nothing else,
 * which is exactly why it passed while six other screens were wrong.
 *
 * ## What "conditionally" is checked as
 *
 * A claim has to sit inside a JSX expression whose condition mentions
 * `signsHere`. That is found structurally rather than by counting lines: from
 * the match, scan backwards to the innermost unclosed brace, and require that
 * brace to open a JSX expression (not a function body) whose text asks the
 * question. A claim in a `{cond ? (A) : (B)}` arm passes; the same sentence
 * sitting loose in the markup does not.
 *
 * `signsHere` rather than "is a vault paired" or "is there a hot record",
 * because it is the field `canSignHere` writes and the one the airgap rule is
 * stated in. A screen that decided this for itself would be a second
 * implementation of the one rule this product rests on.
 */
describe('no screen states vault custody for an account this phone can sign for', () => {
  /** Claims that are false the moment the selected account signs here. */
  const CLAIMS: { name: string; pattern: RegExp }[] = [
    { name: 'no keys enter this device', pattern: phrase('PRIVATE KEYS NEVER ENTER') },
    /* The one unconditional WATCH-ONLY left is `WATCH-ONLY, ALWAYS` on the
     * security screen, which is not a claim about the account being looked at:
     * its own row names the accounts it means, and it is the sentence that has
     * to survive the whole feature. Every other use is about the selection. */
    { name: 'watch-only, said of the selected account', pattern: /WATCH-ONLY(?!, ALWAYS)/ },
    { name: 'the view key is all there is', pattern: phrase('VIEW KEY ONLY') },
    { name: 'the vault signed it', pattern: phrase('vault signed', 'i') },
    { name: 'the vault must return a signature', pattern: phrase('vault did not return a signature') },
    { name: 'this device cannot sign', pattern: phrase('built not to be able to sign') },
    { name: 'the key came from the vault', pattern: phrase('account key your vault handed over') },
    { name: 'sending needs the vault', pattern: phrase('Sending needs your vault') },
  ];

  /**
   * The conditions a custody claim may be made under.
   *
   * Three, and all three are the same two facts: `signsHere` is where
   * `canSignHere`'s answer about an account reaches a screen, and the other two
   * are the question about the device rather than the account, which is what
   * the security screen and the two-panel summary are about. A screen
   * qualifying a custody sentence on anything else is qualifying it on the
   * wrong thing.
   */
  const ALLOWED = /signsHere|anyKeysHere|hot === null/;

  /**
   * The JSX expression a match sits inside, or null when it sits in markup.
   *
   * Backwards to the innermost unclosed `{`, then a look at what precedes it:
   * `)` or `=>` opens a block rather than an expression, and a claim whose
   * nearest enclosing brace is a function body is a claim in the markup.
   */
  function enclosing(code: string, at: number): string | null {
    let depth = 0;
    for (let i = at; i >= 0; i -= 1) {
      const ch = code[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          let j = i - 1;
          while (j >= 0 && /\s/.test(code[j] ?? '')) j -= 1;
          const before = code.slice(Math.max(0, j - 1), j + 1);
          if (before.endsWith(')') || before === '=>') return null;
          return code.slice(i, at);
        }
        depth -= 1;
      }
    }
    return null;
  }

  it('asks the question on every screen that makes one of these claims', () => {
    const guilty: string[] = [];
    for (const { path, code } of screens()) {
      for (const claim of CLAIMS) {
        const pattern = new RegExp(claim.pattern.source, `${claim.pattern.flags}g`);
        for (const hit of code.matchAll(pattern)) {
          const scope = enclosing(code, hit.index);
          if (scope === null || !ALLOWED.test(scope)) {
            const line = code.slice(0, hit.index).split('\n').length;
            guilty.push(`${path}:${line} ${claim.name}`);
          }
        }
      }
    }
    expect(
      guilty,
      'branch this on the account, the way Backup.tsx and SecurityScreen already do',
    ).toEqual([]);
  });

  it('finds claims at all, so the patterns are not quietly matching nothing', () => {
    /* The degenerate-fixture check, on a guard whose whole substance is a list
     * of regexes. A typo in one of them is a rule that reports coverage it
     * does not have, which is the failure this audit found a dozen of. */
    const all = screens().map((entry) => entry.code).join('\n');
    for (const claim of CLAIMS) {
      expect(all, `no screen says "${claim.name}" any more; drop the pattern`).toMatch(claim.pattern);
    }
  });

  it('reads the account rather than deciding signability itself', () => {
    /* `canSignHere` takes a source and nothing else, and `signsHere` is where
     * its answer reaches a screen. A screen comparing sources, or asking
     * whether a hot record exists, would be a second implementation of the one
     * rule the product rests on. */
    for (const { path, code } of screens()) {
      expect(code, `${path} decides signability for itself`).not.toMatch(/canSignHere/);
      expect(code, `${path} reads a seed to decide what to print`).not.toMatch(
        /hot !== null \?\s*'/,
      );
    }
  });
});

describe('the first screen anybody reads describes the app that shipped', () => {
  /* Onboarding cannot branch on an account, because at the moment it is read
   * there is not one. So it scopes its custody claims in prose instead, and
   * this is the only place in the app where that is the right answer: the
   * sentence has to say which half it is about, in words, on the screen that
   * teaches the architecture.
   *
   * The three that were unscoped: "it is the only thing that can spend your
   * money", "It holds no key", "Nothing secret crosses between them, ever."
   * The first two are false on a phone with a seed in its keychain. The third
   * is true of the vault half and says nothing about the other one, which the
   * screen did not mention at all while Home and Accounts both offered it. */

  const onboarding = codeOnly(readFileSync('src/screens/Onboarding.tsx', 'utf8'));

  it('does not claim the vault is the only thing that can spend', () => {
    expect(onboarding, 'true until this phone could hold a seed').not.toMatch(
      phrase('only thing that can spend', 'i'),
    );
  });

  it('scopes the no-key claim to the accounts it is true of', () => {
    /* The claim survives, because for a vault-paired account it is exactly
     * true and it is the product. What it may not do is stand alone. */
    const claim = /holds no key[^.]*/.exec(onboarding.replace(/\s+/g, ' '))?.[0] ?? '';
    expect(claim, 'the sentence went entirely; it is worth keeping, scoped').toBeTruthy();
    expect(onboarding).toMatch(phrase('account paired from your vault it holds no key'));
  });

  it('mentions the kind of account it never used to', () => {
    /* A person who first meets a hot wallet on the accounts screen was misled
     * by omission on the screen that exists to explain the design. */
    expect(onboarding).toMatch(/keychain/);
    expect(onboarding).toMatch(/Face ID/);
  });

  it('sends its two actions to two different places', () => {
    /* W-M23. CONNECT YOUR VAULT and LOOK AROUND FIRST both replaced the route
     * with Home, so the emphasized button landed somebody on a home screen
     * with no explanation of where the pairing had gone. `Pair` was routed and
     * reachable from Accounts the whole time. */
    expect(onboarding).toMatch(/open\('Pair'\)/);
    expect(onboarding).toMatch(/open\('CreateWallet'\)/);
    expect(onboarding).toMatch(/routes: \[\{ name: 'Home' \}, \{ name: route \}\]/);
  });

  it('does not run again once there is something to watch', () => {
    /* W-M22. `initialRouteName` was the constant 'Onboarding' with nothing
     * persisted saying the intro had been seen, so a wallet with a paired
     * vault and a hot account was walked through four panels on every cold
     * launch, forever. */
    const app = codeOnly(readFileSync('App.tsx', 'utf8'));
    expect(app, 'the initial route is a constant again').not.toMatch(/initialRouteName="Onboarding"/);
    expect(app).toMatch(/watchingNothing\(accounts\) \? 'Onboarding' : 'Home'/);
    /* And the navigator does not mount before the answer is known, or the
     * intro shows for a frame to everybody. */
    expect(app).toMatch(/if \(!restored\)/);
    /* The keychain read settles on its own schedule, so the screen leaves if
     * accounts turn up under it. */
    expect(onboarding).toMatch(/if \(!watchingNothing\(accounts\)\) navigation\.replace\('Home'\)/);
  });
});

describe('the vault screen says what this phone holds, not what it used to hold', () => {
  const vault = codeOnly(readFileSync('src/screens/Vault.tsx', 'utf8'));

  it('does not list "holds no keys" as a property of this wallet unconditionally', () => {
    /* The two-panel summary sat 130 lines from a `SecurityScreen` that was
     * carefully made conditional for exactly this reason, and listed the
     * opposite of what that screen said. */
    expect(vault).toMatch(/anyKeysHere \? 'Holds keys for one wallet' : 'Holds no keys'/);
    expect(vault).toMatch(/<Halves anyKeysHere=\{store\.hot !== null\} \/>/);
  });

  it('still promises a vault account is watch-only, unconditionally', () => {
    /* The one custody sentence in the app that must not be branched on
     * anything: it is true whatever else this phone is holding, and it is true
     * because `canSignHere` takes a source and nothing else. */
    expect(vault).toMatch(/WATCH-ONLY, ALWAYS/);
  });
});

describe('a screen reader can find and hit the controls', () => {
  /* W-L1. No screen declared an `accessibilityRole` anywhere, because `Press`
   * is the only pressable in the application and set none. VoiceOver read the
   * text inside each one and announced no control, so navigating this app by
   * traits found nothing to activate: not RECEIVE, not SEND, not BROADCAST.
   * The closed prop list meant no call site could supply one either, which is
   * why this is a fix in one file rather than in twenty.
   *
   * The second half is size. Several targets are the height of a label,
   * around 14 points against Apple's recommended 44, and `hitSlop` is how a
   * small mark keeps a large target without the layout being drawn around a
   * finger. */

  const atoms = codeOnly(readFileSync('src/design/atoms.tsx', 'utf8'));

  it('gives every pressable a trait', () => {
    expect(atoms).toMatch(/accessibilityRole=\{role\}/);
    expect(atoms).toMatch(/role = 'button'/);
  });

  it('lets a caller say what a control is when its content is a glyph', () => {
    expect(atoms).toMatch(/accessibilityLabel=\{label\}/);
    /* And somebody uses it, or the prop is a feature nobody found. The swap
     * screen's flip control is the one whose entire content is an icon. */
    const swap = codeOnly(readFileSync('src/screens/Swap.tsx', 'utf8'));
    expect(swap).toMatch(/label="Swap the two coins around"/);
  });

  it('passes the disabled state through, rather than only dimming it', () => {
    /* Opacity 0.35 is not a fact an assistive reader has. A disabled control
     * that announces itself as available is one somebody activates twice and
     * then wonders about. */
    expect(atoms).toMatch(/accessibilityState=\{\{ disabled: disabled === true \}\}/);
  });

  it('grows the target of the small ones to the size a finger needs', () => {
    /* The arithmetic rather than a number somebody liked: the smallest target
     * in this app wraps a bare `Label`, whose line height `tokens.ts` sets,
     * and Apple asks for 44. Written this way the guard follows the type
     * scale, so shrinking the label without widening the slop fails here
     * rather than on somebody's phone. */
    expect(atoms).toMatch(/hitSlop=\{hitSlop\}/);
    const slop = Number(/hitSlop = (\d+)/.exec(atoms)?.[1]);
    expect(slop, 'no default slop, so every label-sized target is label-sized').toBeTruthy();

    const tokens = readFileSync('src/design/tokens.ts', 'utf8');
    const line = Number(/label: \{ fontSize: [\d.]+, lineHeight: (\d+)/.exec(tokens)?.[1]);
    expect(line, 'the label line height moved or was renamed').toBeGreaterThan(0);
    expect(line + slop * 2, 'a bare label is still under 44 points tall').toBeGreaterThanOrEqual(44);
  });

  it('never nests one pressable inside another', () => {
    /* An outer pressable becomes an accessibility container and an element
     * inside a container is not reliably focusable. The accounts row had a
     * link to the vault, or to the recovery words, sitting inside the row's
     * own control: visible, tappable by sight, and unreachable by trait. */
    const guilty: string[] = [];
    for (const { path, code } of screens()) {
      let depth = 0;
      for (const line of code.split('\n')) {
        for (const token of line.match(/<Press\b|<\/Press>/g) ?? []) {
          if (token === '</Press>') depth -= 1;
          else {
            depth += 1;
            if (depth > 1) guilty.push(`${path}: a Press inside a Press`);
          }
        }
      }
    }
    expect(guilty, 'make them siblings; the row was never drawing a box anyway').toEqual([]);
  });
});

describe('a screen never decides anything by reading its own prose', () => {
  /* W-L2. The destructive-restore warning chose its tone with
   * `effect.includes('replaces')`, grepping the sentence `restoreEffect` had
   * just written for it. Rewording that sentence in `core/backup.ts` would
   * silently downgrade the warning on the only screen in this app that
   * overwrites key material, and nothing anywhere would fail.
   *
   * `restoreReplacesKeys` was exported next to it the whole time. This is the
   * same rule this repository states about guards that grep source, arriving
   * one layer up: a decision read out of prose is a decision that changes when
   * somebody edits a paragraph. */

  it('asks the module whether a restore is destructive', () => {
    const restore = codeOnly(readFileSync('src/screens/Restore.tsx', 'utf8'));
    expect(restore).toMatch(/restoreReplacesKeys\(hot, reading\.chain\)/);
    expect(restore, 'the tone is read out of the sentence again').not.toMatch(/effect\.includes/);
  });

  it('never branches on the text of a sentence it was handed', () => {
    /* The general form, because the specific one took a release to find. A
     * screen may render a sentence and may not interrogate it. */
    const guilty: string[] = [];
    for (const { path, code } of screens()) {
      for (const hit of code.match(/\b(problem|effect|note|caveat|hint)\.(includes|startsWith|match)\(/g) ?? []) {
        guilty.push(`${path}: ${hit}`);
      }
    }
    expect(guilty, 'ask the module that wrote it, not the string it wrote').toEqual([]);
  });
});

describe('a custody sentence imported from core is asked the same question as one written here', () => {
  /* The hole in the guard above, named rather than left. It reads the literal
   * text in a screen, so a claim rendered as `{SPEND_BLINDNESS}` is invisible
   * to it: an identifier carries no sentence. That constant says the Monero
   * spend key "lives in the vault", which is exactly right for a paired
   * account and wrong for a wallet whose twenty-five words are in this phone's
   * keychain, and the nodes screen printed it to both.
   *
   * There is one such import today. If a second appears, this list is where it
   * goes, because the general check cannot see any of them. */

  it('does not print the view-only sentence to an account that holds a spend key', () => {
    const nodes = codeOnly(readFileSync('src/screens/Nodes.tsx', 'utf8'));
    /* Through the selector, with the account it is about as its argument.
     * The screen used to carry both sentences, one imported and one written
     * out locally beside it, which is how this paragraph and the caveat under
     * the balance came to disagree about the same wallet. */
    expect(nodes, 'the view-only sentence is unconditional again').toMatch(
      /spendBlindness\(looking\?\.signsHere \? 'hot' : 'vault'\)/,
    );
  });

  it('never renders a custody constant with nothing behind it', () => {
    /* The pair only holds if there is no way to reach one without answering
     * the question. A screen rendering `{SPEND_BLINDNESS}` has made the
     * decision by importing, which is the version of this that shipped. */
    for (const { path, code } of screens()) {
      expect(code, `${path} prints a custody sentence with no account behind it`).not.toMatch(
        /\{SPEND_BLINDNESS(_HERE)?\}/,
      );
    }
  });

  it('knows which constants carry a custody claim, so a new one is noticed', () => {
    /* Every name a screen imports out of core and renders straight into the
     * markup. Today the list is one long. A name arriving here without a
     * branch around it is the failure this test exists for. */
    const claimants = new Set<string>();
    for (const { code } of screens()) {
      for (const hit of code.match(/\{[A-Z][A-Z_]{3,}\}/g) ?? []) claimants.add(hit.slice(1, -1));
    }
    /* `NOTHING_WATCHED` is about an empty list, `PRIVACY_NOTE` about what an
     * exchange learns, and `COLUMN` is a width. None of the three names where
     * a key lives. `SPEND_BLINDNESS` was on this list and is not any more:
     * it is reached through `spendBlindness(source)` now, so there is no
     * spelling of it a screen can render without saying which account it
     * means. A name arriving here is a sentence somebody should read before
     * deciding it needs no branch. */
    expect(
      [...claimants].sort(),
      'a constant is rendered straight into a screen; check whether it makes a custody claim',
    ).toEqual(['COLUMN', 'NOTHING_WATCHED', 'PRIVACY_NOTE']);
  });
});

describe('the destination a screen stores is the one the vault will be shown', () => {
  /* W-H7 and W-M15, the halves that live in the screens.
   *
   * `checkAddress` re-encodes a Bitcoin address into one spelling and returns
   * it, because `verifySigned` compares `draft.recipient` against an address
   * the finished transaction always re-encodes lowercase. BIP173 declares
   * uppercase bech32 valid and recommends it inside QR codes, so a pasted
   * BC1Q... produced a byte-correct signature that came back refused with
   * "Nothing in this transaction pays BC1Q...", at the end of the whole
   * airgap ceremony, on a screen with no text field to correct it in. Scan
   * stored the canonical form from the start; paste did not, and the two
   * screens disagreeing is the shape of the defect.
   *
   * `readPaymentUri` refuses a `monero:` URI carrying a loose payment ID,
   * because this wallet has nowhere to attach one and paying it would produce
   * a payment that arrives and is never credited. It answers an empty address
   * and a sentence. A screen that reads only the address fails closed, which
   * is the right direction, but tells the person "Enter or scan a
   * destination." about a code they just handed it. */
  const reading = () => screens().filter((screen) => /readPaymentUri\(/.test(screen.code));

  it('finds the screens that read a payment URI, so a pass means something', () => {
    expect(reading().map((screen) => screen.path).sort()).toEqual([
      'src/screens/Scan.tsx',
      'src/screens/Send.tsx',
    ]);
  });

  it('reads the refusal, not only the address', () => {
    for (const screen of reading()) {
      expect(screen.code, `${screen.path} drops the sentence readPaymentUri returned`).toMatch(
        /read\.problem/,
      );
    }
  });

  it('stores the spelling checkAddress hands back, never the one that arrived', () => {
    for (const screen of reading()) {
      const dispatches = screen.code.match(/type: 'recipient', *\n? *value: [^,\n]+/g) ?? [];
      expect(dispatches.length, `${screen.path} dispatches no recipient`).toBeGreaterThan(0);
      for (const dispatch of dispatches) {
        expect(dispatch, `${screen.path} stores an unchecked address`).not.toMatch(
          /value: read\.address/,
        );
      }
    }
  });

  it('budgets SEND MAX against the destination once there is one', () => {
    /* W-M4. `maxSendable` prices the widest standard output when it is not
     * told where the money is going. That is the safe direction and it is not
     * free: MAX is the button somebody presses to empty an account, and it
     * left a few sat behind every time. */
    const send = screens().find((screen) => screen.path === 'src/screens/Send.tsx')!;
    expect(send.code).toMatch(/maxSendable\(view\.utxos, fee\.rate, session\.compose\.recipient\)/);
  });
});
