// The sandbox limits of skill parsing (PARSE_SANDBOX_LIMITS in skills.ts). A parse waits on purpose here, then runs the
// real xml-format parser in the sandbox: a slower machine than the one a document was tried on must not refuse it.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cp, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSkillParserRegistry} from './skills.ts';
import {parseDocument} from './parser.ts';
import type {PackRegistry} from '../runs/api.ts';
import type {RecordsKit} from '../records/api.ts';

const XML_FORMAT = fileURLToPath(new URL('../../packs/skill/xml-format/', import.meta.url));
const EARLIER_LIMIT_MS = 5000;

test('a skill parse that takes longer than the earlier 5 s limit still completes', {timeout: 120_000}, async t => {
  // The real path: macOS keeps the temporary directory behind a symbolic link, which sandbox-exec would not follow.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'skill-parse-limits-')));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await cp(XML_FORMAT, dir, {recursive: true, filter: source => !source.endsWith('.test.ts') && !source.includes(`${sep}testing`)});
  await writeFile(join(dir, 'functions', 'slow-parse.ts'), [
    "import parse from './parse.ts';",
    'export default async function slowParse(input: Parameters<typeof parse>[0]) {',
    `  await new Promise(resolve => setTimeout(resolve, ${EARLIER_LIMIT_MS + 500}));`,
    '  return parse(input);',
    '}',
    '',
  ].join('\n'));
  const skill = JSON.parse(await readFile(join(dir, 'skill.json'), 'utf8'));
  skill.parsers[0].function = {module: 'functions/slow-parse.ts', export: 'default'};
  const opened = {info: {id: 'xml-format', version: '1.0.3', digest: 'a'.repeat(64), manifest: {}}, declarations: {kind: 'skill', skill}, handle: {directory: dir}};
  const registry = {installedSkills: async () => [opened], open: async () => opened} as unknown as PackRegistry;
  const parsers = createSkillParserRegistry({registry, records: {} as RecordsKit, sandbox: {requireOsIsolation: false}});
  await parsers.refresh!();
  const parser = parsers.get('xml@1');
  assert.ok(parser);
  const started = performance.now();
  const document = await parseDocument(parser, Buffer.from('<r><a>synthetic</a></r>'));
  assert.ok(performance.now() - started > EARLIER_LIMIT_MS, 'the parse outlasted the earlier limit');
  assert.ok(await document.locate(document.listSelectors('')[0]));
});
