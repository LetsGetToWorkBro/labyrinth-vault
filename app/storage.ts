/**
 * Sealed storage, wired to the platform keystore.
 *
 * The rule from seal.ts, made operational: the store only ever sees
 * ciphertext. What actually sits in the iOS Keychain is two items:
 *
 *   - a device passphrase: 32 random bytes, hex-encoded, created once at
 *     setup and kept under kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
 *     with no iCloud sync — it exists on this phone or nowhere;
 *   - the sealed blob from seal(): Argon2id + XChaCha20-Poly1305 ciphertext.
 *
 * The seed itself is never stored, in any encoding, sealed or not — only the
 * blob. The device passphrase means the vault is always sealed under at least
 * 256 bits nobody typed; if the person layers their own passphrase on top,
 * both are required, so a dumped keychain alone is still not enough.
 *
 * Everything here takes its platform as arguments — the store, the RNG, the
 * clock — for the same reason seal() takes its randomness as an argument:
 * where a secret-bearing dependency came from should be answerable at the
 * call site, and a fake store in a test should exercise the identical code
 * path the Keychain does.
 */

import {
  DEFAULT_KDF,
  calibrateKdf,
  seal,
  unseal,
  type KdfParams,
} from '../src/keys/seal';
import { withSecret, wipe } from '../src/keys/wipe';

/** Fresh CSPRNG bytes. In the app this is crypto.getRandomValues, which
 *  react-native-get-random-values provides — see boot.js. */
export type Rng = (bytes: number) => Uint8Array;

/** What the Keychain native module implements (app/ios/VaultKeychain.swift).
 *  Values are strings because that is what the platform stores; everything
 *  secret is hex on the way in and parsed back to bytes on the way out. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { accessibility?: 'whenPasscodeSetThisDeviceOnly' | 'whenUnlocked' },
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

export const DEVICE_KEY = 'vault.device-passphrase.v1';
export const SEALED_KEY = 'vault.sealed-seed.v1';

/** seal()'s contract: SALT(16) + NONCE(24), fresh per seal. */
const SEAL_RANDOM_BYTES = 40;
const DEVICE_PASSPHRASE_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The passphrase the blob is actually sealed under.
 *
 * The device passphrase always participates. A user passphrase, when present,
 * is layered after a newline — a character the hex alphabet cannot contain,
 * so the two layers cannot collide into each other. Layering means AND: to
 * unseal you need what the Keychain guards *and* what the person knows.
 */
function effectivePassphrase(deviceHex: string, userPassphrase?: string): string {
  return userPassphrase ? `${deviceHex}\n${userPassphrase}` : deviceHex;
}

/**
 * KDF parameters costing about a second on *this* phone.
 *
 * Run once, at setup, before the first seal — calibrateKdf walks memory
 * upward and times the real code path, so this call itself takes a few
 * seconds. The result is baked into the sealed blob's authenticated header;
 * nothing needs storing separately.
 */
export function calibrateForThisDevice(now: () => number = Date.now): KdfParams {
  return calibrateKdf(1000, now);
}

export interface CreateVaultResult {
  ok: boolean;
  problem?: string;
}

/**
 * Seal a seed and store the blob. The seed is the caller's to wipe — pass it
 * through withSecret() at the call site so it dies even on a throw.
 */
export async function createVault(
  store: SecretStore,
  rng: Rng,
  seed: Uint8Array,
  options: { userPassphrase?: string; params?: KdfParams } = {},
): Promise<CreateVaultResult> {
  const deviceSecret = rng(DEVICE_PASSPHRASE_BYTES);
  if (deviceSecret.length !== DEVICE_PASSPHRASE_BYTES) {
    return { ok: false, problem: 'The random source did not return what was asked of it.' };
  }
  const deviceHex = toHex(deviceSecret);
  wipe(deviceSecret);

  const sealed = seal(
    seed,
    effectivePassphrase(deviceHex, options.userPassphrase),
    rng(SEAL_RANDOM_BYTES),
    options.params ?? DEFAULT_KDF,
  );
  if (!sealed.ok || !sealed.sealed) {
    return { ok: false, problem: sealed.problem ?? 'Sealing failed.' };
  }

  /* The device passphrase is the item that must never leave this phone:
   * passcode-set-this-device-only, no sync. The blob is ciphertext and could
   * survive laxer treatment, but there is no reason to grant it any. */
  await store.set(DEVICE_KEY, deviceHex, { accessibility: 'whenPasscodeSetThisDeviceOnly' });
  await store.set(SEALED_KEY, toHex(sealed.sealed), {
    accessibility: 'whenPasscodeSetThisDeviceOnly',
  });
  return { ok: true };
}

export async function vaultExists(store: SecretStore): Promise<boolean> {
  return (await store.get(SEALED_KEY)) !== null;
}

/** Both items gone. There is no recovery path except the words on paper,
 *  which is the design, not an accident. */
export async function destroyVault(store: SecretStore): Promise<void> {
  await store.remove(SEALED_KEY);
  await store.remove(DEVICE_KEY);
}

export interface UnsealOutcome<T> {
  ok: boolean;
  problem?: string;
  value?: T;
}

/**
 * Unseal transiently: the seed exists for exactly the duration of `use`, and
 * is wiped in a finally whatever happens inside. Nothing here retains it, and
 * callers get no way to keep it except deliberately copying — which is the
 * kind of line a reviewer can grep for.
 */
export async function withUnsealedSeed<T>(
  store: SecretStore,
  userPassphrase: string | undefined,
  use: (seed: Uint8Array) => T,
): Promise<UnsealOutcome<T>> {
  const blobHex = await store.get(SEALED_KEY);
  const deviceHex = await store.get(DEVICE_KEY);
  if (!blobHex || !deviceHex) {
    return { ok: false, problem: 'No vault on this device.' };
  }

  const opened = unseal(fromHex(blobHex), effectivePassphrase(deviceHex, userPassphrase));
  if (!opened.ok || !opened.secret) {
    /* Wrong passphrase and corrupt blob are indistinguishable on purpose;
     * see seal.ts. Pass the reader's wording through untouched. */
    return { ok: false, problem: opened.problem ?? 'The vault did not open.' };
  }

  return { ok: true, value: withSecret(opened.secret, use) };
}
