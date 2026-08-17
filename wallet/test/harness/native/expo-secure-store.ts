/**
 * The keychain, in memory.
 *
 * This is where the seed for a wallet on this phone lives, so it is the one
 * stand-in whose *accessibility* argument is worth checking rather than
 * ignoring: `keychainStore.ts` passes `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on
 * every call, and the reason it does is that the alternative syncs somebody's
 * spending key to iCloud. A stand-in that dropped the option would let a
 * regression through silently, so every call's option is kept and
 * `harness.test.ts` asserts on it.
 */

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

interface Entry {
  value: string;
  accessible: string | undefined;
}

const keychain = new Map<string, Entry>();

/** Every call, in order, with the accessibility class it asked for. */
export const calls: { op: 'get' | 'set' | 'delete'; key: string; accessible: string | undefined }[] = [];

export function reset(): void {
  keychain.clear();
  calls.length = 0;
}

/** What the keychain holds, for a test that wants to seed one or read one. */
export function contents(): Map<string, string> {
  return new Map([...keychain].map(([key, entry]) => [key, entry.value]));
}

type Options = { keychainAccessible?: string } | undefined;

export async function getItemAsync(key: string, options?: Options): Promise<string | null> {
  calls.push({ op: 'get', key, accessible: options?.keychainAccessible });
  return keychain.get(key)?.value ?? null;
}

export async function setItemAsync(key: string, value: string, options?: Options): Promise<void> {
  calls.push({ op: 'set', key, accessible: options?.keychainAccessible });
  keychain.set(key, { value, accessible: options?.keychainAccessible });
}

export async function deleteItemAsync(key: string, options?: Options): Promise<void> {
  calls.push({ op: 'delete', key, accessible: options?.keychainAccessible });
  keychain.delete(key);
}
