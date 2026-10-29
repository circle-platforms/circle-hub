import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedPacks, packsOfPaths, preparationPlan, preparePacks, versionWarning } from './prepare-packs.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-pack-prepare-'));
  const pack = (name: string, script: 'api.ts' | 'pack-files.ts' | null) => {
    const path = join(root, 'packs/workflow', name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'pack.json'), JSON.stringify({ id: name, version: '1.0.0', files: [] }));
    if (script) writeFileSync(join(path, script), `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./called.txt', import.meta.url), process.argv[2]);`);
    return path;
  };
  return { root, pack, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('changed paths identify package directories once without inspecting file content', () => {
  assert.deepEqual(packsOfPaths(['docs/readme.md', 'packs/workflow/example/a.ts', 'packs/workflow/example/tools/a.ts', 'packs/skill/parser/pack.json', 'packs/workflow']), ['packs/skill/parser', 'packs/workflow/example']);
});

test('each declared pack uses its own generator and invalid lists do not prepare any pack', () => {
  const f = fixture();
  try {
    const first = f.pack('first', 'pack-files.ts'), second = f.pack('second', 'api.ts'), missing = f.pack('missing', null);
    assert.deepEqual(preparationPlan([first, second, first], f.root, {}).map(row => row.args), [['--write'], ['sign']]);
    assert.throws(() => preparePacks([first, missing], { root: f.root, shared: {} }), /没有声明/);
    assert.throws(() => readFileSync(join(first, 'called.txt')));
    preparePacks([first, second], { root: f.root, shared: {} });
    assert.equal(readFileSync(join(first, 'called.txt'), 'utf8'), '--write');
    assert.equal(readFileSync(join(second, 'called.txt'), 'utf8'), 'sign');
    assert.throws(() => preparationPlan([f.root], f.root, {}), /包目录/);
  } finally { f.close(); }
});

test('a shared owner is used only for its explicitly declared directory', () => {
  const f = fixture();
  try {
    const path = f.pack('shared', null);
    assert.deepEqual(preparationPlan([path], f.root, { shared: path })[0].args, ['sign', 'shared']);
    assert.throws(() => preparationPlan([path], f.root, {}), /没有声明/);
  } finally { f.close(); }
});

test('the version warning distinguishes changed content, unchanged content and a new version', () => {
  const old = JSON.stringify({ version: '1.0.0', files: [{ path: 'a', sha256: 'a' }] });
  assert.equal(versionWarning(old, JSON.stringify({ version: '1.0.0', files: [{ path: 'a', sha256: 'b' }] })), true);
  assert.equal(versionWarning(old, old), false);
  assert.equal(versionWarning(old, JSON.stringify({ version: '1.0.0', title: 'new title', files: [{ path: 'a', sha256: 'a' }] })), true);
  assert.equal(versionWarning(old, JSON.stringify({ files: [{ sha256: 'a', path: 'a' }], version: '1.0.0' })), false);
  assert.equal(versionWarning(old, JSON.stringify({ version: '1.0.1', files: [{ path: 'a', sha256: 'b' }] })), false);
  assert.equal(versionWarning(null, old), false);
});

test('changed mode sees committed-base changes and untracked package files', () => {
  const f = fixture();
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  try {
    f.pack('first', 'pack-files.ts'); f.pack('second', 'api.ts');
    git('init', '-q'); git('add', 'packs/workflow/first/pack.json', 'packs/workflow/first/pack-files.ts', 'packs/workflow/second/pack.json', 'packs/workflow/second/api.ts');
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qsm', 'Create synthetic fixture');
    git('mv', 'packs/workflow/first/pack-files.ts', 'packs/workflow/second/moved.ts');
    f.pack('third', 'api.ts');
    assert.deepEqual(changedPacks('HEAD', f.root), ['packs/workflow/first', 'packs/workflow/second', 'packs/workflow/third']);
    assert.throws(() => changedPacks('--bad-revision', f.root), /基线/);
  } finally { f.close(); }
});
