import { createHash } from 'node:crypto';
import FORMAT from '../../../packs/skill/runner-workbook/functions/modules/workbook-writer/format.json' with { type: 'json' };
import { readTemplate, TemplateError, type TemplateBook, type TemplateDoc } from '../../../packs/skill/runner-workbook/functions/modules/workbook-writer/workbook-template.ts';
import { zipStore } from '../../../packs/skill/runner-workbook/functions/modules/workbook-writer/zip-store.ts';

const xmlText = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function rebindTemplate(book: TemplateBook, runtimeVersion: string, contractIdentity: string): TemplateDoc {
  const template = readTemplate(book);
  const start = template.sheet.indexOf('<row r="1"');
  const end = template.sheet.indexOf('</row>', start) + '</row>'.length;
  let first = template.sheet.slice(start, end);
  for (const [column, value] of [['B', runtimeVersion], ['C', contractIdentity]]) {
    const cell = new RegExp(`(<c r="${column}1"[^>]*><is><t[^>]*>)[\\s\\S]*?(</t></is>)`);
    if (!cell.test(first)) throw new TemplateError(`运行器模板第一行缺少可替换的 ${column}1 身份格`);
    first = first.replace(cell, (_match, open: string, close: string) => open + xmlText(value) + close);
  }
  const sheet = Buffer.from(template.sheet.slice(0, start) + first + template.sheet.slice(end), 'utf8');
  const bytes = zipStore(template.members.map(member => member.name === FORMAT.worksheet_part ? { name: member.name, bytes: sheet } : member));
  const result = { sha256: createHash('sha256').update(bytes).digest('hex'), xlsx_base64: Buffer.from(bytes).toString('base64') };
  const rebound = readTemplate({ ...book, template: result });
  if (rebound.identity[1] !== runtimeVersion || rebound.identity[2] !== contractIdentity) throw new TemplateError('更新后的模板身份与指定执行器规则不一致');
  return result;
}
