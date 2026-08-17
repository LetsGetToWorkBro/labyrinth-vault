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
 *
 * ## Why there is an empty state at all
 *
 * There is no address until a refresh has walked the chain, and the app ships
 * with no node set, so the first-run sequence is: pair, tap RECEIVE, and get
 * here with nothing derived. This screen used to index the empty list and
 * dereference the result during render, which takes the whole tree down with
 * it, because there is no error boundary anywhere in this app. A first tap on
 * the most harmless screen in the product is the worst possible place for
 * that.
 *
 * The empty state names the cause rather than saying "no address yet",
 * because the two causes want different actions from a person: a chain this
 * account does not hold is a different problem from a node that was never
 * set, and neither is solved on this screen.
 *
 * ## Why the chips come from the account
 *
 * They used to be a hardcoded BTC and XMR defaulting to BTC. An account may
 * hold one chain: `accountsFrom` builds `chains` from what the pairing or the
 * record actually carries. Offering a chip for a chain this account has no key
 * for is offering an address that cannot exist.
 */

import { useMemo, useState, type ReactNode } from 'react';
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
import { NOTHING_WATCHED, signingNote, type Account } from '../core/accounts';
import type { Asset } from '../core/model';
import type { Nav } from '../nav/routes';

export function ReceiveScreen({ navigation, route }: Nav<'Receive'>) {
  const store = useStore();
  /* Which account this address belongs to. The wallet watches several and
   * shows one at a time, so an address on this screen is one account's
   * address and not the wallet's. See below for why that has to be on the
   * glass rather than inferable. */
  const account = store.accounts.find((entry) => entry.id === store.selectedAccount) ?? null;
  /* The chains this account actually holds, in the app's usual order. An
   * account is allowed to carry one: a pairing that only ever exported a
   * Monero view key has `chains: ['XMR']`, and a chip for the other one leads
   * to a screen that can never have an address on it. */
  const chains: Asset[] = account
    ? (['BTC', 'XMR'] as const).filter((which) => account.chains.includes(which))
    : ['BTC', 'XMR'];
  /* The requested chain only when this account has it. `Asset.tsx` routes here
   * with the chain a person was looking at, and looking at Bitcoin on a
   * Monero-only account is reachable through the chips there. */
  const wanted = route.params?.asset;
  const [asset, setAsset] = useState<Asset>(
    wanted && chains.includes(wanted) ? wanted : chains[0] ?? 'BTC',
  );
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  /* The first address the chain has not seen a payment to. Derived from the
   * snapshot rather than handed out by a counter, so it is the same address
   * every time this screen opens until somebody actually pays it. Rotating on
   * view would burn through the gap limit for people who like looking at their
   * own QR code.
   *
   * Null rather than an index assertion. The list is empty until a refresh
   * writes it, and `[0]!` here was a render-time throw with no error boundary
   * above it anywhere in this app. */
  const address = useMemo(() => {
    const derived = store.snapshot.assets[asset].addresses;
    return derived.find((entry) => !entry.used) ?? derived[0] ?? null;
  }, [store.snapshot, asset]);

  const copy = async () => {
    if (address === null) return;
    await Clipboard.setStringAsync(address.address);
    confirmed();
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const chips = (
    <View style={{ flexDirection: 'row', gap: space.snug }}>
      {chains.map((which) => (
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
  );

  if (address === null) {
    return (
      <Nothing
        account={account}
        asset={asset}
        chips={chips}
        nodeSet={asset === 'BTC' ? store.nodes.btc !== null : store.nodes.xmr !== null}
        onBack={() => navigation.goBack()}
        onNodes={() => navigation.navigate('Nodes')}
        onAccounts={() => navigation.navigate('Accounts')}
      />
    );
  }

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline={account ? `RECEIVE INTO ${account.label.toUpperCase()}` : 'RECEIVE'}
          title={asset === 'BTC' ? 'Bitcoin' : 'Monero'}
          right={chips}
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
            {/* A statement about custody, read from the account rather than
                from what this app used to be. It said WATCH-ONLY to everybody,
                fourteen lines above a row printing SIGNS ON THIS PHONE for the
                same account, and this is the screen somebody holds up while
                they are being paid. */}
            <Chip tone={account?.signsHere ? color.warn : color.slate}>
              {account?.signsHere ? 'KEYS ON THIS PHONE' : 'WATCH-ONLY'}
            </Chip>
          </View>
          <AddressBlock address={address.address} />

          {/* Said twice, above the QR and under the address, and that is not
              redundancy. This wallet holds more than one account now, and an
              address belongs to exactly one of them: money sent to this one
              lands in the account named here and nowhere else. Somebody who
              means to fund the wallet on this phone and pastes the vault's
              address has not lost anything, and has put it somewhere they
              cannot spend from without the other device.

              The same argument as the coin picker naming its chain on every
              row: the thing that decides where money ends up goes in the row,
              not behind a tap. */}
          {account !== null ? (
            <>
              <Gap size={space.step} />
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.snug }}>
                <Label tone={color.bone}>{account.label.toUpperCase()}</Label>
                <Label tone={account.signsHere ? color.warn : color.good}>{signingNote(account)}</Label>
                <View style={{ flex: 1 }} />
                {store.accounts.length > 1 ? (
                  <Press onPress={() => navigation.navigate('Accounts')}>
                    <Label tone={color.slate}>ANOTHER ACCOUNT</Label>
                  </Press>
                ) : null}
              </View>
            </>
          ) : null}

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
              {/* The read-across is only a check when a second device derived
                  the same path from a different secret. On an account this
                  phone signs for there is no second device, so offering the
                  vault ritual would be telling somebody to check one screen
                  against itself. What is left that is true is the words. */}
              <Body>
                {account?.signsHere
                  ? 'This came from the seed on this phone, so there is no second screen to check it ' +
                    'against. What checks it is the words: restore them into any wallet that reads ' +
                    'them and it will derive this same address.'
                  : 'Ask your vault to show the address at this path. It derives it from the keys it ' +
                    'holds; this wallet derives it from a public key. If the two screens disagree, do ' +
                    'not use this address. One of the two devices is not showing you the truth.'}
              </Body>
            </>
          ) : null}

          <Gap size={space.section} />
          {/* The loud closing statement, and the one that was false on every
              hot account. It is the last thing read on the screen a person
              holds up while they are being paid, so it says where the keys for
              this account are rather than where they are in the architecture
              this app was first written for. */}
          {account?.signsHere ? (
            <Notice tone="warn" title="THE KEYS FOR THIS ACCOUNT ARE ON THIS PHONE">
              This address was derived from a seed in this phone's keychain. Anything sent to it can be
              spent from here, behind Face ID, with no second device involved. Anything worth more than
              this phone belongs on an account your vault signs for.
            </Notice>
          ) : (
            <Notice title="PRIVATE KEYS NEVER ENTER THIS DEVICE">
              This address was derived from a public key your vault exported. Anything sent to it can only
              be spent with a signature from the vault, which is the half that has never been online.
            </Notice>
          )}

          <Gap size={space.section} />
          <Action label="DONE" quiet onPress={() => navigation.goBack()} />
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

/**
 * The screen with no address on it, saying which of the two reasons it is.
 *
 * Not one sentence for both. "No address yet" is true of a wallet waiting on
 * its first refresh and true of a Monero-only account being asked for a
 * Bitcoin address, and those want opposite things from a person: one is a node
 * away, the other is a different account or a different chain. A dead end that
 * cannot tell you which is the shape this app spends its refusals avoiding.
 */
function Nothing({
  account,
  asset,
  chips,
  nodeSet,
  onBack,
  onNodes,
  onAccounts,
}: {
  account: Account | null;
  asset: Asset;
  chips: ReactNode;
  nodeSet: boolean;
  onBack: () => void;
  onNodes: () => void;
  onAccounts: () => void;
}) {
  /* Named apart from `watchingNothing` in `core/accounts.ts`, which asks the
   * same question of the whole list. This one is about the selection, and two
   * names one letter apart for two different questions is how the wrong one
   * gets called. */
  const noAccount = account === null;
  const wrongChain = account !== null && !account.chains.includes(asset);
  const chain = asset === 'BTC' ? 'Bitcoin' : 'Monero';

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={onBack}
          overline={account ? `RECEIVE INTO ${account.label.toUpperCase()}` : 'RECEIVE'}
          title={`No ${chain} address yet`}
          right={noAccount ? undefined : chips}
        />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          {noAccount ? (
            <>
              <Notice tone="warn" title="NOTHING IS BEING WATCHED">
                {NOTHING_WATCHED}
              </Notice>
              <Gap size={space.section} />
              <Action label="ACCOUNTS" onPress={onAccounts} />
            </>
          ) : wrongChain ? (
            <>
              <Notice tone="warn" title={`THIS ACCOUNT HAS NO ${chain.toUpperCase()} KEY`}>
                {`${account.label} covers ${account.chains.join(' and ')}. An address has to be derived ` +
                  `from a key, so there is no ${chain} address to hand out here. Another account may hold ` +
                  'that chain.'}
              </Notice>
              <Gap size={space.section} />
              <Action label="ANOTHER ACCOUNT" onPress={onAccounts} />
            </>
          ) : nodeSet ? (
            <>
              <Notice tone="warn" title="NOTHING HAS COME BACK FROM THE NODE">
                {`A ${chain} node is set, and this wallet has not yet derived an address from it. Pull ` +
                  'down on the home screen to refresh. If that keeps failing, the node is the place to ' +
                  'look.'}
              </Notice>
              <Gap size={space.section} />
              <Action label="NODES" quiet onPress={onNodes} />
            </>
          ) : (
            <>
              <Notice tone="warn" title="NO NODE IS SET">
                {`This wallet reads the chain through a node you choose, and it never picks one for you. ` +
                  `Set a ${chain} node and it will derive your addresses on the next refresh.`}
              </Notice>
              <Gap size={space.section} />
              <Action label="SET A NODE" onPress={onNodes} />
            </>
          )}

          <Gap size={space.section} />
          <Action label="DONE" quiet onPress={onBack} />
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
