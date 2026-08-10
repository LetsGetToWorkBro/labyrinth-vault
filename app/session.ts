/**
 * The wallet session, and what backgrounding does to it.
 *
 * The lifecycle rule: private keys exist in memory only while the app is
 * frontmost and a person has just unsealed. The moment the app leaves the
 * foreground — backgrounded, app switcher, incoming call — closeWallet()
 * zeroes the private keys in place. What survives is the watch half: the
 * account xpub, address derivation, the ability to render everything that
 * needs no secret. Signing after that requires a fresh unseal, which is the
 * point: a phone lifted out of a pocket mid-session holds ciphertext and
 * public keys, nothing else.
 *
 * AppState arrives as an argument (a subscribe function), so the test can be
 * the app switcher.
 */

import {
  closeWallet,
  openFromMnemonic,
  type BtcWallet,
} from '../src/keys/bitcoin';

export type ForegroundState = 'active' | 'background' | 'inactive';

export type SessionState =
  /** No wallet open at all (before first unseal). */
  | 'empty'
  /** Public half only: addresses derive, nothing signs. */
  | 'watching'
  /** Private keys in memory; signing possible. */
  | 'signing';

export class Session {
  private wallet: BtcWallet | null = null;
  private unsubscribe: (() => void) | null = null;

  get state(): SessionState {
    if (!this.wallet) return 'empty';
    return this.wallet.kind === 'full' ? 'signing' : 'watching';
  }

  /** The open wallet, for the screens. Never cached by callers. */
  get current(): BtcWallet | null {
    return this.wallet;
  }

  /**
   * Open from seed bytes fresh out of withUnsealedSeed(). The mnemonic must
   * transit as a string because that is what BIP39 derivation takes; wipe.ts
   * is honest that a string cannot be zeroed, which is one more reason the
   * unsealed window is kept this short.
   */
  unlock(seedBytes: Uint8Array): void {
    this.lock();
    this.wallet = openFromMnemonic(new TextDecoder().decode(seedBytes));
  }

  /**
   * Wipe the private keys in place. The same object keeps watching — that is
   * closeWallet's contract, checked in its tests — so the interface does not
   * go blank when the phone does.
   */
  lock(): void {
    if (this.wallet) closeWallet(this.wallet);
  }

  /** Leaving the foreground locks. 'inactive' counts: that is the app
   *  switcher, which is exactly the moment a phone changes hands. */
  handleForeground(next: ForegroundState): void {
    if (next !== 'active') this.lock();
  }

  /**
   * Wire to the platform. `subscribe` is AppState.addEventListener('change')
   * in the app; returns a detach for symmetry.
   */
  attach(subscribe: (handler: (next: ForegroundState) => void) => () => void): void {
    this.detach();
    this.unsubscribe = subscribe((next) => this.handleForeground(next));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
