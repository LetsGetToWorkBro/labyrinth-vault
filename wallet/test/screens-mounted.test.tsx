/**
 * Every registered screen, mounted.
 *
 * ## Why this file is the important one
 *
 * `test/screens.test.ts` reads the screens as text and enforces the rules that
 * are visible in source. It exists because nothing could run them. This runs
 * them.
 *
 * The distinction matters more here than the line count suggests. The audit's
 * worst wallet finding was `Receive` dereferencing `addresses[0]` on an
 * account with nothing derived yet, which is a crash on the first screen a new
 * person opens. It was found by somebody reading that line. A screen that
 * throws during render is the one class of defect no amount of source reading
 * reliably catches, because the throw is usually two files away from the line
 * that looks wrong.
 *
 * So the first thing here is the least clever thing here: mount all of them,
 * in the states a wallet is actually in, and see whether they draw.
 *
 * ## The states
 *
 * A wallet with nothing is the state that finds crashes, and it is the state
 * every install starts in: no pairing, no keys on this phone, no addresses
 * derived, no chain data. Almost every empty-list dereference in this codebase
 * would have shown up here.
 *
 * ## The registry check
 *
 * The table below has to match `App.tsx`. A screen registered there and absent
 * here is a screen nobody mounts, which is how this file would quietly stop
 * being about the application, so the last test in this file compares the two.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { mount, navigator, resetNative } from './harness/render';
import { StoreProvider } from '../src/state/store';
import type { Nav, Routes } from '../src/nav/routes';
import { HomeScreen } from '../src/screens/Home';
import { ActivityScreen, TransactionScreen } from '../src/screens/Activity';
import { AssetScreen } from '../src/screens/Asset';
import { ReceiveScreen } from '../src/screens/Receive';
import { SwapScreen } from '../src/screens/Swap';
import { CoinPickerScreen } from '../src/screens/CoinPicker';
import { SwapDepositScreen } from '../src/screens/SwapDeposit';
import { SwapStatusScreen } from '../src/screens/SwapStatus';
import { NodesScreen } from '../src/screens/Nodes';
import { KeyImagesScreen } from '../src/screens/KeyImages';
import { MoneroFileScreen } from '../src/screens/MoneroFile';
import { SendScreen } from '../src/screens/Send';
import { ScanScreen } from '../src/screens/Scan';
import { PairScreen, SecurityScreen, VaultScreen } from '../src/screens/Vault';
import { AccountsScreen } from '../src/screens/Accounts';
import { BackupScreen, CreateWalletScreen } from '../src/screens/Backup';
import { RestoreScreen } from '../src/screens/Restore';
import { OnboardingScreen } from '../src/screens/Onboarding';

/**
 * One route, and the parameters a navigator would arrive with.
 *
 * The parameters are the realistic ones rather than the minimal ones. A swap
 * deposit reached with an empty address is a screen state the application
 * cannot produce, and a test that mounts it is asking about a screen that does
 * not exist.
 */
interface Registered {
  route: keyof Routes;
  screen: string;
  draw: (props: <R extends keyof Routes>(params?: Routes[R]) => Nav<R>) => ReactElement;
}

const SCREENS: Registered[] = [
  { route: 'Onboarding', screen: 'OnboardingScreen', draw: (p) => <OnboardingScreen {...p<'Onboarding'>()} /> },
  { route: 'Home', screen: 'HomeScreen', draw: (p) => <HomeScreen {...p<'Home'>()} /> },
  { route: 'Activity', screen: 'ActivityScreen', draw: (p) => <ActivityScreen {...p<'Activity'>()} /> },
  {
    route: 'Transaction',
    screen: 'TransactionScreen',
    /* An id that is not in the history, which is what a deep link or a
     * restored navigation state hands this screen after the transaction it
     * named has been forgotten. */
    draw: (p) => <TransactionScreen {...p<'Transaction'>({ id: 'not-in-the-history' })} />,
  },
  { route: 'Asset', screen: 'AssetScreen', draw: (p) => <AssetScreen {...p<'Asset'>({ asset: 'XMR' })} /> },
  { route: 'Accounts', screen: 'AccountsScreen', draw: (p) => <AccountsScreen {...p<'Accounts'>()} /> },
  { route: 'Vault', screen: 'VaultScreen', draw: (p) => <VaultScreen {...p<'Vault'>()} /> },
  { route: 'Security', screen: 'SecurityScreen', draw: (p) => <SecurityScreen {...p<'Security'>()} /> },
  { route: 'Receive', screen: 'ReceiveScreen', draw: (p) => <ReceiveScreen {...p<'Receive'>()} /> },
  { route: 'Send', screen: 'SendScreen', draw: (p) => <SendScreen {...p<'Send'>()} /> },
  { route: 'Swap', screen: 'SwapScreen', draw: (p) => <SwapScreen {...p<'Swap'>()} /> },
  {
    route: 'CoinPicker',
    screen: 'CoinPickerScreen',
    draw: (p) => <CoinPickerScreen {...p<'CoinPicker'>({ side: 'to', selected: 'xmr', exclude: 'btc' })} />,
  },
  {
    route: 'SwapDeposit',
    screen: 'SwapDepositScreen',
    draw: (p) => (
      <SwapDepositScreen
        {...p<'SwapDeposit'>({
          fromId: 'btc',
          address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
          extra: null,
          amount: 0.01,
          provider: 'Trocador',
          orderId: 'order-1',
        })}
      />
    ),
  },
  { route: 'SwapStatus', screen: 'SwapStatusScreen', draw: (p) => <SwapStatusScreen {...p<'SwapStatus'>()} /> },
  { route: 'Nodes', screen: 'NodesScreen', draw: (p) => <NodesScreen {...p<'Nodes'>()} /> },
  { route: 'KeyImages', screen: 'KeyImagesScreen', draw: (p) => <KeyImagesScreen {...p<'KeyImages'>()} /> },
  { route: 'MoneroFile', screen: 'MoneroFileScreen', draw: (p) => <MoneroFileScreen {...p<'MoneroFile'>()} /> },
  { route: 'Scan', screen: 'ScanScreen', draw: (p) => <ScanScreen {...p<'Scan'>({ purpose: 'wire' })} /> },
  { route: 'Pair', screen: 'PairScreen', draw: (p) => <PairScreen {...p<'Pair'>()} /> },
  { route: 'CreateWallet', screen: 'CreateWalletScreen', draw: (p) => <CreateWalletScreen {...p<'CreateWallet'>()} /> },
  { route: 'Backup', screen: 'BackupScreen', draw: (p) => <BackupScreen {...p<'Backup'>()} /> },
  { route: 'Restore', screen: 'RestoreScreen', draw: (p) => <RestoreScreen {...p<'Restore'>()} /> },
];

beforeEach(() => {
  resetNative();
});

describe('a wallet with nothing in it draws every screen', () => {
  for (const { route, draw } of SCREENS) {
    it(`${route} renders, says something, and offers a way on`, async () => {
      const { props } = navigator();
      const ui = mount(<StoreProvider>{draw(props)}</StoreProvider>);
      await ui.settle();

      /* A screen that renders nothing is a screen that threw somewhere React
       * swallowed it, or an empty state nobody wrote. Both are bugs and both
       * look identical from outside, which is why the number is a sentence's
       * worth rather than zero. */
      expect(ui.text().length, `${route} drew nothing a person could read`).toBeGreaterThan(20);

      /* Every screen is a dead end without one. Onboarding is the exception
       * and it is not an exception to this rule: it has its own controls. */
      expect(ui.controls().length, `${route} has nothing to press, so it cannot be left`).toBeGreaterThan(0);

      ui.unmount();
    });
  }
});

describe('the screens this file mounts are the screens the application registers', () => {
  it('covers every Stack.Screen in App.tsx', () => {
    const app = readFileSync('App.tsx', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const registered = [...app.matchAll(/<Stack\.Screen\s+name="(\w+)"\s+component=\{(\w+)\}/g)].map(
      (found) => ({ route: found[1]!, screen: found[2]! }),
    );

    expect(registered.length, 'no screens found in App.tsx, so this guard is checking nothing').toBeGreaterThan(
      15,
    );

    const mounted = new Set(SCREENS.map((entry) => `${entry.route}:${entry.screen}`));
    const missing = registered.filter((entry) => !mounted.has(`${entry.route}:${entry.screen}`));
    expect(missing, 'App.tsx registers these and nothing in this file mounts them').toEqual([]);

    const names = new Set(registered.map((entry) => entry.route));
    const stale = SCREENS.filter((entry) => !names.has(entry.route)).map((entry) => entry.route);
    expect(stale, 'this file mounts these and App.tsx does not register them').toEqual([]);
  });
});
