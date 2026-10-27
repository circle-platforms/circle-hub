// Acceptance test 33: T1-1 Knowledge QA (知识问答)
// - Precondition: Knowledge root for line L is synced.
// - Step 1: Circle calls get_nodes to read command and manual nodes of line L.
// - Step 2: Circle quotes verbatim command text / tree reference in its answer; calls resolve_reference to verify.
// - Step 3: Counter-example 1: quote tampered by a single character / unknown command -> resolution: 'unresolved'.
// - Step 4: Counter-example 2: reference from another product line's root -> rejected / unresolved.
//
// Synthetic fixtures only: product FAMX/FAMY (two-name) and lumen-api (one-name).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let adminClient: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: true });
  client = await bed.connect(bed.reviewer, 'session-knowledge-qa');
  adminClient = await bed.connect(bed.hub.admin, 'session-admin');
});

after(async () => {
  await adminClient?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('T1-1 知识问答端到端验收', () => {
  it('reads command nodes via get_nodes and resolves verbatim citations in standalone root mode without a run', async () => {
    const sync = bed.syncs.two;
    assert.ok(sync && sync.builds.length > 0, 'two-name product is synced');
    const produced = sync.builds.find((b) => b.outcome === 'produced' && b.root !== null);
    assert.ok(produced?.root, 'has a produced root on line L');
    const rootL = produced.root;

    // 1. Circle calls get_nodes to read commands and manual sections on line L
    const nodesAnswer = await client.call('get_nodes', {
      root: rootL,
      paths: ['/commands'],
      depth: 2,
    });
    assert.equal(nodesAnswer.isError, false, nodesAnswer.text);
    const nodes = nodesAnswer.out.nodes as Array<{
      path: string;
      name: string;
      reference: string;
      entries: Array<{ statement: string; reference: string; kind: string; data?: { words?: string[] } }>;
    }>;
    assert.ok(nodes.length > 0, 'returned nodes from knowledge root');

    // Find a command entry with words
    const commandNode = nodes.find((n) => n.entries?.some((e) => Array.isArray(e.data?.words) && e.data.words.length > 0));
    assert.ok(commandNode, 'found a command node with entries');
    const entry = commandNode.entries[0];
    const commandWords = (entry.data?.words ?? ['show', 'health']).join(' ');

    // 2. Root mode: Command literal resolves to /commands node
    const resolveCmd = await client.call('resolve_reference', {
      root: rootL,
      text: commandWords,
      expect: 'command',
    });
    assert.equal(resolveCmd.isError, false, resolveCmd.text);
    assert.equal(resolveCmd.out.call_result, 'ok');
    assert.equal(resolveCmd.out.resolution, 'resolved', 'command literal resolves to node');
    assert.ok(resolveCmd.out.references.length > 0);
    assert.ok(resolveCmd.out.references.some((r: any) => r.reference.startsWith(`tree:${rootL}`)));

    // Second root has manual documents (endpoints-2.1.0.md)
    const secondSync = bed.syncs.one;
    assert.ok(secondSync && secondSync.builds.length > 0, 'second product is synced');
    const secondRoot = secondSync.builds.find((b) => b.root !== null)?.root;
    assert.ok(secondRoot && secondRoot !== rootL, 'second product has distinct root');

    // 3. Root mode: Manual quotation resolves to src: fragment
    const manualQuote = '列出池，按名称排序。';
    const resolveManual = await adminClient.call('resolve_reference', {
      root: secondRoot,
      text: manualQuote,
      expect: 'quotation',
    });
    assert.equal(resolveManual.isError, false, resolveManual.text);
    assert.equal(resolveManual.out.call_result, 'ok');
    assert.equal(resolveManual.out.resolution, 'resolved', 'manual quotation resolves to src: fragment');
    assert.ok(resolveManual.out.references.some((r: any) => r.reference.startsWith('src:')));

    // 4. Counter-example 1: Single character alteration fails resolution
    const tamperedQuote = '列出池，按名称排序！';
    const resolveTampered = await adminClient.call('resolve_reference', {
      root: secondRoot,
      text: tamperedQuote,
      expect: 'quotation',
    });
    assert.equal(resolveTampered.isError, false);
    assert.equal(resolveTampered.out.call_result, 'ok');
    assert.equal(resolveTampered.out.resolution, 'unresolved', 'single character alteration fails resolution');

    // 5. Counter-example 2: Words from another version line's root are not found
    const resolveAlienWords = await adminClient.call('resolve_reference', {
      root: rootL,
      text: manualQuote,
      expect: 'quotation',
    });
    assert.equal(resolveAlienWords.isError, false);
    assert.equal(resolveAlienWords.out.call_result, 'ok');
    assert.equal(resolveAlienWords.out.resolution, 'unresolved', 'words from another version line root are unresolved');

    const alienReference = `tree:${secondRoot}/commands/alien@${'0'.repeat(64)}`;
    const resolveAlien = await client.call('resolve_reference', {
      root: rootL,
      text: alienReference,
      expect: 'reference',
    });
    assert.equal(resolveAlien.isError, false);
    assert.equal(resolveAlien.out.call_result, 'ok');
    assert.equal(resolveAlien.out.resolution, 'unresolved', 'alien tree root reference is unresolved');

    // 6. rec: reference in root mode is rejected with exit remedy
    const recRef = await client.call('resolve_reference', {
      root: rootL,
      text: `rec:${'a'.repeat(64)}`,
    });
    assert.equal(recRef.isError, true);
    assert.equal(recRef.out.call_result, 'error');
    assert.equal(recRef.out.errors[0].code, 'REFERENCE_UNRESOLVED');
    assert.ok(recRef.out.errors[0].fix?.includes('start_run'), 'fix explains how to open run with start_run');

    // 7. 3 parameter error cases
    // a) Neither run nor root
    const neither = await client.call('resolve_reference', {
      text: commandWords,
    });
    assert.equal(neither.isError, true);
    assert.equal(neither.out.call_result, 'error');
    assert.equal(neither.out.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');

    // b) Both run and root
    const both = await client.call('resolve_reference', {
      run: 'run-12345678',
      root: rootL,
      text: commandWords,
    });
    assert.equal(both.isError, true);
    assert.equal(both.out.call_result, 'error');
    assert.equal(both.out.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');

    // c) Malformed root
    const malformed = await client.call('resolve_reference', {
      root: 'not-a-sha256-hex',
      text: commandWords,
    });
    assert.equal(malformed.isError, true);
    assert.equal(malformed.out.call_result, 'error');
    assert.equal(malformed.out.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');

    // 8. Unavailable root and unreadable source give identical refusal shape to get_nodes
    const unavailableRoot = '0'.repeat(64);
    const getNodesUnavailable = await client.call('get_nodes', {
      root: unavailableRoot,
      paths: ['/'],
    });
    assert.equal(getNodesUnavailable.isError, true);
    assert.equal(getNodesUnavailable.out.call_result, 'error');
    assert.equal(getNodesUnavailable.out.errors[0].code, 'SOURCE_UNAVAILABLE');

    const resolveUnavailable = await client.call('resolve_reference', {
      root: unavailableRoot,
      text: commandWords,
    });
    assert.equal(resolveUnavailable.isError, true);
    assert.equal(resolveUnavailable.out.call_result, 'error');
    assert.equal(resolveUnavailable.out.errors[0].code, 'SOURCE_UNAVAILABLE');
    assert.equal(resolveUnavailable.out.errors[0].message, getNodesUnavailable.out.errors[0].message);
    assert.equal(resolveUnavailable.out.errors[0].fix, getNodesUnavailable.out.errors[0].fix);

    // Unreadable source artifact outside a run gives identical refusal shape to get_nodes
    const srcRef = resolveManual.out.references[0].reference;
    const getNodesUnauth = await client.call('get_nodes', { reference: srcRef });
    assert.equal(getNodesUnauth.isError, true);
    assert.equal(getNodesUnauth.out.errors[0].code, 'SOURCE_UNAVAILABLE');

    const resolveUnauth = await client.call('resolve_reference', {
      root: secondRoot,
      text: srcRef,
      expect: 'reference',
    });
    assert.equal(resolveUnauth.isError, true);
    assert.equal(resolveUnauth.out.errors[0].code, 'SOURCE_UNAVAILABLE');
    assert.equal(resolveUnauth.out.errors[0].message, getNodesUnauth.out.errors[0].message);
    assert.equal(resolveUnauth.out.errors[0].fix, getNodesUnauth.out.errors[0].fix);

    // 9. Run mode continues to pass as before
    const startResult = await client.call('start_run', {
      pack: 'case-location',
      product: 'FAMX',
      inputs: {
        documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }],
      },
    });
    assert.equal(startResult.isError, false, startResult.text);
    assert.equal(startResult.out.call_result, 'ok');
    const runId = startResult.out.run!.run;
    assert.equal(startResult.out.run!.root, rootL, 'run locked to root L');

    const resolveRunCmd = await client.call('resolve_reference', {
      run: runId,
      text: commandWords,
      expect: 'command',
    });
    assert.equal(resolveRunCmd.isError, false);
    assert.equal(resolveRunCmd.out.call_result, 'ok');
    assert.equal(resolveRunCmd.out.resolution, 'resolved');
  });
});
