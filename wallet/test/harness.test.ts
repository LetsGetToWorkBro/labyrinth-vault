/**
 * The harness, checked against the application it stands in for.
 *
 * A stand-in is a claim: that mounting a screen against these modules tells
 * you something about mounting it against the real ones. The claim is only as
 * good as the correspondence, and correspondence rots silently. A screen adds
 * an import, the stand-in does not have it, and depending on which of three
 * things happens the suite either fails somewhere confusing, passes against
 * `undefined`, or never notices because no mounted test reaches that line.
 *
 * The third is the dangerous one, so it is checked here rather than left to
 * whether a test happened to walk that path: every name the application
 * imports from a stood-in module has to exist in the stand-in, whether or not
 * anything mounts the screen that imports it.
 *
 * This file is deliberately about the harness and not about any screen. It
 * fails when the harness has drifted, which is a different repair from a
 * screen being wrong, and mixing the two is how a suite gets a class of
 * failure everybody learns to re-run.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strict } from './harness/strict';
import * as reactNative from './harness/native/react-native';
import * as reanimated from './harness/native/react-native-reanimated';
import * as safeArea from './harness/native/react-native-safe-area-context';
import * as svg from './harness/native/react-native-svg';
import * as statusBar from './harness/native/expo-status-bar';
import * as camera from './harness/native/expo-camera';
import * as clipboard from './harness/native/expo-clipboard';
import * as documents from './harness/native/expo-document-picker';
import * as fileSystem from './harness/native/expo-file-system';
import * as haptics from './harness/native/expo-haptics';
import * as localAuthentication from './harness/native/expo-local-authentication';
import * as secureStore from './harness/native/expo-secure-store';

/**
 * The stand-ins, by the specifier they replace.
 *
 * Statically imported rather than reached for by name at runtime. A dynamic
 * import cannot name these: the modules are a mix of `.ts` and `.tsx` and a
 * template with the extension in its variable part is exactly what the bundler
 * warns it cannot analyze. The cost is a list written twice, which the first
 * test below removes by comparing this against the config that actually
 * installs them.
 */
const STAND_INS: Record<string, Record<string, unknown>> = {
  'react-native': reactNative,
  'react-native-reanimated': reanimated,
  'react-native-safe-area-context': safeArea,
  'react-native-svg': svg,
  'expo-status-bar': statusBar,
  'expo-camera': camera,
  'expo-clipboard': clipboard,
  'expo-document-picker': documents,
  'expo-file-system': fileSystem,
  'expo-haptics': haptics,
  'expo-local-authentication': localAuthentication,
  'expo-secure-store': secureStore,
};

/** Comments removed, so a guard never fires on its own documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourcesUnder(path, found);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/** The stand-ins, read from the config that installs them rather than listed
 *  again here: two lists of the same thing is one list and a stale copy. */
function standIns(): string[] {
  const config = codeOnly(readFileSync('vitest.config.mts', 'utf8'));
  return [...config.matchAll(/^\s*harness\('([^']+)'/gm)].map((found) => found[1]!);
}

/**
 * What one file imports from one module, by name.
 *
 * Type-only specifiers are dropped. `import { type ViewStyle }` is erased
 * before a line runs, so requiring the stand-in to export it would be a rule
 * about nothing, and `StyleProp` genuinely has no runtime existence to model.
 *
 * A default import is reported as `default`, which is how three of these
 * modules are actually used: Reanimated's `Animated`, react-native-svg's `Svg`.
 */
function importsOf(code: string, module: string): Set<string> {
  const names = new Set<string>();
  /* The clause may not contain a quote. Without that the non-greedy match
   * starts at some earlier `import` in the file and swallows every statement
   * between it and this one, which reported `useState } from 'react'; import {
   * ScrollView` as a name this module owes an export for. The closing quote of
   * the previous statement is the only reliable barrier in a file that may
   * wrap an import across six lines. */
  const statements = code.matchAll(
    new RegExp(`import\\s+([^'"]*?)\\s+from\\s+'${module.replace(/[-/]/g, '\\$&')}'`, 'g'),
  );
  for (const statement of statements) {
    const clause = statement[1]!;
    if (/^\s*type\s/.test(clause)) continue;
    const braced = clause.match(/\{([\s\S]*)\}/);
    const leading = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
    if (leading.startsWith('* as ')) names.add('*');
    else if (leading !== '') names.add('default');
    for (const piece of (braced?.[1] ?? '').split(',')) {
      const name = piece.trim();
      if (name === '' || name.startsWith('type ')) continue;
      names.add(name.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return names;
}

const sources = sourcesUnder('src').map((path) => ({ path, code: codeOnly(readFileSync(path, 'utf8')) }));

describe('the stand-ins cover what the application imports', () => {
  it('finds the application source at all', () => {
    expect(sources.length, 'src moved, so every check in this file is about nothing').toBeGreaterThan(50);
    expect(standIns().length, 'no stand-ins found in vitest.config.mts').toBeGreaterThan(8);
  });

  it('holds the same stand-ins the config installs', () => {
    /* The config is the authority: it is what vitest reads, so a module listed
     * only here is checked and never used, and one listed only there is used
     * and never checked. Both are silent. */
    expect(Object.keys(STAND_INS).sort()).toEqual([...standIns()].sort());
  });

  it('stands in for every module the phone provides and Node does not', () => {
    /* The set is derived rather than listed: anything under these three
     * families is a native module by definition, and one added to a screen
     * without a stand-in fails here instead of at whatever future moment a
     * test first mounts that screen. */
    const native = new Set<string>();
    for (const { code } of sources) {
      for (const found of code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/g)) {
        const specifier = found[1]!;
        if (/^(expo-|react-native$|react-native-)/.test(specifier)) native.add(specifier);
      }
    }

    expect(native.size, 'no native imports found, so this guard is checking nothing').toBeGreaterThan(8);
    const uncovered = [...native].filter((module) => !standIns().includes(module)).sort();
    expect(uncovered, 'the application imports these and the harness has no stand-in for them').toEqual([]);
  });

  for (const module of standIns()) {
    it(`exports everything the application imports from ${module}`, () => {
      const wanted = new Set<string>();
      for (const { code } of sources) for (const name of importsOf(code, module)) wanted.add(name);
      expect(wanted.size, `nothing imports ${module}, so its stand-in is dead weight`).toBeGreaterThan(0);

      const standIn = STAND_INS[module]!;
      for (const name of wanted) {
        /* A namespace import asks for the module and not for a name in it. */
        if (name === '*') continue;
        expect(
          name in standIn,
          `${module}.${name} is imported by the application and missing from the stand-in, ` +
            `so any screen that reaches it renders against undefined`,
        ).toBe(true);
      }
    });
  }
});

describe('a stand-in refuses to answer a question nobody taught it', () => {
  it('throws a sentence naming the file to fix', () => {
    const namespace = strict('react-native', 'StyleSheet', { create: <T,>(sheet: T): T => sheet }) as Record<
      string,
      unknown
    >;

    expect(typeof namespace['create']).toBe('function');
    expect(() => namespace['flatten']).toThrow(/not modeled by the react-native test harness/);
    expect(() => namespace['flatten']).toThrow(/test\/harness\/native\/react-native\.tsx/);
  });

  it('answers the questions a runtime asks rather than a caller', () => {
    /* `then` is how an accidental `await` on a namespace is decided, and
     * `toJSON` is how a failure message prints one. Throwing on those would
     * turn every diagnostic into a second, wrong error, which is the failure
     * mode that teaches people to delete a guard. */
    const namespace = strict('react-native', 'Share', { share: async () => ({}) }) as Record<string, unknown>;
    expect(namespace['then']).toBeUndefined();
    expect(namespace['toJSON']).toBeUndefined();
  });
});

describe('a test that mounts a screen starts from a fresh launch', () => {
  it('resets the stand-ins before each test', () => {
    /* Module state outlives a test. The keychain is the one that matters: a
     * seed one test wrote is a wallet the next test did not make, and the
     * assertion that would have caught a missing write passes on the
     * leftover. */
    const mounting = readdirSync('test')
      .filter((name) => name.endsWith('.test.tsx'))
      .map((name) => ({ name, code: codeOnly(readFileSync(join('test', name), 'utf8')) }))
      .filter((file) => file.code.includes('mount('));

    expect(mounting.length, 'nothing mounts a screen, so this guard is checking nothing').toBeGreaterThan(0);
    for (const file of mounting) {
      expect(
        /beforeEach\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}?resetNative\(\)/.test(file.code),
        `${file.name} mounts screens and does not call resetNative in a beforeEach`,
      ).toBe(true);
    }
  });
});
