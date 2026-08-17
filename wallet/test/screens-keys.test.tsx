/**
 * Making a wallet on this phone, and getting the words back out.
 *
 * ## The two orderings this file exists for
 *
 * A record is not saved until its words have been shown. `core/backup.ts`
 * holds that as a state machine and has its own tests; what it cannot hold is
 * whether the screen wired the machine to the button. That gap is the shape of
 * the whole audit: a rule enforced in a module and bypassed by a component.
 *
 * The other is the gate on the way back. This screen showed thirty-seven words
 * on a bare press while `signgate.ts` argued at length for a prompt before
 * every signature, which was guarding the smaller thing: reading the seed off
 * a taken phone is not one signature, it is every future signature, on any
 * device, forever.
 *
 * ## Why the relaunch is real here
 *
 * The second half of this file makes a wallet on one mounted tree, throws the
 * tree away, and mounts a fresh store. Nothing is handed between them but the
 * keychain, which is exactly what a phone hands between two launches. A test
 * that reached into the store to place a record would prove that the screen
 * renders a record, and this proves that the record survives the way a
 * person's does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { gate, keychain, mount, navigator, resetNative } from './harness/render';
import { StoreProvider } from '../src/state/store';
import { BackupScreen, CreateWalletScreen } from '../src/screens/Backup';

const WROTE_THEM_DOWN = 'I HAVE WRITTEN THEM DOWN';

beforeEach(() => {
  resetNative();
});

/** A wallet made the way a person makes one: reveal the words, then keep. */
async function makeAWallet(): Promise<{ went: string[] }> {
  const { nav, props } = navigator();
  const ui = mount(
    <StoreProvider>
      <CreateWalletScreen {...props<'CreateWallet'>()} />
    </StoreProvider>,
  );
  await ui.settle();
  ui.hold('HOLD TO REVEAL');
  await ui.act(() => ui.press(WROTE_THEM_DOWN));
  ui.unmount();
  return { went: nav.went };
}

describe('making a wallet on this phone', () => {
  it('draws dashes rather than words until a finger is down', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <CreateWalletScreen {...props<'CreateWallet'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    /* Concealed means not drawn. A blur is a treatment over a string that is
     * still in the view tree, still in a screenshot, still in whatever the
     * system captures when the app is backgrounded, and this is the networked
     * half of the product. */
    expect(ui.shows('CONCEALED')).toBe(true);
    expect(ui.text(), 'something other than dashes is where the words go').toContain('----');

    ui.hold('HOLD TO REVEAL');
    expect(ui.shows('VISIBLE')).toBe(true);
    expect(ui.text(), 'the grid still holds placeholders after being revealed').not.toContain('----');

    ui.release('HOLD TO REVEAL');
    expect(ui.shows('CONCEALED'), 'the words stayed on the glass after the finger lifted').toBe(true);
    expect(ui.text()).toContain('----');
  });

  it('will not keep a wallet whose words nobody has seen', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <CreateWalletScreen {...props<'CreateWallet'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.enabled(WROTE_THEM_DOWN), 'a wallet could be kept before its words were shown').toBe(false);
    /* Nothing is on the phone yet either, which is the half that matters: a
     * disabled button over a record already written would be theater. */
    expect([...keychain.contents().keys()]).toEqual([]);

    ui.hold('HOLD TO REVEAL');
    expect(ui.enabled(WROTE_THEM_DOWN)).toBe(true);
  });

  it('writes the keys where only this phone, unlocked, can read them', async () => {
    await makeAWallet();

    const written = [...keychain.contents().keys()];
    expect(written.length, 'the wallet was kept and nothing reached the keychain').toBeGreaterThan(0);

    /* The accessibility class is the whole of the storage argument. The
     * alternative syncs somebody's spending key to iCloud, and it is one
     * missing option away at every call site. */
    const writes = keychain.calls.filter((call) => call.op === 'set');
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.accessible, `${write.key} was written with no accessibility class`).toBe(
        'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
      );
    }
  });

  it('leaves for home once the words are written down', async () => {
    const { went } = await makeAWallet();
    expect(went).toContain('Home');
  });

  it('refuses to make a second one rather than replacing the first', async () => {
    await makeAWallet();

    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <CreateWalletScreen {...props<'CreateWallet'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.shows('This phone already holds a wallet')).toBe(true);
    /* A refusal that names an action no screen offers is a refusal telling
     * somebody to do something they cannot do, which is how this one read for
     * the whole of the hot-spending work. */
    expect(ui.controls()).toContain('RESTORE A PHRASE');
    expect(ui.controls()).toContain('FORGET THE WALLET ON THIS PHONE');
  });
});

describe('getting the words back, on a phone that has been relaunched', () => {
  it('is a real relaunch, and not a store remembering across a mount', async () => {
    /* The test this whole describe rests on, so it goes first.
     *
     * Every case below makes a wallet in one mounted tree and reads it back in
     * another, and the claim is that nothing passes between them but the
     * keychain. If the store kept its record in module state instead, all of
     * them would pass without a byte ever being stored, and the suite would be
     * reporting on itself. So: empty the keychain between the two mounts and
     * check that the second one finds nothing. */
    await makeAWallet();
    expect(keychain.contents().size, 'nothing was stored, so the relaunch proves nothing').toBeGreaterThan(0);

    keychain.reset();

    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <BackupScreen {...props<'Backup'>()} />
      </StoreProvider>,
    );
    await ui.settle();
    expect(
      ui.shows('No keys are stored on this phone'),
      'a fresh store found a wallet that is not in the keychain, so it is reading module state',
    ).toBe(true);
  });

  it('asks for the same check a payment does before it draws anything', async () => {
    await makeAWallet();

    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <BackupScreen {...props<'Backup'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.shows('The words on paper'), 'the relaunched wallet did not find its own keys').toBe(true);
    expect(ui.text(), 'the words were drawn before anybody was asked').not.toContain('----');
    expect(ui.shows('CONCEALED')).toBe(false);
    expect(ui.controls()).toContain('SHOW THE WORDS');
    expect(gate.prompts, 'a prompt was raised before anybody asked for the words').toEqual([]);
  });

  it('says why it did not show them when the check is refused', async () => {
    await makeAWallet();
    gate.set({ approves: false });

    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <BackupScreen {...props<'Backup'>()} />
      </StoreProvider>,
    );
    await ui.settle();
    await ui.act(() => ui.press('SHOW THE WORDS'));

    expect(ui.shows('NOT SHOWN')).toBe(true);
    expect(ui.shows('CONCEALED'), 'the grid came up after the check was refused').toBe(false);
    /* A sentence, not a code. Somebody reading a refusal should learn what to
     * do next. */
    expect(ui.text().length).toBeGreaterThan(120);
  });

  it('draws the grid, still concealed, once the check passes', async () => {
    await makeAWallet();

    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <BackupScreen {...props<'Backup'>()} />
      </StoreProvider>,
    );
    await ui.settle();
    await ui.act(() => ui.press('SHOW THE WORDS'));

    expect(gate.prompts).toContain('Show your recovery words');
    /* Past the gate and still not on the glass. Two locks rather than one: the
     * check says who, the hold says when. */
    expect(ui.shows('CONCEALED')).toBe(true);
    expect(ui.text()).toContain('----');

    ui.hold('HOLD TO REVEAL');
    expect(ui.shows('VISIBLE')).toBe(true);
    expect(ui.text()).not.toContain('----');
  });

  it('says there is nothing to write down when the keys are somewhere else', async () => {
    const { props } = navigator();
    const ui = mount(
      <StoreProvider>
        <BackupScreen {...props<'Backup'>()} />
      </StoreProvider>,
    );
    await ui.settle();

    expect(ui.shows('No keys are stored on this phone')).toBe(true);
    expect(ui.controls()).not.toContain('SHOW THE WORDS');
    expect(gate.prompts).toEqual([]);
  });
});
