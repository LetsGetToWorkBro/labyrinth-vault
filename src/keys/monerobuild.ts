/**
 * The final assembly: an unsigned set in, a broadcastable transaction out.
 *
 * This is the last file in the Monero spend path, and the one that touches
 * everything before it. The wallet built the unsigned set (coins, rings, fee,
 * change); this file, running on the airgapped vault with the spend key,
 * turns it into the exact bytes a node relays:
 *
 *   - one-time output keys, view tags, and encrypted amounts for each
 *     destination, from the freshly drawn transaction key;
 *   - deterministic commitment masks the receiver can reconstruct, and
 *     pseudo-output masks that close the balance to the piconero;
 *   - a Bulletproof+ range proof over the output amounts;
 *   - a CLSAG per input over the transaction's real pre-hash;
 *   - the serialized transaction and its id.
 *
 * ## What is checked before anything is signed
 *
 * Every claim the unsigned set makes about this wallet is re-proved from the
 * vault's own keys, the same way the scan proves amounts: the one-time key
 * must re-derive from the view secret, and the claimed amount must recommit
 * to the on-chain commitment. An input that fails either check is a refusal,
 * because signing it would be signing a lie somebody else composed. After
 * assembly, the balance is re-checked on the curve (pseudo-outs against
 * commitments plus fee), the range proof is re-verified by the
 * consensus-anchored verifier, and every CLSAG is re-verified before the
 * bytes leave this function.
 *
 * ## What this cannot check
 *
 * Whether a real node accepts the bytes. The serializer is anchored to real
 * transaction ids and the range proof verifier to real proofs, which is as
 * close as an airgapped machine gets; the last inch is a stagenet broadcast,
 * and `moneroreadiness.ts` keeps the mainnet gate shut until one is recorded.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  amountMask,
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  deriveSecretKey,
  deriveViewTag,
  encryptPaymentId,
  generateKeyDerivation,
  generateKeyImage,
  RCT_H,
} from './monerocrypto';
import { fromHex, toHex, parseAddress, publicFromSecret, type Wallet } from './monero';
import { buildTxExtra } from './monerowire';
import { clsagSign, clsagVerify, type RingMember } from './monerosign';
import {
  bppRandomCount,
  proveBulletproofPlus,
  verifyBulletproofPlus,
} from './bulletproofplus';
import {
  absoluteToRelative,
  assembleRawTransaction,
  preClsagHash,
  serializePrefix,
  serializeRctBase,
  type WireClsag,
  type WirePrefix,
} from './monerowire';
import { wipe } from './wipe';
import { ed25519 } from '@noble/curves/ed25519.js';

const Point = ed25519.Point;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const b2s = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n % L;
};
const s2b = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let n = ((value % L) + L) % L;
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};

// ---------------------------------------------------------------------------
// The unsigned set, as the vault reads it off the airgap

/** Must match the wallet's `UNSIGNED_VERSION`; bumped together. */
export const UNSIGNED_VERSION = 1;
/** The version inside the XMRSIGNED payload going back. */
export const SIGNED_VERSION = 1;

export interface VaultRingMember { globalIndex: number; key: string; commitment: string }

export interface VaultUnsignedInput {
  txPublicKey: string;
  indexInTx: number;
  globalIndex: number;
  amount: string;
  ring: VaultRingMember[];
  realPosition: number;
}

export interface VaultUnsignedOutput { address: string; amount: string; change: boolean; dummy?: boolean }

export interface VaultUnsignedSet {
  v: number;
  chain: 'xmr';
  network: 'mainnet' | 'stagenet' | 'testnet';
  inputs: VaultUnsignedInput[];
  outputs: VaultUnsignedOutput[];
  fee: string;
  ringSize: number;
}

const decoder = new TextDecoder();
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * An array entry as something safe to read fields off.
 *
 * The same guard `keyimages.ts` keeps, for the same reason: `JSON.parse` will
 * produce `[null]` from a hostile payload, and reading a field off `null` is a
 * TypeError thrown out of a parser whose contract is to refuse in a sentence.
 * A non-object entry becomes an empty one and fails the ordinary checks.
 */
function fields(entry: unknown): Record<string, unknown> {
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
}

/**
 * Read an unsigned set, refusing anything malformed.
 *
 * The strictness mirrors `parseKeyImageRequest`: everything over the airgap is
 * untrusted, and a malformed field refused here is a sentence on a screen
 * rather than an exception inside curve arithmetic. This is the vault's own
 * copy of the wallet's parser, because the two devices share a wire format
 * and deliberately share no code.
 */
export function parseUnsignedSet(
  bytes: Uint8Array,
): { ok: true; set: VaultUnsignedSet } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, problem: 'That is not an unsigned transaction set.' };
  }
  if (!value || typeof value !== 'object') return { ok: false, problem: 'That is not an unsigned transaction set.' };
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return { ok: false, problem: 'That set is not about Monero.' };
  if (raw['v'] !== UNSIGNED_VERSION) return { ok: false, problem: 'That set is from a different wallet version than this vault understands.' };
  const network = raw['network'];
  if (network !== 'mainnet' && network !== 'stagenet' && network !== 'testnet') {
    return { ok: false, problem: 'That set does not name a known network.' };
  }

  const amount = (v: unknown): bigint | null => {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
    const parsed = BigInt(v);
    return parsed < 2n ** 64n ? parsed : null;
  };
  const hex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

  if (!Array.isArray(raw['inputs']) || raw['inputs'].length === 0) return { ok: false, problem: 'That set has no inputs.' };
  if (!Array.isArray(raw['outputs']) || raw['outputs'].length === 0) return { ok: false, problem: 'That set has no outputs.' };
  if (raw['inputs'].length > 128 || raw['outputs'].length > 16) return { ok: false, problem: 'That set is implausibly large.' };
  const fee = amount(raw['fee']);
  if (fee === null) return { ok: false, problem: 'That set has no fee.' };
  const ringSize = Number(raw['ringSize']);
  if (!Number.isInteger(ringSize) || ringSize < 1 || ringSize > 64) return { ok: false, problem: 'That set has an unreasonable ring size.' };

  const inputs: VaultUnsignedInput[] = [];
  for (const entry of raw['inputs']) {
    const input = fields(entry);
    const amt = amount(input['amount']);
    if (!hex64(input['txPublicKey']) || amt === null) return { ok: false, problem: 'An input is malformed.' };
    const indexInTx = Number(input['indexInTx']);
    const globalIndex = Number(input['globalIndex']);
    if (!Number.isInteger(indexInTx) || indexInTx < 0 || !Number.isInteger(globalIndex) || globalIndex < 0) {
      return { ok: false, problem: 'An input is malformed.' };
    }
    if (!Array.isArray(input['ring']) || input['ring'].length !== ringSize) return { ok: false, problem: 'An input ring is the wrong size.' };
    const ring: VaultRingMember[] = [];
    for (const memberEntry of input['ring']) {
      const m = fields(memberEntry);
      const memberIndex = Number(m['globalIndex']);
      if (!hex64(m['key']) || !hex64(m['commitment']) || !Number.isInteger(memberIndex) || memberIndex < 0) {
        return { ok: false, problem: 'A ring member is malformed.' };
      }
      ring.push({ globalIndex: memberIndex, key: m['key'].toLowerCase(), commitment: (m['commitment'] as string).toLowerCase() });
    }
    const realPosition = Number(input['realPosition']);
    if (!Number.isInteger(realPosition) || realPosition < 0 || realPosition >= ringSize) {
      return { ok: false, problem: 'An input real position is outside its ring.' };
    }
    inputs.push({
      txPublicKey: input['txPublicKey'].toLowerCase(),
      indexInTx,
      globalIndex,
      amount: amt.toString(),
      ring,
      realPosition,
    });
  }

  const outputs: VaultUnsignedOutput[] = [];
  for (const entry of raw['outputs']) {
    const output = fields(entry);
    const amt = amount(output['amount']);
    if (typeof output['address'] !== 'string' || amt === null) return { ok: false, problem: 'An output is malformed.' };
    outputs.push({ address: output['address'], amount: amt.toString(), change: output['change'] === true, dummy: output['dummy'] === true });
  }
  if (outputs.length < 2) {
    /* Consensus requires at least two outputs. The wallet pads a one-output
     * spend with a zero-amount self-output; a set that reaches the vault with
     * one output would only ever be rejected by the network, so it is refused
     * here with a sentence instead of signed into a dead transaction. */
    return { ok: false, problem: 'That set has fewer than two outputs, which the network will not accept.' };
  }

  return { ok: true, set: { v: UNSIGNED_VERSION, chain: 'xmr', network, inputs, outputs, fee: fee.toString(), ringSize } };
}

// ---------------------------------------------------------------------------
// Randomness accounting

/**
 * How many 32-byte random scalars `signMoneroSpend` consumes:
 * the transaction key, a shuffle seed, one additional transaction key per
 * output (used only when a subaddress destination forces additional keys, but
 * always reserved so the count is the same whatever the addresses are), a
 * pseudo-output mask for every input but the last (the last is arithmetic, not
 * chance), `ringSize + 1` CLSAG nonces per input, and the range proof's blinds.
 */
export function signingRandomCount(nInputs: number, ringSize: number, nOutputs: number): number {
  return 1 + 1 + nOutputs + (nInputs - 1) + nInputs * (ringSize + 1) + bppRandomCount(nOutputs);
}

// ---------------------------------------------------------------------------
// The signature

export interface SignedMoneroTx {
  /** The broadcastable bytes, hex: `/send_raw_transaction`'s `tx_as_hex`. */
  hex: string;
  txid: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  fee: string;
  /** The consensus weight the fee prices, so a caller can check the rate. */
  weight: number;
  /** One per input, for the wallet's spent-detection book. */
  keyImages: string[];
  /** What was paid where, for the confirmation screen and the record. */
  outputs: { address: string; amount: string; change: boolean }[];
}

export type SignResult = { ok: true; tx: SignedMoneroTx } | { ok: false; problem: string };

/** The eight ecdh bytes: the little-endian amount XORed with the shared mask. */
function encryptAmount(amount: bigint, sharedSecret: Uint8Array): string {
  const mask = amountMask(sharedSecret);
  const out = new Uint8Array(8);
  let n = amount;
  for (let i = 0; i < 8; i++) { out[i] = Number(n & 0xffn) ^ mask[i]!; n >>= 8n; }
  return toHex(out);
}

/** C's memcmp order on 32-byte strings, for the consensus input sort. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Fisher-Yates from a Keccak counter over the seed: deterministic, testable. */
function shuffledIndices(count: number, seed: Uint8Array): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  let pool = keccak_256(seed);
  let at = 0;
  const nextByte = (): number => {
    if (at >= pool.length) { pool = keccak_256(pool); at = 0; }
    return pool[at++]!;
  };
  for (let i = count - 1; i > 0; i--) {
    /* Rejection sampling, so small counts stay unbiased. */
    const bound = Math.floor(256 / (i + 1)) * (i + 1);
    let draw = nextByte();
    while (draw >= bound) draw = nextByte();
    const j = draw % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * Sign a Monero spend: the unsigned set, the vault's keys, and enough
 * injected randomness, out the other side a raw transaction.
 *
 * Randomness is injected for the same reason it is everywhere in this
 * repository: the caller owns the entropy source and the tests replay one.
 * `randomScalars` must hold exactly `signingRandomCount(...)` values from the
 * platform CSPRNG.
 */
export function signMoneroSpend(
  wallet: Wallet,
  set: VaultUnsignedSet,
  randomScalars: readonly Uint8Array[],
): SignResult {
  if (wallet.network !== set.network) {
    return { ok: false, problem: `That set is for ${set.network} and this vault's wallet is ${wallet.network}. Not signing across networks.` };
  }
  const need = signingRandomCount(set.inputs.length, set.ringSize, set.outputs.length);
  if (randomScalars.length !== need) {
    return { ok: false, problem: `Signing this set needs exactly ${need} random scalars, not ${randomScalars.length}.` };
  }
  let drawAt = 0;
  const draw = (): Uint8Array => randomScalars[drawAt++]!;

  const fee = BigInt(set.fee);
  const inTotal = set.inputs.reduce((sum, i) => sum + BigInt(i.amount), 0n);
  const outTotal = set.outputs.reduce((sum, o) => sum + BigInt(o.amount), 0n);
  if (inTotal !== outTotal + fee) {
    return { ok: false, problem: `That set does not balance: ${inTotal} in, ${outTotal} out, ${fee} fee.` };
  }

  /* Each destination is parsed to its keys and kind. Standard, subaddress, and
   * integrated are all handled; an integrated address is a standard address
   * carrying an eight-byte payment id, which rides in the extra. A wrong kind
   * pays the wrong place, so the kind drives the transaction-key math below and
   * is never guessed. */
  interface ParsedDest {
    spendPublic: Uint8Array;
    viewPublic: Uint8Array;
    isSubaddress: boolean;
    isSelf: boolean;
    paymentId: Uint8Array | null;
  }
  const parsedOutputs: ParsedDest[] = [];
  for (const output of set.outputs) {
    const parsed = parseAddress(output.address);
    if (!parsed.valid || !parsed.spendPublic || !parsed.viewPublic) {
      return { ok: false, problem: `An output address is not valid: ${parsed.problem ?? 'unreadable'}` };
    }
    if (parsed.network !== set.network) {
      return { ok: false, problem: `An output address is for ${parsed.network}, not ${set.network}.` };
    }
    parsedOutputs.push({
      spendPublic: fromHex(parsed.spendPublic),
      viewPublic: fromHex(parsed.viewPublic),
      isSubaddress: parsed.kind === 'subaddress',
      isSelf: output.change || output.dummy === true,
      paymentId: parsed.kind === 'integrated' && parsed.paymentId ? fromHex(parsed.paymentId) : null,
    });
  }

  /* Classify, over all destinations, change included: change is a standard
   * self-address. The rule that follows is Monero's `classify_addresses`. */
  const numSub = parsedOutputs.filter((d) => d.isSubaddress).length;
  const numStd = parsedOutputs.length - numSub;
  /* Additional per-output transaction keys are needed unless every destination
   * is standard, or there is exactly one destination and it is a subaddress. */
  const needAdditional = numSub > 0 && (numStd > 0 || numSub > 1);

  const secrets: Uint8Array[] = [];
  try {
    // --- The transaction key, and the outputs in a shuffled order ---
    const txSecret = s2b(b2s(draw()));
    if (b2s(txSecret) === 0n) return { ok: false, problem: 'A random scalar reduced to zero. Draw again.' };
    secrets.push(txSecret);

    /* The main transaction public key. For a lone subaddress destination it is
     * `r·D`, so the subaddress recipient recovers the shared secret from the
     * main key; otherwise `r·G`, and subaddresses get their own keys below. */
    const soleSubaddress = numStd === 0 && numSub === 1 ? parsedOutputs.find((d) => d.isSubaddress) : undefined;
    const txPublic = soleSubaddress
      ? Point.fromBytes(soleSubaddress.spendPublic).multiplyUnsafe(b2s(txSecret)).toBytes()
      : publicFromSecret(txSecret);

    const order = shuffledIndices(set.outputs.length, draw());

    /* One additional-key secret per output position, always drawn so the
     * randomness budget does not depend on the address kinds. They are only
     * turned into public keys and used when `needAdditional`. */
    const additionalSecrets: Uint8Array[] = [];
    for (let position = 0; position < order.length; position++) {
      const secret = s2b(b2s(draw()));
      additionalSecrets.push(secret);
      secrets.push(secret);
    }

    interface BuiltOutput {
      source: VaultUnsignedOutput;
      oneTimeKey: string;
      viewTag: string;
      ecdhAmount: string;
      commitment: string;
      mask: bigint;
      amount: bigint;
    }
    const builtOutputs: BuiltOutput[] = [];
    const additionalPublicKeys: string[] = [];
    for (let position = 0; position < order.length; position++) {
      const sourceIndex = order[position]!;
      const output = set.outputs[sourceIndex]!;
      const dest = parsedOutputs[sourceIndex]!;
      const amount = BigInt(output.amount);

      /* The additional public key for this output: `r·D` for a subaddress,
       * `r·G` otherwise. Present only when the transaction needs them. */
      if (needAdditional) {
        const r = additionalSecrets[position]!;
        const pub = dest.isSubaddress
          ? Point.fromBytes(dest.spendPublic).multiplyUnsafe(b2s(r)).toBytes()
          : publicFromSecret(r);
        additionalPublicKeys.push(toHex(pub));
      }

      /* The shared secret. A subaddress destination with additional keys uses
       * that output's own key against the subaddress view key (`r·C`); every
       * other destination, change and lone-subaddress included, uses the main
       * transaction key against the destination view key. */
      const txPrivate = dest.isSubaddress && needAdditional ? additionalSecrets[position]! : txSecret;
      const derivation = generateKeyDerivation(dest.viewPublic, txPrivate);
      const shared = derivationToScalar(derivation, position);
      const mask = commitmentMask(shared);
      builtOutputs.push({
        source: output,
        oneTimeKey: toHex(derivePublicKey(derivation, position, dest.spendPublic)),
        viewTag: toHex(deriveViewTag(derivation, position)),
        ecdhAmount: encryptAmount(amount, shared),
        commitment: toHex(commit(amount, mask)),
        mask: b2s(mask),
        amount,
      });
    }

    /* The extra field: the main key, the additional keys, and an encrypted
     * short payment id. The id is the integrated address's when there is one,
     * and a dummy zero otherwise, so integrated and ordinary payments look
     * identical on the chain. Both need a single non-change destination to
     * encrypt against, which a normal one-payment spend has. */
    const nonChange = parsedOutputs.filter((d) => !d.isSelf);
    const integrated = nonChange.find((d) => d.paymentId);
    let encryptedPaymentId: string | undefined;
    if (integrated && nonChange.length === 1) {
      encryptedPaymentId = toHex(encryptPaymentId(integrated.paymentId!, integrated.viewPublic, txSecret));
    } else if (integrated) {
      return { ok: false, problem: 'An integrated-address payment must be the only destination.' };
    } else if (set.outputs.length <= 2 && nonChange.length === 1) {
      encryptedPaymentId = toHex(encryptPaymentId(new Uint8Array(8), nonChange[0]!.viewPublic, txSecret));
    }
    const extra = buildTxExtra({
      txPublicKey: toHex(txPublic),
      ...(needAdditional ? { additionalPublicKeys } : {}),
      ...(encryptedPaymentId !== undefined ? { encryptedPaymentId } : {}),
    });

    // --- Prove every input is ours, and its amount is the chain's ---
    interface BuiltInput {
      source: VaultUnsignedInput;
      oneTimeSecret: Uint8Array;
      keyImage: Uint8Array;
      inputMask: bigint;
      amount: bigint;
    }
    const builtInputs: BuiltInput[] = [];
    for (const input of set.inputs) {
      const derivation = generateKeyDerivation(fromHex(input.txPublicKey), wallet.viewSecret);
      const real = input.ring[input.realPosition]!;
      const derivedKey = toHex(derivePublicKey(derivation, input.indexInTx, fromHex(wallet.spendPublic)));
      if (derivedKey !== real.key) {
        return { ok: false, problem: "An input does not derive from this vault's keys. Not signing an output that is not this wallet's." };
      }
      const oneTimeSecret = deriveSecretKey(derivation, input.indexInTx, wallet.spendSecret);
      secrets.push(oneTimeSecret);
      if (toHex(publicFromSecret(oneTimeSecret)) !== real.key) {
        return { ok: false, problem: "An input's derived secret does not match its key. Refusing to sign." };
      }
      const shared = derivationToScalar(derivation, input.indexInTx);
      const inputMask = commitmentMask(shared);
      const amount = BigInt(input.amount);
      if (toHex(commit(amount, inputMask)) !== real.commitment) {
        return { ok: false, problem: "An input's claimed amount does not recommit to the on-chain commitment. Refusing to sign a lie." };
      }
      builtInputs.push({
        source: input,
        oneTimeSecret,
        keyImage: generateKeyImage(fromHex(real.key), oneTimeSecret),
        inputMask: b2s(inputMask),
        amount,
      });
    }

    /* Consensus orders inputs by key image, descending. */
    builtInputs.sort((a, b) => -compareBytes(a.keyImage, b.keyImage));

    // --- Pseudo-output masks: every one random but the last, which balances ---
    const outputMaskSum = builtOutputs.reduce((sum, o) => (sum + o.mask) % L, 0n);
    const pseudoMasks: bigint[] = [];
    let partialSum = 0n;
    for (let i = 0; i < builtInputs.length - 1; i++) {
      const mask = b2s(draw());
      pseudoMasks.push(mask);
      partialSum = (partialSum + mask) % L;
    }
    pseudoMasks.push(((outputMaskSum - partialSum) % L + L) % L);
    const pseudoOuts = builtInputs.map((input, i) => commit(input.amount, s2b(pseudoMasks[i]!)));

    /* The money equation, on the curve: sum of pseudo-outs equals sum of
     * output commitments plus the fee times H. This is the identity the
     * network checks first, and there is no reason to sign before it holds. */
    let lhs = Point.ZERO;
    for (const pseudo of pseudoOuts) lhs = lhs.add(Point.fromBytes(pseudo));
    let rhs = fee === 0n ? Point.ZERO : Point.fromBytes(RCT_H).multiplyUnsafe(fee);
    for (const output of builtOutputs) rhs = rhs.add(Point.fromBytes(fromHex(output.commitment)));
    if (!lhs.equals(rhs)) {
      return { ok: false, problem: 'The commitments do not balance on the curve. Refusing to sign.' };
    }

    // --- The range proof, checked by the consensus-anchored verifier ---
    const bppRandoms = Array.from({ length: bppRandomCount(builtOutputs.length) }, draw);
    const { proof } = proveBulletproofPlus(
      builtOutputs.map((o) => o.amount),
      builtOutputs.map((o) => s2b(o.mask)),
      bppRandoms,
    );
    if (!verifyBulletproofPlus(builtOutputs.map((o) => o.commitment), proof)) {
      return { ok: false, problem: 'The freshly built range proof did not verify. Refusing to emit it.' };
    }

    // --- The prefix, and the message every ring signature signs ---
    const prefix: WirePrefix = {
      version: 2,
      unlockTime: 0,
      inputs: builtInputs.map((input) => ({
        keyOffsets: absoluteToRelative(input.source.ring.map((m) => m.globalIndex)),
        keyImage: toHex(input.keyImage),
      })),
      outputs: builtOutputs.map((o) => ({ key: o.oneTimeKey, viewTag: o.viewTag })),
      extra,
    };
    const base = {
      fee,
      ecdhAmounts: builtOutputs.map((o) => o.ecdhAmount),
      outPk: builtOutputs.map((o) => o.commitment),
    };
    const prefixBytes = serializePrefix(prefix);
    const baseBytes = serializeRctBase(base);
    const message = preClsagHash(keccak_256(prefixBytes), baseBytes, [proof]);

    // --- One CLSAG per input, each verified before it ships ---
    const clsags: WireClsag[] = [];
    for (let i = 0; i < builtInputs.length; i++) {
      const input = builtInputs[i]!;
      const ring: RingMember[] = input.source.ring.map((m) => ({ key: m.key, commitment: m.commitment }));
      const nonces = Array.from({ length: set.ringSize + 1 }, draw);
      const z = s2b(((input.inputMask - pseudoMasks[i]!) % L + L) % L);
      secrets.push(z);
      const signature = clsagSign(
        message,
        ring,
        { p: input.oneTimeSecret, z, index: input.source.realPosition },
        pseudoOuts[i]!,
        nonces,
      );
      if (toHex(input.keyImage) !== signature.keyImage) {
        return { ok: false, problem: "A signature's key image disagrees with the input's. Refusing to emit it." };
      }
      if (!clsagVerify(message, ring, pseudoOuts[i]!, signature)) {
        return { ok: false, problem: 'A freshly made ring signature did not verify. Refusing to emit it.' };
      }
      clsags.push({ s: signature.s, c1: signature.c1, D: signature.dInv8 });
    }

    const raw = assembleRawTransaction(prefix, base, {
      bpp: [proof],
      clsags,
      pseudoOuts: pseudoOuts.map(toHex),
    });

    return {
      ok: true,
      tx: {
        hex: raw.hex,
        txid: raw.txid,
        network: set.network,
        fee: set.fee,
        weight: raw.weight,
        keyImages: builtInputs.map((input) => toHex(input.keyImage)),
        outputs: builtOutputs.map((o) => ({ address: o.source.address, amount: o.amount.toString(), change: o.source.change })),
      },
    };
  } catch (error) {
    return { ok: false, problem: `Signing failed: ${(error as Error).message}` };
  } finally {
    wipe(...secrets);
  }
}

// ---------------------------------------------------------------------------
// The signed payload, back across the airgap

const encoder = new TextEncoder();

/** The bytes for the XMRSIGNED payload: what the wallet broadcasts. */
export function encodeSignedTx(tx: SignedMoneroTx): Uint8Array {
  return encoder.encode(JSON.stringify({
    v: SIGNED_VERSION,
    chain: 'xmr',
    network: tx.network,
    txid: tx.txid,
    hex: tx.hex,
    fee: tx.fee,
    keyImages: tx.keyImages,
  }));
}
