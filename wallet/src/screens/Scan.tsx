/**
 * The camera, which is the receiving end of the only wire this system has.
 *
 * Frames go to `Scanner` from `src/airgap/scanner.ts` — the vault's own
 * reader, running here unchanged. It reads both wires off one camera loop
 * without being told which, so pointing this at a Labyrinth vault, at Sparrow,
 * or at a Keystone all work and none of them need a setting.
 *
 * ## What the progress line is honest about
 *
 * `17 / 42` is frames *assembled*, not frames seen. The collector throws away
 * anything whose digest does not match, and a payload that fails at the end
 * fails entirely — there is no partial import. So the number can go up, and it
 * can go back to zero when somebody points the camera at a different
 * transaction mid-scan, and that is a correct thing to watch happen rather
 * than a glitch to smooth over.
 *
 * ## Camera permission
 *
 * Asked for at the moment it is needed and explained in the same sentence.
 * This is the one permission the application requests, and the reason is
 * exactly one thing: this is how the two halves speak.
 */

import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Action, Gap, Notice, Panel, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Small } from '../design/text';
import { Header } from '../components/chrome';
import { Link } from '../labyrinth/glyphs';
import { color, radius, space } from '../design/tokens';
import { formatOf, Scanner } from '@vault/airgap/scanner';
import { checkAddress, readPaymentUri } from '../core/addresses';
import { confirmed, refused } from '../design/haptics';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function ScanScreen({ navigation, route }: Nav<'Scan'>) {
  const store = useStore();
  const purpose = route.params?.purpose ?? 'wire';
  const [permission, requestPermission] = useCameraPermissions();
  const scanner = useRef(new Scanner());
  const [progress, setProgress] = useState<{ have: number; total: number; kind: string | null }>({
    have: 0,
    total: 0,
    kind: null,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; note: string } | null>(null);

  const onFrame = useCallback(
    ({ data }: { data: string }) => {
      if (done) return;

      /* A destination is a single code carrying text, so it is finished the
       * moment it is read. It is checked here rather than accepted here: a
       * camera pointed at a room sees wifi codes and cereal boxes, and the
       * one thing that must not happen is a string that is not an address
       * landing in the recipient field looking like one. */
      if (purpose === 'address' && formatOf(data) === null) {
        const read = readPaymentUri(data);
        const verdict = checkAddress(read.address, store.asset);
        if (!verdict.ok) {
          refused();
          setProblem(verdict.problem);
          return;
        }
        confirmed();
        store.send({ type: 'recipient', value: verdict.address, source: 'scanned' });
        if (read.amount) store.send({ type: 'amount', value: read.amount });
        navigation.goBack();
        return;
      }

      const status = scanner.current.offer(data);
      setProgress({ have: status.have, total: status.total, kind: typeof status.kind === 'string' ? status.kind : null });
      if (status.problem && status.have === 0) setProblem(status.problem);
      else setProblem(null);

      if (status.payload) {
        /* The payload goes somewhere, always. Assembling and verifying a
         * message and then dropping it on the floor was this screen's state
         * for exactly one commit, and it read as success while doing
         * nothing. The store dispatches on the kind and answers in a
         * sentence either way. */
        const kind = String(status.kind ?? '');
        const result = store.acceptWirePayload(kind, status.payload);
        if (result.ok) confirmed();
        else refused();
        setOutcome(result);
        setDone(kind || 'payload');
      }
    },
    [done, purpose, store, navigation],
  );

  if (!permission) return <Screen />;

  if (!permission.granted) {
    return (
      <Screen>
        <StatusBar style="light" />
        <Header onBack={() => navigation.goBack()} overline="CAMERA" title="This is the wire" />
        <View style={{ paddingHorizontal: space.gutter }}>
          <Gap size={space.gap} />
          <Body>
            The camera is how this wallet reads anything from your vault: an account key when you pair, a
            signature when you spend. Nothing it sees is stored, and nothing is sent anywhere.
          </Body>
          <Gap size={space.section} />
          <Action label="ALLOW THE CAMERA" onPress={() => void requestPermission()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <StatusBar style="light" />
      <Header
        onBack={() => navigation.goBack()}
        overline="SCAN"
        title={done ? 'Received' : purpose === 'address' ? 'Point at a payment code' : 'Point at the vault'}
      />

      <Gap size={space.gap} />
      <View style={{ paddingHorizontal: space.gutter }}>
        <Panel tone={color.void} style={{ height: 360, overflow: 'hidden', borderRadius: radius.panel }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onFrame}
          />
          <View style={corner('top-left')} />
          <View style={corner('top-right')} />
          <View style={corner('bottom-left')} />
          <View style={corner('bottom-right')} />
        </Panel>

        <Gap size={space.gap} />
        {done ? (
          <>
            <LabelWide tone={outcome?.ok === false ? color.warn : color.good}>
              {`${done.toUpperCase()} · CHECKSUM VERIFIED`}
            </LabelWide>
            <Gap size={space.step} />
            <Body>
              {outcome?.note ??
                'Every frame arrived and the payload matches its own digest. Nothing was assembled from parts of two different scans.'}
            </Body>
            <Gap size={space.section} />
            <Action label="CONTINUE" onPress={() => navigation.goBack()} />
            {outcome?.ok === false ? (
              <>
                <Gap size={space.snug} />
                <Action
                  label="SCAN AGAIN"
                  quiet
                  onPress={() => {
                    scanner.current.reset();
                    setOutcome(null);
                    setDone(null);
                    setProgress({ have: 0, total: 0, kind: null });
                  }}
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.gap }}>
              <Label tone={color.bone}>
                {purpose === 'address'
                  ? 'ONE CODE, ANY PAYMENT APP'
                  : progress.total > 0
                    ? `FRAMES ${progress.have} / ${progress.total}`
                    : 'WAITING FOR FRAMES'}
              </Label>
              <View style={{ flex: 1 }} />
              {progress.kind ? <Label tone={color.slate}>{progress.kind.toUpperCase()}</Label> : null}
            </View>
            {purpose === 'address' ? null : (
              <>
                <Gap size={space.step} />
                <Bar have={progress.have} total={progress.total} />
              </>
            )}
            <Gap size={space.gap} />
            <Link direction="in" active width={280} labels={purpose !== 'address'} />
            {problem ? (
              <>
                <Gap size={space.gap} />
                <Small tone={color.slate}>{problem}</Small>
              </>
            ) : null}
            <Gap size={space.section} />
            {purpose === 'address' ? (
              <Notice title="A VALID ADDRESS IS NOT A CORRECT ADDRESS">
                The checksum only proves this code was not corrupted on its way to the camera. Software that
                swaps a destination swaps in one that checksums perfectly, which is why your vault will show
                you where this payment is going before it signs anything.
              </Notice>
            ) : (
              <Notice title="A SCAN EITHER FINISHES OR IT DOES NOT">
                Frames can arrive out of order and repeat; that is normal and the reader expects it. What
                cannot happen is a half-assembled payload being accepted. If the digest disagrees, the whole
                scan is thrown away and started again.
              </Notice>
            )}
          </>
        )}
        <Gap size={space.gap} />
        {store.snapshot.demo && !done && purpose !== 'address' ? (
          <Small tone={color.dim}>
            There is no vault in this build to point this at. The reader is real; there is simply nothing
            drawing frames on the other side.
          </Small>
        ) : null}
      </View>
    </Screen>
  );
}

function Bar({ have, total }: { have: number; total: number }) {
  const slots = Math.min(Math.max(total, 1), 48);
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {Array.from({ length: slots }, (_, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            backgroundColor: index < Math.round((have / Math.max(total, 1)) * slots) ? color.good : color.dim,
          }}
        />
      ))}
    </View>
  );
}

/** Four corner marks rather than a full frame: a rectangle drawn over a camera
 *  reads as a viewfinder, and a viewfinder that occludes is a viewfinder that
 *  hides the code somebody is trying to line up. */
function corner(position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') {
  const base = {
    position: 'absolute' as const,
    width: 26,
    height: 26,
    borderColor: color.bone,
  };
  const inset = 18;
  switch (position) {
    case 'top-left':
      return { ...base, top: inset, left: inset, borderTopWidth: 2, borderLeftWidth: 2 };
    case 'top-right':
      return { ...base, top: inset, right: inset, borderTopWidth: 2, borderRightWidth: 2 };
    case 'bottom-left':
      return { ...base, bottom: inset, left: inset, borderBottomWidth: 2, borderLeftWidth: 2 };
    default:
      return { ...base, bottom: inset, right: inset, borderBottomWidth: 2, borderRightWidth: 2 };
  }
}
