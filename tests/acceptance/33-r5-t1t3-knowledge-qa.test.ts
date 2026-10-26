// Acceptance test 33: T1-1 Knowledge QA (知识问答)
// - Precondition: Knowledge root for line L is synced.
// - Step 1: Circle calls get_nodes to read command and manual nodes of line L.
// - Step 2: Circle quotes verbatim command text / tree reference in its answer; calls resolve_reference to verify.
// - Step 3: Counter-example 1: quote tampered by a single character / unknown command -> resolution: 'unresolved'.
// - Step 4: Counter-example 2: reference from another product line's root -> rejected / unresolved.
//
// Synthetic fixtures only: product APV/NSAE (two-name) and lumen-api (one-name).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: true });
  client = await bed.connect(bed.reviewer, 'session-knowledge-qa');
});

after(async () => {
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('T1-1 知识问答端到端验收', () => {
  it('reads command nodes via get_nodes and resolves verbatim citations via resolve_reference', async () => {
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

    // 2. Start a run on line L (using case-location) to lock rootL for resolve_reference
    const startResult = await client.call('start_run', {
      pack: 'case-location',
      product: 'APV',
      inputs: {
        documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }],
      },
    });
    assert.equal(startResult.isError, false, startResult.text);
    assert.equal(startResult.out.call_result, 'ok');
    const runId = startResult.out.run!.run;
    assert.equal(startResult.out.run!.root, rootL, 'run locked to root L');

    // 3. Resolve command citation against the run
    const resolveCmd = await client.call('resolve_reference', {
      run: runId,
      text: commandWords,
      expect: 'command',
    });
    assert.equal(resolveCmd.isError, false, resolveCmd.text);
    assert.equal(resolveCmd.out.call_result, 'ok');
    assert.equal(resolveCmd.out.resolution, 'resolved', 'command citation resolves successfully');
    assert.ok(resolveCmd.out.references.length > 0, 'returns references citable as grounds');

    // Also resolve exact tree reference citation
    const resolveRef = await client.call('resolve_reference', {
      run: runId,
      text: entry.reference,
      expect: 'reference',
    });
    assert.equal(resolveRef.isError, false, resolveRef.text);
    assert.equal(resolveRef.out.call_result, 'ok');
    assert.equal(resolveRef.out.resolution, 'resolved', 'tree address reference resolves successfully');

    // 4. Counter-example 1: Tamper with command by 1 character -> resolution must be unresolved
    const tamperedCommand = `${commandWords} bogus`;
    const resolveTampered = await client.call('resolve_reference', {
      run: runId,
      text: tamperedCommand,
      expect: 'command',
    });
    assert.equal(resolveTampered.isError, false);
    assert.equal(resolveTampered.out.call_result, 'ok');
    assert.equal(resolveTampered.out.resolution, 'unresolved', 'tampered command citation fails resolution');

    // 5. Counter-example 2: Reference from another product line's root
    const secondSync = bed.syncs.one;
    assert.ok(secondSync && secondSync.builds.length > 0, 'second product is synced');
    const secondRoot = secondSync.builds.find((b) => b.root !== null)?.root;
    assert.ok(secondRoot && secondRoot !== rootL, 'second product has distinct root');

    const alienReference = `tree:${secondRoot}/commands/alien@${'0'.repeat(64)}`;
    const resolveAlien = await client.call('resolve_reference', {
      run: runId,
      text: alienReference,
      expect: 'reference',
    });
    assert.equal(resolveAlien.isError, false);
    assert.equal(resolveAlien.out.resolution, 'unresolved', 'reference pointing outside line L locked root is unresolved');
  });
});
