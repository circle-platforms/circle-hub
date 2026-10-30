import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyReferenceArchive,
  type SourceManifest,
} from './verify-reference-archive.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'circle-hub-reference-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  execFileSync('git', ['init', '--quiet', source]);
  const originals = ['node.ts', 'node/a.ts', '层级/资料.md'];
  for (const [index, path] of originals.entries()) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), `source ${index}\r\n原始字节\n`);
  }
  execFileSync('git', ['-C', source, 'add', '--', ...originals]);
  const tree = execFileSync('git', ['-C', source, 'write-tree'], {
    encoding: 'utf8',
  }).trim();
  const manifest: SourceManifest = {
    schemaVersion: '1.0.0',
    sources: {},
    files: [],
  };
  for (const [name, prefix] of [['circle', 'foundation/circle']]) {
    manifest.sources[name] = {
      repository: 'synthetic fixture',
      commit: 'a'.repeat(40),
      tree,
      completeSnapshot: true,
    };
    for (const path of originals) {
      const bytes = readFileSync(join(source, path));
      const destination = `${prefix}/${path}`;
      mkdirSync(dirname(join(root, destination)), { recursive: true });
      writeFileSync(join(root, destination), bytes);
      manifest.files.push({
        source: name,
        sourcePath: path,
        destination,
        mode: '100644',
        gitBlob: execFileSync('git', ['hash-object', '--stdin'], {
          input: bytes,
          encoding: 'utf8',
        }).trim(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        owner: 'A',
        related: [],
        status: 'unmodified-source-baseline',
      });
    }
  }
  return { root, manifest };
}
test('the actual archive reconstructs the complete Circle source Git tree', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = verifyReferenceArchive(root);
  assert.equal(result.files, 287);
  assert.deepEqual(Object.keys(result.sources), ['circle']);
  assert.equal(result.sources.circle.files, 287);
});
test('Git independently confirms tree ordering, Unicode paths and CRLF bytes', (t) => {
  const f = fixture(t);
  assert.equal(verifyReferenceArchive(f.root, f.manifest).files, 3);
});
test('changed source bytes fail without changing their expected receipt', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, f.manifest.files[0].destination), 'changed\n');
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /source bytes changed/,
  );
});
test('new unregistered files cannot silently become part of an archive', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'foundation/circle/extra.ts'), 'extra');
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /unregistered archive file/,
  );
});
test('placement cannot escape the frozen archive', (t) => {
  const f = fixture(t);
  f.manifest.files[0].destination = '../outside';
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /invalid archive path/,
  );
});
test('a reference cannot promote itself to implemented or replace its source tree', (t) => {
  const f = fixture(t);
  f.manifest.files[0].status = 'implemented';
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /production availability/,
  );
  f.manifest.files[0].status = 'unmodified-source-baseline';
  f.manifest.sources.circle.tree = 'b'.repeat(40);
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /source tree mismatch/,
  );
});
test('a symlink cannot replace the approved archive root', (t) => {
  const f = fixture(t);
  const path = join(f.root, 'foundation/circle');
  const moved = join(f.root, 'moved-circle');
  const files = f.manifest.files.filter((file) => file.source === 'circle');
  for (const file of files) {
    const target = join(moved, file.sourcePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(f.root, file.destination)));
  }
  rmSync(path, { recursive: true });
  symlinkSync(moved, path, 'dir');
  assert.throws(
    () => verifyReferenceArchive(f.root, f.manifest),
    /ordinary directory/,
  );
});

test('the Circle baseline is the only archive source a manifest may declare', (t) => {
  const f = fixture(t);
  f.manifest.sources['synthetic-archive'] = f.manifest.sources.circle;
  assert.throws(() => verifyReferenceArchive(f.root, f.manifest), /invalid source manifest/);
  delete f.manifest.sources['synthetic-archive'];
  f.manifest.files[0].source = 'synthetic-archive';
  assert.throws(() => verifyReferenceArchive(f.root, f.manifest), /invalid or duplicate source placement/);
});
