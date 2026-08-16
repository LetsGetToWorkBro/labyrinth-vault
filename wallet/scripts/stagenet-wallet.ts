/**
 * A throwaway stagenet wallet, so the faucet request can go out first.
 *
 * `docs/testflight.md` and the field-test runbook both say to start the faucet
 * request before building anything, because stagenet coins are the one input
 * with a queue in front of it. A faucet wants an address. An address wants a
 * wallet. And until now the only way to get one was to finish the Xcode build
 * first, which is exactly the ordering the advice was trying to avoid.
 *
 * So this makes one from the same code the app makes one from: 32 bytes of
 * CSPRNG entropy through `walletFromSeed`, which reduces the seed, derives the
 * view key from it, and encodes the address with the stagenet prefix. Nothing
 * here is a second implementation, which matters: an address made by some
 * other tool would be a fine faucet target and a useless test subject.
 *
 * ## What it prints, and where
 *
 * The address goes to stdout, alone. Everything else goes to stderr. That is
 * the same split `stagenet-send.ts` uses for the transaction id, and it means
 * the address can be piped or copied without picking it out of prose.
 *
 * The secrets go to stderr because they have to go somewhere, and a terminal
 * is an acceptable place for a wallet whose entire purpose is to hold faucet
 * coins on a test network. It is not an acceptable place for anything else,
 * which is why this script refuses mainnet outright rather than warning about
 * it. The vault is where a real wallet gets made, on a device, behind a
 * passphrase.
 *
 * ## Running it
 *
 *     cd wallet
 *     npx tsx scripts/stagenet-wallet.ts
 *
 * With a node, which is worth doing:
 *
 *     LABYRINTH_XMR_NODE=https://your-stagenet-node:38081 \
 *     npx tsx scripts/stagenet-wallet.ts
 *
 * The node is optional and only used to read the current height, which becomes
 * the birth height. A wallet cannot have been paid before it existed, so the
 * tip at the moment of creation is the exact right place for a later scan to
 * start, and getting it right is the difference between a scan measured in
 * seconds and one that walks the whole stagenet chain. Without a node the
 * birth height is unknown and `stagenet-send.ts` starts from zero.
 *
 * Set `LABYRINTH_XMR_SEED` to re-derive an existing wallet instead of making a
 * new one, which is how to reprint an address without generating a second
 * wallet nobody funded.
 */

import { randomBytes } from 'node:crypto';
import { live } from '../src/net/http';
import { info } from '../src/net/monerod';
import {
  walletFromSeed,
  revealMnemonic,
  revealSecretHex,
  wipeWallet,
  type Network,
} from '@vault/keys/monero';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2) throw new Error('LABYRINTH_XMR_SEED is not hex.');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main(): Promise<void> {
  const network = (process.env['LABYRINTH_XMR_NETWORK'] ?? 'stagenet') as Network;
  if (network === 'mainnet') {
    console.error('This script makes test wallets and prints their keys. Not on mainnet.');
    process.exit(2);
  }

  const existing = process.env['LABYRINTH_XMR_SEED'];
  const seed = existing ? hexToBytes(existing) : new Uint8Array(randomBytes(32));
  if (seed.length !== 32) {
    console.error('LABYRINTH_XMR_SEED must be 32 bytes of hex.');
    process.exit(2);
  }

  const wallet = walletFromSeed(seed, network);

  /* The reduced spend key rather than the raw entropy. `walletFromSeed`
   * reduces whatever it is given, and reduction is idempotent, so this is the
   * form that re-derives this exact wallet when fed back in. Printing the raw
   * bytes instead would round-trip too, but only by accident of what was
   * generated, and the phrase below encodes the reduced key regardless. */
  const seedHex = revealSecretHex(wallet.spendSecret);

  /* The height at creation, from a node if one was named. A wallet cannot have
   * been paid before it existed. */
  let birth: number | null = null;
  const node = process.env['LABYRINTH_XMR_NODE'];
  if (node) {
    const tip = await info(live(node));
    if (!tip.ok) {
      console.error(`Node: ${tip.problem}`);
      console.error('Carrying on without a birth height. Scans will start from zero.');
    } else {
      birth = tip.value.height;
      if (tip.value.syncing) {
        console.error('That node is still syncing, so the height below is behind the real tip.');
        console.error('Subtract a margin, or rerun against a synced node.');
      }
    }
  }

  const lines = [
    '',
    `A new ${network} wallet. Test money only.`,
    '',
    `  Address       ${wallet.address}`,
    `  Seed (hex)    ${seedHex}`,
    `  View key      ${revealSecretHex(wallet.viewSecret)}`,
    birth === null
      ? '  Birth height  unknown. Pass LABYRINTH_XMR_NODE to record it.'
      : `  Birth height  ${birth}`,
    '',
    '  Words         ' + revealMnemonic(wallet).slice(0, 13).join(' '),
    '                ' + revealMnemonic(wallet).slice(13).join(' '),
    '',
    'Next: paste the address into a stagenet faucet. Then, once it has paid,',
    'the send script wants exactly what is above:',
    '',
    `  LABYRINTH_XMR_SEED=${seedHex} \\`,
    `  LABYRINTH_XMR_NODE=${node ?? '<your stagenet node>'} \\`,
    `  LABYRINTH_XMR_BIRTH=${birth ?? 0} \\`,
    '  LABYRINTH_XMR_TO=<where to send> \\',
    '  LABYRINTH_XMR_AMOUNT=<piconero> \\',
    '  npx tsx scripts/stagenet-send.ts',
    '',
    'Keep this output until the stagenet run is done. Losing it loses the coins,',
    'which costs another faucet request rather than money.',
    '',
  ];
  console.error(lines.join('\n'));

  /* The one line stdout carries: the address, for pasting into a faucet. */
  console.log(wallet.address);

  /* Not a meaningful defense in a process that is about to exit and has
   * already printed the secret, and done anyway because the rule in
   * `wipe.ts` is that a wallet's secrets get zeroed when the work is over. A
   * script that quietly exempts itself is how the rule stops being one. */
  wipeWallet(wallet);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
