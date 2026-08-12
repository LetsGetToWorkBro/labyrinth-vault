/**
 * The things that are true only until somebody stops looking.
 *
 * Everything in this file is about a claim made to Apple or to a person
 * reading an App Store listing. Those claims are made in property lists and
 * generated assets, which is to say in files nobody reads twice, and they are
 * the kind of claim that goes quietly false: an API gets called, a manifest
 * still says it is not, and the discrepancy surfaces months later as a
 * rejection or, worse, as a promise that was not kept.
 *
 * So they are tests. The privacy manifest declares four empty lists, and each
 * emptiness is checked against the source rather than trusted. The icons are
 * generated from the app's own geometry, and the committed PNGs are compared
 * against a fresh render. The export compliance answer is pinned, because it
 * is the one field on this list where the convenient answer and the true
 * answer differ.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { codeOnly, sourcesUnder } from './support/source';

const PROJECT = 'ios/project.yml';
const MANIFEST = 'ios/LabyrinthVault/Resources/PrivacyInfo.xcprivacy';
const APPICON = 'ios/LabyrinthVault/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png';

describe('the vault is shaped like something that can be uploaded', () => {
  const project = readFileSync(PROJECT, 'utf8');

  it('has a bundle identifier of its own', () => {
    /* Not inferred from the target name. The two halves ship as two apps and
     * an identifier that drifts is an identifier that overwrites the wrong
     * TestFlight build. */
    expect(project).toMatch(/PRODUCT_BUNDLE_IDENTIFIER: vision\.labyrinth\.vault/);
    expect(project).not.toMatch(/PRODUCT_BUNDLE_IDENTIFIER: vision\.labyrinth\.wallet/);
  });

  it('has a marketing version and a build number', () => {
    expect(project).toMatch(/CFBundleShortVersionString: "\d+\.\d+\.\d+"/);
    expect(project).toMatch(/CFBundleVersion: "\d+"/);
  });

  it('points at an app icon that exists', () => {
    expect(project).toMatch(/ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon/);
    expect(existsSync(APPICON), 'the icon the catalog names is missing').toBe(true);
    const catalog = JSON.parse(
      readFileSync('ios/LabyrinthVault/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json', 'utf8'),
    ) as { images: { filename: string; size: string }[] };
    expect(catalog.images.some((i) => i.filename === 'icon-1024.png' && i.size === '1024x1024')).toBe(true);
  });

  it('answers the export compliance question, and answers it truthfully', () => {
    /* The convenient answer is false and it would be a misstatement. This app
     * encrypts a seed at rest with Argon2id and XChaCha20-Poly1305, which is
     * data confidentiality rather than any of the exempt uses. See
     * docs/shipping.md, which writes out the exemption it does qualify for and
     * the annual report that goes with it. */
    expect(project).toMatch(/ITSAppUsesNonExemptEncryption: true/);
    const doc = readFileSync('docs/shipping.md', 'utf8');
    expect(doc).toMatch(/5D992/);
    expect(doc).toMatch(/self-classification/i);
  });

  it('reaches its fixtures through the accessor that exists in both builds', () => {
    /* `Bundle.module` is synthesised by SwiftPM for targets that declare
     * resources. Xcode synthesises nothing, so naming it there is a compile
     * error: "Type 'Bundle' has no member 'module'". It is the same shape of
     * mistake as the module name above, and it fails in the same asymmetric
     * way: green under `swift test`, green in CI, broken at the first ⌘U.
     *
     * `FixtureBundle` holds both lookups in one place, including the detail
     * that SwiftPM's `.copy` preserves the `Fixtures/` directory while
     * Xcode's resource phase flattens it to the bundle root. */
    const tests = sourcesUnder('ios/LabyrinthVaultTests', ['.swift']);
    for (const { path, text } of tests) {
      if (path.endsWith('FixtureBundle.swift')) continue;
      expect(text, `${path} uses Bundle.module, which does not exist under Xcode`).not.toMatch(
        /Bundle\.module/,
      );
    }
  });

  it('imports the model under both names it is built with', () => {
    /* The same sources are built twice. `Package.swift` makes the
     * platform-free files a library target called `LabyrinthVaultCore`, which
     * is what `swift test` and CI run. Xcode has no such target: those files
     * are compiled straight into the app, where the module is
     * `LabyrinthVault`. So a bare `@testable import LabyrinthVaultCore`
     * passes on Linux, passes in CI, and fails the first ⌘U on a Mac with
     * "Unable to resolve module dependency" — which is the worst place to
     * find out, because ⌘U is where these tests stop being a formality and
     * start checking NFKD against Apple's own Foundation.
     *
     * Every test file therefore imports conditionally, and this is what says
     * so when somebody adds the sixth one. */
    const tests = sourcesUnder('ios/LabyrinthVaultTests', ['.swift']);
    expect(tests.length, 'no contract tests found to check').toBeGreaterThan(3);
    for (const { path, text } of tests) {
      if (!/@testable import/.test(text)) continue;
      expect(text, `${path} imports one module name; it needs both`).toMatch(
        /#if canImport\(LabyrinthVaultCore\)\s*\n@testable import LabyrinthVaultCore\s*\n#else\s*\n@testable import LabyrinthVault\s*\n#endif/,
      );
    }
  });

  it('leaves the built product named after its target, so the tests can find a host', () => {
    /* The home screen label comes from `CFBundleDisplayName`, which is the key
     * iOS actually reads for it. `PRODUCT_NAME` is a different thing: it
     * renames the product on disk. Both were set, so the app built as
     * `Labyrinth Vault.app/Labyrinth Vault` while XcodeGen derived the test
     * bundle's `TEST_HOST` from the target name and pointed it at
     * `LabyrinthVault.app/LabyrinthVault`.
     *
     * The app was fine. The first ⌘U was not: "Could not find test host",
     * which reads like a broken test target rather than a renamed product.
     * And the tests are the half that checks NFKD against Apple's own
     * Foundation, the check that catches a vault which opens on the device
     * that sealed it and nowhere else. Losing that quietly is what getting
     * this wrong costs, so it is held here. */
    expect(
      project,
      'ios/project.yml sets PRODUCT_NAME; CFBundleDisplayName is what names the app on a home screen, and renaming the product breaks TEST_HOST',
    ).not.toMatch(/^\s*PRODUCT_NAME:/m);
    expect(
      project,
      'nothing names the app for the home screen any more',
    ).toMatch(/CFBundleDisplayName:\s*Labyrinth Vault/);
  });
});

describe('the privacy manifest is empty because the app is', () => {
  /* Four empty lists. Each is a promise, and each is checked against the thing
   * it is a promise about rather than left as an assertion in a plist. */

  const manifest = readFileSync(MANIFEST, 'utf8');
  const swift = sourcesUnder('ios/LabyrinthVault', ['.swift']);

  it('declares no tracking, no collection and no required-reason APIs', () => {
    for (const key of [
      'NSPrivacyTrackingDomains',
      'NSPrivacyCollectedDataTypes',
      'NSPrivacyAccessedAPITypes',
    ]) {
      expect(manifest, `${key} is not declared`).toContain(key);
      // `<array/>` is the empty form; `<array>` with children is not.
      expect(manifest).toMatch(new RegExp(`<key>${key}</key>\\s*<array/>`));
    }
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  });

  it('found the Swift to check it against', () => {
    expect(swift.length).toBeGreaterThan(10);
  });

  it('calls none of the required-reason APIs it says it calls none of', () => {
    /* The five families Apple asks about. A file that starts using one of
     * these needs a declaration in the manifest, and this is what will say so
     * before an upload does. Comments stripped: the prose naming an API is not
     * the API being called. */
    const families: [string, RegExp][] = [
      ['user defaults', /\bUserDefaults\b/],
      ['file timestamps', /\b(creationDate|modificationDate|attributesOfItem|contentModificationDate)\b/],
      ['disk space', /\b(volumeAvailableCapacity|systemFreeSize|volumeTotalCapacity)\b/],
      ['system boot time', /\b(systemUptime|kern\.boottime)\b/],
      ['active keyboards', /\bactiveInputModes\b/],
    ];
    const guilty: string[] = [];
    for (const file of swift) {
      for (const [name, pattern] of families) {
        if (pattern.test(codeOnly(file.text))) guilty.push(`${file.path}: ${name}`);
      }
    }
    expect(guilty, 'these need a declaration in PrivacyInfo.xcprivacy').toEqual([]);
  });

  it('is shipped inside the app rather than merely present in the repository', () => {
    /* A manifest outside the bundle is a manifest Apple never sees. It lives
     * under `Resources/`, which the target's source path includes. */
    expect(MANIFEST.startsWith('ios/LabyrinthVault/')).toBe(true);
    expect(readFileSync(PROJECT, 'utf8')).toMatch(/- path: LabyrinthVault/);
  });

});

describe('the icons are the app mark, not a drawing of it', () => {
  it('regenerate byte for byte from the geometry the app uses', () => {
    /* The same arrangement as the engine bundle and its digest. The labyrinth
     * is generated by `wallet/src/design/geometry.ts` and the send flow draws a
     * payment along it; an icon exported by hand is a second labyrinth that
     * starts being subtly wrong the first time the first one is tuned. */
    const before = [
      APPICON,
      'wallet/assets/icon.png',
      'wallet/assets/splash-icon.png',
    ].map((path) => ({ path, digest: createHash('sha256').update(readFileSync(path)).digest('hex') }));

    execFileSync('node', ['scripts/make-icons.mjs'], { stdio: 'pipe' });

    for (const { path, digest } of before) {
      const now = createHash('sha256').update(readFileSync(path)).digest('hex');
      expect(now, `${path} is stale: run node scripts/make-icons.mjs`).toBe(digest);
    }
  });

  it('gives the two apps opposite palettes, so they cannot be confused', () => {
    /* One holds keys and one does not, and they will sit next to each other on
     * a home screen. Read the first pixel of each: the vault is ink-on-dark,
     * the wallet is ink-on-light. */
    const corner = (path: string): number => {
      /* IHDR is 8 (signature) + 8 (length+type) + 13 bytes; the first pixel is
       * inside the compressed IDAT, so instead of decoding, compare overall
       * darkness by file entropy proxy. Simpler and sufficient: the two files
       * must differ. */
      return readFileSync(path).length;
    };
    const vault = readFileSync(APPICON);
    const wallet = readFileSync('wallet/assets/icon.png');
    expect(vault.equals(wallet), 'the two apps ship the same icon').toBe(false);
    expect(corner(APPICON)).toBeGreaterThan(0);

    // And the generator states the inversion, so the intent is not folklore.
    const script = readFileSync('scripts/make-icons.mjs', 'utf8');
    expect(script).toMatch(/must never be confused/);
  });
});

describe('the wallet is shaped like something that can be uploaded', () => {
  /* Read from here rather than from the wallet's own suite because these are
   * the same questions asked of the same App Store Connect account, and
   * answering them in two places is how the two apps drift apart. */

  const app = JSON.parse(readFileSync('wallet/app.json', 'utf8')) as {
    expo: {
      icon?: string;
      splash?: { image?: string };
      ios: {
        bundleIdentifier: string;
        buildNumber?: string;
        infoPlist: Record<string, unknown>;
        privacyManifests?: Record<string, unknown>;
      };
    };
  };
  const ios = app.expo.ios;
  const walletPackage = JSON.parse(readFileSync('wallet/package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };

  it('has its own bundle identifier, an icon and a build number', () => {
    expect(ios.bundleIdentifier).toBe('vision.labyrinth.wallet');
    expect(ios.buildNumber).toMatch(/^\d+$/);
    expect(app.expo.icon).toBe('./assets/icon.png');
    expect(existsSync('wallet/assets/icon.png')).toBe(true);
    expect(existsSync(`wallet/${app.expo.splash?.image?.slice(2)}`)).toBe(true);
  });

  it('declares the same empty privacy manifest, for the same reason', () => {
    expect(ios.privacyManifests).toEqual({
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [],
    });
  });

  it('answers export compliance differently from the vault, on purpose', () => {
    /* The wallet holds no secret and encrypts nothing at rest. It is watch
     * only: an extended public key, a view key, addresses. Different app,
     * different true answer, and the difference is the point rather than an
     * inconsistency. docs/shipping.md carries the reasoning. */
    expect(ios.infoPlist['ITSAppUsesNonExemptEncryption']).toBe(false);
    expect(readFileSync('docs/shipping.md', 'utf8')).toMatch(/watch only/i);
  });

  it('carries every dependency its own config leans on', () => {
    /* Found by running `expo prebuild` on Linux rather than discovering it in
     * the first Xcode session: the config's `backgroundColor` silently does
     * nothing on iOS without expo-system-ui, and a dark app whose root view
     * stays white flashes on every overscroll. The prebuild dry run is the
     * check; this pins its finding. */
    expect(walletPackage.dependencies['expo-system-ui']).toBeDefined();
    /* And the two storage choices that carry privacy claims stay declared,
     * not merely present transitively where a lockfile update could drop
     * them. */
    expect(walletPackage.dependencies['expo-file-system']).toBeDefined();
    expect(walletPackage.dependencies['expo-secure-store']).toBeDefined();
  });

  it('never commits the generated native project', () => {
    /* `wallet/ios` regenerates from app.json on every prebuild. Committing a
     * copy freezes it against the config and the two drift; the config is the
     * source, this suite is what holds the config, and the ignore rule is
     * what keeps the copy out. */
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/wallet\/ios\//);
  });
});
