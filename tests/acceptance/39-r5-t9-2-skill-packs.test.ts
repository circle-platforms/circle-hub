// T9-2: a missing parser skill is named, installation lets the reference resolve, and the locked digest still does after uninstall.
// One test so the four packs share one registry without overlapping installs. Synthetic documents only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { sha256Hex } from '../../hub/refs/canonical-json.ts';
import { createSkillParserRegistry, bindLegacyParser, resolveReference, verifyQuote } from '../../hub/refs/api.ts';
import { openPackTestbed, type PackTestbed } from '../../hub/runs/packs/testing/setup.ts';
import { temporaryDirectory, writePack, type PackDescription } from '../../hub/runs/packs/testing/builder.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';

let postgres: TemporaryPostgres;
let bed: PackTestbed;

before(async () => {
  postgres = await startPostgres();
  bed = await openPackTestbed({ postgres });
  await bed.kit.authorizations.grantPublishRight(bed.admin, bed.admin.id, '合成技能发布');
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

async function documentOf(pack: string): Promise<{ parser: string; mediaType: string; quote: string; bytes: Buffer; selector: string }> {
  if (pack === 'mindmap-format') return {
    parser: 'kityminder@1', mediaType: 'application/json', quote: '合成用例', selector: 'n/case1',
    bytes: Buffer.from(JSON.stringify({ root: { data: { id: 'root', text: '合成脑图' }, children: [{ data: { id: 'case1', text: '合成用例', resource: ['function'] }, children: [] }] } })),
  };
  if (pack === 'workbook-format') {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('工作表一');
    sheet.addRow(['标题', '数量']);
    sheet.addRow(['合成用例', 42]);
    return { parser: 'xlsx@1', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', quote: '合成用例', selector: 'c/工作表一/A2', bytes: Buffer.from(await book.xlsx.writeBuffer()) };
  }
  if (pack === 'xml-format') return {
    parser: 'xml@1', mediaType: 'application/xml', quote: 'IP or hostname', selector: 'x/commands/scope/menu/item/arguments/arg/@help',
    bytes: Buffer.from('<commands><scope name="global"><menu name="system"><item name="ping"><arguments><arg name="host" help="IP or hostname"/></arguments></item></menu></scope></commands>'),
  };
  return {
    parser: 'html@1', mediaType: 'text/html', quote: 'link text', selector: 'a/0',
    bytes: Buffer.from('<html><head><title>Test</title></head><body><h2>Heading</h2><p>Paragraph with <a href="https://192.0.2.1/item">link text</a></p></body></html>'),
  };
}

async function publish(pack: string): Promise<{ version: string; digest: string }> {
  const root = fileURLToPath(new URL(`../../packs/skill/${pack}/`, import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, 'pack.json'), 'utf8')) as { id: string; version: string; kind: PackDescription['kind']; title: string; description: string; files: Array<{ path: string }> };
  const files: PackDescription['files'] = {};
  for (const row of manifest.files) files[row.path] = await readFile(join(root, row.path));
  const temp = await temporaryDirectory(`t9-${pack}-`);
  try {
    const staged = await writePack(join(temp.path, pack), { id: manifest.id, version: manifest.version, kind: manifest.kind, title: manifest.title, description: manifest.description, files });
    const outcome = await bed.registry.publish(bed.admin, staged.dir);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) throw new Error('publish');
    return { version: outcome.version.version, digest: outcome.version.digest };
  } finally {
    await temp.remove();
  }
}

test('mindmap, xlsx, xml and html skills are named when missing and old references keep the locked digest', async () => {
  for (const pack of ['mindmap-format', 'workbook-format', 'xml-format', 'html-format']) {
    const spec = await documentOf(pack);
    const published = await publish(pack);
    const options = () => ({ registry: bed.registry, records: bed.kit, sandbox: { requireOsIsolation: false } });
    const parsers = createSkillParserRegistry(options());
    await parsers.refresh!();
    const reference = `src:${sha256Hex(spec.bytes)}/${spec.parser}/${spec.selector}`;
    const read = () => ({ bytes: spec.bytes, mediaType: spec.mediaType, size: spec.bytes.length, readTier: 'model_readable' as const });
    const missing = await resolveReference(reference, { parsers, reader: { user: bed.bob.id, role: 'user' }, sources: { read } });
    assert.equal(missing.resolved, false, pack);
    if (missing.resolved) return;
    assert.equal(missing.code, 'SOURCE_UNAVAILABLE');
    assert.match(missing.message, new RegExp(spec.parser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(missing.message, /下一步/);
    await bed.registry.install(bed.admin, `${pack}@${published.version}`);
    const bound = await bindLegacyParser(options(), bed.admin, spec.parser, `${pack}@${published.version}`);
    assert.equal(bound.skill.digest, published.digest);
    await parsers.refresh!();
    const installed = await resolveReference(reference, { parsers, reader: { user: bed.bob.id, role: 'user' }, sources: { read } });
    assert.equal(installed.resolved, true, `${pack} ${JSON.stringify(installed)}`);
    if (!installed.resolved) return;
    assert.equal(verifyQuote(installed, spec.quote), true);
    await bed.registry.uninstall(bed.admin, pack);
    const restarted = createSkillParserRegistry(options());
    const lockedParsers = await restarted.forReference!(spec.parser);
    assert.equal(lockedParsers.get(spec.parser)?.skill_digest, published.digest);
    const locked = await resolveReference(reference, { parsers: restarted, reader: { user: bed.bob.id, role: 'user' }, sources: { read } });
    assert.equal(locked.resolved, true, `${pack} ${JSON.stringify(locked)}`);
    if (!locked.resolved) return;
    assert.match(locked.note ?? '', /事后声明/);
    assert.equal(verifyQuote(locked, spec.quote), true);
  }
});
