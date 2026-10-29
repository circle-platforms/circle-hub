import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseModel } from './parse-model.ts';
import { stagePack as stageFormat } from '../../../workflow/case-review/packaging.ts';
import { classify } from '../../../workflow/template-gap/functions/classification.ts';
import { readTemplate } from '../../../workflow/template-gap/functions/template.ts';
import TABLE from '../../../workflow/template-gap/tables/template-v3.json' with { type: 'json' };
import { locateCandidates } from './locate-quotes.ts';

const node = (id: string, text: string, children: unknown[] = [], priority = 2) => ({ data: { id, text, priority, ...(id === 'a' || id === 'b' || id === 'nested' ? { resource: ['Functional'] } : {}) }, children });
const document = () => ({ root: node('root', '根', [node('a', '用例一', [node('step', '合成🧪 "输出"\\路径'), node('nested', '嵌套用例', [node('inside', '合成')])]), node('b', '用例二', [node('other', '合成 合成')])], 1) });

for (const double of [false, true]) test(`produce original byte evidence for escaped ${double ? 'double-encoded' : 'ordinary'} JSON`, () => {
  let raw = JSON.stringify(document()).replace('合成', '\\u5408\\u6210');
  if (double) raw = JSON.stringify(raw);
  const parsed = parseModel(Buffer.from(raw));
  const [result] = locateCandidates(raw, parsed, [{ item: 'd:a', selector: 'n/step', text: '合成🧪 "输出"\\路径' }]);
  assert.equal(result.quotes.length, 1);
  const quote = result.quotes[0];
  assert.equal(Buffer.from(raw).subarray(quote.identity.span.offset, quote.identity.span.offset + quote.identity.span.length).toString(), quote.text);
  assert.notEqual(quote.text, '合成🧪 "输出"\\路径', 'the submitted text names the encoded original bytes');
  const template = readTemplate(TABLE); assert.notEqual(typeof template, 'string');
  if (typeof template === 'string') throw new Error(template);
  const claim = { data: { item: 'd:a', category_id: 'audit_log', quote, producer: { model_id: 'synthetic', model_family_id: 'synthetic-family' } } };
  const outcome = classify(template, { sha256: parsed.source_sha256, model: parsed.model }, 'd', 'marked', [claim], { [`src:${parsed.source_sha256}`]: raw });
  assert.deepEqual(outcome.errors, []); assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.cases.find(row => row.id === 'd:a')?.categories, ['audit_log']);
});

test('ambiguity stays visible and the Hub rejects sibling, nested and wrong-source evidence', () => {
  const raw = JSON.stringify(document()), parsed = parseModel(Buffer.from(raw));
  const candidates = [
    { item: 'd:b', selector: 'n/other', text: '合成' },
    { item: 'd:a', selector: 'n/other', text: '合成' },
    { item: 'd:a', selector: 'n/inside', text: '合成' },
    { item: 'd:a', selector: 'n/step', text: '不存在' },
  ];
  const results = locateCandidates(raw, parsed, candidates);
  assert.deepEqual(results.map(row => row.quotes.length), [2, 2, 1, 0]);
  const template = readTemplate(TABLE); if (typeof template === 'string') throw new Error(template);
  for (const row of results.slice(1, 3)) {
    const claim = { data: { item: row.item, category_id: 'audit_log', quote: row.quotes[0], producer: { model_id: 'synthetic', model_family_id: 'synthetic-family' } } };
    assert.equal(classify(template, { sha256: parsed.source_sha256, model: parsed.model }, 'd', 'marked', [claim], { [`src:${parsed.source_sha256}`]: raw }).errors.length, 1, 'Hub rejects the other case or nested case');
  }
  assert.throws(() => locateCandidates(raw + ' ', parsed, candidates), /摘要/);
});

test('both installed tool entrypoints prepare the evidence without printing original text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synthetic-quote-tools-'));
  try {
    const source = join(dir, 'source.json'), model = join(dir, 'model.json'), candidates = join(dir, 'candidates.json'), output = join(dir, 'output.json');
    await writeFile(source, JSON.stringify(document()));
    await writeFile(candidates, JSON.stringify([{ item: 'd:a', selector: 'n/step', text: '合成🧪' }]));
    const skill = join(dir, 'mindmap-format');
    await stageFormat(fileURLToPath(new URL('../', import.meta.url)), skill);
    const parse = spawnSync(process.execPath, [join(skill, 'tools/parse-model.ts'), '--source', source, '--out', model], { encoding: 'utf8' });
    assert.equal(parse.status, 0, parse.stderr); assert.ok(!parse.stdout.includes('合成🧪'));
    const locate = spawnSync(process.execPath, [join(skill, 'tools/locate-quotes.ts'), '--source', source, '--model', model, '--candidates', candidates, '--out', output], { encoding: 'utf8' });
    assert.equal(locate.status, 0, locate.stderr); assert.ok(!locate.stdout.includes('合成🧪'));
    assert.equal(JSON.parse(await readFile(output, 'utf8'))[0].quotes.length, 1);
    const repeat = spawnSync(process.execPath, [join(skill, 'tools/locate-quotes.ts'), '--source', source, '--model', model, '--candidates', candidates, '--out', output], { encoding: 'utf8' });
    assert.notEqual(repeat.status, 0, 'the output never overwrites an existing file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
