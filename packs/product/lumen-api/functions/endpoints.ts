// The producer of the Lumen API product (product@1 producers, ProducerInput -> ProducerOutput): the endpoint reference of a
// build (slot spec, markdown@1) -> one definition entry per endpoint at /endpoints/<METHOD>/<path segments>. An endpoint is
// a section titled `<METHOD> <path>`; its parameter table (name, type, values) gives the typed positional parameters of the
// catalog entry (catalog-entry@1 data: words, signatures, summary): an endpoint is cited as `<METHOD> <path> <values...>`.
// lumen-endpoint-parameters@2 (README): the exact header fixes eight named columns;
// optional is a JSON boolean, bounds are complete JSON nonnegative integers, enum values a JSON string array.
// Natural-language descriptions never determine a domain or optionality.
import type { ProducedEntry, ProducerOutput } from '../../../../contracts/src/product.ts';
import type { CatalogParamType } from '../../../../contracts/src/tables.ts';
import { asArray, asString, isRecord, tableRows } from './common.ts';

const PARSER = 'markdown@1';
const GRAMMAR={id:'lumen-endpoint-parameters@2',source:'product:lumen-api/README.md',complete:false};
const TITLE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_{}./-]*)$/;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_ENDPOINTS = 2000;

type Param = { name: string; type: Extract<CatalogParamType, 'int' | 'string' | 'enum' | 'port'>; optional?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; values?: string[] };

const PARAMETER_COLUMNS = ['name','type','optional','minimum','maximum','minLength','maxLength','values'] as const;
/** One complete typed row of the declared source schema, or its structural violation. */
export function paramOf(row: readonly string[]): Param | string {
  if(row.length!==PARAMETER_COLUMNS.length)return '缺 lumen-endpoint-parameters@2 的完整八列；下一步：来源作者在下次同步前补显式类型和 optional 布尔字段';
  const [name,type,optional,...tail]=row;
  if(!NAME.test(name))return '参数名不符合 schema';
  if(optional!=='true'&&optional!=='false')return 'optional 不是 JSON 布尔字段';
  if(type!=='int'&&type!=='port'&&type!=='string'&&type!=='enum')return 'type 不在本 schema 支持的精确类型闭集';
  const base:Param={name,type,optional:optional==='true'};
  for(let at=0;at<4;at++){
    const value=tail[at];if(value==='')continue;
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{return '约束不是完整 JSON 整数';}
    if(typeof parsed!=='number'||!Number.isSafeInteger(parsed)||parsed<0)return '约束不是非负安全整数';
    const key=PARAMETER_COLUMNS[at+3] as 'minimum'|'maximum'|'minLength'|'maxLength';
    if((key==='minimum'||key==='maximum')&&type!=='int'&&type!=='port'||(key==='minLength'||key==='maxLength')&&type!=='string')return '约束字段与声明类型不相容';
    base[key]=parsed;
  }
  if(base.minimum!==undefined&&base.maximum!==undefined&&base.minimum>base.maximum||base.minLength!==undefined&&base.maxLength!==undefined&&base.minLength>base.maxLength)return '约束上下界颠倒';
  const raw=tail[4];
  if(type==='enum'){
    let values:unknown;try{values=JSON.parse(raw);}catch{return '枚举不是完整 JSON 字符串数组';}
    if(!Array.isArray(values)||!values.length||values.some(v=>typeof v!=='string'||v.length===0)||new Set(values).size!==values.length)return '枚举值为空、重复或不是字符串';
    base.values=values;
  }else if(raw!=='')return '非枚举参数不得填 values';
  return base;
}

/** The tree path of an endpoint: /endpoints/<METHOD>/<segments> (braces kept, empty segments dropped). */
export function endpointPath(method: string, path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  return `/endpoints/${[method, ...segments].join('/')}`;
}

export function produceEndpoints(input: unknown): ProducerOutput {
  const slots = isRecord(input) && isRecord(input.slots) ? input.slots : {};
  const spec = isRecord(slots.spec) ? slots.spec : null;
  if (spec === null) return { grammar:GRAMMAR, entries: [], warnings: ['没有接口参考'] };
  if (spec.parser !== PARSER || !isRecord(spec.model)) return { entries: [], warnings: [`接口参考不是 Markdown（解析器 ${String(spec.parser)}）`] };
  const build = isRecord(input) && isRecord(input.build) && typeof input.build.name === 'string' ? input.build.name : null;
  const sections = asArray(spec.model.sections);
  const blocks = asArray(spec.model.blocks);
  const entries: ProducedEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (entries.length >= MAX_ENDPOINTS) {
      warnings.push(`接口超过 ${MAX_ENDPOINTS} 个，后面的没有读`);
      break;
    }
    if (!isRecord(section) || typeof section.selector !== 'string') continue;
    const m = TITLE.exec((asString(section.title) ?? '').trim());
    if (m === null) continue;
    const [, method, path] = m;
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      warnings.push(`接口 ${key} 写了两次，只取第一次`);
      continue;
    }
    seen.add(key);
    const own = asArray(section.blocks).map((k) => (typeof k === 'number' ? blocks[k] : undefined)).filter(isRecord);
    const summary = own.find((b) => b.kind === 'paragraph' && typeof b.text === 'string')?.text as string | undefined;
    const table = own.find((b) => b.kind === 'table' && typeof b.text === 'string');
    if(table===undefined){warnings.push(`${key}：缺显式参数表（零参数也须声明空表）；下一步由来源作者补完整参数结构后重产`);continue;}
    const params: Param[] = [];
    let invalid = false;
    if (table !== undefined) {
      const header = (table.text as string).split('\n')[0].split('|').slice(1,-1).map(cell=>cell.trim());
      if(header.length!==PARAMETER_COLUMNS.length||header.some((value,k)=>value!==PARAMETER_COLUMNS[k])){
        warnings.push(`${key}：缺声明的 lumen-endpoint-parameters@2 表头；下一步：来源作者在下次同步前补完整结构字段`);
        continue;
      }
      for (const row of tableRows(table.text as string)) {
        const param = paramOf(row);
        if (typeof param === 'string') {warnings.push(`${key}：${param}；下一步：来源作者在下次同步前修订结构字段后重产`);invalid=true;}
        else params.push(param);
      }
    }
    if(invalid)continue;
    const fragments = [{ parser: PARSER, selector: section.selector }, ...(table !== undefined && typeof table.selector === 'string' ? [{ parser: PARSER, selector: table.selector }] : [])];
    const signature = params.length === 0 ? '无参数' : params.map((p) => `${p.name}${p.optional ? '?' : ''}:${p.type}`).join(' ');
    entries.push({
      kind: 'definition',
      path: endpointPath(method, path),
      statement: `接口 ${key}：${signature}${summary ? `。${summary.slice(0, 200)}` : ''}`,
      data: { words: [method, path], signatures: [{ id: '1', params }], ...(summary ? { summary: summary.slice(0, 200) } : {}), form: 'endpoint' },
      fragments,
      applicability: build === null ? null : { builds: [build] },
    });
  }
  if (entries.length === 0) warnings.push('接口参考里没有 “<方法> <路径>” 形式的章节');
  return { grammar:{...GRAMMAR,complete:warnings.length===0}, entries, warnings };
}

export default function (input: unknown): unknown {
  try {
    return produceEndpoints(input);
  } catch {
    return { entries: [], warnings: ['接口参考的生产函数内部出错（任务包的缺陷）'] };
  }
}
