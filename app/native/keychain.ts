/**
 * The TS face of app/ios/VaultKeychain.swift, shaped as the SecretStore that
 * storage.ts consumes. The native side owns the two properties that matter
 * and cannot be expressed from JavaScript:
 *
 *   - kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly: the item exists only
 *     while the phone has a passcode, and never migrates to a new device;
 *   - no sync attribute of any kind, so nothing here is eligible for iCloud
 *     Keychain. The item is on this phone or it is nowhere.
 */

import { NativeModules } from 'react-native';
import type { SecretStore } from '../storage';

interface VaultKeychainModule {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, accessibility: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const native = NativeModules.VaultKeychain as VaultKeychainModule;

export const keychainStore: SecretStore = {
  get: (key) => native.get(key),
  set: (key, value, options) =>
    native.set(key, value, options?.accessibility ?? 'whenPasscodeSetThisDeviceOnly'),
  remove: (key) => native.remove(key),
};
