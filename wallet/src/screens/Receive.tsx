/**
 * Receiving, which is the one thing this half can do entirely on its own.
 *
 * Worth saying out loud on the screen, and it is: an address is public
 * information derived from a public key, so a wallet with no keys in it can
 * hand one out all day. That asymmetry — receive works offline from the vault,
 * spend does not — is the clearest illustration of the architecture anywhere
 * in the product, and this screen is where a person meets it without being
 * lectured.
 *
 * The QR is large, white, and the calmest thing in the application. No
 * countdown, no expiry, no "waiting for payment" spinner: an address does not
 * expire and the wallet cannot tell you a payment is coming.
 *
 * VERIFY is not decoration either. It shows the derivation path beside the
 * address, which is what a person needs to check the same address on the
 * vault's screen — the vault can re-derive `0/4` and show it, and if the two
 * disagree, this device is lying about where to send money.
 */

import { useMemo, useState } from 'react';
import { ScrollView, Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { Action, ActionRow, Chip, Gap, Notice, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Mono } from '../design/text';
import { Header } from '../components/chrome';
import { AddressBlock } from '../components/money';
import { QrCanvas } from '../qr/QrCanvas';
import { CopyIcon, OutIcon, CheckIcon } from '../components/icons';
import { assetColor, color, space } from '../design/tokens';
import { confirmed } from '../design/haptics';
import { useStore } from '../state/store';
import type { Asset } from '../core/model';
import type { Nav } from '../nav/routes';

export function ReceiveScreen({ navigation, route }: Nav<'Receive'>) {
  const store = useStore();
  const [asset, setAsset] = useState<Asset>(route.params?.asset ?? 'BTC');
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  /* One address per visit, not one per render: a screen that re-derives on
   * every state change hands out a different address every time somebody taps
   * a chip, and the gap limit is a real thing on the other side. */
  const address = useMemo(() => store.snapshot.assets[asset].addresses.find((entry) => !entry.used)
    ?? store.snapshot.assets[asset].addresses[0]!, [store.snapshot, asset]);

  const copy = async () => {
    await Clipboard.setStringAsync(address.address);
    confirmed();
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline="RECEIVE"
          title={asset === 'BTC' ? 'Bitcoin' : 'Monero'}
          right={
            <View style={{ flexDirection: 'row', gap: space.snug }}>
              {(['BTC', 'XMR'] as const).map((which) => (
                <Chip
                  key={which}
                  tone={which === asset ? color.void : color.slate}
                  fill={which === asset ? assetColor(which) : 'transparent'}
                  onPress={() => setAsset(which)}
                >
                  {which}
                </Chip>
              ))}
            </View>
          }
        />

        <Gap size={space.section} />
        <View style={{ alignItems: 'center' }}>
          <QrCanvas value={uriFor(asset, address.address)} size={300} level="Q" />
        </View>

        <Gap size={space.section} />
        <View style={{ paddingHorizontal: space.gutter }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.step }}>
            <Label>YOUR ADDRESS</Label>
            <View style={{ flex: 1 }} />
            <Chip tone={color.slate}>WATCH-ONLY</Chip>
          </View>
          <AddressBlock address={address.address} />

          <Gap size={space.gap} />
          <ActionRow>
            <View style={{ flex: 1 }}>
              <Press onPress={copy}>
                <View style={cellStyle}>
                  {copied ? <CheckIcon size={18} tone={color.good} /> : <CopyIcon size={18} />}
                  <Label tone={copied ? color.good : color.bone}>{copied ? 'COPIED' : 'COPY'}</Label>
                </View>
              </Press>
            </View>
            <View style={{ flex: 1 }}>
              <Press onPress={() => void Share.share({ message: address.address })}>
                <View style={cellStyle}>
                  <OutIcon size={18} />
                  <Label>SHARE</Label>
                </View>
              </Press>
            </View>
            <View style={{ flex: 1 }}>
              <Press onPress={() => setVerifying((current) => !current)}>
                <View style={cellStyle}>
                  <CheckIcon size={18} tone={verifying ? color.good : color.bone} />
                  <Label tone={verifying ? color.good : color.bone}>VERIFY</Label>
                </View>
              </Press>
            </View>
          </ActionRow>

          {verifying ? (
            <>
              <Gap size={space.gap} />
              <Rule />
              <Gap size={space.gap} />
              <Label style={{ marginBottom: 6 }}>DERIVATION</Label>
              <Mono size={14} tone={color.bone}>
                {asset === 'BTC' ? `m/84'/0'/0'/${address.path ?? '0/0'}` : 'primary address'}
              </Mono>
              <Gap size={space.step} />
              <Body>
                Ask your vault to show the address at this path. It derives it from the keys it holds; this
                wallet derives it from a public key. If the two screens disagree, do not use this address.
                One of the two devices is not showing you the truth.
              </Body>
            </>
          ) : null}

          <Gap size={space.section} />
          <Notice title="PRIVATE KEYS NEVER ENTER THIS DEVICE">
            This address was derived from a public key your vault exported. Anything sent to it can only be
            spent with a signature from the vault, which is the half that has never been online.
          </Notice>

          <Gap size={space.section} />
          <Action label="DONE" quiet onPress={() => navigation.goBack()} />
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

/** A payment URI, which is what most senders expect a receive code to be. */
function uriFor(asset: Asset, address: string): string {
  return `${asset === 'BTC' ? 'bitcoin' : 'monero'}:${address}`;
}

const cellStyle = {
  height: 72,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: space.snug,
  borderRadius: 14,
  borderWidth: 1,
  borderColor: color.rule,
  backgroundColor: color.surface,
};
