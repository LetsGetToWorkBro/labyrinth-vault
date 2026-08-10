/**
 * The application shell, wiring the pieces in the order the security model
 * requires. This file is deliberately small: every screen it routes to is
 * specified in ui/ and ios/, and every decision it makes is implemented and
 * tested in storage.ts / session.ts / src. What lives here is only the
 * sequence:
 *
 *   boot polyfills (index.js)
 *     → self-test gate            nothing runs unless the machine proves itself
 *       → no vault? setup         calibrate KDF on this phone, seal, store blob
 *       → vault? locked           unseal transiently, open wallet, wipe seed
 *         → backgrounded          closeWallet(): keys wiped, watching survives
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { mnemonicFromEntropy } from '../src/keys/bitcoin';
import { withSecret } from '../src/keys/wipe';
import { SelfTestGate } from './SelfTestGate';
import { keychainStore } from './native/keychain';
import { Session, type ForegroundState } from './session';
import {
  calibrateForThisDevice,
  createVault,
  vaultExists,
  withUnsealedSeed,
} from './storage';
import { ink, mono, text as t } from './theme';

const rng = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

type Shell =
  | { at: 'checking' }
  | { at: 'setup' }
  | { at: 'sealing' }
  | { at: 'locked'; problem?: string }
  | { at: 'open' };

export function App() {
  return (
    <SelfTestGate>
      <VaultShell />
    </SelfTestGate>
  );
}

function VaultShell() {
  const session = useMemo(() => new Session(), []);
  const [shell, setShell] = useState<Shell>({ at: 'checking' });
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => {
    // Leaving the foreground wipes private keys; watching survives. The app
    // switcher ('inactive') counts — that is the moment a phone changes hands.
    session.attach((handler) => {
      const sub = AppState.addEventListener('change', (next) => {
        handler(next as ForegroundState);
        if (next !== 'active') setShell((s) => (s.at === 'open' ? { at: 'locked' } : s));
      });
      return () => sub.remove();
    });
    vaultExists(keychainStore).then((exists) =>
      setShell({ at: exists ? 'locked' : 'setup' }),
    );
    return () => session.detach();
  }, [session]);

  async function runSetup() {
    setShell({ at: 'sealing' });
    /* calibrateKdf runs the real Argon2id repeatedly and takes a few seconds;
     * done once, here, and the result rides in the blob's own header. */
    const params = calibrateForThisDevice();
    const mnemonic = mnemonicFromEntropy(rng(32));
    const result = await withSecret(
      new TextEncoder().encode(mnemonic),
      (seed) =>
        createVault(keychainStore, rng, seed, {
          userPassphrase: passphrase || undefined,
          params,
        }),
    );
    setPassphrase('');
    setShell(result.ok ? { at: 'locked' } : { at: 'setup' });
  }

  async function unlock() {
    const outcome = await withUnsealedSeed(
      keychainStore,
      passphrase || undefined,
      (seed) => session.unlock(seed),
    );
    setPassphrase('');
    setShell(outcome.ok ? { at: 'open' } : { at: 'locked', problem: outcome.problem });
  }

  switch (shell.at) {
    case 'checking':
      return <Stage eyebrow="VAULT" title={'…'} />;
    case 'setup':
      return (
        <Stage eyebrow="FIRST RUN" title={'SEAL\nTHE VAULT'}>
          <Text style={styles.prose}>
            A device passphrase is generated into the Keychain either way — this phone or
            nowhere. Adding your own means both are required to unseal.
          </Text>
          <PassphraseField value={passphrase} onChange={setPassphrase} placeholder="PASSPHRASE · OPTIONAL" />
          <Lever label="CALIBRATE AND SEAL" onPress={runSetup} />
        </Stage>
      );
    case 'sealing':
      return (
        <Stage eyebrow="SEALING" title={'TUNING TO\nTHIS PHONE'}>
          <Text style={styles.prose}>
            Measuring how slow a passphrase guess can be made on this hardware. A few seconds,
            once.
          </Text>
        </Stage>
      );
    case 'locked':
      return (
        <Stage eyebrow={session.state === 'watching' ? 'LOCKED · WATCHING' : 'LOCKED'} title={'SEALED'}>
          <Text style={styles.prose}>
            {session.state === 'watching'
              ? 'Private keys were wiped when the app left the foreground. Addresses still derive; signing needs a fresh unseal.'
              : 'The seed exists only as ciphertext until you unseal.'}
          </Text>
          {shell.problem ? <Text style={styles.problem}>{shell.problem}</Text> : null}
          <PassphraseField value={passphrase} onChange={setPassphrase} placeholder="PASSPHRASE" />
          <Lever label="UNSEAL" onPress={unlock} />
        </Stage>
      );
    case 'open':
      return (
        <Stage eyebrow="VAULT · SIGNING READY" title={'READY'}>
          <Text style={styles.prose}>
            Keys are in memory and die the moment this app leaves the foreground. From here the
            flow is the one specified in ui/ and ios/: scan, read, verify, hold to sign.
          </Text>
        </Stage>
      );
  }
}

function Stage({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.headline}>{title}</Text>
      {children}
    </View>
  );
}

function PassphraseField(props: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <TextInput
      style={styles.input}
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={ink.paperFaint}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      // Secrets never transit the clipboard; the field refuses cut/copy/paste
      // rather than trusting habit. Test-enforced across app/ and ios/.
      contextMenuHidden
    />
  );
}

function Lever({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.lever} onPress={onPress}>
      <Text style={styles.leverText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.void, paddingHorizontal: 24, paddingTop: 80 },
  eyebrow: { ...t.eyebrow },
  headline: { ...t.statement, marginTop: 14, marginBottom: 20 },
  prose: { fontSize: 14, lineHeight: 20, color: ink.paperDim, marginBottom: 22 },
  problem: { fontFamily: mono, fontSize: 11, color: ink.attention, marginBottom: 14 },
  input: {
    height: 56,
    borderWidth: 1,
    borderColor: ink.rule,
    color: ink.paper,
    paddingHorizontal: 16,
    fontFamily: mono,
    fontSize: 13,
    marginBottom: 12,
  },
  lever: { height: 66, backgroundColor: ink.paper, alignItems: 'center', justifyContent: 'center' },
  leverText: { fontSize: 15, fontWeight: '600', letterSpacing: 0.4, color: ink.void },
});
