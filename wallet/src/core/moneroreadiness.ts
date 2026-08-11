/**
 * The gate that keeps unverified consensus crypto off mainnet.
 *
 * ## What is built, and the one thing that is not proven
 *
 * The Monero spend path is real code: coin selection and change
 * (`monerospend.ts`), decoy selection (`decoys.ts`), and the CLSAG ring
 * signature in the vault (`@vault/keys/monerosign`). CLSAG round-trips and
 * survives every adversarial tamper. Decoys match wallet2's distribution.
 * The arithmetic that could lose money — change to the owner, the balance
 * closing — is tested to the piconero.
 *
 * What is **not** established anywhere in this repository is that a real
 * monerod accepts the finished bytes. That takes two things a Node test cannot
 * supply: a complete Bulletproof+ range proof whose Fiat-Shamir transcript
 * matches the network's exactly, and a live node to relay it to. A from-scratch
 * Bulletproof+ verified only by round-trip against its own prover is precisely
 * the "unverifiable thing with no real blobs to check against" that this
 * codebase refuses to write blind — the same call that put the chain scan on
 * the JSON path instead of an epee decoder.
 *
 * So this gate exists. A Monero spend may be *built* and *signed* as far as the
 * verified pieces reach, on any network, for inspection and for testnet work.
 * It may not be *broadcast on mainnet* until a real stagenet acceptance has
 * been recorded here, because until then the honest status of the bytes is
 * "never accepted by a node", and broadcasting real value on that basis is the
 * one thing a signing device must not do quietly.
 *
 * ## Why this is a constant and not a config flag
 *
 * A flag someone can flip is a gate that gets flipped. This is a source
 * constant with a single true value, changed only in a commit that also lands
 * the evidence: a recorded stagenet transaction id the bytes produced and the
 * node accepted. `docs/monero-send.md` is where that evidence goes, and the
 * commit that lifts the gate is the commit that fills it in.
 */

/**
 * Whether the Monero spend path has been confirmed against a live node.
 *
 * `false` until a stagenet broadcast built by this code has been accepted and
 * the transaction id recorded in `docs/monero-send.md`. While it is false, the
 * wallet refuses to broadcast a Monero spend on mainnet. It does not refuse to
 * build one, sign one, or broadcast one on stagenet or testnet, because that
 * is exactly how the evidence to lift this gate gets made.
 */
export const MONERO_SEND_BROADCAST_VERIFIED = false;

/** The sentence the refusal shows, so the reason travels with it. */
export const MONERO_SEND_GATE_NOTE =
  'This build can construct and sign a Monero spend, but it has not yet had a transaction accepted by a live node, so it will not broadcast one with real value on mainnet. The signing is real; the last mile is a confirmation this build does not yet have. Stagenet and testnet are open for exactly that confirmation.';

export type MoneroBroadcastGate =
  | { allowed: true }
  | { allowed: false; problem: string };

/**
 * May a Monero spend be broadcast to this network?
 *
 * Stagenet and testnet: always, because that is where the mainnet gate gets
 * its evidence. Mainnet: only once the gate has been lifted by a recorded live
 * acceptance. The check is on the network the *transaction* names, not the node
 * it is being sent to, so a mainnet transaction pointed at a stagenet node is
 * still refused: the danger is the value, not the endpoint.
 */
export function moneroBroadcastGate(network: 'mainnet' | 'stagenet' | 'testnet'): MoneroBroadcastGate {
  if (network !== 'mainnet') return { allowed: true };
  if (MONERO_SEND_BROADCAST_VERIFIED) return { allowed: true };
  return { allowed: false, problem: MONERO_SEND_GATE_NOTE };
}
