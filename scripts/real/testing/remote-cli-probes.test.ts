import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { stage } from '../../../packs/workflow/case-compile/pack-files.ts';
import { verifyCliInvocations } from '../verify-tool-cli.ts';
import { buildRemoteCliProbes, REMOTE_CASE_COMPILE_TOOLS, REMOTE_RECOMPOSE_TOOLS } from './remote-cli-probes.ts';

async function stageRecompose(target: string): Promise<void> {
  const source = fileURLToPath(new URL('../../../packs/workflow/case-compile/recompose/', import.meta.url));
  const identity = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8'));
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  async function visit(relative: string) {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path !== 'pack.json' && !path.endsWith('.test.ts')) {
        const bytes = await readFile(join(source, path));
        await mkdir(join(target, relative), { recursive: true }); await cp(join(source, path), join(target, path));
        files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(''); await writeFile(join(target, 'pack.json'), JSON.stringify({ ...identity, files }));
}
async function selectRemoteInventory(directory: string, tools: readonly string[]) {
  const path = join(directory, 'pack.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files = manifest.files.filter((entry: { path: string }) => !entry.path.startsWith('tools/') || tools.includes(entry.path) || tools.some(tool => entry.path === tool.slice(0, -3) + '.cli.json'));
  await writeFile(path, JSON.stringify(manifest));
}

test('seven staged remote CLI tools accept synthetic stdin or reach a declared business check; empty stdin makes no HTTP request', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-cli-probes-'));
  try {
    const cc = await stage(join(root, 'case-compile')), rc = join(root, 'recompose'); await stageRecompose(rc);
    const fixture = await buildRemoteCliProbes(cc, rc, join(root, 'work'));
    try {
      for (const [directory, tools, probes] of [[cc, REMOTE_CASE_COMPILE_TOOLS, fixture.caseCompile], [rc, REMOTE_RECOMPOSE_TOOLS, fixture.recompose]] as const) {
        for (const tool of tools) {
          const probe = probes[tool][0], before = (await fixture.receipts()).length;
          const empty = spawnSync(process.execPath, [join(directory, tool), ...probe.argv], { cwd: probe.cwd, input: '', encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 30_000 });
          assert.equal(empty.error, undefined, tool); assert.equal(empty.status, 1, tool);
          assert.equal(empty.stdout, '', tool); assert.equal(empty.stderr, probe.empty!.stderr, tool);
          assert.equal((await fixture.receipts()).length, before, `${tool}: empty stdin must stop before HTTP`);
        }
      }
      await selectRemoteInventory(cc, REMOTE_CASE_COMPILE_TOOLS); await selectRemoteInventory(rc, REMOTE_RECOMPOSE_TOOLS);
      assert.deepEqual(verifyCliInvocations(cc, new Set(), fixture.caseCompile), { declarations: 5, invocations: 5, processes: 10 });
      assert.deepEqual(verifyCliInvocations(rc, new Set(), fixture.recompose), { declarations: 2, invocations: 2, processes: 4 });
      const receipts = await fixture.receipts();
      assert.ok(receipts.every(value => value.authorized), 'all complete probes use only the explicit synthetic credential');
      assert.equal(receipts.filter(value => value.path.endsWith('/jobs') && value.path.includes('run_01cccc')).length, 1, 'delivery reached the declared empty-jobs business check');
      assert.equal(receipts.filter(value => value.method === 'POST').length, 2, 'both submission commands reached the loopback MCP responder');
      assert.ok(receipts.some(value => value.path.endsWith('/run')), 'download and submission metadata was actually requested');
      assert.ok(receipts.some(value => value.path.includes('/sources/')), 'original source bytes were actually requested');
    } finally { await fixture.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
