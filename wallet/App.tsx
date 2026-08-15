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
 */

import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider } from './src/state/store';
import { HomeScreen } from './src/screens/Home';
import { ActivityScreen, TransactionScreen } from './src/screens/Activity';
import { AssetScreen } from './src/screens/Asset';
import { ReceiveScreen } from './src/screens/Receive';
import { SwapScreen } from './src/screens/Swap';
import { SwapStatusScreen } from './src/screens/SwapStatus';
import { NodesScreen } from './src/screens/Nodes';
import { KeyImagesScreen } from './src/screens/KeyImages';
import { MoneroFileScreen } from './src/screens/MoneroFile';
import { SendScreen } from './src/screens/Send';
import { ScanScreen } from './src/screens/Scan';
import { PairScreen, SecurityScreen, VaultScreen } from './src/screens/Vault';
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
          <NavigationContainer theme={theme}>
            <Stack.Navigator
              initialRouteName="Onboarding"
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
              <Stack.Screen name="Vault" component={VaultScreen} />
              <Stack.Screen name="Security" component={SecurityScreen} />

              <Stack.Group screenOptions={{ presentation: 'modal', animation: 'slide_from_bottom' }}>
                <Stack.Screen name="Receive" component={ReceiveScreen} />
                <Stack.Screen name="Send" component={SendScreen} />
                <Stack.Screen name="Swap" component={SwapScreen} />
              <Stack.Screen name="SwapStatus" component={SwapStatusScreen} />
              <Stack.Screen name="Nodes" component={NodesScreen} />
              <Stack.Screen name="KeyImages" component={KeyImagesScreen} />
              <Stack.Screen name="MoneroFile" component={MoneroFileScreen} />
                <Stack.Screen name="Scan" component={ScanScreen} />
                <Stack.Screen name="Pair" component={PairScreen} />
              </Stack.Group>
            </Stack.Navigator>
          </NavigationContainer>
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
