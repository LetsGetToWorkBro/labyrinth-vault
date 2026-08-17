/**
 * The airgap's inbound half, driven through the camera.
 *
 * ## What could not be tested before this file
 *
 * Pairing is the moment this product becomes what it claims to be: a vault
 * exports a watching key, the wallet reads it off a screen, and from then on
 * that account is watched here and signed for somewhere else. Every piece of
 * it had tests. `envelope.ts` had frame tests, `scanner.ts` had assembly
 * tests, `pairing.ts` had acceptance tests, the store had source-level
 * guards. Nothing had ever run the whole path, because the path starts at a
 * camera and there was no way to put a frame into one.
 *
 * So the payloads below are built by `keys/account.ts` and `airgap/envelope.ts`
 * — the vault's own export code, the same functions the other device runs —
 * and handed to a mounted `Scan` screen one frame at a time. What comes out
 * the far end is read off a mounted `Accounts` screen in the same store.
 *
 * That is the rule from CLAUDE.md applied to a screen rather than a format:
 * where this repository holds both halves, the test uses the real sender.
 *
 * ## The rule this proves
 *
 * A vault-paired account is watch-only on this phone, forever. Every other
 * test of that rule asks `canSignHere` or reads source. This one pairs an
 * account the way a person does and then looks at what the send screen offers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { bitcoinAccount, encodeAccount, moneroAccount } from '@vault/keys/account';
import { openWatch } from '@vault/keys/bitcoin';
import { walletFromSeed } from '@vault/keys/monero';
import { encodeParts } from '@vault/airgap/envelope';
import Svg, { Path } from 'react-native-svg';
import { View } from 'react-native';
import { camera, haptics, mount, navigator, resetNative } from './harness/render';
import { QrCanvas } from '../src/qr/QrCanvas';
import { StoreProvider } from '../src/state/store';
import { ScanScreen } from '../src/screens/Scan';
import { AccountsScreen } from '../src/screens/Accounts';
import { SendScreen } from '../src/screens/Send';
import { DEMO_ZPUB } from '../src/core/demo';

/* Varied rather than a fill. A seed of one repeated byte is the degenerate
 * fixture this repository keeps finding: it reduces to key material with no
 * variety in it, and a check that depends on variety passes over nothing. */
const xmrWallet = walletFromSeed(new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff));

const btcWallet = (() => {
  const opened = openWatch(DEMO_ZPUB);
  if (!opened.ok || !opened.wallet) throw new Error('the demo key does not open');
  return opened.wallet;
})();

/** What the vault puts on its screen when it exports a Bitcoin account. */
function bitcoinFrames(): string[] {
  return encodeParts('ACCOUNT', encodeAccount(bitcoinAccount(btcWallet)));
}

function moneroFrames(): string[] {
  return encodeParts('ACCOUNT', encodeAccount(moneroAccount(xmrWallet)));
}

beforeEach(() => {
  resetNative();
});

describe('pairing a vault by pointing the camera at it', () => {
  it('reads every frame and says the payload matched its own digest', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(camera.reading(), 'the scan screen mounted no camera').toBe(true);

    const frames = bitcoinFrames();
    expect(frames.length, 'a one-frame export cannot exercise assembly').toBeGreaterThan(0);
    for (const frame of frames) await ui.act(() => camera.scan(frame));

    expect(ui.shows('ACCOUNT · CHECKSUM VERIFIED')).toBe(true);
    /* The store's own sentence, not the screen's fallback. The fallback is
     * what shows when a payload arrived and nothing did anything with it,
     * which was this screen's real state for one commit: it assembled, it
     * verified, and it dropped the result on the floor while reading as
     * success. Asserting the fallback here would have passed then too. */
    expect(ui.shows('Bitcoin account key accepted')).toBe(true);
    expect(ui.shows('The first address matches what this wallet derives')).toBe(true);

    /* The confirmation haptic, because a person doing this is looking at the
     * other phone rather than at this one. `design/haptics.ts` argues that at
     * length and nothing could check it until a screen could be driven. */
    expect(haptics.felt).toContain('notification:success');
  });

  it('puts the account on the accounts screen, watch-only, in the same store', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
        <AccountsScreen {...props<'Accounts'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.shows('No accounts yet'), 'this wallet started with something in it').toBe(true);

    for (const frame of bitcoinFrames()) await ui.act(() => camera.scan(frame));

    expect(ui.shows('No accounts yet'), 'the scan finished and the accounts screen did not notice').toBe(
      false,
    );
    /* The sentence the whole product is for. A paired account that did not
     * say this would be a wallet that looks like it can spend from keys that
     * are not on it. */
    expect(ui.shows('SIGNS ON YOUR VAULT')).toBe(true);
    expect(ui.shows('This phone holds the watching half and nothing that can spend')).toBe(true);
  });

  it('never offers to sign a vault account on this phone', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
        <SendScreen {...props<'Send'>()} />
      </StoreProvider>,
    );
    await ui.settle();
    for (const frame of moneroFrames()) await ui.act(() => camera.scan(frame));

    /* The convenience that breaks the airgap is "if we happen to hold a seed,
     * sign with it". There is no seed here, and the point of asserting it on a
     * mounted screen rather than on `canSignHere` is that a screen can offer a
     * control the core would refuse: the offer itself is the lie. */
    const offered = ui.controls().join(' | ').toUpperCase();
    expect(offered).not.toContain('SIGN ON THIS PHONE');
    expect(offered).not.toContain('SIGN HERE');
  });
});

describe('what the camera refuses', () => {
  it('refuses to assemble one account out of halves of two exports', async () => {
    /* Small parts on purpose, so both exports are several frames and the
     * mixture is a real one. At the default part size these payloads are one
     * frame each, which completes on arrival and makes any second frame a
     * frame arriving after the scan was already over: a weaker question than
     * the one worth asking, which is whether a second transmission can extend
     * a first. */
    const bitcoin = encodeParts('ACCOUNT', encodeAccount(bitcoinAccount(btcWallet)), 24);
    const monero = encodeParts('ACCOUNT', encodeAccount(moneroAccount(xmrWallet)), 24);
    expect(bitcoin.length, 'the mixture needs more than one frame per export').toBeGreaterThan(2);
    expect(monero.length).toBeGreaterThan(2);

    /* A complete Bitcoin export with exactly one frame swapped for the
     * corresponding frame of a different one. Every frame is a valid frame of
     * a valid payload, the count is right, and the indices are right. This is
     * the only shape that distinguishes a reader keyed on the digest from one
     * keyed on position, and a reader with the second kind would end up
     * watching an address neither vault ever exported. */
    const mixed = [...bitcoin];
    mixed[1] = monero[1]!;

    const feed = async (frames: string[]) => {
      const { props } = navigator();
      const ui = mount(
        <StoreProvider>
          <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
          <AccountsScreen {...props<'Accounts'>()} />
        </StoreProvider>,
      );
      await ui.settle();
      for (const frame of frames) await ui.act(() => camera.scan(frame));
      const verdict = { verified: ui.shows('CHECKSUM VERIFIED'), empty: ui.shows('No accounts yet') };
      ui.unmount();
      return verdict;
    };

    /* The control, and the reason this test is not about nothing: the same
     * frames without the substitution do pair. Without this line a scanner
     * that refused everything would pass. */
    resetNative();
    expect(await feed(bitcoin)).toEqual({ verified: true, empty: false });

    resetNative();
    expect(await feed(mixed), 'one frame of a different export got assembled into this one').toEqual({
      verified: false,
      empty: true,
    });
  });

  it('finishes the export that is actually in front of it', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
        <AccountsScreen {...props<'Accounts'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    /* The other half of the check above, and the reason it is here: a reader
     * that refused mixtures by refusing everything would pass that test and
     * be a broken app. Frames arrive out of order and repeat, which the screen
     * says out loud, so this feeds them backwards and twice. */
    const frames = encodeParts('ACCOUNT', encodeAccount(moneroAccount(xmrWallet)), 24);
    for (const frame of [...frames].reverse()) await ui.act(() => camera.scan(frame));
    for (const frame of frames) await ui.act(() => camera.scan(frame));

    expect(ui.shows('CHECKSUM VERIFIED')).toBe(true);
    expect(ui.shows('No accounts yet')).toBe(false);
  });

  it('ignores a code that is not one of ours rather than refusing the scan', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
      </StoreProvider>,
    );
    await ui.settle();

    /* A camera pointed at a room sees wifi codes and cereal boxes. The scanner
     * documents that it returns null for those rather than throwing, and this
     * is that claim with a camera in front of it. */
    await ui.act(() => camera.scan('WIFI:S=somebody-else;T=WPA;P=hunter2;;'));
    expect(ui.shows('CHECKSUM VERIFIED')).toBe(false);

    for (const frame of bitcoinFrames()) await ui.act(() => camera.scan(frame));
    expect(ui.shows('CHECKSUM VERIFIED'), 'a stray code poisoned the scanner').toBe(true);
  });
});

describe('the airgap going the other way', () => {
  it('resolves react-native without swallowing react-native-svg', () => {
    /* `vitest.config.mts` claims the alias list matches a specifier only when
     * it is equal or begins with it plus a slash, which is what keeps
     * `react-native` from taking `react-native-svg` with it. That is a claim
     * about somebody else's resolver, so it is checked rather than trusted: if
     * it were wrong, `Svg` would be undefined and every QR in this app would
     * render as nothing, silently. */
    expect(Svg).toBe('Svg');
    expect(Path).toBe('Path');
    expect(View).toBe('View');
  });

  it('draws a QR with real geometry in it', () => {
    /* The outbound half. Everything a vault reads off this phone goes through
     * `QrCanvas`, and until a screen could be mounted the only thing tested
     * was `matrix.ts` deciding which modules are dark. This is that decision
     * arriving as a path a renderer would draw. */
    const ui = mount(<QrCanvas value="bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" size={300} />);
    expect(ui.all('Svg').length, 'the QR canvas drew no Svg').toBeGreaterThan(0);

    const paths = ui.all('Path');
    expect(paths.length, 'the QR canvas drew no path').toBeGreaterThan(0);
    expect(
      String(paths[0]!.props['d'] ?? '').length,
      'the path is on the screen with no geometry in it',
    ).toBeGreaterThan(100);
  });
});

describe('the camera stand-in, held honest', () => {
  it('stops reading when the screen that mounted it goes away', async () => {
    /* `reading()` is what three tests in this file assert on, and its first
     * version answered "has a camera ever been mounted in this process"
     * because the handler was registered during render and never removed.
     * That is the same answer as the truth until somebody asks after an
     * unmount, and then it is wrong in the direction that passes. */
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
      </StoreProvider>,
    );
    await ui.settle();
    expect(camera.reading()).toBe(true);

    ui.unmount();
    expect(camera.reading(), 'a camera nobody has mounted is still reading').toBe(false);
  });
});

describe('the camera permission a person has not answered yet', () => {
  it('draws nothing rather than a refusal while the system has not said', async () => {
    camera.permission({ at: null });
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
      </StoreProvider>,
    );
    await ui.settle();

    /* The hook returns null before it has asked, and this screen draws an
     * empty void for that frame on purpose. A stand-in that started at
     * "granted" would never render this branch, which is why the harness
     * starts where the device does. */
    expect(camera.reading()).toBe(false);
    expect(ui.shows('ALLOW THE CAMERA')).toBe(false);
  });

  it('explains what the camera is for, and asks, when it has been refused', async () => {
    camera.permission({ at: camera.refused, afterAsking: camera.allowed });
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <ScanScreen {...props<'Scan'>({ purpose: 'wire' })} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.shows('Nothing it sees is stored, and nothing is sent anywhere')).toBe(true);
    expect(camera.reading()).toBe(false);

    await ui.act(() => ui.press('ALLOW THE CAMERA'));
    expect(camera.reading(), 'permission was granted and no camera came up').toBe(true);
  });
});
