/**
 * Choosing a node, which is choosing who watches you.
 *
 * Most wallets make this decision once, for everybody, in a constant. This
 * screen makes it in front of the person it affects, and tells them what it
 * costs before they make it rather than in a settings sub-page afterward.
 *
 * Three things about the design follow from that.
 *
 * **The cost is stated per node, not once.** A public Bitcoin node learns
 * every address in the account. A Monero node serving blocks learns nothing
 * about which outputs are yours, because the scan happens on this device. Your
 * own node on your own network learns nothing at all. Those are three
 * different truths and showing the same warning for all three would train
 * somebody to skip it.
 *
 * **Your own node is the ordinary option.** It is at the top, with the command
 * to run, and the public list is below it. Every wallet that reverses this
 * teaches people that running a node is exotic.
 *
 * **Nothing is chosen until it is chosen.** The suggestions are inert. There
 * is no default, and with no node set the app shows fixture data and says so.
 */

import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, ActionRow, Chip, Gap, Notice, Panel, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Mono, Small, Title } from '../design/text';
import { Header } from '../components/chrome';
import { color, space } from '../design/tokens';
import { confirmed, refused } from '../design/haptics';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';
import {
  OWN_NODE_HINT,
  SUGGESTIONS,
  parseNode,
  privacyNote,
  type NodeConfig,
  type NodeKind,
} from '../core/nodes';

export function NodesScreen({ navigation }: Nav<'Nodes'>) {
  const store = useStore();
  const [kind, setKind] = useState<NodeKind>('esplora');
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const current: NodeConfig | null = kind === 'esplora' ? store.nodes.btc : store.nodes.xmr;

  function apply(url: string, label?: string) {
    const parsed = parseNode(kind, url, label);
    if (!parsed.ok) {
      refused();
      setProblem(parsed.problem);
      return;
    }
    confirmed();
    setProblem(null);
    setTyped('');
    store.setNode(kind, parsed.config);
  }

  return (
    <Screen>
      <StatusBar style="light" />
      <Header title="NODES" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: space.gutter }}>
        <Body>
          This wallet reads the chain through a node. There is no node set by
          default, because picking one for you would be picking who gets to
          watch your addresses.
        </Body>

        <Gap />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['esplora', 'monerod'] as NodeKind[]).map((option) => (
            <Chip
              key={option}
              onPress={() => { setKind(option); setProblem(null); }}
              tone={kind === option ? color.void : color.slate}
              fill={kind === option ? color.bone : 'transparent'}
            >
              {option === 'esplora' ? 'BITCOIN' : 'MONERO'}
            </Chip>
          ))}
        </View>

        <Gap />
        <Notice
          title={current ? 'WHAT THIS NODE SEES' : 'NO NODE SET'}
          tone={current ? (current.mine ? 'good' : 'warn') : 'plain'}
        >
          {privacyNote(current)}
        </Notice>

        {current ? (
          <>
            <Gap />
            <Panel>
              <Title>{current.label.toUpperCase()}</Title>
              <Mono size={12}>{current.url}</Mono>
            </Panel>
            <Gap size={8} />
            <ActionRow>
              <Action label="REFRESH" disabled={store.refreshing} onPress={() => void store.refresh()} />
              <Action label="FORGET" quiet onPress={() => store.setNode(kind, null)} />
            </ActionRow>
          </>
        ) : null}

        {store.nodeProblems.length ? (
          <>
            <Gap />
            {store.nodeProblems.map((entry) => (
              <Notice key={entry.asset} title={`${entry.asset} NODE`} tone="alarm">
                {entry.problem}
              </Notice>
            ))}
          </>
        ) : null}

        <Gap />
        <Rule />
        <Gap />

        <Label>YOUR OWN NODE</Label>
        <Gap size={8} />
        <Body>{OWN_NODE_HINT[kind]}</Body>
        <Gap size={8} />
        <Small>
          On your own network plain http is fine and the address looks like
          http://192.168.1.20{kind === 'esplora' ? ':3002' : ':18081'}. Anywhere
          else needs https, because otherwise everyone between here and there
          sees the same thing the node does.
        </Small>

        <Gap />
        <TextInput
          value={typed}
          onChangeText={(value) => { setTyped(value); setProblem(null); }}
          placeholder="https://"
          placeholderTextColor={color.slate}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          inputMode="url"
          style={{
            fontFamily: 'monospace',
            fontSize: 13,
            color: color.bone,
            borderColor: problem ? color.alarm : color.rule,
            borderWidth: 1,
            padding: space.step,
          }}
        />
        {problem ? (
          <>
            <Gap size={8} />
            <Small tone={color.alarm}>{problem}</Small>
          </>
        ) : null}
        <Gap size={8} />
        <ActionRow>
          <Action label="USE THIS NODE" disabled={!typed.trim()} onPress={() => apply(typed)} />
        </ActionRow>

        <Gap />
        <Rule />
        <Gap />

        <Label>SOMEWHERE TO START</Label>
        <Gap size={8} />
        <Small>
          Public nodes, with who runs them. Nothing here is selected until you
          select it, and every one of them is a stranger.
        </Small>
        <Gap size={8} />
        {SUGGESTIONS.filter((entry) => entry.kind === kind).map((entry) => (
          <Press key={entry.url} onPress={() => apply(entry.url, entry.label)}>
            <Panel>
              <Title>{entry.label.toUpperCase()}</Title>
              <Mono size={11}>{entry.url}</Mono>
              <Gap size={4} />
              <Small>{entry.who}</Small>
            </Panel>
          </Press>
        ))}

        <Gap />
        <Notice title="NOT REMEMBERED YET" tone="plain">
          A node set here lasts until the app is closed. Storing it needs a
          dependency this package does not have yet, and adding one deserves
          its own change rather than arriving quietly beside a node client.
        </Notice>
      </ScrollView>
    </Screen>
  );
}
