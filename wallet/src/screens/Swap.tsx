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
 *
 * ## The presentation
 *
 * Two halves of one instrument: what leaves, what arrives, and a single
 * control between them. The sent amount is set with the same readout treatment
 * as every amount in the application; the received amount is the provider's
 * own estimate, marked with the approximation it is, and it animates in when a
 * quote lands because a number that changed silently is a number nobody
 * noticed changing. The route list shows what each exchange actually answered,
 * word for word when the answer was no, and the one honest ranking this screen
 * can compute: which of the live quotes pays out the most. Nothing here shows
 * a fee, an arrival time, or a rating, because no provider in core/swap.ts
 * supplies one, and decorating a quote with invented reassurance is how swap
 * screens earn their reputation.
 */

import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Action, ActionRow, Chip, Dot, Gap, Notice, Panel, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Small, Strong, Mono } from '../design/text';
import { Header } from '../components/chrome';
import { Amount } from '../components/money';
import { SwapIcon } from '../components/icons';
import { assetColor, color, face, motion, radius, space, tabular, type } from '../design/tokens';
import { confirmed, refused, settled } from '../design/haptics';
import { parseAmount as parseAtoms } from '../core/units';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';
import type { Asset } from '../core/model';
import {
  OUR_COINS,
  PRIVACY_NOTE,
  PROVIDERS,
  SWAP_COINS,
  chainIsAmbiguous,
  chainName,
  confusableChains,
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

  /* The one honest ranking this screen can compute: of the quotes that
   * answered, which pays out the most. Shown only when there is a live
   * comparison to win; a single quote is not "best", it is the only one. */
  const live = quotes.filter((quote) => quote.ok && (quote.toAmount ?? 0) > 0);
  const bestPayoutProvider =
    live.length >= 2
      ? live.reduce((top, quote) => ((quote.toAmount ?? 0) > (top.toAmount ?? 0) ? quote : top)).provider
      : null;

  async function getQuotes() {
    if (!pair.ok) return;
    setPhase('quoting');
    setQuotes(await quoteAll(store.swapTransport, pair.pair, Number(amount)));
    /* Two soft beats: an answer landing, not an achievement. */
    settled();
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
    store.depositForSwap(result.order, from.ours as Asset, to.id);
    navigation.navigate('Send');
  }

  /* Reversing the trade is only meaningful when the coin coming back is one
   * this wallet holds, because a swap must start from one it can sign for.
   * The control disables rather than disappears: an affordance that vanishes
   * teaches nobody why. */
  const canFlip = to.ours !== null;
  const flipTurns = useSharedValue(0);
  function flip() {
    if (!canFlip) return;
    flipTurns.value = withSpring(flipTurns.value + 0.5, motion.standard);
    setFromId(toId);
    setToId(fromId);
    setPhase('compose');
  }
  const flipStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${flipTurns.value * 360}deg` }],
  }));

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
          <Gap size={space.section} />
          <Label style={{ marginBottom: space.snug }}>WHAT WAS SEEN</Label>
          <Panel tone={color.well} style={{ padding: space.gap }}>
            <Mono size={12}>{refusal.detail}</Mono>
          </Panel>
          <Gap />
          <Body>
            This is worth reporting either way. An exchange with a bug and an
            exchange being interfered with look identical from here, which is
            why the answer to both is the same.
          </Body>
          <Gap size={space.section} />
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
        {store.pendingSwap ? (
          <>
            <Press onPress={() => navigation.navigate('SwapStatus')}>
              <View style={styles.inflight}>
                <Dot state="working" tone={color.warn} />
                <View style={{ flex: 1 }}>
                  <Strong>Swap in flight</Strong>
                  <Small tone={color.slate}>
                    {PROVIDERS.find((p) => p.id === store.pendingSwap!.provider)!.label}
                    {' order '}
                    {store.pendingSwap.id}
                  </Small>
                </View>
                <Label tone={color.ash}>STATUS</Label>
              </View>
            </Press>
            <Gap size={space.gap} />
          </>
        ) : null}
        <Notice title="AN EXCHANGE WILL SEE THIS" tone="warn">
          {PRIVACY_NOTE}
        </Notice>
        <Gap size={space.section} />

        {/* ------------------------------------------------ the instrument */}

        <Label>YOU SEND</Label>
        <Gap size={space.snug} />
        <SendReadout amount={amount} asset={from.ours as Asset} />
        <Gap size={space.gap} />
        <CoinRow
          coins={OUR_COINS}
          selected={fromId}
          onSelect={(id) => { setFromId(id); setPhase('compose'); }}
        />
        <Gap size={space.step} />
        <View style={styles.presetRow}>
          {['0.01', '0.05', '0.1', '0.25'].map((step) => (
            <Chip
              key={step}
              onPress={() => { setAmount(step); setPhase('compose'); }}
              tone={amount === step ? color.bone : color.slate}
              fill={amount === step ? color.raised : 'transparent'}
            >
              {step}
            </Chip>
          ))}
        </View>

        <Gap size={space.section} />
        <View style={styles.divide}>
          <View style={{ flex: 1 }}><Rule /></View>
          <Press onPress={flip} disabled={!canFlip} scale={0.92}>
            <View style={styles.flip}>
              <Animated.View style={flipStyle}>
                <SwapIcon size={18} tone={canFlip ? color.bone : color.dim} />
              </Animated.View>
            </View>
          </Press>
          <View style={{ flex: 1 }}><Rule /></View>
        </View>
        <Gap size={space.section} />

        <Label>YOU RECEIVE</Label>
        <Gap size={space.snug} />
        <ReceiveReadout quote={best} to={to} phase={phase} />
        <Gap size={space.gap} />
        <CoinRow
          coins={destinations}
          selected={toId}
          onSelect={(id) => { setToId(id); setPhase('compose'); }}
          neutral
        />

        <Gap size={space.section} />
        <Rule />
        <Gap size={space.section} />

        <PayoutBlock to={to} typed={typedPayout} onType={setTypedPayout} derived={store.own.receive(to.ours as Asset)} />

        {phase === 'quoted' || phase === 'creating' ? (
          <>
            <Gap size={space.section} />
            <Rule />
            <Gap size={space.section} />
            <Label>AVAILABLE ROUTES</Label>
            <Gap size={space.step} />
            {quotes.map((quote, index) => (
              <RouteRow
                key={quote.provider}
                quote={quote}
                to={to}
                chosen={quote.provider === chosen}
                bestPayout={quote.provider === bestPayoutProvider}
                index={index}
                onPress={() => setChosen(quote.provider)}
              />
            ))}
            <Gap size={space.gap} />
            <QuoteFacts quote={best} from={from} to={to} amount={Number(amount)} />
            <Gap size={space.gap} />
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

        <Gap size={space.section} />
        {phase === 'quoted' && best ? (
          <View style={{ gap: space.snug }}>
            <Action
              label={creating ? 'CREATING' : 'CREATE ORDER'}
              detail="the deposit goes through the vault like any other payment"
              disabled={!request.ok || creating}
              onPress={create}
            />
            <Action label="REFRESH QUOTES" quiet disabled={creating} onPress={getQuotes} />
          </View>
        ) : (
          <ActionRow>
            <Action
              label={phase === 'quoting' ? 'ASKING' : 'GET QUOTES'}
              disabled={!pair.ok || phase === 'quoting'}
              onPress={getQuotes}
            />
          </ActionRow>
        )}

        <Gap />
        <Notice title="DEMO DATA" tone="plain">
          There is no network client in this build, so the quotes above come
          from a fixture. It answers in the shape a real exchange answers in,
          so the checks around it are the real ones.
        </Notice>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

// --------------------------------------------------------------- the readouts

/**
 * What leaves, set exactly the way every other amount in the application is
 * set: bright whole, dimmed precision tail, the ticker never bold. The coin
 * being sent is always one this wallet holds, so the real Amount treatment
 * applies without invention.
 */
function SendReadout({ amount, asset }: { amount: string; asset: Asset }) {
  const parsed = parseAtoms(amount, asset);
  if (parsed.ok && parsed.atoms !== undefined) {
    return <Amount atoms={parsed.atoms} asset={asset} size="readout" />;
  }
  return <Mono size={22}>{amount}</Mono>;
}

/**
 * What arrives, as the provider estimated it.
 *
 * The number is the provider's own, split for the eye the way money.tsx splits
 * an amount, and prefixed with the approximation sign it deserves. It animates
 * in when a quote lands: a rate that appears is read, a rate that was always
 * somehow there is skimmed. Before any quote exists the space says so quietly
 * instead of showing a zero that would read as a fact.
 */
function ReceiveReadout({
  quote,
  to,
  phase,
}: {
  quote: SwapQuote | undefined;
  to: SwapCoin;
  phase: Phase;
}) {
  if (!quote?.toAmount) {
    return (
      <View style={{ height: type.readout.lineHeight, justifyContent: 'center' }}>
        <Small tone={color.dim}>
          {phase === 'quoting' ? 'asking the exchanges' : 'no quote yet'}
        </Small>
      </View>
    );
  }

  const text = String(quote.toAmount);
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  const bright = fraction.slice(0, 4);
  const tail = fraction.slice(4);
  const tickerTone = to.ours ? assetColor(to.ours) : color.slate;

  return (
    <Animated.View key={text} entering={FadeInDown.springify().damping(26).stiffness(220)}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Animated.Text style={[type.readout, tabular, { color: color.slate }]}>{'≈ '}</Animated.Text>
        <Animated.Text style={[type.readout, tabular, { color: color.bone }]}>{whole}</Animated.Text>
        {fraction ? (
          <>
            <Animated.Text style={[type.readout, tabular, { color: color.bone }]}>.</Animated.Text>
            <Animated.Text style={[type.readout, tabular, { color: color.bone }]}>{bright}</Animated.Text>
            {tail ? (
              <Animated.Text
                style={[type.readout, tabular, { color: color.slate, fontSize: type.readout.fontSize * 0.78 }]}
              >
                {tail}
              </Animated.Text>
            ) : null}
          </>
        ) : null}
        <Animated.Text style={[type.label, { color: tickerTone, marginLeft: space.snug, letterSpacing: 1.9 }]}>
          {to.ticker.toUpperCase()}
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

// ------------------------------------------------------------------ the coins

/**
 * The coin selector: the asset first, then the chain it sits on.
 *
 * Two rows rather than one, and not only because every coin on every chain in
 * a single row is a wall of chips. USDC is one idea to a person and eight
 * addresses to a network, and the chain is the half that loses the money:
 * every EVM chain accepts the same 0x address, so nothing downstream can tell
 * Arbitrum from Base once the wrong one is chosen here. Splitting the choice
 * makes the chain something somebody picked rather than a suffix they skimmed.
 * An asset that lives on one chain shows no second row, because there is no
 * decision to make about Bitcoin.
 */
function CoinRow({
  coins,
  selected,
  onSelect,
  neutral = false,
}: {
  coins: SwapCoin[];
  selected: string;
  onSelect: (id: string) => void;
  neutral?: boolean;
}) {
  /* Catalog order, so what a person reads is the order the catalog was written
   * in rather than whatever order a Set happened to keep. */
  const tickers = useMemo(() => {
    const seen: string[] = [];
    for (const coin of coins) if (!seen.includes(coin.ticker)) seen.push(coin.ticker);
    return seen;
  }, [coins]);

  const current = useMemo(() => coins.find((c) => c.id === selected) ?? null, [coins, selected]);
  const activeTicker = current?.ticker ?? '';
  const chains = useMemo(() => coins.filter((c) => c.ticker === activeTicker), [coins, activeTicker]);

  const fillFor = (coin: SwapCoin | undefined, active: boolean) =>
    !active ? 'transparent' : coin?.ours && !neutral ? assetColor(coin.ours) : color.bone;

  return (
    <View>
      <View style={styles.presetRow}>
        {tickers.map((ticker) => {
          const active = ticker === activeTicker;
          /* Choosing an asset lands on its first chain in catalog order, which
           * is the one that carries the volume. */
          const first = coins.find((c) => c.ticker === ticker)!;
          return (
            <Chip
              key={ticker}
              onPress={() => onSelect(first.id)}
              tone={active ? color.void : color.slate}
              fill={fillFor(first, active)}
            >
              {ticker.toUpperCase()}
            </Chip>
          );
        })}
      </View>

      {chains.length > 1 ? (
        <View style={[styles.presetRow, { marginTop: 8 }]}>
          {chains.map((coin) => {
            const active = coin.id === selected;
            return (
              <Chip
                key={coin.id}
                onPress={() => onSelect(coin.id)}
                tone={active ? color.void : color.slate}
                fill={fillFor(coin, active)}
              >
                {chainName(coin.chain).toUpperCase()}
              </Chip>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// ----------------------------------------------------------------- the routes

/**
 * One exchange's answer, as a row: the name, the payout it offered, and its
 * exact words when it declined. Selection is a filled dot against a hollow
 * one, same vocabulary as the vault-link status, and the only ranking shown
 * is computed from the live quotes on this screen.
 */
function RouteRow({
  quote,
  to,
  chosen,
  bestPayout,
  index,
  onPress,
}: {
  quote: SwapQuote;
  to: SwapCoin;
  chosen: boolean;
  bestPayout: boolean;
  index: number;
  onPress: () => void;
}) {
  const provider = PROVIDERS.find((p) => p.id === quote.provider)!;
  return (
    <Animated.View entering={FadeIn.delay(index * 60)}>
      <Press onPress={onPress}>
        <View
          style={[
            styles.route,
            {
              backgroundColor: chosen ? color.surface : 'transparent',
              borderColor: chosen ? color.ruleStrong : color.rule,
            },
          ]}
        >
          <Dot state={chosen ? 'ready' : 'offline'} tone={chosen ? color.bone : color.slate} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
              <Strong tone={chosen ? color.bone : color.ash}>{provider.label}</Strong>
              {bestPayout ? (
                <Chip tone={color.good} fill={color.goodDim}>BEST PAYOUT</Chip>
              ) : null}
            </View>
            <Small tone={color.slate}>{provider.host}</Small>
          </View>
          <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
            {quote.ok && quote.toAmount ? (
              <>
                <Strong figures tone={chosen ? color.bone : color.ash}>{String(quote.toAmount)}</Strong>
                <Label tone={color.slate}>{to.ticker.toUpperCase()}</Label>
              </>
            ) : (
              <Small tone={color.slate} style={{ textAlign: 'right' }}>{quote.reason}</Small>
            )}
          </View>
        </View>
      </Press>
      <Gap size={space.snug} />
    </Animated.View>
  );
}

/**
 * The facts a quote actually carries, and nothing else. The rate is division
 * over the provider's own numbers; the bounds appear only when the provider
 * stated them. No fee, no arrival time, no stars: core/swap.ts supplies none,
 * and a detail row with an invented value is not a detail row.
 */
function QuoteFacts({
  quote,
  from,
  to,
  amount,
}: {
  quote: SwapQuote | undefined;
  from: SwapCoin;
  to: SwapCoin;
  amount: number;
}) {
  if (!quote?.toAmount || !Number.isFinite(amount) || amount <= 0) return null;
  const rate = quote.toAmount / amount;
  const provider = PROVIDERS.find((p) => p.id === quote.provider)!;
  const trimmed = (n: number) => String(Number(n.toPrecision(6)));
  const fromTicker = from.ticker.toUpperCase();
  return (
    <View>
      <FactLine label="RATE" value={`1 ${fromTicker} ≈ ${trimmed(rate)} ${to.ticker.toUpperCase()}`} />
      {Number.isFinite(quote.minAmount ?? NaN) ? (
        <FactLine label="MINIMUM" value={`${quote.minAmount} ${fromTicker}`} />
      ) : null}
      {Number.isFinite(quote.maxAmount ?? NaN) ? (
        <FactLine label="MAXIMUM" value={`${quote.maxAmount} ${fromTicker}`} />
      ) : null}
      <FactLine label="ROUTE" value={provider.label} last />
    </View>
  );
}

function FactLine({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View>
      <View style={styles.factLine}>
        <Label>{label}</Label>
        <Strong figures>{value}</Strong>
      </View>
      {last ? null : <Rule />}
    </View>
  );
}

// ---------------------------------------------------------------- the payout

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
        <Gap size={space.snug} />
        <Panel tone={color.well} style={{ padding: space.gap }}>
          <Mono size={13}>{derived ?? 'no account paired'}</Mono>
        </Panel>
        <Gap size={space.snug} />
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
      <Gap size={space.snug} />
      <Notice title="NOTHING CAN CHECK THIS ADDRESS" tone="warn">
        This wallet does not hold {to.label}, so the payout address is one you
        supply. It appears in no transaction, which means the vault never shows
        it and neither device can tell you it is right. Read it twice against
        wherever you copied it from.
      </Notice>
      {chainIsAmbiguous(to) ? (
        <>
          <Gap size={space.snug} />
          {/* The shape check passes on every chain that shares this address
            * format, so it proves nothing about which one. Saying which chain
            * is being paid, and naming the ones it cannot be told apart from,
            * is the only warning available before the money moves. */}
          <Notice title={`THIS PAYS OUT ON ${chainName(to.chain).toUpperCase()}`} tone="warn">
            The same address is valid on {confusableChains(to).map(chainName).join(', ')} as
            well, so checking its shape cannot tell those apart. Make sure the
            wallet or exchange you are paying accepts {to.ticker.toUpperCase()} on{' '}
            {chainName(to.chain)}.
          </Notice>
        </>
      ) : null}
      <Gap size={space.snug} />
      <TextInput
        value={typed}
        onChangeText={onType}
        placeholder={addressHint(to)}
        placeholderTextColor={color.slate}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={styles.payoutField}
      />
    </>
  );
}

const styles = StyleSheet.create({
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
  },
  /* The direction control sits between two hairlines rather than on top of
   * one, which is how the two halves read as one system with a hinge. */
  divide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.gap,
  },
  flip: {
    width: 44,
    height: 44,
    borderRadius: radius.round,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.ruleStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.step,
    padding: space.gap,
    borderRadius: radius.soft,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inflight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.step,
    padding: space.gap,
    borderRadius: radius.soft,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.ruleStrong,
  },
  factLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.gap,
    paddingVertical: space.step,
  },
  payoutField: {
    fontFamily: face.mono,
    fontSize: 13,
    lineHeight: 19,
    color: color.bone,
    backgroundColor: color.well,
    borderColor: color.rule,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.soft,
    padding: space.gap,
    minHeight: 52,
  },
});
