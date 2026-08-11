/**
 * Swapping, and the screen's job of saying what nothing else can check.
 *
 * Every other payment in this app ends at the vault's confirmation screen: a
 * person reads a destination on a second device and approves it. A swap has an
 * address in it that is in no transaction, so it reaches no confirmation
 * screen, and the vault cannot help. That is the payout address, and this
 * screen is built around it. See `core/swap.ts` for the argument in full.
 *
 * Three things follow, and they are the whole design of this screen.
 *
 * **The payout address is shown as derived, not as entered.** When the coin
 * coming back is one this wallet watches, there is no field. The address is
 * displayed with the words that say where it came from, because a field would
 * invite somebody to paste, and a pasted payout address is the attack.
 *
 * **The unchecked case is labeled as unchecked.** Swapping into a coin this
 * wallet does not hold means typing an address that neither device can verify.
 * That is allowed, and it is marked, in the same tone the rest of the app uses
 * for a thing it cannot promise.
 *
 * **The deposit is an ordinary payment.** Once an order is verified, this
 * screen hands off to the send flow and gets out of the way. Same compose,
 * same prepare, same vault, same confirmation. A swap does not get a private
 * road to a signature, because the deposit address is the one part of a swap
 * the vault *can* check and it must not be routed around.
 *
 * The privacy line at the top is not a first-run dialog. It costs the same on
 * the hundredth swap as on the first, so it is shown every time.
 */

import { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, ActionRow, Chip, Gap, Notice, Panel, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Mono, Small, Title } from '../design/text';
import { Header } from '../components/chrome';
import { assetColor, color, space } from '../design/tokens';
import { confirmed, refused } from '../design/haptics';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';
import type { Asset } from '../core/model';
import {
  OUR_COINS,
  PRIVACY_NOTE,
  PROVIDERS,
  SWAP_COINS,
  addressHint,
  buildRequest,
  createOrder,
  parsePair,
  quoteAll,
  swapCoin,
  type ProviderId,
  type SwapCoin,
  type SwapQuote,
} from '../core/swap';

type Phase = 'compose' | 'quoting' | 'quoted' | 'creating' | 'refused';

export function SwapScreen({ navigation }: Nav<'Swap'>) {
  const store = useStore();

  const [fromId, setFromId] = useState('btc');
  const [toId, setToId] = useState('xmr');
  const [amount, setAmount] = useState('0.05');
  const [typedPayout, setTypedPayout] = useState('');
  const [phase, setPhase] = useState<Phase>('compose');
  const [quotes, setQuotes] = useState<SwapQuote[]>([]);
  const [chosen, setChosen] = useState<ProviderId>('exolix');
  /** A refusal: the problem in words, and what was actually seen. */
  const [refusal, setRefusal] = useState<{ problem: string; detail: string } | null>(null);

  const from = swapCoin(fromId)!;
  const to = swapCoin(toId)!;

  /* Everything the destination picker may offer: anything but the coin being
   * sent. `parsePair` is the authority on what is allowed; this only keeps the
   * obviously-wrong option off the screen. */
  const destinations = useMemo(() => SWAP_COINS.filter((coin) => coin.id !== fromId), [fromId]);

  const pair = parsePair(fromId, toId);
  const request = pair.ok
    ? buildRequest({
        provider: chosen,
        pair: pair.pair,
        amount: Number(amount),
        own: store.own,
        typedPayout,
      })
    : ({ ok: false, problem: pair.problem } as const);

  const best = quotes.find((quote) => quote.provider === chosen && quote.ok);
  const creating = phase === 'creating';

  async function getQuotes() {
    if (!pair.ok) return;
    setPhase('quoting');
    setQuotes(await quoteAll(store.swapTransport, pair.pair, Number(amount)));
    setPhase('quoted');
  }

  async function create() {
    if (!request.ok || !best?.toAmount) return;
    setPhase('creating');
    const result = await createOrder(store.swapTransport, request.request, best.toAmount);
    if (!result.ok) {
      /* Terminal, and terminal here means there is nothing to show. A refused
       * order carries no deposit address, so there is no address on this
       * screen to send coins to even by accident. */
      refused();
      setRefusal({ problem: result.problem, detail: result.detail });
      setPhase('refused');
      return;
    }
    confirmed();
    store.depositForSwap(result.order, from.ours as Asset);
    navigation.navigate('Send');
  }

  if (phase === 'refused' && refusal) {
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="SWAP REFUSED" onBack={() => { setRefusal(null); setPhase('quoted'); }} />
        <ScrollView contentContainerStyle={{ padding: space.gutter }}>
          <Notice title="NO ORDER WAS CREATED" tone="alarm">
            {refusal.problem}
          </Notice>
          <Gap />
          <Body>
            The exchange answered with something that does not match what it was
            asked for. There is no deposit address on this screen because there
            is no order: nothing was sent and nothing can be.
          </Body>
          <Gap />
          <Label>WHAT WAS SEEN</Label>
          <Mono size={12}>{refusal.detail}</Mono>
          <Gap />
          <Body>
            This is worth reporting either way. An exchange with a bug and an
            exchange being interfered with look identical from here, which is
            why the answer to both is the same.
          </Body>
          <Gap />
          <ActionRow>
            <Action label="START OVER" onPress={() => { setRefusal(null); setPhase('compose'); }} />
          </ActionRow>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <StatusBar style="light" />
      <Header title="SWAP" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: space.gutter }}>
        <Notice title="AN EXCHANGE WILL SEE THIS" tone="warn">
          {PRIVACY_NOTE}
        </Notice>
        <Gap />

        <Label>SENDING</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {OUR_COINS.map((coin) => (
            <Chip
              key={coin.id}
              onPress={() => { setFromId(coin.id); setPhase('compose'); }}
              tone={fromId === coin.id ? color.void : color.slate}
              fill={fromId === coin.id ? assetColor(coin.ours as Asset) : 'transparent'}
            >
              {coin.label.toUpperCase()}
            </Chip>
          ))}
        </View>

        <Gap />
        <Label>RECEIVING</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {destinations.map((coin) => (
            <Chip
              key={coin.id}
              onPress={() => { setToId(coin.id); setPhase('compose'); }}
              tone={toId === coin.id ? color.void : color.slate}
              fill={toId === coin.id ? color.bone : 'transparent'}
            >
              {coin.label.toUpperCase()}
            </Chip>
          ))}
        </View>

        <Gap />
        <Rule />
        <Gap />

        <PayoutBlock to={to} typed={typedPayout} onType={setTypedPayout} derived={store.own.receive(to.ours as Asset)} />

        <Gap />
        <Rule />
        <Gap />

        <Label>AMOUNT</Label>
        <Panel>
          <Mono size={22}>{amount} {from.ticker.toUpperCase()}</Mono>
        </Panel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {['0.01', '0.05', '0.1', '0.25'].map((step) => (
            <Chip key={step} onPress={() => { setAmount(step); setPhase('compose'); }}>{step}</Chip>
          ))}
        </View>

        <Gap />
        {phase === 'quoted' || phase === 'creating' ? (
          <>
            <Label>QUOTES</Label>
            {quotes.map((quote) => {
              const label = PROVIDERS.find((p) => p.id === quote.provider)!;
              return (
                <Press key={quote.provider} onPress={() => setChosen(quote.provider)}>
                  <Panel>
                    <Title>{label.label.toUpperCase()}</Title>
                    {quote.ok ? (
                      <Mono>{quote.toAmount} {to.ticker.toUpperCase()}</Mono>
                    ) : (
                      <Small>{quote.reason}</Small>
                    )}
                    {quote.provider === chosen ? <Label tone={color.bone}>SELECTED</Label> : null}
                  </Panel>
                </Press>
              );
            })}
            <Gap />
            <Small>
              An estimate. The rate is fixed when the order is created, not now,
              and every provider here trades at a floating rate.
            </Small>
          </>
        ) : null}

        {!request.ok ? (
          <>
            <Gap />
            <Notice tone="plain">{request.problem}</Notice>
          </>
        ) : null}

        <Gap />
        <ActionRow>
          {phase === 'quoted' && best ? (
            <Action
              label={creating ? 'CREATING' : 'CREATE ORDER'}
              detail="the deposit goes through the vault like any other payment"
              disabled={!request.ok || creating}
              onPress={create}
            />
          ) : (
            <Action
              label={phase === 'quoting' ? 'ASKING' : 'GET QUOTES'}
              disabled={!pair.ok || phase === 'quoting'}
              onPress={getQuotes}
            />
          )}
        </ActionRow>

        <Gap />
        <Notice title="DEMO DATA" tone="plain">
          There is no network client in this build, so the quotes above come
          from a fixture. It answers in the shape a real exchange answers in,
          so the checks around it are the real ones.
        </Notice>
      </ScrollView>
    </Screen>
  );
}

/**
 * Where the bought coin goes, and how it got there.
 *
 * Two completely different presentations, because they carry two completely
 * different guarantees and a screen that showed them the same way would be
 * lying by layout.
 */
function PayoutBlock({
  to,
  derived,
  typed,
  onType,
}: {
  to: SwapCoin;
  derived: string | null;
  typed: string;
  onType: (value: string) => void;
}) {
  if (to.ours !== null) {
    return (
      <>
        <Label>PAYING OUT TO</Label>
        <Panel>
          <Mono size={12}>{derived ?? 'no account paired'}</Mono>
        </Panel>
        <Gap size={8} />
        <Notice title="THIS ADDRESS IS YOURS" tone="good">
          Derived from the account key your vault handed over, not typed and not
          remembered. You can check it on the receive screen and on the vault,
          which derive it from the same key. There is no field here on purpose:
          a payout address is in no transaction, so no confirmation screen ever
          shows it, and a field is somewhere to paste an attacker's address.
        </Notice>
      </>
    );
  }

  return (
    <>
      <Label>PAYING OUT TO</Label>
      <Notice title="NOTHING CAN CHECK THIS ADDRESS" tone="warn">
        This wallet does not hold {to.label}, so the payout address is one you
        supply. It appears in no transaction, which means the vault never shows
        it and neither device can tell you it is right. Read it twice against
        wherever you copied it from.
      </Notice>
      <Gap size={8} />
      <TextInput
        value={typed}
        onChangeText={onType}
        placeholder={addressHint(to)}
        placeholderTextColor={color.slate}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={{
          fontFamily: 'monospace',
          fontSize: 12,
          color: color.bone,
          borderColor: color.rule,
          borderWidth: 1,
          padding: space.step,
        }}
      />
    </>
  );
}
