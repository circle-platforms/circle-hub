// Scenario 27 (acceptance): checks read bound sources by declared role (reads: { roles: [...] }).
// A check declaring reads receives bound sources matching that role in its sources input.
// A check without reads does not receive bound sources.
// An oversized source exceeding max_bytes appears in unread_sources instead of sources.
// Sources are read along the same path as get_nodes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ValidationResult } from '../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';

describe('scenario 27: checks read bound sources by declaration', () => {
  let postgres: TemporaryPostgres;
  let bed: Bed;
  let client: McpClient;
  let packRoot: string;

  const PROJECTION = `export default function project(_input: unknown): unknown {
  return {
    items: [{ id: 'item-1', label: '条目一', location: { slot: 'subject', parser: 'json@1', selector: 'p' }, fields: {} }],
    warnings: [],
  };
}
`;

  const WORKFLOW = {
    schema: 'workflow@1',
    inputs: [
      { slot: 'subject', role: 'subject', description: '被评审对象', accepts: ['application/json'], required: true, many: false },
      { slot: 'guide', role: 'expected', description: '期望规程', accepts: ['application/json'], required: true, many: false },
    ],
    parameters: [],
    product: { catalogs: [] },
    subject: 'subject',
    projection: { module: 'functions/project.ts' },
  };

  const REQUIREMENTS = {
    schema: 'requirements@1',
    requirements: [
      { key: 'req_reads', name: '读来源检查', description: '声明 reads', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['check_reads'], error_handling: [] },
      { key: 'req_plain', name: '不读来源检查', description: '未声明 reads', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['check_plain'], error_handling: [] },
    ],
  };

  const CHECKS = {
    schema: 'checks@1',
    checks: [
      {
        id: 'check_reads',
        title: '读来源检查',
        function: { module: 'functions/check-reads.ts' },
        reads: { roles: ['expected'] },
        applies: 'run',
        judges: 'subject',
        tier: 'advisory',
      },
      {
        id: 'check_plain',
        title: '不读来源检查',
        function: { module: 'functions/check-plain.ts' },
        applies: 'run',
        judges: 'subject',
        tier: 'advisory',
      },
    ],
  };

  const FUNCTION_READS = `export default function (input: { subject?: { refuse?: boolean }; sources: Record<string, string>; unread_sources?: Array<{ reference: string; reason: string }> }) {
  if (input.subject?.refuse === true) {
    return [{ verdict: 'refute', code: 'toy-check-reads.sample_refute', statement: '样例反驳', grounds: [], tier: 'advisory' }];
  }
  const keys = Object.keys(input.sources ?? {});
  const unread = input.unread_sources ?? [];
  return [{
    verdict: 'support',
    statement: \`已读来源 \${keys.length} 份，未读 \${unread.length} 份\`,
    grounds: [],
    tier: 'advisory',
    data: { source_keys: keys, unread_sources: unread },
  }];
}
`;

  const FUNCTION_PLAIN = `export default function (input: { subject?: { refuse?: boolean }; sources: Record<string, string>; unread_sources?: Array<{ reference: string; reason: string }> }) {
  if (input.subject?.refuse === true) {
    return [{ verdict: 'refute', code: 'toy-check-reads.sample_refute', statement: '样例反驳', grounds: [], tier: 'advisory' }];
  }
  const keys = Object.keys(input.sources ?? {});
  const unread = input.unread_sources ?? [];
  return [{
    verdict: 'support',
    statement: \`普通检查看到来源 \${keys.length} 份\`,
    grounds: [],
    tier: 'advisory',
    data: { source_keys: keys, unread_sources: unread },
  }];
}
`;

  before(async () => {
    postgres = await startPostgres();
    bed = await openBed({ postgres, plm: false });
    packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-accept-check-reads-'));
    const dir = join(packRoot, 'toy-check-reads-1.0.0');

    await mkdir(join(dir, 'functions'), { recursive: true });
    await writeFile(join(dir, 'workflow.json'), `${JSON.stringify(WORKFLOW, null, 2)}\n`);
    await writeFile(join(dir, 'requirements.json'), `${JSON.stringify(REQUIREMENTS, null, 2)}\n`);
    await writeFile(join(dir, 'slots.schema.json'), `${JSON.stringify({ schema: 'slots@1', item: {}, run: {} }, null, 2)}\n`);
    await writeFile(join(dir, 'SKILL.md'), '# 合成检查读取来源测试包\n\n测试检查按声明读取绑定来源。\n');
    await writeFile(join(dir, 'checks.json'), `${JSON.stringify(CHECKS, null, 2)}\n`);
    await writeFile(join(dir, 'functions', 'project.ts'), PROJECTION);
    await writeFile(join(dir, 'functions', 'check-reads.ts'), FUNCTION_READS);
    await writeFile(join(dir, 'functions', 'check-plain.ts'), FUNCTION_PLAIN);

    // Samples for both checks
    await mkdir(join(dir, 'samples', 'positive'), { recursive: true });
    await mkdir(join(dir, 'samples', 'negative'), { recursive: true });
    const writeSample = (folder: string, name: string, sample: unknown) =>
      writeFile(join(dir, 'samples', folder, `${name}.json`), `${JSON.stringify(sample, null, 2)}\n`);

    await writeSample('positive', 'reads_pos', {
      id: 'reads_pos',
      source: 'author',
      check: 'check_reads',
      note: '正例',
      subject: { items: [], context: {} },
      sources: { 'src:0000000000000000000000000000000000000000000000000000000000000001': '{"k":1}' },
      expect: [{ verdict: 'support', tier: 'advisory' }],
    });
    await writeSample('negative', 'reads_neg', {
      id: 'reads_neg',
      source: 'author',
      check: 'check_reads',
      note: '反例',
      subject: { refuse: true },
      expect: [{ verdict: 'refute', code: 'toy-check-reads.sample_refute', tier: 'advisory' }],
    });
    await writeSample('positive', 'plain_pos', {
      id: 'plain_pos',
      source: 'author',
      check: 'check_plain',
      note: '正例',
      subject: { items: [], context: {} },
      expect: [{ verdict: 'support', tier: 'advisory' }],
    });
    await writeSample('negative', 'plain_neg', {
      id: 'plain_neg',
      source: 'author',
      check: 'check_plain',
      note: '反例',
      subject: { refuse: true },
      expect: [{ verdict: 'refute', code: 'toy-check-reads.sample_refute', tier: 'advisory' }],
    });

    const paths: string[] = [];
    const walk = async (base: string): Promise<void> => {
      for (const entry of await readdir(join(dir, base), { withFileTypes: true })) {
        const rel = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else paths.push(rel);
      }
    };
    await walk('');
    const files = await Promise.all(
      paths.sort().map(async (path) => {
        const bytes = new Uint8Array(await readFile(join(dir, path)));
        return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      }),
    );
    await writeFile(join(dir, 'pack.json'), `${JSON.stringify({ schema: 'pack@1', id: 'toy-check-reads', version: '1.0.0', kind: 'workflow', title: '合成读来源测试包', description: '测试用', files }, null, 2)}\n`);

    await bed.hub.publishPack(dir);
    await bed.hub.assignPack(bed.reviewer.principal, 'toy-check-reads');
    client = await bed.connect(bed.reviewer, 'sess-s27-check-reads');
  });

  after(async () => {
    await bed?.close();
    await rm(packRoot, { recursive: true, force: true });
    await postgres?.stop();
  });

  test('check declaring reads receives bound expected sources, while check without reads does not', async () => {
    const uploadGuide = await client.call('upload_file', {
      name: 'guide.json',
      media_type: 'application/json',
      file_path: Buffer.from(JSON.stringify({ rule: 'strict_mode', version: 2 })).toString('base64'),
    });
    assert.equal(uploadGuide.isError, false, uploadGuide.text);
    const guideRef = (uploadGuide.out as { reference: string }).reference;

    const uploadSubject = await client.call('upload_file', {
      name: 'subject.json',
      media_type: 'application/json',
      file_path: Buffer.from(JSON.stringify({ name: 'target-item' })).toString('base64'),
    });
    assert.equal(uploadSubject.isError, false, uploadSubject.text);
    const subjectRef = (uploadSubject.out as { reference: string }).reference;

    const start = await client.call('start_run', {
      pack: 'toy-check-reads',
      inputs: {
        subject: { reference: subjectRef },
        guide: { reference: guideRef },
      },
    });
    assert.equal(start.isError, false, start.text);
    const resultRef = (start.out as { result?: { reference: string } }).result?.reference;
    assert.ok(resultRef);

    // Read the validation result via get_nodes
    const readResult = await client.call('get_nodes', { reference: resultRef });
    assert.equal(readResult.isError, false, readResult.text);
    const content = (readResult.out as { content: { text: string } }).content.text;
    const validation = ValidationResult.parse(JSON.parse(content));

    const claimReads = validation.cross_item.find((c) => c.requirement === 'req_reads');
    assert.ok(claimReads);
    const dataReads = claimReads.statement.data as { source_keys: string[]; unread_sources: unknown[] };
    assert.ok(dataReads.source_keys.includes(guideRef), `expected ${guideRef} to be in check_reads sources`);
    assert.equal(dataReads.unread_sources.length, 0);

    const claimPlain = validation.cross_item.find((c) => c.requirement === 'req_plain');
    assert.ok(claimPlain);
    const dataPlain = claimPlain.statement.data as { source_keys: string[]; unread_sources: unknown[] };
    assert.ok(!dataPlain.source_keys.includes(guideRef), `expected ${guideRef} NOT to be in check_plain sources`);

    // Verify reading the source via get_nodes along the same path
    const readGuide = await client.call('get_nodes', { reference: guideRef });
    assert.equal(readGuide.isError, false);
    const guideContent = (readGuide.out as { content: { readable: boolean; text: string } }).content;
    assert.equal(guideContent.readable, true);
    assert.match(guideContent.text, /strict_mode/);
  });

  test('oversized bound source exceeding core max bytes limit appears in unread_sources', async () => {
    // 1 MiB + 100 bytes payload
    const bigContent = JSON.stringify({ huge: 'x'.repeat(1024 * 1024 + 100) });
    const uploadBig = await client.call('upload_file', {
      name: 'big-guide.json',
      media_type: 'application/json',
      file_path: Buffer.from(bigContent).toString('base64'),
    });
    assert.equal(uploadBig.isError, false, uploadBig.text);
    const bigRef = (uploadBig.out as { reference: string }).reference;

    const uploadSubject = await client.call('upload_file', {
      name: 'subject-2.json',
      media_type: 'application/json',
      file_path: Buffer.from(JSON.stringify({ name: 'target-item-2' })).toString('base64'),
    });
    const subjectRef = (uploadSubject.out as { reference: string }).reference;

    const start = await client.call('start_run', {
      pack: 'toy-check-reads',
      inputs: {
        subject: { reference: subjectRef },
        guide: { reference: bigRef },
      },
    });
    assert.equal(start.isError, false, start.text);
    const resultRef = (start.out as { result?: { reference: string } }).result?.reference;
    assert.ok(resultRef);

    const readResult = await client.call('get_nodes', { reference: resultRef });
    const content = (readResult.out as { content: { text: string } }).content.text;
    const validation = ValidationResult.parse(JSON.parse(content));

    const claimReads = validation.cross_item.find((c) => c.requirement === 'req_reads');
    assert.ok(claimReads);
    const dataReads = claimReads.statement.data as { source_keys: string[]; unread_sources: Array<{ reference: string; reason: string; slot?: string }> };
    assert.ok(!dataReads.source_keys.includes(bigRef), 'oversized source must NOT be in sources');
    assert.equal(dataReads.unread_sources.length, 1);
    assert.equal(dataReads.unread_sources[0].reference, bigRef);
    assert.equal(dataReads.unread_sources[0].slot, 'guide');
    assert.equal(dataReads.unread_sources[0].reason, 'budget_exhausted');
  });
});
