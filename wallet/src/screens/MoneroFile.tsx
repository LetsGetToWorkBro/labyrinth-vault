/**
 * Showing the vault one of Monero's own wallet files.
 *
 * ## The one job, and the one thing it must not imply
 *
 * Somebody has an `unsigned_monero_tx` that Feather or the Monero GUI wrote.
 * The vault can open it and say what is in it. This screen is the wire between
 * those two facts: pick the file, and it plays as codes.
 *
 * What it must not imply is that a signature comes back. It does not, ever,
 * and not because of a missing feature: a wallet2 file is the *sending*
 * wallet's account of its own transaction, and a signature has to be over
 * destinations the vault rebuilt from its own keys. The vault refuses to sign
 * one whatever this screen does — `signable` is false for all six containers
 * in `src/keys/monerotx.ts` — so nothing here can widen what happens over
 * there. What this screen owes a person is that they know it before they walk
 * to a drawer, not after.
 *
 * Hence: no "waiting for the vault" state, no camera handoff at the end, and
 * the words READ ONLY in the overline. The send flow's transmit step looks
 * almost exactly like this and ends by turning the camera on, and the
 * difference between the two screens has to be legible without reading.
 *
 * ## Why the refusals happen here
 *
 * `offerMoneroFile` decides, and it decides using the vault's own
 * `readContainer`, so a file the vault would only name gets named here instead
 * — before the trip rather than after it. The sentences are in `core/`, under
 * test, for the same reason every other sentence that decides something is.
 */

import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Action, Gap, Notice, Screen } from '../design/atoms';
import { Body, Label, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { QrCanvas } from '../qr/QrCanvas';
import { Link } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import { moneroFileTransmission, offerMoneroFile, type MoneroFileOffer } from '../core/monerofile';
import { useFrames } from '../qr/useFrames';
import type { Nav } from '../nav/routes';
import type { Transmission } from '../core/wire';

export function MoneroFileScreen({ navigation }: Nav<'MoneroFile'>) {
  const [offer, setOffer] = useState<MoneroFileOffer | null>(null);
  const [transmission, setTransmission] = useState<Transmission | null>(null);
  const [reading, setReading] = useState(false);
  const { frame, status } = useFrames(transmission);

  async function choose() {
    setReading(true);
    try {
      /* `copyToCacheDirectory` so the bytes are readable without holding a
       * security-scoped URL open, which is what a file picked out of iCloud
       * Drive hands back. The copy lives in the cache and the OS reclaims it. */
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: '*/*',
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (!asset) return;

      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = bytesFromBase64(base64);

      const verdict = offerMoneroFile(bytes);
      setOffer(verdict);
      setTransmission(verdict.ok ? moneroFileTransmission(bytes) : null);
    } catch {
      /* A file the OS would not hand over, or one that is not there any more.
       * Nothing is known about it, so nothing is claimed about it. */
      setOffer({ ok: false, problem: 'That file could not be read off this device.' });
      setTransmission(null);
    } finally {
      setReading(false);
    }
  }

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline="MONERO FILE · READ ONLY"
          title="Show a file to the vault"
        />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          {transmission ? null : (
            <>
              <Body>
                If your Monero wallet on a computer wrote an `unsigned_monero_tx`, the vault can open it
                and tell you what it says. Pick the file and it plays as codes for the vault's camera.
              </Body>
              <Gap size={space.gap} />
              <Notice title="NOTHING COMES BACK">
                The vault reads these and does not sign them. What is in one is the sending wallet's own
                account of its own transaction, and a signature has to be over a destination the vault
                rebuilt from its own keys. To send Monero the vault will check, use SEND on this wallet
                instead.
              </Notice>
              <Gap size={space.gap} />
              <Action
                label={reading ? 'READING…' : 'CHOOSE A FILE'}
                onPress={() => void choose()}
              />
            </>
          )}

          {offer && !offer.ok ? (
            <>
              <Gap size={space.gap} />
              <Notice tone="warn" title={offer.what ? 'NOT WORTH THE TRIP' : 'NOT A MONERO FILE'}>
                {offer.problem ?? 'That file could not be used.'}
              </Notice>
            </>
          ) : null}
        </View>

        {transmission ? (
          <View style={{ alignItems: 'center' }}>
            <Gap size={space.gap} />
            <QrCanvas value={frame} size={320} level="M" />
            <Gap size={space.gap} />
            <View style={{ flexDirection: 'row', gap: space.section }}>
              <View>
                <Label tone={color.slate}>FRAME</Label>
                <Strong>{`${status.frame} / ${status.total}`}</Strong>
              </View>
              <View>
                <Label tone={color.slate}>PASSES</Label>
                <Strong>{`${status.laps}`}</Strong>
              </View>
            </View>
            <Gap size={space.gap} />
            <Link direction="out" active width={280} />
            <Gap size={space.gap} />

            <View style={{ paddingHorizontal: space.gutter }}>
              <Small tone={color.slate}>
                {`${offer?.what ?? 'A Monero file'} · about ${offer?.seconds ?? 0}s a pass. It repeats until you leave, because the vault has no way to say it has seen enough.`}
              </Small>
              <Gap size={space.gap} />
              <Action label="CHOOSE ANOTHER FILE" quiet onPress={() => void choose()} />
              <Gap size={space.snug} />
              <Action label="DONE" quiet onPress={() => navigation.goBack()} />
            </View>
          </View>
        ) : null}

        <Gap size={space.section} />
      </ScrollView>
    </Screen>
  );
}

/**
 * Base64 to bytes, without `atob` or `Buffer`.
 *
 * React Native has neither reliably, and `expo-file-system` hands back base64
 * because a JavaScript string is the only thing that crosses its bridge. This
 * is the same alphabet the standard uses, decoded four characters at a time.
 */
function bytesFromBase64(text: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const character of clean) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      out[at++] = (buffer >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, at);
}
