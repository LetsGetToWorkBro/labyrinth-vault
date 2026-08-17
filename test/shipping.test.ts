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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
    /* The answer is no longer in the manifest, and this guard had to move
     * with it.
     *
     * `ITSAppUsesNonExemptEncryption: true` lived here and was correct, and
     * Apple refused every upload against it: answering yes puts the app in
     * the category that owes documentation, and validation then compares the
     * plist to whatever the app record holds. Completing the App Encryption
     * Documentation wizard did not settle it. So the question moved to App
     * Store Connect, where it is asked per build.
     *
     * What is checkable from here is only that the key is genuinely absent
     * rather than present and wrong, and that the runbook still carries the
     * true answer for the person filling in the form. That is weaker than a
     * manifest a test can read, and it is why `project.yml` says to put it
     * back when Apple's side is understood. */
    const withoutComments = project.replace(/^\s*#.*$/gm, '');
    expect(
      withoutComments,
      'the export answer is back in the manifest; if that now works, delete this guard',
    ).not.toMatch(/ITSAppUsesNonExemptEncryption/);
    expect(
      readFileSync('docs/shipping.md', 'utf8'),
      'the runbook no longer says what to answer in App Store Connect',
    ).toMatch(/answer[^.]*\bYES\b|\bYES\b[^.]*App Store Connect/i);

    /* And the companion key is absent rather than empty, which is not the
     * same thing and is the version that gets an upload rejected.
     * `ITSEncryptionExportComplianceCode` is for apps issued a code after
     * CCATS; 5D992.c mass market is not one, so there is nothing to declare.
     * App Store Connect validates the value it finds instead of ignoring it,
     * so a key present with `""` in it answers wrongly rather than declining
     * to answer.
     *
     * Guarded because it is a plausible thing to add back: somebody reading
     * "leave it empty", or an editor filling in a schema, produces exactly
     * the line this refuses. Comments stripped first, because the manifest
     * now explains the absence at the place the key used to be, and a guard
     * that reads its own documentation as a violation is a mistake this
     * suite has made before. */
    const projectCode = project.replace(/^\s*#.*$/gm, '');
    expect(
      projectCode,
      'ITSEncryptionExportComplianceCode is set; omit the key unless Apple issued a code',
    ).not.toMatch(/ITSEncryptionExportComplianceCode/);

    const doc = readFileSync('docs/shipping.md', 'utf8');
    expect(doc).toMatch(/5D992/);
    expect(doc).toMatch(/self-classification/i);
  });

  it('never tells the submitter to make the edit that failed four uploads', () => {
    /* The assertion above reads the whole runbook for the word YES near "App
     * Store Connect", and the runbook is long enough that unrelated prose
     * satisfied it. Underneath it, the vault's submission checklist said the
     * export answer "is answered in the Info.plist
     * (`ITSAppUsesNonExemptEncryption: true`), so Connect will not re-ask per
     * build", which is the edit Apple rejected four consecutive times and
     * which `test/shipping.test.ts` now fails on. A person working down a
     * checklist does what the checkbox says; they do not read the essay four
     * hundred lines above it.
     *
     * So this reads the checkboxes themselves. A `- [ ]` item is the line
     * plus its indented continuations, because that is how the runbook wraps
     * them, and a check that looked at single lines would miss the half of a
     * sentence that carries the instruction. */
    const doc = readFileSync('docs/shipping.md', 'utf8');
    const items: string[] = [];
    for (const line of doc.split('\n')) {
      if (/^- \[[ x]\]/.test(line)) items.push(line);
      else if (items.length > 0 && /^ {2,}\S/.test(line)) items[items.length - 1] += ' ' + line.trim();
      else if (line.trim() === '') items.push('');
    }
    const boxes = items.filter((item) => item.startsWith('- ['));
    expect(boxes.length, 'the runbook lost its checklists').toBeGreaterThan(10);

    /* Naming the key to warn against it is the point of the corrected line,
     * so what is refused is a box that names it without the warning. */
    const telling = boxes.filter(
      (box) => /ITSAppUsesNonExemptEncryption/.test(box) && !/do not add|rather than flipped/i.test(box),
    );
    expect(telling, 'a checklist item tells the submitter to put the export key back').toEqual([]);

    /* And both per-app checklists have to carry the instruction that replaced
     * it, since the failure this guard exists for was one app's list being
     * corrected and the other's left behind. */
    const compliance = boxes.filter((box) => /export compliance/i.test(box));
    expect(compliance.length, 'a per-app checklist lost its export compliance line').toBe(2);
    for (const box of compliance) {
      expect(box, 'a checklist item does not say to answer YES per build').toMatch(
        /answer\s+\*{0,2}YES/i,
      );
    }
  });

  it('reaches its fixtures through the accessor that exists in both builds', () => {
    /* `Bundle.module` is synthesized by SwiftPM for targets that declare
     * resources. Xcode synthesizes nothing, so naming it there is a compile
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
    /* Rendered somewhere else and compared, rather than rendered over the
     * committed files and re-read.
     *
     * The re-read version was the obvious one and it was a race. Vitest runs
     * test files in parallel, so this test rewrote three tracked PNGs while
     * other files were reading the same working tree. It passed almost always
     * and failed twice in one afternoon, which is the worst failure rate
     * there is: often enough to waste an hour, rare enough to be dismissed as
     * a fluke. A check that mutates the tree it is checking cannot be trusted
     * to be checking only what it claims.
     *
     * `ICON_OUT_ROOT` exists in make-icons.mjs for this. The test is now
     * read-only and the comparison is the same one. */
    const rendered = '.icons-check';
    execFileSync('node', ['scripts/make-icons.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ICON_OUT_ROOT: rendered },
    });

    for (const path of [APPICON, 'wallet/assets/icon.png', 'wallet/assets/splash-icon.png']) {
      const committed = createHash('sha256').update(readFileSync(path)).digest('hex');
      const fresh = createHash('sha256').update(readFileSync(`${rendered}/${path}`)).digest('hex');
      expect(fresh, `${path} is stale: run node scripts/make-icons.mjs`).toBe(committed);
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
      plugins?: (string | [string, Record<string, unknown>])[];
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

  /** A plugin entry by name, with its configuration, or null if it is absent. */
  const plugin = (name: string): Record<string, unknown> | null => {
    for (const entry of app.expo.plugins ?? []) {
      if (entry === name) return {};
      if (Array.isArray(entry) && entry[0] === name) return entry[1] ?? {};
    }
    return null;
  };

  it('has its own bundle identifier, an icon and a build number', () => {
    expect(ios.bundleIdentifier).toBe('vision.labyrinth.wallet');
    expect(ios.buildNumber).toMatch(/^\d+$/);
    expect(app.expo.icon).toBe('./assets/icon.png');
    expect(existsSync('wallet/assets/icon.png')).toBe(true);
  });

  it('hands the splash asset to something that reads it', () => {
    /* This used to assert that the file named by a top-level `splash` block
     * existed, and that was three green checks over an unconsumed file:
     * `make-icons.mjs` rendered the asset, this test found it on disk, and
     * the icon test compared its bytes. None of the three asked whether
     * anything read it. `splash` is not a recognized SDK 57 field and
     * `expo-splash-screen` was not installed, so `expo config --type
     * introspect` resolved `[expo-camera, expo-font]` and no splash at all.
     *
     * The plugin is installed now and carries the same three values. Proved
     * once by hand rather than asserted: `expo prebuild` with the plugin
     * writes `SplashScreenLogo.imageset` from this image and a
     * `SplashScreenBackground.colorset` holding exactly this color, and the
     * same prebuild without it writes no logo asset at all. What is checked
     * here is that the three parts stay together, because the failure mode is
     * a config that looks configured. */
    const splash = plugin('expo-splash-screen');
    expect(splash, 'the splash configuration is not attached to a plugin that reads it').not.toBe(
      null,
    );
    expect(
      walletPackage.dependencies['expo-splash-screen'],
      'the splash plugin is configured but not installed, so prebuild will skip it',
    ).toBeDefined();
    const image = String(splash?.image ?? '');
    expect(image, 'the splash plugin names no image').toMatch(/^\.\//);
    expect(existsSync(`wallet/${image.slice(2)}`), `${image} is not in the repository`).toBe(true);
  });

  it('declares every package the phone actually loads as a dependency', () => {
    /* `qrcode` was in `devDependencies` while `src/qr/matrix.ts` imported it
     * unconditionally and five registered screens rendered it. Nothing broke,
     * because CI installs everything: `npm ci` with no `--omit=dev` anywhere.
     * What it broke was the security review, which bounds this app's runtime
     * risk with `npm audit --omit=dev` and was therefore describing a runtime
     * surface with a package missing from it, plus nine nested ones under it.
     *
     * A misplaced dependency is invisible until the day somebody does a
     * production install, and then it is a crash on a screen rather than a
     * failure at build time. So it is checked here: every bare specifier the
     * wallet's own source imports has to resolve to `dependencies`.
     *
     * Comments stripped first. The specifier pattern is deliberately anchored
     * to an import or export statement rather than looking for quotes near the
     * word "from", because prose and JSX both contain that shape and a guard
     * that reads them reports packages nobody imports. */
    const sources = sourcesUnder('wallet/src', ['.ts', '.tsx']);
    expect(sources.length, 'the wallet source moved').toBeGreaterThan(20);

    const bare = new Set<string>();
    for (const file of sources) {
      const statements = file.code.matchAll(
        /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'/g,
      );
      for (const found of statements) {
        const specifier = found[1] ?? found[2] ?? '';
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        /* `@vault/*` is a tsconfig path alias onto the shared engine in
         * `src/`, not a package, which is the whole reason both halves speak
         * one wire format without a copy. */
        if (specifier.startsWith('@vault/')) continue;
        const parts = specifier.split('/');
        bare.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
      }
    }
    expect(bare.size, 'no imports found, so this guard is checking nothing').toBeGreaterThan(10);

    const misplaced = [...bare].filter((name) => walletPackage.dependencies[name] === undefined);
    expect(misplaced, 'the phone loads these and the manifest calls them development tools').toEqual(
      [],
    );
  });

  it('declares the same empty privacy manifest, for the same reason', () => {
    expect(ios.privacyManifests).toEqual({
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [],
    });
  });

  it('no longer claims to hold no secret, because it holds one', () => {
    /* This asserted `false` for as long as the wallet was watch only, and that
     * was the right assertion for that app. The wallet generates and stores a
     * seed as of `core/backup.ts`, so `false` became a misstatement on a US
     * export form, and a test asserting it would have held the misstatement in
     * place. The key is absent rather than `true` for the reason the vault's
     * is absent: `true` in a manifest is what made Apple refuse four uploads.
     *
     * This test is the pair of the one above it for the vault. If somebody
     * ever adds the key back to stop Connect asking per build, both fail. */
    expect(
      ios.infoPlist['ITSAppUsesNonExemptEncryption'],
      'a manifest answer here is what failed four vault uploads: answer in Connect instead',
    ).toBeUndefined();
  });

  it('has a key store, which is the fact the export answer turns on', () => {
    /* The guard against the reasoning silently reversing. If the wallet ever
     * goes back to holding no keys, this fails and whoever is doing that work
     * gets sent to reconsider the export answer rather than leaving it wrong
     * in the other direction. */
    expect(existsSync('wallet/src/core/keyvault.ts')).toBe(true);
    expect(existsSync('wallet/src/core/backup.ts')).toBe(true);
    expect(readFileSync('wallet/src/state/keychainStore.ts', 'utf8')).toMatch(/spendingKeyStore/);
  });

  it('lists both apps on the BIS report, since both hold key material now', () => {
    /* The report and the answer given to Apple are the same claim made to two
     * agencies, so they cannot disagree. The wallet used to be deliberately
     * absent from this file and the README used to explain why. */
    const report = readFileSync('store/bis/self-classification-report.csv', 'utf8');
    const rows = report.trim().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^Labyrinth Vault,vision\.labyrinth\.vault,SELF,5D992,MMKT,/);
    expect(rows[2]).toMatch(/^Labyrinth Wallet,vision\.labyrinth\.wallet,SELF,5D992,MMKT,/);

    /* Twelve columns exactly, on every row. The format is fixed by Supplement
     * No. 8 and a row with the wrong count fails to parse at the other end. */
    for (const row of rows) expect(row.split(',')).toHaveLength(12);

    expect(readFileSync('store/bis/README.md', 'utf8')).toMatch(/Why both apps are listed now/);
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

  it('asks for no permission the app has no use for', () => {
    /* `microphonePermission` was unset, and `expo-camera`'s config plugin
     * removes its default only when the value is strictly `false`. So
     * prebuild wrote expo's stock "Allow $(PRODUCT_NAME) to access your
     * microphone" into the generated Info.plist, of an app that never records
     * audio. An unused purpose string grants nothing and never prompts, so
     * the cost is an App Review question and a product that says one thing
     * about what it touches while its manifest says another.
     *
     * Confirmed against the real artifact rather than reasoned about: with
     * the key absent, `expo config --type introspect` reports
     * `NSMicrophoneUsageDescription` set to the stock sentence; with it
     * `false`, the key is gone. This asserts the input that decides it,
     * because introspection needs `wallet/node_modules`, which CI installs
     * only after this suite has run.
     *
     * `false` and not a string: a purpose string is a request, and there is
     * nothing to request. */
    const camera = plugin('expo-camera');
    expect(camera, 'the camera plugin is gone; the QR round trip needs it').not.toBe(null);
    expect(
      camera?.microphonePermission,
      'the microphone default is back in the generated plist',
    ).toBe(false);
    expect(
      ios.infoPlist['NSMicrophoneUsageDescription'],
      'a microphone purpose string was added by hand',
    ).toBeUndefined();
  });

  it('never commits the generated native project', () => {
    /* `wallet/ios` regenerates from app.json on every prebuild. Committing a
     * copy freezes it against the config and the two drift; the config is the
     * source, this suite is what holds the config, and the ignore rule is
     * what keeps the copy out. */
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/wallet\/ios\//);
  });
});

describe('every suite in this repository runs when nobody remembers to run it', () => {
  /*
   * D-H1. `.github/workflows/tests.yml` had one job and it stopped after the
   * companion. The Worker is a separate package with its own vitest config,
   * which the root config cannot pick up by design, so `worker/package.json`
   * declared `test` and `typecheck` and nothing anywhere called either. Every
   * guard under `worker/test` was enforced by whoever remembered, including
   * the retention guard that `store/wallet/privacy-policy.md` points the
   * public at as "a structural property enforced by an automated test".
   *
   * The typecheck is the sharper half. It had never been run once, because
   * the Worker bundles `wallet/src/net` and typechecks it against
   * `@cloudflare/workers-types`, and one browser-only fetch option failed the
   * whole thing. A check nobody has ever run is not a check.
   *
   * This is written against the packages rather than against the step names,
   * so renaming a step is free and deleting a package's run is not.
   */
  const workflow = readFileSync('.github/workflows/tests.yml', 'utf8');

  it('is the only workflow, so this file is the whole of CI', () => {
    /* If a second one appears, the reasoning below covers half of CI and
     * somebody has to decide what the other half is for. */
    const dir = '.github/workflows';
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)) : [];
    expect(files).toEqual(['tests.yml']);
  });

  it('runs the vault suite and its typecheck', () => {
    /* `npm test` at the root is the whole pipeline: bundle, fixtures, vitest,
     * swift-check, typecheck. */
    expect(workflow).toMatch(/^\s+npm test$/m);
  });

  it('runs the companion suite and its typecheck', () => {
    expect(workflow).toMatch(/working-directory: wallet/);
    expect(workflow).toMatch(/^\s+npx vitest run$/m);
    expect(workflow).toMatch(/^\s+npx tsc --noEmit$/m);
  });

  it('runs the Worker suite and its typecheck', () => {
    expect(workflow, 'the Worker step is gone and its guards are decoration again').toMatch(
      /working-directory: worker/,
    );
    const step = workflow.slice(workflow.indexOf('working-directory: worker'));
    expect(step).toMatch(/^\s+npm test$/m);
    expect(step, 'the Worker typechecks the wallet modules it bundles').toMatch(
      /^\s+npm run typecheck$/m,
    );
  });

  it('checks the test counts CLAUDE.md documents, after all three have run', () => {
    /* The counts exist so a suite quietly shrinking is visible, and nothing
     * checked them: they read 1015 and 631 while the suites held 1060 and 905.
     * The check cannot be a test, because a test that knew its own suite's
     * total would have to run that suite inside itself, so the suites write
     * JSON reports from their own configs and a script compares the three.
     *
     * Ordered, not just present. Running it before a suite is running it
     * against that suite's previous report, which is a check that passes on
     * yesterday's number. */
    expect(workflow, 'nothing compares the documented counts against the real ones').toContain(
      'node scripts/test-counts.mjs',
    );
    const counts = workflow.indexOf('node scripts/test-counts.mjs');
    for (const [marker, suite] of [
      ['working-directory: wallet', 'companion'],
      ['working-directory: worker', 'Worker'],
    ] as const) {
      expect(
        workflow.indexOf(marker),
        `the counts are checked before the ${suite} suite has run, so it reads a stale report`,
      ).toBeLessThan(counts);
    }
  });

  it('has every suite write the report that check reads', () => {
    /* Written from each vitest config rather than a flag on the CI command,
     * so a person running a suite the ordinary way produces it too. A check
     * that exists only in CI tells you about a mistake after you pushed it. */
    for (const config of ['vitest.config.ts', 'wallet/vitest.config.mts', 'worker/vitest.config.ts']) {
      const text = readFileSync(config, 'utf8');
      expect(text, `${config} no longer writes a JSON report, so the count check has nothing to read`)
        .toMatch(/reporters:\s*\['default',\s*'json'\]/);
      expect(text, `${config} names no output file for its report`).toMatch(
        /outputFile:\s*\{\s*json:\s*'\.counts\//,
      );
    }
  });

  it('keeps those reports out of the tree', () => {
    /* A run's own arithmetic, regenerated every time. Committed, it would be
     * one more number to keep in step, which is the problem being solved. */
    const ignored = readFileSync('.gitignore', 'utf8');
    for (const dir of ['.counts/', 'wallet/.counts/', 'worker/.counts/']) {
      expect(ignored, `${dir} is written by every run and is not ignored`).toContain(dir);
    }
  });

  it('caches against every lockfile it installs from', () => {
    /* Three `npm ci` runs, three lockfiles. A missing one is not a failure,
     * it is a slow job forever, which nobody files. */
    for (const lock of ['package-lock.json', 'wallet/package-lock.json', 'worker/package-lock.json']) {
      expect(workflow, `${lock} is installed from and not cached`).toContain(lock);
    }
  });

  it('leaves no document claiming the Worker is unrun', () => {
    /* The sentence was true, was written down in three places, and is the
     * kind that outlives its fact. */
    for (const path of ['CLAUDE.md', 'docs/handoff.md']) {
      expect(readFileSync(path, 'utf8'), `${path} still says nothing runs the Worker`).not.toMatch(
        /nothing runs it|does not run on push/,
      );
    }
  });
});
