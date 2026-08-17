/**
 * Everything this wallet watches, in one list.
 *
 * ## What this replaced
 *
 * A vault screen that was three things at once: a device manager, an
 * explanation of the architecture, and the only place an account could be said
 * to exist. That last one was the problem. It meant the app had a *mode*, and
 * the mode was "paired or not", so a wallet with keys of its own had nowhere to
 * appear and a wallet with nothing at all had to pretend it had something.
 *
 * A list solves both by being ordinary. A vault is a row. Keys on this phone
 * are a row. Nothing is an empty list with a sentence, which is a state the
 * design can now have rather than one it has to disguise.
 *
 * ## The one thing every row must say
 *
 * Where it signs. Not "watch-only", which is the wrong half of the sentence:
 * it says what this wallet cannot do without saying that something else can,
 * so it reads as a limitation rather than as the design. `signingNote` writes
 * it, in the affirmative, in one place.
 *
 * This matters most on the phone that holds both. A seed sitting in this
 * device's keychain is not permission to sign for the account watched from a
 * vault, and the two rows saying different things about where they sign is how
 * a person sees that rather than being told it in a paragraph.
 */

import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Chip, Gap, Notice, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { assetColor, color, space } from '../design/tokens';
import { useStore } from '../state/store';
import { NOTHING_WATCHED, signingNote, watchingNothing, type Account } from '../core/accounts';
import type { Nav } from '../nav/routes';

export function AccountsScreen({ navigation }: Nav<'Accounts'>) {
  const { accounts } = useStore();

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.chapter }}>
        <Header onBack={() => navigation.goBack()} overline="ACCOUNTS" title="What this wallet watches" />

        <View style={{ paddingHorizontal: space.gutter }}>
          {watchingNothing(accounts) ? (
            <>
              <Body>{NOTHING_WATCHED}</Body>
              <Gap size={space.section} />
              <Action label="PAIR A VAULT" onPress={() => navigation.navigate('Pair')} />
              <Gap size={space.snug} />
              <Action label="MAKE A WALLET ON THIS PHONE" quiet onPress={() => navigation.navigate('CreateWallet')} />
              <Gap size={space.snug} />
              <Action label="RESTORE FROM WORDS" quiet onPress={() => navigation.navigate('Restore')} />
            </>
          ) : (
            <>
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onPress={() =>
                    /* A vault row opens the vault screen, which is still the
                       device manager it always was. A hot row opens the words,
                       because that is the thing a person came to this list to
                       find. Neither is a settings page for the other. */
                    account.source === 'vault'
                      ? navigation.navigate('Vault')
                      : navigation.navigate('Backup')
                  }
                />
              ))}

              <Gap size={space.section} />
              {/* The offer to add the kind that is missing, and only that
                  kind. Two levers where one is inert is a screen asking
                  somebody to work out which of them applies to them. */}
              {accounts.some((account) => account.source === 'vault') ? null : (
                <>
                  <Action label="PAIR A VAULT" quiet onPress={() => navigation.navigate('Pair')} />
                  <Gap size={space.snug} />
                </>
              )}
              {accounts.some((account) => account.source === 'hot') ? null : (
                <>
                  <Action label="MAKE A WALLET ON THIS PHONE" quiet onPress={() => navigation.navigate('CreateWallet')} />
                  <Gap size={space.snug} />
                  <Action label="RESTORE FROM WORDS" quiet onPress={() => navigation.navigate('Restore')} />
                  <Gap size={space.snug} />
                </>
              )}

              <Gap size={space.gap} />
              <Notice tone="plain" title="TWO KINDS OF ACCOUNT, ON PURPOSE">
                A vault account is signed for on a device with no network on it, and this phone
                cannot sign for it whatever else it is holding. An account on this phone is signed
                for here, behind Face ID, and is protected by the device rather than by something
                you know. The second is a convenience and the first is the product.
              </Notice>
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * One account.
 *
 * The chains are chips rather than prose because a person scanning this list
 * is looking for "where is my Monero", and the signing note is the loud half
 * of the row for the reason the whole screen exists.
 */
function AccountRow({ account, onPress }: { account: Account; onPress: () => void }) {
  return (
    <Press onPress={onPress}>
      <View style={{ paddingVertical: space.gap, gap: space.snug }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.step }}>
          <Strong style={{ flex: 1 }}>{account.label}</Strong>
          <Label tone={account.signsHere ? color.warn : color.good}>{signingNote(account)}</Label>
        </View>
        <View style={{ flexDirection: 'row', gap: space.snug }}>
          {account.chains.map((chain) => (
            <Chip key={chain} tone={assetColor(chain)}>
              {chain}
            </Chip>
          ))}
        </View>
        {account.source === 'hot' ? (
          <Small tone={color.dim}>
            The words that restore this are the only backup of it. Tap to read them.
          </Small>
        ) : (
          <Small tone={color.dim}>
            Paired from a vault. This phone holds the watching half and nothing that can spend.
          </Small>
        )}
      </View>
      <Rule />
    </Press>
  );
}
