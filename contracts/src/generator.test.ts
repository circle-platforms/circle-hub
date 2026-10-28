// (b) The generated files are current and deterministic; tools/gen-contracts.ts reports drift and bad input clearly.
// Mutations run on a temporary copy of contracts/ so the repository is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drift, generate, LOCK_FILE, REPO_ROOT, validateInputs } from '../../tools/gen-contracts.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, args: string[], cwd = repo) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
/** Runs an ES module given as text in a fresh Node process. */
const evaluate = (code: string, args: string[] = [], maxBuffer: number = 16 * 1024 * 1024) => spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: repo, encoding: 'utf8', maxBuffer });

/** Every file under a directory, by relative name. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, snapshot(join(dir, e.name), `${prefix}${e.name}/`));
    else out[`${prefix}${e.name}`] = readFileSync(join(dir, e.name), 'utf8');
  }
  return out;
}

test('the repository generated files match the model (same as --check)', () => {
  const result = run(join(repo, 'tools', 'gen-contracts.ts'), ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contracts\/generated matches the model \(\d+ files\)/);
});

test('generate() in this process equals the files on disk', async () => {
  const files = await generate(REPO_ROOT);
  assert.deepEqual(drift(REPO_ROOT, files), []);
  for (const name of ['vocabulary.ts', 'protocol.ts', 'tools.json']) assert.ok(name in files, `${name} is generated`);
  assert.ok(Object.keys(files).some((n) => n.startsWith('schemas/')), 'schemas are generated');
});

test('validateInputs accepts the model and the codes as they are', () => {
  const model = JSON.parse(readFileSync(join(repo, 'contracts', 'model.json'), 'utf8'));
  const codes = JSON.parse(readFileSync(join(repo, 'contracts', 'codes.json'), 'utf8'));
  assert.deepEqual(validateInputs(model, codes), []);
});

describe('on a temporary copy', () => {
  let root = '';
  let script = '';
  const generated = (name: string): string => join(root, 'contracts', 'generated', name);
  const editJson = (path: string, edit: (value: any) => void): void => {
    const file = join(root, path);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    edit(value);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const axis = (name: string, label = '合成轴') => ({ axis: name, label, owner: 'B01', values: [{ code: 'one', label: '一' }] });
  /** A current copy: regenerated first, so the tests do not depend on whether the repository was regenerated after a stub changed. */
  const fresh = (): void => {
    rmSync(join(root, 'contracts'), { recursive: true, force: true });
    cpSync(join(repo, 'contracts'), join(root, 'contracts'), { recursive: true });
    rmSync(generated(LOCK_FILE), { force: true });
    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'hub-contracts-'));
    mkdirSync(join(root, 'tools'));
    cpSync(join(repo, 'tools', 'gen-contracts.ts'), join(root, 'tools', 'gen-contracts.ts'));
    cpSync(join(repo, 'tools', 'slot-schema.ts'), join(root, 'tools', 'slot-schema.ts'));
    writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    // The generator also reads the declared resource-tag table and writes package-local vocabulary snapshots and copied
    // schema tables under packs/, so the copy carries them; drift and the written/removed counts include those files.
    cpSync(join(repo, 'packs'), join(root, 'packs'), { recursive: true });
    script = join(root, 'tools', 'gen-contracts.ts');
  });
  after(() => {
    if (existsSync(generated(''))) chmodSync(generated(''), 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  test('--check lists every missing, out-of-date and stale file, then a write repairs all of them', () => {
    fresh();
    writeFileSync(generated('vocabulary.ts'), `${readFileSync(generated('vocabulary.ts'), 'utf8')}// edited by hand\n`);
    writeFileSync(generated('tools.json'), readFileSync(generated('tools.json'), 'utf8').replace('"list_task_packs"', '"list_packs"'));
    unlinkSync(generated('schemas/claim.v1.schema.json'));
    writeFileSync(generated('schemas/old.v1.schema.json'), '{}\n');
    writeFileSync(generated('notes.txt'), 'stray\n');

    const check = run(script, ['--check'], root);
    assert.equal(check.status, 1);
    const lines = check.stderr.split('\n').map((l) => l.trim());
    assert.ok(lines.some((l) => /^out of date: contracts\/generated\/vocabulary\.ts \(first difference at line \d+\)$/.test(l)), check.stderr);
    assert.ok(lines.some((l) => /^out of date: contracts\/generated\/tools\.json \(first difference at line \d+\)$/.test(l)), check.stderr);
    assert.ok(lines.includes('missing: contracts/generated/schemas/claim.v1.schema.json'), check.stderr);
    assert.ok(lines.includes('stale: contracts/generated/schemas/old.v1.schema.json'), check.stderr);
    assert.ok(lines.includes('stale: contracts/generated/notes.txt'), check.stderr);
    assert.match(check.stderr, /does not match the model \(5 files\)/);

    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /3 written, 2 removed/);
    assert.equal(existsSync(generated('schemas/old.v1.schema.json')), false);
    assert.equal(existsSync(generated('notes.txt')), false);
    assert.equal(existsSync(generated(LOCK_FILE)), false, 'the lock is released');
    const again = run(script, ['--check'], root);
    assert.equal(again.status, 0, again.stderr);
  });

  test('generation starts from nothing when contracts/generated is absent', () => {
    fresh();
    rmSync(join(root, 'contracts', 'generated'), { recursive: true, force: true });
    const check = run(script, ['--check'], root);
    assert.equal(check.status, 1);
    assert.ok(check.stderr.includes('missing: contracts/generated/vocabulary.ts'), check.stderr);
    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
    assert.equal(run(script, ['--check'], root).status, 0);
    for (const name of ['vocabulary.ts', 'protocol.ts']) {
      assert.equal(readFileSync(generated(name), 'utf8'), readFileSync(join(repo, 'contracts', 'generated', name), 'utf8'), `${name} equals the repository copy`);
    }
  });

  test('two runs in fresh processes write the same bytes', () => {
    fresh();
    const first = snapshot(generated(''));
    rmSync(join(root, 'contracts', 'generated'), { recursive: true, force: true });
    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
    assert.deepEqual(snapshot(generated('')), first);
    assert.deepEqual(first, snapshot(join(repo, 'contracts', 'generated')), 'and the bytes in the repository');
  });

  test('a second generate() in the same process sees a changed source', async () => {
    fresh();
    const before = await generate(root);
    const tools = join(root, 'contracts', 'src', 'tools.ts');
    writeFileSync(tools, readFileSync(tools, 'utf8').replace("title: 'List task packs'", "title: 'List the task packs'"));
    const after = await generate(root);
    assert.ok(before['tools.json'].includes('"List task packs"'));
    assert.ok(after['tools.json'].includes('"List the task packs"'), 'the second call loads contracts/src afresh');
    assert.equal(after['vocabulary.ts'], before['vocabulary.ts']);
  });

  test('generate() through a symbolic link to the root works, also without contracts/generated', () => {
    fresh();
    const expected = snapshot(generated(''));
    rmSync(join(root, 'contracts', 'generated'), { recursive: true, force: true });
    const link = `${root}-link`;
    symlinkSync(root, link, 'dir');
    try {
      const output = join(root, 'linked-generated.json');
      const code = `import { generate } from ${JSON.stringify(pathToFileURL(join(repo, 'tools', 'gen-contracts.ts')).href)};
        import {writeFileSync} from 'node:fs';
        writeFileSync(process.argv[2],JSON.stringify(await generate(process.argv[1])));`;
      // Keep the exact snapshot comparison independent of stdout size and bound unexpected child output.
      const result = evaluate(code, [link,output], Buffer.byteLength(JSON.stringify(expected))+1024);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(output,'utf8')), expected);
    } finally {
      unlinkSync(link);
    }
  });

  test('a vocabulary change converges in one run: tools.json is rendered with the new vocabulary', () => {
    fresh();
    editJson('contracts/model.json', (m) => m.vocabulary.find((a: { axis: string }) => a.axis === 'pack_kind').values.push({ code: 'sample', label: '样例包' }));
    assert.equal(run(script, ['--check'], root).status, 1);
    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
    assert.equal(run(script, ['--check'], root).status, 0);
    const tools = JSON.parse(readFileSync(generated('tools.json'), 'utf8')) as { name: string; inputSchema: { properties: { kind: { enum: string[] } } } }[];
    assert.ok(tools.find((t) => t.name === 'list_task_packs')?.inputSchema.properties.kind.enum.includes('sample'));
    assert.match(readFileSync(generated('vocabulary.ts'), 'utf8'), /export const PACK_KIND = \[[^\]]*'sample'\] as const;/);
  });

  test('invalid model content is reported problem by problem with exit status 2, nothing is written', () => {
    fresh();
    let layerIndex=-1;
    editJson('contracts/model.json', (m) => {
      layerIndex=m.vocabulary.findIndex((a:{axis:string})=>a.axis==='layer');
      const layer = m.vocabulary[layerIndex];
      layer.values.push({ ...layer.values[0] });
      layer.owner = 'Z99';
      m.formatProposals.protocolCodes.push({ code: 'bad code', when: 'when', fix: '' });
    });
    editJson('contracts/codes.json', (c) => c.codes.push({ code: 'core.catalog.extra', interpreter: 'range', when: '说明', fix: '改正' }));
    const before = readFileSync(generated('vocabulary.ts'), 'utf8');
    const result = run(script, [], root);
    assert.equal(result.status, 2);
    for (const expected of [
      `vocabulary[${layerIndex}] (layer): code static appears twice`,
      `vocabulary[${layerIndex}] (layer): label 静态 appears twice`,
      'owner "Z99" is not an element id of the model',
      'code "bad code" must be UPPER_SNAKE_CASE',
      '(bad code): when must be Chinese text',
      '(bad code): fix must be Chinese text',
      'interpreter must be catalog, the middle segment of the code',
    ]) {
      assert.ok(result.stderr.includes(expected), `missing ${JSON.stringify(expected)} in:\n${result.stderr}`);
    }
    assert.equal(readFileSync(generated('vocabulary.ts'), 'utf8'), before);
  });

  test('an axis label that would end the doc comment, or a line separator in a label, is refused', () => {
    fresh();
    editJson('contracts/model.json', (m) => {
      m.vocabulary.find((a: { axis: string }) => a.axis === 'layer').label = '判定层 */ export const injected = globalThis.process?.pid; /*';
      m.vocabulary.find((a: { axis: string }) => a.axis === 'verdict').values[0].label = '支持 持';
    });
    const before = readFileSync(generated('vocabulary.ts'), 'utf8');
    const result = run(script, [], root);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\(layer\): label must not contain \*\//);
    assert.match(result.stderr, /\(verdict\)\.values\[0\]: label must be non-empty text without control characters/);
    assert.equal(readFileSync(generated('vocabulary.ts'), 'utf8'), before);
  });

  test('protocolCodes, packFiles and displayOrder of the wrong type are reported, not thrown', () => {
    fresh();
    editJson('contracts/model.json', (m) => {
      m.formatProposals.packFiles = 'pack.json';
      delete m.formatProposals.displayOrder;
    });
    const result = run(script, ['--check'], root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /formatProposals\.packFiles must be a non-empty array/);
    assert.match(result.stderr, /formatProposals\.displayOrder must be a non-empty array/);
    assert.doesNotMatch(result.stderr, /TypeError|    at /);
  });

  test('axes named after global types (record, readonly) still type-check', () => {
    fresh();
    editJson('contracts/model.json', (m) => m.vocabulary.push(axis('record', '记录轴'), axis('readonly', '只读轴')));
    const write = run(script, [], root);
    assert.equal(write.status, 0, write.stderr);
    assert.doesNotMatch(readFileSync(generated('vocabulary.ts'), 'utf8'), /\bRecord<|\bReadonly</);
    const tsc = spawnSync(
      process.execPath,
      [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--target', 'ES2024', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict',
        '--allowImportingTsExtensions', '--erasableSyntaxOnly', '--skipLibCheck', '--types', 'node', 'contracts/api.ts'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  });

  test('an axis whose names another module of the barrel exports is refused, naming both modules', () => {
    fresh();
    editJson('contracts/model.json', (m) => m.vocabulary.push(axis('coverage', '覆盖轴')));
    const result = run(script, ['--check'], root);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Coverage is exported by contracts\/generated\/vocabulary\.ts and contracts\/src\/common\.ts/);
    fresh();
    editJson('contracts/model.json', (m) => m.vocabulary.push(axis('record_kind', '记录种类轴')));
    const generatedClash = run(script, ['--check'], root);
    assert.equal(generatedClash.status, 2, generatedClash.stderr);
    assert.match(generatedClash.stderr, /axis record_kind renders RecordKind, which the generator itself declares/);
  });

  test('a reference scheme added to the model without a URI grammar stops the generator', () => {
    fresh();
    editJson('contracts/model.json', (m) => {
      m.vocabulary.find((a: { axis: string }) => a.axis === 'reference_scheme').values.push({ code: 'obs', label: '观察记录' });
      m.formatProposals.references.push({ scheme: 'obs', form: 'obs:<摘要>' });
    });
    const result = run(script, ['--check'], root);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /reference scheme obs has no URI grammar in contracts\/src\/reference\.ts/);
  });

  test('a lock held by a running process stops a write with exit status 3; a lock left by an ended process is taken over', () => {
    fresh();
    writeFileSync(generated(LOCK_FILE), `${process.pid}\n`);
    const held = run(script, [], root);
    assert.equal(held.status, 3, held.stderr);
    assert.match(held.stderr, new RegExp(`another gen-contracts run \\(pid ${process.pid}\\) is writing contracts/generated`));
    assert.equal(run(script, ['--check'], root).status, 0, '--check reads without the lock and ignores it');
    const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(generated(LOCK_FILE), `${ended.stdout}\n`);
    writeFileSync(generated(`.tools.json.${ended.stdout}.tmp`), 'partial');
    const takeover = run(script, [], root);
    assert.equal(takeover.status, 0, takeover.stderr);
    assert.equal(existsSync(generated(LOCK_FILE)), false);
    assert.equal(existsSync(generated(`.tools.json.${ended.stdout}.tmp`)), false, 'temporary files of the ended run are removed');
  });

  test('a directory that cannot be written gives exit status 3 and one line, not a stack', { skip: process.getuid?.() === 0 ? 'root ignores permissions' : false }, () => {
    fresh();
    writeFileSync(generated('tools.json'), '[]\n');
    chmodSync(generated(''), 0o555);
    try {
      const result = run(script, [], root);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /^cannot write contracts\/generated: /);
      assert.doesNotMatch(result.stderr, /    at /);
    } finally {
      chmodSync(generated(''), 0o755);
    }
  });

  test('unreadable input and unknown options are reported, not thrown', () => {
    fresh();
    writeFileSync(join(root, 'contracts', 'codes.json'), '{ "codes": [ }');
    const broken = run(script, ['--check'], root);
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /contracts\/codes\.json: not valid JSON/);
    fresh();
    const unknown = run(script, ['--chek'], root);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown argument: --chek/);
    assert.match(unknown.stderr, /usage: node tools\/gen-contracts\.ts \[--check\]/);
    const help = run(script, ['--help'], root);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);
  });

  test('a schema registered twice by two owners is refused with both files named', () => {
    fresh();
    const stub = join(root, 'contracts', 'src', 'knowledge.ts');
    writeFileSync(stub, "import { z } from 'zod';\nexport const schemas: Record<string, z.ZodType> = { 'claim@1': z.object({}) };\n");
    const result = run(script, ['--check'], root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /schema claim@1 is registered twice: contracts\/src\/index\.ts and contracts\/src\/knowledge\.ts/);
    writeFileSync(stub, "import { z } from 'zod';\nexport const schemas: Record<string, z.ZodType> = { '../escape@1': z.object({}) };\n");
    const unsafe = run(script, ['--check'], root);
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /schema key "\.\.\/escape@1" is not name@major/);
  });
});
