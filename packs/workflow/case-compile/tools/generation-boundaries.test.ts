import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { generationFixture } from '../testing/workbook.ts';
import { GenerationError, generateWorkbook } from '../functions/generate.ts';
import { CallFailure, callFailureData } from '../functions/text.ts';
import { readTemplate } from '../functions/generated/skills/runner-workbook/workbook-writer/workbook-template.ts';
import { main } from './generate-workbook.ts';

async function stderrOf(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const chunks: string[] = [], saved = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), text: chunks.join('') }; } finally { process.stderr.write = saved; }
}

test('generation errors keep their public identity and explicitly classify the declared input constraint', () => {
  const error = new GenerationError('/fields/title', 'synthetic generation fact', 'xstring_escape');
  assert.equal(error.name, 'GenerationError'); assert.equal(error.rule, 'xstring_escape'); assert.equal(error.pointer, '/fields/title');
  assert.equal(error.message, '/fields/title：synthetic generation fact');
  assert.ok(error instanceof CallFailure); assert.equal(callFailureData(error).category, 'invalid_parameters');
  const input = generationFixture(); input.fields.title = '=synthetic';
  assert.throws(() => generateWorkbook(input), (error: unknown) => error instanceof GenerationError && error.category === 'invalid_parameters' && error.path === error.pointer);
});

test('a readable template with an invalid ZIP member is refused at the declared template boundary', () => {
  const input = generationFixture(), original = input.profile.workbook.template!;
  const members = unzipSync(Buffer.from(original.xlsx_base64, 'base64')); members['../synthetic-extra'] = Buffer.from('synthetic');
  const bytes = zipSync(members);
  input.profile.workbook.template = { sha256: createHash('sha256').update(bytes).digest('hex'), xlsx_base64: Buffer.from(bytes).toString('base64') };
  assert.doesNotThrow(() => readTemplate(input.profile.workbook));
  assert.throws(() => generateWorkbook(input), (error: unknown) => error instanceof GenerationError && error.category === 'invalid_parameters' && error.pointer === '/profile/workbook/template' && error.message.includes('../synthetic-extra'));
});

test('workbook input reads retain the real flag and filesystem refusal instead of InputFileError', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-generation-files-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const args: string[] = [];
  for (const flag of ['run', 'result', 'submission', 'contract', 'profile', 'inventory']) { const path = join(scratch, flag + '.json'); args.push('--' + flag, flag === 'run' ? scratch : path); if (flag !== 'run') await writeFile(path, '{}'); }
  args.push('--out', join(scratch, 'new.xlsx'));
  const missing = await stderrOf(() => main(args));
  assert.equal(missing.code, 1); assert.match(missing.text, /^不存在：找不到 --run 目录里的 run\.json 文件/); assert.match(missing.text, /合法写法：--run/);
  await writeFile(join(scratch, 'run.json'), Buffer.from([0xff]));
  const encoding = await stderrOf(() => main(args));
  assert.equal(encoding.code, 1); assert.match(encoding.text, /^参数无效：--run/); assert.match(encoding.text, /UTF-8/);
  await writeFile(join(scratch, 'run.json'), '{');
  const syntax = await stderrOf(() => main(args));
  assert.equal(syntax.code, 1); assert.match(syntax.text, /^参数无效：--run/); assert.match(syntax.text, /JSON/);
  assert.doesNotMatch(missing.text + encoding.text + syntax.text, /缺少结构化错误原因/);
  const asFile = [...args]; asFile[asFile.indexOf('--run') + 1] = join(scratch, 'run.json');
  const file = await stderrOf(() => main(asFile));
  assert.equal(file.code, 1);
  assert.ok(file.text.startsWith(`参数无效：--run ${join(scratch, 'run.json')} 不是普通目录。`), file.text);
  assert.ok(file.text.trimEnd().endsWith("合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。"), file.text);
  assert.equal(file.text.trim().split('\n').length, 1);
});
