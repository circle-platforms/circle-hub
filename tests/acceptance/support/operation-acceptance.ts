import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { KnowledgeContributionView } from '../../../contracts/src/contributions.ts';
import { startPostgres } from '../../../hub/testing/postgres.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import {
  SESSION, enable, hookInput, scratch, skill,
} from '../../../packs/workflow/knowledge-contribution/testing/operation-support.ts';
import { sessionDirectory } from '../../../packs/workflow/knowledge-contribution/tools/operation-capture/lib/common.ts';
import { readEvents, type CaptureEvent, type UploadEvent } from '../../../packs/workflow/knowledge-contribution/tools/operation-capture/lib/state.ts';
import type { SourceArtifact } from '../../../hub/records/api.ts';
import { openBed, type Bed } from './hub.ts';
import type { McpClient } from './mcp.ts';

export async function openOperationWorld(t: TestContext, options: { captureUrl?: string; manual?: boolean } = {}) {
  if (!await osIsolationAvailable()) {
    t.skip('sandbox-exec 不可用；未验证真实 Hub 沙箱验收');
    return null;
  }
  const postgres = await startPostgres();
  let bed: Bed | undefined;
  t.after(async () => {
    await bed?.close();
    await postgres.stop();
  });
  bed = await openBed({ postgres, syncOneName: options.manual === true });
  await bed.hub.assignPack(bed.reviewer.principal, 'knowledge-contribution');
  const local = await scratch(t);
  if (options.captureUrl === undefined) await writeFile(local.tokenFile, `${bed.reviewer.token}\n`, { mode: 0o600 });
  assert.equal((await enable(local, options.captureUrl ?? bed.hub.mcpUrl)).code, 0);
  const client = await bed.connect(bed.reviewer, SESSION);
  const sync = options.manual === true ? bed.syncs.one : bed.syncs.two;
  const build = options.manual === true ? bed.store.RELEASED : bed.site.RELEASED;
  const produced = sync?.builds.find(row => row.name === build && row.outcome === 'produced' && row.root !== null);
  assert.ok(produced?.root, 'the target synthetic build has a locked root');
  return {
    bed, local, client, root: produced.root, session: SESSION,
    product: options.manual === true ? bed.second.names[0] : bed.product.names[0],
    productId: options.manual === true ? bed.second.line : bed.product.line,
    build,
  };
}

export type OperationWorld = NonNullable<Awaited<ReturnType<typeof openOperationWorld>>>;

export async function commandTarget(client: McpClient, root: string, path?: string): Promise<{ path: string; command: string }> {
  const page = await client.call('get_nodes', { root, paths: ['/commands'], depth: 6 });
  assert.equal(page.isError, false, page.text);
  for (const node of page.out.nodes ?? []) {
    if (path !== undefined && node.path !== path) continue;
    for (const entry of node.entries) {
      const words = (entry.data as { words?: unknown } | undefined)?.words;
      if (Array.isArray(words) && words.every(word => typeof word === 'string')) return { path: node.path, command: words.join(' ') };
    }
  }
  assert.fail('the locked command tree contains the requested structured command');
}

export async function pageTarget(world: OperationWorld): Promise<string> {
  const page = await world.client.call('get_nodes', { root: world.root, paths: ['/'], depth: 6 });
  assert.equal(page.isError, false, page.text);
  const node = page.out.nodes?.find(row => row.entries.length > 0);
  assert.ok(node, 'the locked synthetic root has a knowledge node for the page procedure');
  return node.path;
}

export async function capture(
  world: OperationWorld,
  output: string,
  input: Record<string, unknown>,
  toolName = 'ssh',
): Promise<{ event: CaptureEvent; upload: UploadEvent; bytes: Buffer }> {
  const definition = JSON.parse(await readFile(join(world.local.skill, 'hooks.json'), 'utf8')).hooks.after_tool[0];
  const result = await hookInput(world.local, JSON.stringify({
    event: 'after_tool', session_id: world.session, cwd: '/synthetic/workspace',
    hook: definition.name, source: 'skill', source_label: 'operation-capture',
    tool_name: toolName, tool_input: input, paths: [], tool_output: output, tool_status: 'success',
  }));
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  const listed = await skill(world.local, ['list', '--session', world.session]);
  assert.equal(listed.code, 0, `${listed.out}\n${listed.err}`);
  const rows = JSON.parse(listed.out) as Array<{ sequence: number }>;
  const sequence = rows.at(-1)?.sequence;
  const dir = sessionDirectory(world.session, { CIRCLE_HOME: world.local.home });
  const events = await readEvents(dir, world.session);
  const event = events.find(row => row.kind === 'capture' && row.sequence === sequence);
  assert.ok(event?.kind === 'capture', 'the capture is recorded in the scratch session');
  const upload = events.find(row => row.kind === 'upload' && row.capture === event.sequence);
  assert.ok(upload?.kind === 'upload', 'the capture has a verified upload event');
  const bytes = await readFile(join(dir, event.output.file));
  assert.deepEqual(bytes.toString('utf8'), output);
  return { event, upload, bytes };
}

export async function capturedArtifact(world: OperationWorld, event: CaptureEvent): Promise<SourceArtifact> {
  const rows = await world.bed.hub.records.artifacts.records(event.output.sha256);
  const artifact = rows.find(row =>
    row.body.provenance_type === 'client_captured' &&
    'upload' in row.body.origin && row.body.origin.upload.session === world.session &&
    row.body.author.user === world.bed.reviewer.user.id &&
    row.body.name === `circle-operation-${event.sequence}.txt`);
  assert.ok(artifact, 'the exact session capture is a client_captured upload');
  assert.equal(artifact.body.sha256, event.output.sha256);
  assert.equal(artifact.body.size, event.output.size);
  return artifact;
}

export function quote(event: CaptureEvent, line: number, text: string): { reference: string; text: string } {
  return { reference: `src:${event.output.sha256}/text@1/l/${line}`, text };
}

export async function integrate(world: OperationWorld, items: Array<Record<string, unknown>>): Promise<{
  acceptance: string; result: { run: string; contributions: { stored: Array<{ record: string }> } };
}> {
  const file = join(world.local.home, 'proposals.json');
  await writeFile(file, JSON.stringify({ schema: 'operation-integration@1', session: world.session, items }));
  const result = await skill(world.local, [
    'submit', '--session', world.session, '--proposals', file,
    '--product', world.product, '--build', world.build, '--model', 'integration-synthetic@1',
  ]);
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  assert.ok(!`${result.out}${result.err}`.includes(world.bed.reviewer.token));
  const receipts = (await readFile(join(sessionDirectory(world.session, { CIRCLE_HOME: world.local.home }), 'receipts.jsonl'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line));
  const receipt = receipts.at(-1)?.receipt;
  assert.equal(receipt?.acceptance, 'accepted', JSON.stringify(receipt));
  assert.ok(receipt.result.contributions.stored.length > 0);
  return receipt;
}

export async function startOperationRun(world: OperationWorld, captures: CaptureEvent[]): Promise<{ run: string; root: string }> {
  const manifest = await world.client.upload(
    new TextEncoder().encode(JSON.stringify({ items: [{ id: 'assertion', title: '合成操作断言' }] })),
    'synthetic-operation-manifest.json',
  );
  const started = await world.client.call('start_run', {
    pack: 'knowledge-contribution', product: world.product, build: world.build,
    inputs: {
      subject: { reference: manifest },
      originals: [...new Set(captures.map(event => `src:${event.output.sha256}`))].map(reference => ({ reference })),
    },
  });
  assert.equal(started.isError, false, started.text);
  assert.ok(started.out.run?.run);
  assert.equal(started.out.run.product, world.productId);
  assert.equal(started.out.run.root, world.root);
  return { run: started.out.run.run, root: world.root };
}

export async function nodeContributions(world: OperationWorld, path: string, client = world.client) {
  const page = await client.call('get_nodes', { root: world.root, paths: [path], depth: 0 });
  assert.equal(page.isError, false, page.text);
  return (page.out.nodes?.[0]?.contributions ?? []).map(row => KnowledgeContributionView.parse(row));
}

export async function contribution(world: OperationWorld, path: string, record: string, client = world.client) {
  const view = (await nodeContributions(world, path, client)).find(row => row.record === record);
  assert.ok(view, `contribution ${record} is readable on ${path}`);
  assert.ok('statement' in view.contribution);
  return view as typeof view & { contribution: Extract<typeof view.contribution, { statement: string }> };
}
