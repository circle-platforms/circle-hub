// Every entry point runs unchanged in the Hub sandbox (hub/rules): only modules inside the pack are loaded at run time,
// the type imports are erased, and the output equals the direct call.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import commandTree from './command-tree.ts';
import commands from './commands.ts';
import ids from './ids.ts';
import listing from './listing.ts';
import locate from './locate.ts';
import manual from './manual.ts';
import releaseNotes from './release-notes.ts';
import selectBuild from './select-build.ts';
import planSync, { syncBuildsFunction } from './sync-plan.ts';
import { fixtureBytes, html, jsonDocument, markdown, xml } from '../testing/test-support.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

const famxModel = html(fixtureBytes('listing-famx.html'));
const builds = listing(famxModel).builds;
const cases: Array<{ module: string; export?: string; input: unknown; direct: (input: unknown) => unknown }> = [
  { module: 'functions/ids.ts', input: 'bug to case 61001 & 61002', direct: ids },
  { module: 'functions/locate.ts', input: ['030：产品测试项目', '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'], direct: locate },
  { module: 'functions/commands.ts', input: { text: '执行 `demo pool add p1 192.0.2.5 80` 后', heads: ['demo pool add'] }, direct: commands },
  { module: 'functions/listing.ts', input: famxModel, direct: listing },
  { module: 'functions/select-build.ts', input: { candidates: builds, line: '10.6.1' }, direct: selectBuild },
  { module: 'functions/sync-plan.ts', input: { index: html(fixtureBytes('index.html')) }, direct: planSync },
  { module: 'functions/sync-plan.ts', export: 'syncBuildsFunction', input: { builds, existingRoots: [] }, direct: syncBuildsFunction },
  { module: 'functions/command-tree.ts', input: xml(fixtureBytes('command-tree.xml')), direct: commandTree },
  { module: 'functions/manual.ts', input: jsonDocument(fixtureBytes('manual-catalog.json')).model, direct: manual },
  { module: 'functions/release-notes.ts', input: markdown(fixtureBytes('release-note.md')), direct: releaseNotes },
];

describe('pack functions in the Hub sandbox', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)' }, () => {
  for (const item of cases) {
    it(`${item.module}${item.export ? `#${item.export}` : ''} gives the same result as the direct call`, async () => {
      const result = await callPackFunction({ packDir, module: item.module, export: item.export }, item.input, { timeoutMs: 20_000 });
      assert.equal(result.osIsolation, true);
      assert.deepEqual(result.output, JSON.parse(JSON.stringify(item.direct(item.input))));
    });
  }
});
