/**
 * The launch gate: the machine proving itself before it may hold money.
 *
 * Wraps the whole app. On mount it runs selfTest() — the real hash, the real
 * derivation, the real seal round-trip, against NIST/BIP84/Monero/BC-UR
 * vectors, a few hundred milliseconds — and renders every check by name.
 * Children do not mount until allChecksPass. There is no skip, no timeout
 * that waves it through, and the failure state's one action re-runs the
 * checks; a signing device whose hash is wrong has exactly one honest
 * behavior, and "continue" is not it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { allChecksPass, selfTest, type Check } from '../src/selftest';
import { ink, mono, text as t } from './theme';

type Phase = 'running' | 'passed' | 'failed';

export function SelfTestGate({ children }: { children: React.ReactNode }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [phase, setPhase] = useState<Phase>('running');

  const run = useCallback(() => {
    setPhase('running');
    setChecks([]);
    // One frame so the POWER-ON header paints before the ~300ms of hashing.
    requestAnimationFrame(() => {
      const results = selfTest();
      setChecks(results);
      setPhase(allChecksPass(results) ? 'passed' : 'failed');
    });
  }, []);

  useEffect(run, [run]);

  if (phase === 'passed') return <>{children}</>;

  const failed = checks.filter((c) => !c.ok);

  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>POWER-ON SELF-TEST</Text>
      <Text style={styles.headline}>
        {phase === 'failed' ? 'CANNOT\nSTART' : 'PROVING\nTHE MACHINE'}
      </Text>

      <ScrollView style={styles.list}>
        {checks.map((check) => (
          <View key={check.name} style={styles.row}>
            <Text style={[styles.mark, !check.ok && styles.markBad]}>
              {check.ok ? '✓' : '×'}
            </Text>
            <View style={styles.rowText}>
              <Text style={[styles.name, !check.ok && styles.nameBad]}>{check.name}</Text>
              <Text style={styles.proves}>{check.ok ? check.proves : check.detail}</Text>
            </View>
          </View>
        ))}
        {phase === 'running' && checks.length === 0 && (
          <Text style={styles.running}>RUNNING CHECKS AGAINST PUBLISHED VECTORS</Text>
        )}
      </ScrollView>

      {phase === 'failed' && (
        <>
          <Text style={styles.refusal}>
            {failed.length} of {checks.length} checks failed. This build will not derive a key
            or touch a transaction in this state. Nothing has been damaged; nothing will run.
          </Text>
          <Pressable style={styles.lever} onPress={run}>
            <Text style={styles.leverText}>RUN CHECKS AGAIN</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.void, paddingHorizontal: 24, paddingTop: 60 },
  eyebrow: { ...t.eyebrow },
  headline: { ...t.statement, marginTop: 14, marginBottom: 22 },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ink.rule,
  },
  mark: { fontFamily: mono, fontSize: 11, color: ink.verified, width: 14, marginTop: 1 },
  markBad: { color: ink.refused },
  rowText: { flex: 1 },
  name: { fontFamily: mono, fontSize: 11.5, letterSpacing: 0.7, color: ink.paper },
  nameBad: { color: ink.refused },
  proves: { fontSize: 11, lineHeight: 15, color: ink.paperFaint, marginTop: 4 },
  running: { fontFamily: mono, fontSize: 10, letterSpacing: 1.6, color: ink.paperFaint, paddingVertical: 20 },
  refusal: { fontSize: 13.5, lineHeight: 19, color: ink.paperDim, paddingVertical: 18 },
  lever: {
    height: 66,
    backgroundColor: ink.paper,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  leverText: { fontSize: 15, fontWeight: '600', letterSpacing: 0.4, color: ink.void },
});
