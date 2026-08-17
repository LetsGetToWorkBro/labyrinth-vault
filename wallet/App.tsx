/**
 * The application, and the shape of its navigation.
 *
 * A native stack, not a tab bar. Tabs are for peer destinations you move
 * between all day; this wallet has one place you look at (home) and a handful
 * of things you go and do, each of which ends by coming back. A tab bar would
 * also spend 83 points of a dark screen on chrome that is lit at all times,
 * which is exactly the wrong trade on the one screen that gets held up to a
 * camera.
 *
 * The three flows that are *tasks* rather than places — send, receive, scan —
 * are modal, with the iOS sheet presentation and its dismissal gesture. That
 * is not decoration: it is the platform's way of saying "you are in the middle
 * of something", and the send flow is the longest something in the product.
 *
 * Header rendering is off throughout. Each screen draws its own, because a
 * wordmark, a status line and a large title are not what a navigation bar is
 * for, and a blurred bar sliding over the top of a QR code helps nobody.
 *
 * ## Why the navigator waits
 *
 * `initialRouteName` is read once, when the navigator first mounts, and it was
 * the constant `Onboarding`. Nothing persisted said the intro had been seen,
 * so a person with a paired vault and a wallet on this phone was walked
 * through the four panels on every cold launch, forever.
 *
 * The route is chosen from whether anything is being watched, which is the
 * question onboarding exists to answer, so nothing new has to be stored and
 * kept in step. That means the choice cannot be made until the store has read
 * what is on disk: mounting first and correcting afterwards would show the
 * intro for a frame to everybody. Hence `Ready`, which draws the void the
 * launch screen was already drawing and nothing else.
 *
 * The keychain read for a wallet on this phone settles on its own schedule, so
 * `OnboardingScreen` carries the other half of this: it leaves for Home if
 * accounts turn up under it.
 */

import { View } from 'react-native';
import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from './src/state/store';
import { watchingNothing } from './src/core/accounts';
import { HomeScreen } from './src/screens/Home';
import { ActivityScreen, TransactionScreen } from './src/screens/Activity';
import { AssetScreen } from './src/screens/Asset';
import { ReceiveScreen } from './src/screens/Receive';
import { SwapScreen } from './src/screens/Swap';
import { CoinPickerScreen } from './src/screens/CoinPicker';
import { SwapDepositScreen } from './src/screens/SwapDeposit';
import { SwapStatusScreen } from './src/screens/SwapStatus';
import { NodesScreen } from './src/screens/Nodes';
import { KeyImagesScreen } from './src/screens/KeyImages';
import { MoneroFileScreen } from './src/screens/MoneroFile';
import { SendScreen } from './src/screens/Send';
import { ScanScreen } from './src/screens/Scan';
import { PairScreen, SecurityScreen, VaultScreen } from './src/screens/Vault';
import { AccountsScreen } from './src/screens/Accounts';
import { BackupScreen, CreateWalletScreen } from './src/screens/Backup';
import { RestoreScreen } from './src/screens/Restore';
import { OnboardingScreen } from './src/screens/Onboarding';
import { color } from './src/design/tokens';
import type { Routes } from './src/nav/routes';

const Stack = createNativeStackNavigator<Routes>();

/** The navigator's own colors, so the space behind a sheet mid-transition is
 *  the same near-black as everything else rather than the system's gray. */
const theme: Theme = {
  dark: true,
  colors: {
    primary: color.bone,
    background: color.void,
    card: color.void,
    text: color.bone,
    border: color.rule,
    notification: color.warn,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '600' },
    heavy: { fontFamily: 'System', fontWeight: '700' },
  },
};

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.void }}>
      <SafeAreaProvider>
        <StoreProvider>
          <Ready />
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The navigator, once there is something to decide its first route with.
 *
 * Inside the provider rather than around it, because the decision is a
 * question about what was stored and only the store can answer it.
 */
function Ready() {
  const { restored, accounts } = useStore();

  /* The same near-black the launch screen draws, so waiting is invisible
   * rather than a flash of something else. */
  if (!restored) return <View style={{ flex: 1, backgroundColor: color.void }} />;

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        initialRouteName={watchingNothing(accounts) ? 'Onboarding' : 'Home'}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.void },
          animation: 'slide_from_right',
          gestureEnabled: true,
        }}
      >
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ animation: 'fade' }} />
        <Stack.Screen name="Home" component={HomeScreen} options={{ animation: 'fade' }} />
        <Stack.Screen name="Activity" component={ActivityScreen} />
        <Stack.Screen name="Transaction" component={TransactionScreen} />
        <Stack.Screen name="Asset" component={AssetScreen} />
        <Stack.Screen name="Accounts" component={AccountsScreen} />
        <Stack.Screen name="Vault" component={VaultScreen} />
        <Stack.Screen name="Security" component={SecurityScreen} />

        <Stack.Group screenOptions={{ presentation: 'modal', animation: 'slide_from_bottom' }}>
          <Stack.Screen name="Receive" component={ReceiveScreen} />
          <Stack.Screen name="Send" component={SendScreen} />
          <Stack.Screen name="Swap" component={SwapScreen} />
          <Stack.Screen name="CoinPicker" component={CoinPickerScreen} />
          <Stack.Screen name="SwapDeposit" component={SwapDepositScreen} />
          <Stack.Screen name="SwapStatus" component={SwapStatusScreen} />
          <Stack.Screen name="Nodes" component={NodesScreen} />
          <Stack.Screen name="KeyImages" component={KeyImagesScreen} />
          <Stack.Screen name="MoneroFile" component={MoneroFileScreen} />
          <Stack.Screen name="Scan" component={ScanScreen} />
          <Stack.Screen name="Pair" component={PairScreen} />
          <Stack.Screen name="CreateWallet" component={CreateWalletScreen} />
          <Stack.Screen name="Backup" component={BackupScreen} />
          <Stack.Screen name="Restore" component={RestoreScreen} />
        </Stack.Group>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
