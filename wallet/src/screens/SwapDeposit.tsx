/**
 * Where to send the coin, once an exchange has taken the order.
 *
 * ## Why this screen changes what the wallet can trade
 *
 * A swap used to be limited to sending Bitcoin or Monero, because the wallet
 * built and broadcast the deposit payment itself and it can only do that for a
 * chain it watches. That was a limit of the *implementation* presented as a
 * limit of the product.
 *
 * An exchange does not care who pays. It quotes a rate, gives out an address,
 * and swaps whatever arrives at it. So the deposit is a payment somebody
 * makes, from wherever they keep that coin, and this screen is the whole of
 * what they need to make it. That lifts the sending side from two coins to
 * twenty-four without a single new chain being watched.
 *
 * Paying from this wallet stays available and stays preferred where it can be:
 * for Bitcoin and Monero it is one tap, the amount is filled in exactly, and
 * the airgap review happens on the vault as usual. It is now an offer rather
 * than a requirement.
 *
 * ## The address is the whole screen
 *
 * One wrong character and the money goes to nobody. So the address is set in
 * groups of four with the contrast alternating between them, which is the
 * affordance that lets an eye leave the screen and come back to the right
 * place. Phone numbers and card numbers both arrived at four; it is small
 * enough to hold between one glance and the next.
 *
 * `chunkAddress` never pads a short final group, because a padded group is
 * characters the address does not have, on the one screen where invented
 * characters are least welcome.
 *
 * ## The exact amount
 *
 * Exchanges price a range and refuse or re-rate what falls outside it, so
 * "about right" is how somebody gets a worse rate or a returned deposit. The
 * amount is stated with the word exactly, given its own field, and copyable on
 * its own, because retyping a number is where a digit gets dropped.
 */

import { useState } from 'react';
import { Share, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Action, ActionRow, Gap, Notice, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { QrCanvas } from '../qr/QrCanvas';
import { CheckIcon, CopyIcon, OutIcon } from '../components/icons';
import { assetColor, color, radius, space } from '../design/tokens';
import { chunkAddress } from '../core/coinpick';
import { chainName, swapCoin } from '../core/swap';
import { useStore } from '../state/store';
import type { Asset } from '../core/model';
import type { Nav } from '../nav/routes';

export function SwapDepositScreen({ navigation, route }: Nav<'SwapDeposit'>) {
  const { fromId, address, extra, amount, provider, orderId } = route.params;
  const store = useStore();
  const coin = swapCoin(fromId);

  const [copied, setCopied] = useState<'address' | 'amount' | 'extra' | null>(null);
  const mark = (what: 'address' | 'amount' | 'extra', text: string) => {
    void Clipboard.setStringAsync(text);
    setCopied(what);
  };

  if (!coin) {
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="SWAP" onBack={() => navigation.goBack()} />
        <View style={{ paddingHorizontal: space.gutter }}>
          <Notice title="THIS BUILD DOES NOT KNOW THAT COIN" tone="alarm">
            <Body>
              The order exists at the exchange under id {orderId}. Nothing here can act on it, so
              use that id with {provider} directly.
            </Body>
          </Notice>
        </View>
      </Screen>
    );
  }

  const tone = coin.ours ? assetColor(coin.ours) : color.bone;
  const groups = chunkAddress(address);
  /* Only for a coin this wallet watches. Everything else is paid from wherever
   * the person keeps it, which is the point of the screen. */
  const canPayHere = coin.ours !== null;

  return (
    <Screen>
      <StatusBar style="light" />
      <Header
        onBack={() => navigation.goBack()}
        overline="SEND THE DEPOSIT"
        title={`Pay ${coin.label}`}
      />

      <View style={{ paddingHorizontal: space.gutter }}>
        {/* ------------------------------------------------ the exact amount */}
        <LabelWide>SEND EXACTLY</LabelWide>
        <Gap size={space.snug} />
        <Press onPress={() => mark('amount', String(amount))}>
          <View style={[styles.field, { borderColor: tone }]}>
            <Mono size={22} tone={color.bone}>{String(amount)}</Mono>
            <View style={{ flex: 1 }} />
            <Label tone={tone}>{coin.ticker.toUpperCase()}</Label>
            {copied === 'amount' ? (
              <CheckIcon size={16} tone={color.good} />
            ) : (
              <CopyIcon size={16} />
            )}
          </View>
        </Press>
        <Gap size={space.snug} />
        <Small tone={color.dim}>
          Exchanges quote a range and re-rate or return what falls outside it, so a near-enough
          amount costs money rather than time.
        </Small>

        <Gap size={space.section} />

        {/* -------------------------------------------------------- the chain */}
        <Notice title={`THIS ADDRESS IS ON ${chainName(coin.chain).toUpperCase()}`} tone="warn">
          <Body>
            {coin.label} and nothing else. Sending the same ticker on a different chain reaches an
            address that exists and belongs to nobody, and no exchange can return it.
          </Body>
        </Notice>

        <Gap size={space.section} />

        {/* ----------------------------------------------------------- the QR */}
        <View style={{ alignItems: 'center' }}>
          <View style={styles.code}>
            <QrCanvas value={address} size={260} level="Q" />
          </View>
        </View>

        <Gap size={space.gap} />

        {/* ------------------------------------------------------ the address */}
        <LabelWide>DEPOSIT ADDRESS</LabelWide>
        <Gap size={space.snug} />
        <View style={styles.address}>
          {groups.map((group, index) => (
            /* Alternating contrast rather than a separator character: the eye
               needs somewhere to land coming back, and a separator would be
               characters that are not in the address. */
            <Mono
              key={`${index}:${group}`}
              size={15}
              tone={index % 2 === 0 ? color.bone : color.ash}
            >
              {group}
            </Mono>
          ))}
        </View>

        {extra ? (
          <>
            <Gap size={space.gap} />
            <Notice title="THIS CHAIN NEEDS A MEMO" tone="alarm">
              <Body>
                A deposit sent without it arrives and cannot be matched to this order. Send it in
                the same transaction, in the field your wallet calls memo, tag or extra id.
              </Body>
              <Gap size={space.snug} />
              <Press onPress={() => mark('extra', extra)}>
                <View style={[styles.field, { borderColor: color.alarm }]}>
                  <Mono size={16} tone={color.bone}>{extra}</Mono>
                  <View style={{ flex: 1 }} />
                  {copied === 'extra' ? <CheckIcon size={16} tone={color.good} /> : <CopyIcon size={16} />}
                </View>
              </Press>
            </Notice>
          </>
        ) : null}

        <Gap size={space.gap} />
        <ActionRow>
          <View style={{ flex: 1 }}>
            <Press onPress={() => mark('address', address)}>
              <View style={styles.cell}>
                {copied === 'address' ? (
                  <CheckIcon size={18} tone={color.good} />
                ) : (
                  <CopyIcon size={18} />
                )}
                <Label tone={copied === 'address' ? color.good : color.bone}>
                  {copied === 'address' ? 'COPIED' : 'COPY'}
                </Label>
              </View>
            </Press>
          </View>
          <View style={{ flex: 1 }}>
            <Press onPress={() => void Share.share({ message: address })}>
              <View style={styles.cell}>
                <OutIcon size={18} />
                <Label>SHARE</Label>
              </View>
            </Press>
          </View>
        </ActionRow>

        <Gap size={space.section} />
        <Rule />
        <Gap size={space.section} />

        {/* --------------------------------------------------- how to pay it */}
        {canPayHere ? (
          <>
            <Strong>Pay it from this wallet</Strong>
            <Gap size={space.snug} />
            <Body>
              This wallet watches {coin.label}, so it can build the deposit itself with the amount
              filled in exactly. Your vault reviews and signs it the way it reviews any payment.
            </Body>
            <Gap size={space.step} />
            <Action
              label="PAY FROM THIS WALLET"
              onPress={() => {
                store.setAsset(coin.ours as Asset);
                navigation.navigate('Send');
              }}
            />
            <Gap size={space.step} />
            <Small tone={color.dim}>
              Or pay it from anywhere else using the address above. The exchange swaps whatever
              arrives and does not care who sent it.
            </Small>
          </>
        ) : (
          <>
            <Strong>Pay it from wherever you keep {coin.ticker.toUpperCase()}</Strong>
            <Gap size={space.snug} />
            <Body>
              This wallet does not watch {chainName(coin.chain)}, and it does not need to. The
              exchange swaps whatever arrives at that address, so any wallet or exchange account
              holding {coin.label} can send it.
            </Body>
            <Gap size={space.step} />
            <Small tone={color.dim}>
              Nothing about this order is secret. The address and the amount can be sent to
              yourself, read off another screen, or typed by hand.
            </Small>
          </>
        )}

        <Gap size={space.section} />
        <Action
          label="I HAVE SENT IT"
          quiet
          onPress={() => navigation.navigate('SwapStatus')}
        />
        <Gap size={space.step} />
        <Small tone={color.dim}>
          Nothing here watches for the deposit. Tapping that opens the order so this wallet can ask
          the exchange what it has seen, which is the only way it ever finds out.
        </Small>

        <Gap size={space.chapter} />
      </View>
    </Screen>
  );
}

const styles = {
  field: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.step,
    backgroundColor: color.well,
    borderWidth: 1,
    borderRadius: radius.soft,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  code: {
    backgroundColor: color.codeLight,
    borderRadius: radius.code,
    padding: space.gap,
  },
  address: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    columnGap: 10,
    rowGap: 4,
    backgroundColor: color.well,
    borderWidth: 1,
    borderColor: color.rule,
    borderRadius: radius.soft,
    padding: space.step,
  },
  cell: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: space.snug,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.rule,
    borderRadius: radius.soft,
    paddingVertical: 14,
  },
};
