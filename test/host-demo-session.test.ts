/**
 * The demo button, and the session it lands on top of.
 *
 * `demoUnsigned` opens a fixed vault so the Simulator — which has no camera,
 * and therefore nothing to scan — can still walk the real confirmation flow.
 * It is the one entry point that opens a session without a passphrase, which
 * makes it the one worth checking behaves like the others on the way in.
 *
 * The property: taking over the session closes what was there first. `unlock`
 * has always called the internal lock before assigning, so a vault that was
 * open has its Bitcoin private keys zeroed, its Monero secrets wiped, and its
 * remembered description dropped. `demoUnsigned` assigned straight over the
 * top, which abandoned a real wallet's key material to the garbage collector
 * rather than zeroing it, and left the previous session's approval standing
 * behind a different wallet's keys.
 *
 * Nothing could be *signed* across that seam — an approval carries the id of
 * the keyring it was made against and `signPsbt` checks it — so this is about
 * the wipe and about the state, which is exactly the kind of thing that stays
 * true only if something asserts it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api, resetHost } from '../src/bridge/host';
import { passphraseToBytes } from '../src/keys/seal';

afterEach(() => resetHost());

const hex = (length: number, fill: number) => new Uint8Array(length).fill(fill).reduce(
  (out, byte) => out + byte.toString(16).padStart(2, '0'),
  '',
);

interface Reply { ok: boolean; problem?: string; frames?: string[]; sealed?: string }

function openRealVault(): void {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(api.create(hex(88, 0x5a), pass, '')) as Reply;
  expect(created.ok).toBe(true);
  const unlocked = JSON.parse(api.unlock(created.sealed!, pass)) as Reply;
  expect(unlocked.ok).toBe(true);
}

/** The demo's own PSBT, scanned back out of the frames it hands over. */
function demoPsbtHex(): string {
  const demo = JSON.parse(api.demoUnsigned()) as Reply;
  expect(demo.ok).toBe(true);
  let payload: string | null = null;
  for (const frame of demo.frames!) {
    const progress = JSON.parse(api.scan(frame)) as { payload: string | null };
    if (progress.payload) payload = progress.payload;
  }
  expect(payload).not.toBeNull();
  return payload!;
}

describe('the demo takes over a session rather than sitting beside one', () => {
  /* Opening a real vault costs two Argon2id derivations at 64 MiB, which is
   * the point of Argon2id and well past the default timeout. The same
   * allowance the other host tests make. */
  it('drops an approval made against the keys it replaced', { timeout: 30_000 }, () => {
    /* The demo's PSBT is fetched first, while no real vault is open, because
     * every `openRealVault` costs two Argon2id derivations at 64 MiB and this
     * test only needs one of them. */
    const psbt = demoPsbtHex();
    resetHost();

    /* Describe the demo transaction *as the real vault*: it is a genuine PSBT
     * for different keys, which the real session reads happily — every output
     * is simply somebody else's. That leaves a remembered description behind. */
    openRealVault();
    const described = JSON.parse(api.describe(psbt)) as {
      ok: boolean;
      summary?: { digest: string };
    };
    expect(described.ok).toBe(true);
    const digest = described.summary!.digest;

    // The demo now takes the session over.
    expect((JSON.parse(api.demoUnsigned()) as Reply).ok).toBe(true);

    /* If the previous session's description had survived, this would reach the
     * digest comparison holding the demo's keys. It must not get that far: the
     * approval went with the session it was made in. */
    const signed = JSON.parse(api.sign(psbt, digest)) as Reply;
    expect(signed.ok).toBe(false);
    expect(signed.problem).toContain('Nothing has been described');
  });

  it('still opens a working session of its own', () => {
    /* The wipe must not have cost the demo its own point: what it opens is a
     * real session that describes and signs its own transaction through the
     * ordinary path, with no special case. */
    const psbt = demoPsbtHex();
    const described = JSON.parse(api.describe(psbt)) as {
      ok: boolean;
      summary?: { digest: string; signable: boolean };
    };
    expect(described.ok).toBe(true);
    expect(described.summary!.signable).toBe(true);

    const signed = JSON.parse(api.sign(psbt, described.summary!.digest)) as Reply & { signed?: number };
    expect(signed.ok).toBe(true);
    expect(signed.signed).toBe(1);
  });

  it('leaves the scanner clean for the frames it is about to hand over', { timeout: 30_000 }, () => {
    /* Half a scan of something else must not be waiting when the demo's own
     * frames arrive; `lockInternal` resets the scanner, and the demo now goes
     * through it. */
    openRealVault();
    const stale = JSON.parse(api.scan('LV1:PSBT:1:4:00000000:AAAA')) as { have: number };
    expect(stale.have).toBe(1);

    expect((JSON.parse(api.demoUnsigned()) as Reply).ok).toBe(true);
    const fresh = JSON.parse(api.scan('LV1:PSBT:1:4:00000000:AAAA')) as { have: number };
    expect(fresh.have).toBe(1);
  });
});
