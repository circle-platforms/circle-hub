import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleFixture } from '../fixtures/module.ts';
import { verifyModule, freezeModule } from '../../packages/modules/src/verify.ts';
import { verifyProductLine } from '../../packages/methods/src/product-modules.ts';
import { MAX_SOURCE_BYTES, sha256 } from '../../packages/contracts/src/index.ts';
test('Module bytes: exact file set hashes manifest identity and sha256sum digest are verified without importing code', () => {
    for (const kind of ['skill-pack', 'product-line'] as const) {
        const input = moduleFixture(kind), verified = verifyModule(input.module, input.files);
        assert.deepEqual(verified.manifest, input.manifest);
        assert.equal(verified.module.digest, input.module.digest);
        assert.equal(verified.files.length, 4);
    }
});
test('Module filesystem: total byte budget bounds the frozen payload independently of each file size', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'circle-module-bound-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = moduleFixture(), folder = join(directory, fixture.module.root);
    await mkdir(join(folder, 'tests'), { recursive: true });
    await mkdir(join(folder, 'scripts'), { recursive: true });
    fixture.files.push({ path: 'large-a.bin', base64: Buffer.alloc(MAX_SOURCE_BYTES / 2).toString('base64'), sha256: sha256(Buffer.alloc(MAX_SOURCE_BYTES / 2)) }, { path: 'large-b.bin', base64: Buffer.alloc(MAX_SOURCE_BYTES / 2).toString('base64'), sha256: sha256(Buffer.alloc(MAX_SOURCE_BYTES / 2)) });
    fixture.module.files = fixture.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    fixture.module.digest = sha256(fixture.module.files.map(file => `${file.sha256}  ${file.path}\n`).join(''));
    for (const file of fixture.files)
        await writeFile(join(folder, file.path), Buffer.from(file.base64, 'base64'));
    await writeFile(join(directory, 'modules.json'), JSON.stringify({ schema: 'circle-packs/modules/1', modules: [fixture.module] }));
    await assert.rejects(freezeModule(join(directory, 'modules.json'), fixture.module.id), (error: any) => error.code === 'BODY_TOO_LARGE');
});
test('Module bytes: mismatches omissions extras duplicates unsafe roots and hidden paths cannot become an installation', () => {
    const fixture = moduleFixture();
    for (const input of [{ ...fixture, files: fixture.files.slice(1) }, { ...fixture, files: [...fixture.files, fixture.files[0]] }, { ...fixture, files: [...fixture.files, { path: 'extra.txt', base64: 'eA==', sha256: '0'.repeat(64) }] }, { ...fixture, files: fixture.files.map((file, index) => index === 0 ? { ...file, base64: 'eA==' } : file) }, { ...fixture, module: { ...fixture.module, digest: '0'.repeat(64) } }, { ...fixture, module: { ...fixture.module, id: 'different-id' } }, { ...fixture, module: { ...fixture.module, version: '9.0.0' } }, { ...fixture, module: { ...fixture.module, root: '../escape' } }, { ...fixture, module: { ...fixture.module, files: [...fixture.module.files].reverse() } }])
        assert.throws(() => verifyModule(input.module, input.files));
});
test('Module bytes: reversed paths and a bad digest are reported together', () => {
    const fixture = moduleFixture();
    const input = { ...fixture, module: { ...fixture.module, files: [...fixture.module.files].reverse(), digest: '0'.repeat(64) } };
    assert.throws(() => verifyModule(input.module, input.files), (error: any) => error.details.manifestErrors.length >= 2 && error.message.includes(';'));
});
test('Product line: every missing declared file is reported in one error', () => {
    const manifest = { schemaVersion: 'product-line/1', id: 'synthetic-line', version: '1.0.0', tools: [], hooks: [{ manifest: 'hooks/a.ts', event: 'beforeDispatch', order: 1 }, { manifest: 'hooks/b.ts', event: 'afterResult', order: 2 }], flows: ['flows/missing.json'], resources: [] };
    assert.throws(() => verifyProductLine(manifest, new Map()), (error: any) => error.code === 'SOURCE_HASH_MISMATCH' && error.details.manifestErrors.length >= 3 && error.message.includes(';'));
});
test('Module filesystem: freeze includes every nonhidden file and refuses symlinks extra files and changed bytes', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'circle-module-freeze-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = moduleFixture(), folder = join(directory, fixture.module.root);
    await mkdir(join(folder, 'tests'), { recursive: true });
    await mkdir(join(folder, 'scripts'), { recursive: true });
    for (const file of fixture.files)
        await writeFile(join(folder, file.path), Buffer.from(file.base64, 'base64'));
    await writeFile(join(folder, '.ignored'), 'synthetic hidden setting');
    await writeFile(join(directory, 'modules.json'), JSON.stringify({ schema: 'circle-packs/modules/1', modules: [fixture.module] }));
    const frozen = await freezeModule(join(directory, 'modules.json'), fixture.module.id);
    assert.equal(frozen.files.length, 4);
    assert.equal(frozen.module.digest, fixture.module.digest);
    await writeFile(join(folder, 'SKILL.md'), 'changed');
    assert.equal(frozen.files.find(file => file.path === 'SKILL.md')!.base64, fixture.files.find(file => file.path === 'SKILL.md')!.base64);
    await assert.rejects(freezeModule(join(directory, 'modules.json'), fixture.module.id));
    await writeFile(join(folder, 'SKILL.md'), Buffer.from(fixture.files.find(file => file.path === 'SKILL.md')!.base64, 'base64'));
    await symlink('SKILL.md', join(folder, 'linked.txt'));
    await assert.rejects(freezeModule(join(directory, 'modules.json'), fixture.module.id));
    await rm(join(folder, 'linked.txt'));
    await writeFile(join(folder, 'extra.txt'), 'unlisted');
    await assert.rejects(freezeModule(join(directory, 'modules.json'), fixture.module.id));
    assert.equal((await readFile(join(folder, 'tests/example.ts'), 'utf8')).startsWith('throw'), true);
});
