/**
 * The Monero broadcast chokepoint, network-aware.
 *
 * The gate holds a mainnet spend until a live acceptance is recorded, and
 * leaves stagenet and testnet open, because that is where the acceptance is
 * made. Which side of the gate a transaction falls on is read from the
 * transaction's own declared network, so this proves the wiring: a mainnet
 * broadcast never reaches the node, a stagenet one does and comes back with the
 * id the signer computed.
 */

import { describe, expect, it } from 'vitest';
import { NodeWatcher } from '../src/core/watcher';
import type { Reply, Request, Transport } from '../src/net/http';

function recordingXmrNode(): { transport: Transport; calls: Request[] } {
  const calls: Request[] = [];
  const transport: Transport = {
    base: 'https://node.example',
    async send(request: Request): Promise<Reply> {
      calls.push(request);
      if (request.path === '/send_raw_transaction') {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK' }) };
      }
      return { ok: false, status: 404, problem: `no ${request.path}` };
    },
  };
  return { transport, calls };
}

const RAW = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
const TXID = 'a'.repeat(64);
/* The transport is injected directly, so no node config is needed here. */
const nodes = { btc: null, xmr: null };

describe('the Monero broadcast gate reads the transaction network', () => {
  it('refuses a mainnet spend and never touches the node', async () => {
    const { transport, calls } = recordingXmrNode();
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: transport });
    const result = await watcher.broadcast('XMR', RAW, { network: 'mainnet', txid: TXID });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/has not yet had a transaction accepted/);
    /* The bytes never left the device: the gate is before the node call. */
    expect(calls).toHaveLength(0);
  });

  it('defaults to mainnet when no network is given, and refuses', async () => {
    const { transport, calls } = recordingXmrNode();
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: transport });
    const result = await watcher.broadcast('XMR', RAW);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('lets a stagenet spend through and returns the signer-computed id', async () => {
    const { transport, calls } = recordingXmrNode();
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: transport });
    const result = await watcher.broadcast('XMR', RAW, { network: 'stagenet', txid: TXID });
    expect(result.ok).toBe(true);
    /* monerod answers with a status, not an id; the id passed in comes back. */
    expect(result.txid).toBe(TXID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/send_raw_transaction');
  });

  it('surfaces a node rejection on stagenet as a sentence', async () => {
    const rejecting: Transport = {
      base: 'https://node.example',
      async send(): Promise<Reply> {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'Failed', double_spend: true }) };
      },
    };
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: rejecting });
    const result = await watcher.broadcast('XMR', RAW, { network: 'stagenet', txid: TXID });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/already spent/);
  });
});
