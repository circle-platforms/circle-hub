import {contributionSlots} from './slot-schema.ts';
// Generates everything that must not be written by hand from the cause model:
//   contracts/generated/vocabulary.ts      the one set of enumerations, with Chinese labels and zod enums
//   contracts/generated/protocol-codes.ts  machine tables: protocol and core violation code lists, categories, interpreters, record kinds, pack file names
//   contracts/generated/protocol.ts        human sentences and display layout, re-exporting protocol-codes.ts for compatibility
//   contracts/generated/tools.json         the six MCP tools with JSON Schemas and derived annotations
//   contracts/generated/schemas/*.json     JSON Schema of every registered record and pack-file shape
//   packs/.../functions/generated/vocabulary.ts  package-local runtime snapshots of the axes each pack uses
//   packs/skill/*-format/functions/generated/protocol.ts  declared subset of protocol code names per format skill pack
//   packs/product/famx/functions/generated/adoc-directory.ts  package-local copy of the adoc-format skill's directory
//   packs/.../functions/generated/skills/<skill>/<module>/  the skill modules a pack's pack.json embeds (T01 R[6])
//     walk (packs/skill/adoc-format/functions/directory.ts), since a sandboxed pack function reads only its own files
// Usage: node tools/gen-contracts.ts [--check]
//   without options it writes the files that changed and removes stale ones; --check writes nothing and lists every
//   missing, out-of-date or stale file. Exit status: 0 current, 1 drift found by --check, 2 invalid input, 3 the files
//   could not be written (another run holds the lock, or an I/O error).
// contracts/src is loaded against the freshly rendered vocabulary and protocol (served from memory), so one run converges;
// every call loads it afresh, so generate() always reflects the sources as they are at that moment.
// Writes hold contracts/generated/.gen-contracts.lock and replace each file by an atomic rename, so a reader never sees a
// partly written file and two runs never interleave.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import ts from 'typescript';

/** `ui`: the interface term of the console when it differs from the model's label (the console shows only it). */
type Value = { code: string; label: string; ui?: string };
type Axis = { axis: string; label: string; ui?: string; owner: string; values: Value[] };
type Model = {
  version: number;
  elements: { id: string }[];
  vocabulary: Axis[];
  formatProposals: {
    references: { scheme: string; form: string; example?: string; note?: string }[];
    protocolCodes: { code: string; when: string; fix: string; callErrorCategory: string | null }[];
    recordKinds: string[];
    packFiles: { path: string; content: string; elements: string[] }[];
    displayOrder: string[];
    sharedInterfaces?: unknown;
  };
};
type Codes = { codes: { code: string; interpreter: string; when: string; fix: string }[] };
type Tool = {
  name: string;
  title: string;
  description: string;
  input: unknown;
  output: unknown;
  effect: string;
  writesHubRecords: boolean;
  readsExternal?: boolean;
  idempotent?: boolean;
};
type Contracts = {
  TOOLS: Tool[];
  EFFECT_CLASS: readonly string[];
  SCHEMA_REGISTRY: Record<string, unknown>;
  annotationsFor: (effect: string, writesHubRecords: boolean, options?: { readsExternal?: boolean; idempotent?: boolean }) => Record<string, boolean>;
};

/** Invalid input: every problem found, one per line. */
export class ContractsError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ContractsError';
    this.problems = problems;
  }
}

/** The generated files could not be written (exit status 3). */
export class WriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteError';
  }
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_DIR = 'contracts/generated';
/** Runtime vocabulary snapshots shipped inside sandboxed packs. Only these model axes belong to each target. */
interface PackVocabularyTarget { axes: readonly string[]; labels?: boolean; resourceTags?: boolean; uiLabels?: boolean }
export const PACK_VOCABULARY_TARGETS: Readonly<Record<string, PackVocabularyTarget>> = {
  'packs/workflow/case-compile/authority/functions/generated/vocabulary.ts': {axes:['call_error_category'],labels:true},
  'packs/workflow/case-compile/recompose/functions/generated/vocabulary.ts': {axes:['call_error_category','verdict'],labels:true},
  'packs/workflow/case-compile/adjudicate/functions/generated/vocabulary.ts': {axes:['call_error_category'],labels:true},
  'packs/workflow/case-compile/functions/generated/vocabulary.ts': {axes:['expectation_basis','qualifier_mark','dynamic_terminal','acceptance','item_handling','attribution','exit_action','producer_kind','call_error_category','target'],labels:true,uiLabels:true},
  'packs/workflow/quality-board/functions/generated/vocabulary.ts': { axes: ['knowledge_count','declaration_status','judgment_status'], labels: true, resourceTags: true },
  'packs/product/famx/functions/generated/vocabulary.ts': { axes: ['applicability_field','declaration_status','judgment_status','type_declaration_status','command_parse_status','reason','release_status'], labels: true, resourceTags: true },
  'packs/workflow/case-review/functions/generated/vocabulary.ts': {axes:['declaration_status'],labels:true,resourceTags:true},
  'packs/workflow/case-review-verify/functions/generated/vocabulary.ts': {axes:['declaration_status'],labels:true,resourceTags:true},
  'packs/workflow/template-gap/functions/generated/vocabulary.ts': {axes:['declaration_status'],labels:true,resourceTags:true},
  'packs/workflow/defect-to-case/functions/generated/vocabulary.ts': {axes:['declaration_status','release_status'],labels:true,resourceTags:true},
  'packs/workflow/traceability/functions/generated/vocabulary.ts': {axes:['declaration_status','release_status'],labels:true},
  'packs/workflow/maintenance-sweep/functions/generated/vocabulary.ts': { axes: ['entry_kind', 'change_kind'] },
  'packs/workflow/regression-scope/functions/generated/vocabulary.ts': { axes: ['entry_kind', 'change_kind'] },
  'packs/workflow/case-review-report/functions/generated/vocabulary.ts': { axes: ['requirement_status', 'reason', 'static_terminal', 'dynamic_terminal', 'unsatisfied_reason', 'layer'], labels: true },
};

const RESOURCE_TAG_SOURCE = 'packs/workflow/case-review/tables/resource-tags.json';
function resourceTagSnapshot(root: string): {tableText:string;code:string} {
  const text=readFileSync(join(root,RESOURCE_TAG_SOURCE),'utf8');
  const table:unknown=JSON.parse(text);
  if(!isRecord(table)||Object.keys(table).some(key=>!['schema','id','version','origin','tags'].includes(key))||table.schema!=='resource-tags@1'||typeof table.id!=='string'||typeof table.version!=='string'||typeof table.origin!=='string'||!Array.isArray(table.tags)||table.tags.length===0||table.tags.length>1000)throw new ContractsError(['resource-tags@1: invalid declared table']);
  const ids=new Set<string>(),texts=new Set<string>();
  for(const tag of table.tags){
    if(!isRecord(tag)||Object.keys(tag).some(key=>!['id','text','label','test_type','negative'].includes(key))||typeof tag.id!=='string'||tag.id.length===0||typeof tag.text!=='string'||tag.text.length===0||tag.text.length>200||typeof tag.label!=='string'||typeof tag.test_type!=='boolean'||typeof tag.negative!=='boolean'||tag.negative&&!tag.test_type)throw new ContractsError(['resource-tags@1: invalid declared member']);
    if(ids.has(tag.id)||texts.has(tag.text))throw new ContractsError(['resource-tags@1: ids and exact texts must each be unique']);
    ids.add(tag.id);texts.add(tag.text);
  }
  const source={id:table.id,version:table.version,sha256:createHash('sha256').update(text).digest('hex')};
  const code=`\n// Business values come only from the published package table; they are not core vocabulary axes.
export const RESOURCE_TAG_TABLE = ${JSON.stringify(source)} as const;
export const RESOURCE_TAGS = ${JSON.stringify(table.tags)} as const;
for(const tag of RESOURCE_TAGS)Object.freeze(tag);Object.freeze(RESOURCE_TAGS);
export type ResourceTag = (typeof RESOURCE_TAGS)[number];
export type ResourceTagId = ResourceTag['id'];
export type TestTypeId = Extract<ResourceTag,{test_type:true}>['id'];
export const TEST_TYPE_IDS = RESOURCE_TAGS.filter(tag=>tag.test_type).map(tag=>tag.id) as readonly TestTypeId[];
export const RESOURCE_TAG_TEXTS = Object.freeze(RESOURCE_TAGS.map(tag=>tag.text));
Object.freeze(TEST_TYPE_IDS);
export const TEST_TYPE_LABELS = Object.fromEntries(RESOURCE_TAGS.filter(tag=>tag.test_type).map(tag=>[tag.id,tag.label])) as Record<TestTypeId,string>;
export function declaredResourceTag(value:unknown):ResourceTag|null { return typeof value==='string'?RESOURCE_TAGS.find(tag=>tag.text===value)??null:null; }
export interface ResourceTagIssue { index:number|null; raw:unknown; allowed:readonly string[] }
export interface ResourceTagDeclaration {
  table:typeof RESOURCE_TAG_TABLE; status:DeclarationStatus; valid:boolean; present:boolean; raw:unknown;
  ids:ResourceTagId[]; types:TestTypeId[]; negative:boolean|null; issues:ResourceTagIssue[];
  missing:string|null; next_action:string|null;
}
export function declareResourceTags(value:unknown):ResourceTagDeclaration {
  const present=value!==undefined;
  const values=value===undefined?[]:Array.isArray(value)?value:[];
  const issues:ResourceTagIssue[]=present&&!Array.isArray(value)?[{index:null,raw:value,allowed:RESOURCE_TAG_TEXTS}]:[];
  const matched:ResourceTag[]=[];
  values.forEach((raw,index)=>{const tag=declaredResourceTag(raw);if(tag===null)issues.push({index,raw,allowed:RESOURCE_TAG_TEXTS});else matched.push(tag);});
  const valid=issues.length===0;
  const ids=RESOURCE_TAGS.filter(tag=>matched.some(found=>found.id===tag.id)).map(tag=>tag.id);
  const types=valid?TEST_TYPE_IDS.filter(id=>ids.includes(id)):[];
  const status:DeclarationStatus=types.length>0?'declared':'undeclared';
  return {table:RESOURCE_TAG_TABLE,status,valid,present,raw:value===undefined?null:value,ids,types,
    negative:status==='declared'?matched.some(tag=>tag.negative):null,issues,
    missing:status==='declared'?null:'缺少有效的作者测试类型声明：resource 必须只含发布闭集的精确标签，且至少包含一项测试类型',
    next_action:status==='declared'?null:'作者从发布闭集选择精确原文修改 resource 后重新核验；确需其他标签时由包作者发布扩展闭集的新版本'};
}
`;
  return {tableText:text,code};
}

/** Package-local runtime targets, rendered from the same model values as contracts/generated/vocabulary.ts. */
export function packVocabularyFiles(root: string = REPO_ROOT): Record<string, string> {
  const model = JSON.parse(readFileSync(join(root, 'contracts/model.json'), 'utf8')) as Model;
  const files: Record<string, string> = {};
  for (const [path, target] of Object.entries(PACK_VOCABULARY_TARGETS)) {
    const names = target.axes;
    const out = ['// 生成物，勿手改。Generated by tools/gen-contracts.ts from the contracts/generated vocabulary source.\n'];
    for (const name of names) {
      const axis = model.vocabulary.find(axis => axis.axis === name);
      if (axis === undefined) throw new ContractsError([`${path}: unknown vocabulary axis ${name}`]);
      const constant = upper(name), type = pascal(name);
      out.push(`export const ${constant} = [${axis.values.map(v => q(v.code)).join(', ')}] as const;\n`);
      out.push(`export type ${type} = (typeof ${constant})[number];\n`);
      if (!target.labels && name === 'change_kind') out.push(`export const ${constant}_LABEL: Readonly<Record<${type}, string>> = ${JSON.stringify(Object.fromEntries(axis.values.map(v => [v.code, v.label])))};\n`);
      if (target.labels) {
        out.push(`export const ${constant}_LABEL = { ${axis.values.map(v => `${q(v.code)}: ${q(target.uiLabels ? (v.ui ?? v.label) : v.label)}`).join(', ')} } as const satisfies Record<${type}, string>;\n`);
        out.push(`export function is${type}(value: unknown): value is ${type} { return typeof value === 'string' && (${constant} as readonly string[]).includes(value); }\n`);
      }
    }
    if (target.labels) {
      out.push(`export interface AxisValues { ${names.map(name => `${name}: ${pascal(name)};`).join(' ')} }\n`);
      out.push('export type AxisName = keyof AxisValues;\n');
      out.push(`const LABELS: { [A in AxisName]: Record<AxisValues[A], string> } = { ${names.map(name => `${name}: ${upper(name)}_LABEL`).join(', ')} };\n`);
      out.push('export function labelOf<A extends AxisName>(axis: A, code: AxisValues[A]): string { return LABELS[axis][code]; }\n');
    }
    if(target.resourceTags){
      const tags=resourceTagSnapshot(root);out.push(tags.code);
      const destination=path.slice(0,path.indexOf('/functions/'))+'/tables/resource-tags.json';
      if(destination!==RESOURCE_TAG_SOURCE)files[destination]=tags.tableText;
    }
    files[path] = out.join('');
  }
  return files;
}

/** Held in contracts/generated while a run writes; holds the writer's pid. */
export const LOCK_FILE = '.gen-contracts.lock';
const TEMP_FILE = /^\..+\.[0-9]+\.tmp$/;
const HEADER = '// Generated by tools/gen-contracts.ts from contracts/model.json and contracts/codes.json. Do not edit.\n';
const IDENT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ELEMENT_ID = /^[A-Z][0-9]{2}$/;
const PROTOCOL_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const CORE_CODE = /^core\.([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SCHEMA_ID = /^([a-z][a-z0-9_-]*)@(0|[1-9][0-9]*)$/;
const CJK = /[\u3400-\u9fff]/;
/** C0 and C1 controls and the two line separators that end a line comment in JavaScript. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !CONTROL.test(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const pascal = (s: string): string => s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const upper = (s: string): string => s.toUpperCase();
/** Single-quoted TypeScript string literal. */
const q = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;

function readJson(root: string, path: string, problems: string[]): unknown {
  const file = join(root, path);
  if (!existsSync(file)) {
    problems.push(`${path}: file not found`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${path}: not valid JSON (${(error as Error).message})`);
    return undefined;
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) (seen.has(v) ? out : seen).add(v);
  return [...out];
}

/** Every structural problem of the two inputs; empty when the generator can render them. */
export function validateInputs(model: unknown, codes: unknown): string[] {
  const p: string[] = [];
  const M = 'contracts/model.json';
  if (!isRecord(model)) return [`${M}: the top level must be an object`];
  if (!Number.isInteger(model.version) || (model.version as number) < 1) p.push(`${M}: version must be a positive integer`);
  const elementIds = new Set(list(model.elements).flatMap((e) => (isRecord(e) && typeof e.id === 'string' ? [e.id] : [])));
  if (!Array.isArray(model.vocabulary) || model.vocabulary.length === 0) p.push(`${M}: vocabulary must be a non-empty array`);
  const axes: string[] = [];
  list(model.vocabulary).forEach((a, i) => {
    const at = `${M}: vocabulary[${i}]`;
    if (!isRecord(a)) {
      p.push(`${at} must be an object`);
      return;
    }
    const name = typeof a.axis === 'string' ? a.axis : '';
    if (IDENT.test(name)) axes.push(name);
    else p.push(`${at}: axis ${JSON.stringify(a.axis)} must be snake_case`);
    if (!isText(a.label)) p.push(`${at} (${name}): label must be non-empty text without control characters`);
    // The axis label is written into a doc comment of vocabulary.ts.
    else if (a.label.includes('*/')) p.push(`${at} (${name}): label must not contain */`);
    if (a.ui !== undefined && (!isText(a.ui) || a.ui === a.label)) p.push(`${at} (${name}): ui must be non-empty text that differs from the label`);
    if (typeof a.owner !== 'string' || !ELEMENT_ID.test(a.owner) || !elementIds.has(a.owner)) p.push(`${at} (${name}): owner ${JSON.stringify(a.owner)} is not an element id of the model`);
    if (!Array.isArray(a.values) || a.values.length === 0) {
      p.push(`${at} (${name}): values must be a non-empty array`);
      return;
    }
    const codesOf: string[] = [];
    const labelsOf: string[] = [];
    const termsOf: string[] = [];
    a.values.forEach((v, j) => {
      const vat = `${at} (${name}).values[${j}]`;
      if (!isRecord(v)) {
        p.push(`${vat} must be an object`);
        return;
      }
      if (typeof v.code === 'string' && IDENT.test(v.code)) codesOf.push(v.code);
      else p.push(`${vat}: code ${JSON.stringify(v.code)} must be snake_case`);
      if (isText(v.label)) labelsOf.push(v.label);
      else p.push(`${vat}: label must be non-empty text without control characters`);
      if (v.ui !== undefined && (!isText(v.ui) || v.ui === v.label)) p.push(`${vat}: ui must be non-empty text that differs from the label`);
      else if (isText(v.ui ?? v.label)) termsOf.push((v.ui ?? v.label) as string);
    });
    for (const d of duplicates(codesOf)) p.push(`${at} (${name}): code ${d} appears twice`);
    for (const d of duplicates(labelsOf)) p.push(`${at} (${name}): label ${d} appears twice`);
    // Two codes of one axis must never look the same on the console either.
    for (const d of duplicates(termsOf)) p.push(`${at} (${name}): interface term ${d} appears twice`);
  });
  for (const d of duplicates(axes)) p.push(`${M}: axis ${d} appears twice`);
  p.push(...identifierClashes(axes));

  const f = model.formatProposals;
  if (!isRecord(f)) {
    p.push(`${M}: formatProposals must be an object`);
  } else {
    const schemes = list(f.references).map((r, i) => {
      if (!isRecord(r) || typeof r.scheme !== 'string' || !IDENT.test(r.scheme) || !isText(r.form)) p.push(`${M}: formatProposals.references[${i}] needs a snake_case scheme and a form`);
      return isRecord(r) ? String(r.scheme) : '';
    });
    for (const d of duplicates(schemes)) p.push(`${M}: reference scheme ${d} appears twice`);
    const axis = list(model.vocabulary).find((a) => isRecord(a) && a.axis === 'reference_scheme');
    const vocab = isRecord(axis) ? list(axis.values).map((v) => (isRecord(v) ? String(v.code) : '')) : [];
    if (vocab.join() !== schemes.join()) p.push(`${M}: formatProposals.references schemes [${schemes}] must equal the reference_scheme axis [${vocab}] in order`);
    const protocol: string[] = [];
    const callErrorAxis = list(model.vocabulary).find(a => isRecord(a) && a.axis === 'call_error_category');
    if (!isRecord(callErrorAxis)) p.push(`${M}: call_error_category vocabulary axis is required`);
    const callErrorCategories = new Set(isRecord(callErrorAxis) ? list(callErrorAxis.values).map(v => isRecord(v) ? v.code : undefined) : []);
    list(f.protocolCodes).forEach((c, i) => {
      const at = `${M}: formatProposals.protocolCodes[${i}]`;
      if (!isRecord(c)) {
        p.push(`${at} must be an object`);
        return;
      }
      if (typeof c.code !== 'string' || !PROTOCOL_CODE.test(c.code)) p.push(`${at}: code ${JSON.stringify(c.code)} must be UPPER_SNAKE_CASE`);
      if (!isText(c.when) || !CJK.test(c.when)) p.push(`${at} (${String(c.code)}): when must be Chinese text`);
      if (!isText(c.fix) || !CJK.test(c.fix)) p.push(`${at} (${String(c.code)}): fix must be Chinese text`);
      if (!Object.hasOwn(c, 'callErrorCategory') || c.callErrorCategory !== null && !callErrorCategories.has(c.callErrorCategory)) p.push(`${at} (${String(c.code)}): callErrorCategory must explicitly be null or a call_error_category value`);
      protocol.push(String(c.code));
    });
    if (protocol.length === 0) p.push(`${M}: formatProposals.protocolCodes must be a non-empty array`);
    for (const d of duplicates(protocol)) p.push(`${M}: protocol code ${d} appears twice`);
    const kinds = list(f.recordKinds).map(String);
    if (kinds.length === 0) p.push(`${M}: formatProposals.recordKinds must be a non-empty array`);
    for (const k of kinds) if (!IDENT.test(k)) p.push(`${M}: record kind ${JSON.stringify(k)} must be snake_case`);
    for (const d of duplicates(kinds)) p.push(`${M}: record kind ${d} appears twice`);
    if (!Array.isArray(f.packFiles) || f.packFiles.length === 0) p.push(`${M}: formatProposals.packFiles must be a non-empty array`);
    const paths = list(f.packFiles).map((x, i) => {
      if (!isRecord(x) || !isText(x.path)) p.push(`${M}: formatProposals.packFiles[${i}] needs a path`);
      return isRecord(x) ? String(x.path) : '';
    });
    for (const d of duplicates(paths)) p.push(`${M}: pack file ${d} appears twice`);
    if (!Array.isArray(f.displayOrder) || f.displayOrder.length === 0) p.push(`${M}: formatProposals.displayOrder must be a non-empty array`);
    list(f.displayOrder).forEach((x, i) => {
      if (!isText(x)) p.push(`${M}: formatProposals.displayOrder[${i}] must be non-empty text`);
    });
  }

  const C = 'contracts/codes.json';
  if (!isRecord(codes) || !Array.isArray(codes.codes)) {
    p.push(`${C}: must be an object with a codes array`);
  } else {
    const seen: string[] = [];
    codes.codes.forEach((c, i) => {
      const at = `${C}: codes[${i}]`;
      if (!isRecord(c)) {
        p.push(`${at} must be an object`);
        return;
      }
      const m = typeof c.code === 'string' ? CORE_CODE.exec(c.code) : null;
      if (!m) p.push(`${at}: code ${JSON.stringify(c.code)} must be core.<interpreter>.<name> in snake_case`);
      else if (c.interpreter !== m[1]) p.push(`${at} (${c.code}): interpreter must be ${m[1]}, the middle segment of the code`);
      if (!isText(c.when) || !CJK.test(c.when)) p.push(`${at} (${String(c.code)}): when must be Chinese text`);
      if (!isText(c.fix) || !CJK.test(c.fix)) p.push(`${at} (${String(c.code)}): fix must be Chinese text`);
      seen.push(String(c.code));
    });
    for (const d of duplicates(seen)) p.push(`${C}: code ${d} appears twice`);
  }
  try { renderSharedInterfaces(model); } catch (error) { p.push(...(error instanceof ContractsError ? error.problems : [(error as Error).message])); }
  return p;
}

/** Names the generator itself declares in vocabulary.ts and protocol-codes.ts/protocol.ts; index.ts re-exports both with export *. */
const FIXED_VALUES = ['AXES', 'LABELS', 'labelOf', 'axisLabel', 'UI_LABELS', 'uiLabelOf', 'axisUiLabel', 'z', 'PROTOCOL_CODES', 'PROTOCOL_CODE_NAMES', 'isProtocolCode', 'CORE_VIOLATION_CODES', 'CORE_VIOLATION_CODE_NAMES', 'CORE_VIOLATION_CODE_INTERPRETERS', 'isCoreViolationCode', 'REFERENCE_FORMS', 'RECORD_KINDS', 'PACK_FILE_PATHS', 'DISPLAY_ORDER', 'MODEL_VERSION', 'CALL_ERROR_CATEGORY_BY_CODE', 'callErrorCategory', 'formatCallError'];
const FIXED_TYPES = ['AxisName', 'AxisValues', 'ProtocolCode', 'CoreViolationCode', 'RecordKind'];

/** Names the vocabulary module declares; two axes must never render to the same name, nor to a fixed one. */
function identifierClashes(axes: string[]): string[] {
  const values = new Map<string, string>(FIXED_VALUES.map((n) => [n, 'fixed']));
  const types = new Map<string, string>(FIXED_TYPES.map((n) => [n, 'fixed']));
  const out: string[] = [];
  const claim = (space: Map<string, string>, name: string, axis: string): void => {
    const other = space.get(name);
    if (other !== undefined) out.push(`contracts/model.json: axis ${axis} renders ${name}, which ${other === 'fixed' ? 'the generator itself declares' : `axis ${other} renders too`}`);
    else space.set(name, axis);
  };
  for (const a of new Set(axes)) {
    const C = upper(a);
    const T = pascal(a);
    claim(values, C, a);
    claim(values, `${C}_LABEL`, a);
    claim(values, `${C}_UI`, a);
    claim(values, `${T}Schema`, a);
    claim(values, `is${T}`, a);
    claim(types, T, a);
  }
  return out;
}

function renderVocabulary(model: Model): string {
  const out: string[] = [HEADER, "import { z } from 'zod';\n"];
  out.push('export const AXES = {');
  for (const a of model.vocabulary) {
    const values = a.values.map((v) => `{ code: ${q(v.code)}, label: ${q(v.label)}${v.ui === undefined ? '' : `, ui: ${q(v.ui)}`} }`).join(', ');
    out.push(`  ${a.axis}: { label: ${q(a.label)}, ${a.ui === undefined ? '' : `ui: ${q(a.ui)}, `}owner: ${q(a.owner)}, values: [${values}] },`);
  }
  out.push('} as const;\n', 'export type AxisName = keyof typeof AXES;\n');
  // Mapped types instead of Record and Readonly: an axis may render a type of the same name (record -> Record).
  for (const a of model.vocabulary) {
    const C = upper(a.axis);
    const T = pascal(a.axis);
    out.push(`/** ${a.label.replaceAll('*/', '*\\/')} (${a.owner}) */`);
    out.push(`export const ${C} = [${a.values.map((v) => q(v.code)).join(', ')}] as const;`);
    out.push(`export type ${T} = (typeof ${C})[number];`);
    out.push(`export const ${C}_LABEL = { ${a.values.map((v) => `${q(v.code)}: ${q(v.label)}`).join(', ')} } as const satisfies { readonly [K in ${T}]: string };`);
    out.push(`export const ${C}_UI = { ${a.values.map((v) => `${q(v.code)}: ${q(v.ui ?? v.label)}`).join(', ')} } as const satisfies { readonly [K in ${T}]: string };`);
    out.push(`export const ${T}Schema = z.enum(${C});`);
    out.push(`export function is${T}(value: unknown): value is ${T} {\n  return (${C} as readonly unknown[]).includes(value);\n}\n`);
  }
  out.push('export interface AxisValues {');
  for (const a of model.vocabulary) out.push(`  ${a.axis}: ${pascal(a.axis)};`);
  out.push('}\n');
  out.push('const LABELS: { [A in AxisName]: { readonly [K in AxisValues[A]]: string } } = {');
  for (const a of model.vocabulary) out.push(`  ${a.axis}: ${upper(a.axis)}_LABEL,`);
  out.push('};\n');
  out.push('const UI_LABELS: { [A in AxisName]: { readonly [K in AxisValues[A]]: string } } = {');
  for (const a of model.vocabulary) out.push(`  ${a.axis}: ${upper(a.axis)}_UI,`);
  out.push('};\n');
  out.push('/** Chinese display label of a vocabulary code. The only place labels come from. */');
  out.push('export function labelOf<A extends AxisName>(axis: A, code: AxisValues[A]): string {\n  return LABELS[axis][code];\n}\n');
  out.push('export function axisLabel(axis: AxisName): string {\n  return AXES[axis].label;\n}\n');
  out.push('/** The console\'s interface term of a vocabulary code: its `ui` when the model gives one, else its label. */');
  out.push('export function uiLabelOf<A extends AxisName>(axis: A, code: AxisValues[A]): string {\n  return UI_LABELS[axis][code];\n}\n');
  out.push('/** The console\'s interface term of an axis: its `ui` when the model gives one, else its label. */');
  out.push('export function axisUiLabel(axis: AxisName): string {\n  const entry: { label: string; ui?: string } = AXES[axis];\n  return entry.ui ?? entry.label;\n}\n');
  return out.join('\n');
}

function renderProtocolCodes(model: Model, codes: Codes): string {
  const out: string[] = [HEADER];
  out.push("import type { CallErrorCategory } from './vocabulary.ts';\n");
  const f = model.formatProposals;
  out.push(`export const PROTOCOL_CODE_NAMES = [${f.protocolCodes.map((c) => q(c.code)).join(', ')}] as const;`);
  out.push('export type ProtocolCode = (typeof PROTOCOL_CODE_NAMES)[number];\n');
  out.push(`export function isProtocolCode(value: unknown): value is ProtocolCode {
  return (PROTOCOL_CODE_NAMES as readonly unknown[]).includes(value);
}\n`);
  out.push('export const CALL_ERROR_CATEGORY_BY_CODE = {');
  for (const c of f.protocolCodes) out.push(`  ${c.code}: ${c.callErrorCategory === null ? 'null' : q(c.callErrorCategory)},`);
  out.push('} as const satisfies Record<ProtocolCode, CallErrorCategory | null>;\n');
  out.push(`/** Only the caller can identify a package invocation refusal; unknown and review codes stay unclassified. */
export function callErrorCategory(code: string, packageCode = false): CallErrorCategory | null {
  if (Object.hasOwn(CALL_ERROR_CATEGORY_BY_CODE, code)) return CALL_ERROR_CATEGORY_BY_CODE[code as ProtocolCode];
  if (code.startsWith('core.')) return null;
  return packageCode === true ? 'invalid_parameters' : null;
}\n`);
  out.push(`export const CORE_VIOLATION_CODE_NAMES = [${codes.codes.map((c) => q(c.code)).join(', ')}] as const;`);
  out.push('export type CoreViolationCode = (typeof CORE_VIOLATION_CODE_NAMES)[number];\n');
  out.push('export const CORE_VIOLATION_CODE_INTERPRETERS = {');
  for (const c of codes.codes) out.push(`  ${q(c.code)}: ${q(c.interpreter)},`);
  out.push('} as const satisfies Record<CoreViolationCode, string>;\n');
  out.push(`export function isCoreViolationCode(value: unknown): value is CoreViolationCode {
  return (CORE_VIOLATION_CODE_NAMES as readonly unknown[]).includes(value);
}\n`);
  out.push(`export const RECORD_KINDS = [${f.recordKinds.map(q).join(', ')}] as const;`);
  out.push('export type RecordKind = (typeof RECORD_KINDS)[number];\n');
  out.push(`export const PACK_FILE_PATHS = [${f.packFiles.map((x) => q(x.path)).join(', ')}] as const;\n`);
  out.push(`export const MODEL_VERSION = ${model.version};\n`);
  return out.join('\n');
}

function renderProtocol(model: Model, codes: Codes): string {
  const out: string[] = [HEADER];
  out.push("import { labelOf, type CallErrorCategory } from './vocabulary.ts';");
  out.push("import type { CoreViolationCode, ProtocolCode } from './protocol-codes.ts';\n");
  out.push(`export {
  PROTOCOL_CODE_NAMES,
  type ProtocolCode,
  isProtocolCode,
  CALL_ERROR_CATEGORY_BY_CODE,
  callErrorCategory,
  CORE_VIOLATION_CODE_NAMES,
  type CoreViolationCode,
  CORE_VIOLATION_CODE_INTERPRETERS,
  isCoreViolationCode,
  RECORD_KINDS,
  type RecordKind,
  PACK_FILE_PATHS,
  MODEL_VERSION,
} from './protocol-codes.ts';\n`);
  const f = model.formatProposals;
  out.push('export const PROTOCOL_CODES = {');
  for (const c of f.protocolCodes) out.push(`  ${c.code}: { when: ${q(c.when)}, fix: ${q(c.fix)} },`);
  out.push('} as const satisfies Record<ProtocolCode, { readonly when: string; readonly fix: string }>;\n');
  out.push(`/** Formats caller-supplied facts and actions; never classifies a message or invents missing facts. */
export function formatCallError(category: CallErrorCategory, fact: string, nextAction: string): string {
  const sentence = (text: string): string => text.trim().replace(/[。.!！?？]+$/u, '') + '。';
  return labelOf('call_error_category', category) + '：' + sentence(fact) + sentence(nextAction);
}\n`);
  out.push('export const CORE_VIOLATION_CODES = {');
  for (const c of codes.codes) out.push(`  ${q(c.code)}: { interpreter: ${q(c.interpreter)}, when: ${q(c.when)}, fix: ${q(c.fix)} },`);
  out.push('} as const satisfies Record<CoreViolationCode, { readonly interpreter: string; readonly when: string; readonly fix: string }>;\n');
  out.push(`export const REFERENCE_FORMS = {${f.references.map((r) => `\n  ${r.scheme}: ${q(r.form)}`).join(',')}\n} as const;\n`);
  out.push(`export const DISPLAY_ORDER = [${f.displayOrder.map(q).join(', ')}] as const;\n`);
  return out.join('\n');
}

/**
 * The model-shape@1 JSON Schema subset is a structural language, not executable source.
 * References resolve only to earlier definitions, generated vocabularies or this finite primitive binding set.
 */
const SHARED_PRIMITIVES: Readonly<Record<string,string>> = {
  'contract:common/Sha256':'Common.Sha256',
  'contract:common/UserId':'Common.UserId',
  'contract:common/RunId':'Common.RunId',
  'contract:common/IsoTime':'Common.IsoTime',
  'contract:product/Applicability':'Product.Applicability',
  'contract:common/Versioned':'Common.Versioned',
  'contract:common/ItemId':'Common.ItemId',
  'contract:reference/ReferenceUri':'Reference.ReferenceUri',
  'contract:reference/Ground':'Reference.Ground',
  'contract:reference/SrcUri':"Reference.referenceUriOf('src')",
  'contract:reference/RecUri':"Reference.referenceUriOf('rec')",
  'contract:reference/TreePath':'Reference.TreePath',
  'contract:tables/CatalogParamType':'Tables.CatalogParamType',
};
export function renderSharedInterfaces(input: unknown, leaf?:'FeedingOffset'): string | undefined {
  if(!isRecord(input)||!isRecord(input.formatProposals)||input.formatProposals.sharedInterfaces===undefined)return undefined;
  const spec=input.formatProposals.sharedInterfaces;
  const fail=(at:string,message:string):never=>{throw new ContractsError([`contracts/model.json: sharedInterfaces ${at}: ${message}`]);};
  if(!isRecord(spec)||spec.module!=='shared-interfaces.ts'||!Array.isArray(spec.definitions)||!spec.definitions.length)fail('','needs module shared-interfaces.ts and nonempty definitions');
  const source=spec as Record<string,unknown> & {definitions:unknown[]};
  const axes=new Map(list(input.vocabulary).filter(isRecord).map(a=>[a.axis,a]));
  const names=new Set<string>();const ids=new Set<string>();
  const reserved=new Set(['Common','Reference','Tables','Product','V','SharedInterfaceSchemas','z']);
  const bindings=new Set(reserved);
  const out=leaf?[HEADER,"import { z } from 'zod';","import * as Common from '../src/common.ts';",'']:[HEADER,"import { z } from 'zod';","import * as V from './vocabulary.ts';","import * as Common from '../src/common.ts';","import * as Reference from '../src/reference.ts';","import * as Tables from '../src/tables.ts';","import * as Product from '../src/product.ts';",''];
  const entries:Array<[string,string]>=[];
  const compile=(raw:unknown,at:string,depth=0):string=>{
    if(depth>32||!isRecord(raw))return fail(at,'needs a shape object within depth 32');
    const shape=raw as Record<string,unknown>;
    const allowed=new Set(['$ref','const','anyOf','type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','format','description']);
    for(const k of Object.keys(shape))if(!allowed.has(k))fail(at,`unsupported schema keyword ${k}`);
    const exactKeys=(keys:string[])=>{for(const k of Object.keys(shape))if(k!=='description'&&!keys.includes(k))fail(at,`keyword ${k} does not apply to this shape`);};
    const integerOption=(key:string,min:number):number|undefined=>{const v=shape[key];if(v===undefined)return undefined;if(!Number.isSafeInteger(v)||(v as number)<min)return fail(at+'/'+key,'needs a bounded safe integer');return v as number;};
    const next=(v:unknown,key:string)=>compile(v,at+'/'+key,depth+1);
    let code:string;
    if(Object.hasOwn(shape,'$ref')){
      exactKeys(['$ref']);const r=shape.$ref;if(typeof r!=='string')return fail(at,'$ref must be text');
      if(r.startsWith('#/$defs/')){const name=r.slice(8);if(!names.has(name))return fail(at,`unknown, forward or cyclic reference ${r}`);code=name+'Schema';}
      else if(r.startsWith('vocabulary:')){
        const [axisName,value,...rest]=r.slice(11).split('/');const axis=axes.get(axisName);
        if(!axis||rest.length)return fail(at,`unknown vocabulary reference ${r}`);
        const values=list(axis.values).filter(isRecord);
        if(value!==undefined&&!values.some(v=>v.code===value))return fail(at,`unknown vocabulary value ${r}`);
        code='V.'+pascal(axisName)+'Schema'+(value===undefined?'':`.extract([${q(value)}])`);
      }else if(Object.hasOwn(SHARED_PRIMITIVES,r))code=SHARED_PRIMITIVES[r];
      else return fail(at,`unknown contract reference ${r}`);
    }else if(Object.hasOwn(shape,'const')){
      exactKeys(['const']);const v=shape.const;if(typeof v!=='string'&&typeof v!=='boolean'&&!(typeof v==='number'&&Number.isFinite(v))&&v!==null)return fail(at,'const must be a scalar');
      code='z.literal('+JSON.stringify(v)+')';
    }else if(Object.hasOwn(shape,'anyOf')){
      exactKeys(['anyOf']);if(!Array.isArray(shape.anyOf)||shape.anyOf.length<2||shape.anyOf.length>64)return fail(at,'anyOf needs 2..64 branches');
      code='z.union(['+shape.anyOf.map((v,i)=>next(v,'anyOf/'+i)).join(', ')+'])';
    }else if(shape.type==='object'){
      exactKeys(['type','properties','required','additionalProperties']);
      if(!isRecord(shape.properties)||shape.additionalProperties!==false||!Array.isArray(shape.required))return fail(at,'objects need properties, required and additionalProperties false');
      const properties=shape.properties;const required=new Set(shape.required);
      if(required.size!==shape.required.length||shape.required.some(k=>typeof k!=='string'||!Object.hasOwn(properties,k)))return fail(at,'required must contain unique declared property names');
      const fields=Object.entries(properties).map(([name,v])=>{
        if(['__proto__','prototype','constructor'].includes(name))return fail(at,'unsafe property name');
        return q(name)+': '+next(v,'properties/'+name)+(required.has(name)?'':'.optional()');
      });code='z.strictObject({ '+fields.join(', ')+' })';
    }else if(shape.type==='array'){
      exactKeys(['type','items','minItems','maxItems']);
      const lo=integerOption('minItems',0),hi=integerOption('maxItems',0);if(lo!==undefined&&hi!==undefined&&lo>hi)return fail(at,'minItems exceeds maxItems');
      code='z.array('+next(shape.items,'items')+')'+(lo===undefined?'':`.min(${lo})`)+(hi===undefined?'':`.max(${hi})`);
    }else if(shape.type==='string'){
      exactKeys(['type','minLength','maxLength','format']);
      if(shape.format!==undefined&&shape.format!=='ipv4'&&shape.format!=='ipv6')return fail(at,'only declared IPv4/IPv6 formats are supported');
      const lo=integerOption('minLength',0),hi=integerOption('maxLength',0);if(lo!==undefined&&hi!==undefined&&lo>hi)return fail(at,'minLength exceeds maxLength');
      code=shape.format===undefined?'z.string()':`z.${shape.format}()`;
      if(hi!==undefined)code+=`.max(${hi}, { abort: true })`;if(lo!==undefined)code+=`.min(${lo})`;
    }else if(shape.type==='integer'||shape.type==='number'){
      exactKeys(['type','minimum','maximum']);
      const lo=shape.minimum,hi=shape.maximum;
      for(const v of [lo,hi])if(v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||shape.type==='integer'&&!Number.isSafeInteger(v)))return fail(at,'invalid numeric bound');
      if(lo!==undefined&&hi!==undefined&&(lo as number)>(hi as number))return fail(at,'minimum exceeds maximum');
      code='z.number()'+(shape.type==='integer'?'.int()':'')+(lo===undefined?'':`.min(${lo})`)+(hi===undefined?'':`.max(${hi})`);
    }else if(shape.type==='boolean'){
      exactKeys(['type']);code='z.boolean()';
    }else return fail(at,'unsupported or missing shape type');
    if(shape.description!==undefined){if(!isText(shape.description))return fail(at,'description must be text');code+=`.describe(${q(shape.description as string)})`;}
    return code;
  };
  for(const [index,value] of source.definitions.entries()){
    const at='definitions/'+index;
    if(!isRecord(value))return fail(at,'needs a definition');
    for(const k of Object.keys(value))if(!['name','id','meaning','schema'].includes(k))return fail(at,`unknown definition member ${k}`);
    const {name,id,meaning}=value;
    if(typeof name!=='string'||!/^[A-Z][A-Za-z0-9]*$/.test(name)||bindings.has(name)||bindings.has(name+'Schema'))return fail(at,'name must be a unique PascalCase identifier');
    if(typeof id!=='string'||!SCHEMA_ID.test(id)||ids.has(id))return fail(at,'id must be a unique name@major');
    if(!isText(meaning))return fail(at,'meaning must be text');
    const code=compile(value.schema,at+'/schema');
    names.add(name);bindings.add(name);bindings.add(name+'Schema');ids.add(id);if(leaf&&name!==leaf)continue;entries.push([id,name]);
    out.push(`export const ${name}Schema = ${code}.meta({ title: ${q(id)}, description: ${q(meaning as string)} });`);
    out.push(`export type ${name} = z.infer<typeof ${name}Schema>;`,'');
  }
  out.push('export const SharedInterfaceSchemas = {',...entries.map(([id,name])=>`  ${q(id)}: ${name}Schema,`),'} as const;','');
  return out.join('\n');
}

/** A module index.ts re-exports with `export *`: its runtime exports and the type names it declares. */
type Exporter = { file: string; values: Record<string, unknown>; types: Set<string> };

let loads = 0;
const plain = (url: string): string => url.split(/[?#]/)[0];
const TYPE_DECLARATION = /^export (?:declare )?(?:type|interface) ([A-Za-z_$][\w$]*)/gm;
const STAR_EXPORT = /^export \* from '(\.{1,2}\/[^']+)';$/gm;

/**
 * Imports contracts/src with the given generated modules served from memory instead of from disk. Every call loads a
 * fresh module graph (each module URL carries a tag of this call), so a second call sees changed sources.
 */
async function loadContracts(root: string, generated: Record<string, string>): Promise<{ contracts: Contracts; exporters: Exporter[]; sharedSchemas: Record<string,z.ZodType> }> {
  const tag = `gen-contracts=${++loads}`;
  const tagged = (url: string): string => `${plain(url)}?${tag}`;
  const contractsUrl = `${pathToFileURL(join(root, 'contracts')).href}/`;
  const served = new Map(Object.entries(generated).map(([name, source]) => [pathToFileURL(join(root, GENERATED_DIR, name)).href, source]));
  const hooks = registerHooks({
    // Resolve the served files without touching the disk, so generation also works when contracts/generated is absent.
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      let url: string | undefined;
      // This call's own imports carry the tag; relative imports of a tagged module inherit it.
      if (specifier.endsWith(`?${tag}`)) url = plain(specifier);
      else if (parent !== undefined && parent.endsWith(`?${tag}`) && /^\.\.?\//.test(specifier)) url = plain(new URL(specifier, parent).href);
      if (url === undefined) return nextResolve(specifier, context);
      if (served.has(url)) return { url: tagged(url), format: 'module-typescript', shortCircuit: true };
      const resolved = nextResolve(url, context);
      return resolved.url.startsWith(contractsUrl) ? { ...resolved, url: tagged(resolved.url) } : resolved;
    },
    load(url, context, nextLoad) {
      const source = url.endsWith(`?${tag}`) ? served.get(plain(url)) : undefined;
      return source === undefined ? nextLoad(url, context) : { format: 'module-typescript', source, shortCircuit: true };
    },
  });
  const indexPath = join(root, 'contracts', 'src', 'index.ts');
  try {
    const contracts = (await import(tagged(pathToFileURL(indexPath).href))) as Contracts;
    const exporters: Exporter[] = [];
    for (const [, specifier] of readFileSync(indexPath, 'utf8').matchAll(STAR_EXPORT)) {
      const url = plain(new URL(specifier, pathToFileURL(indexPath)).href);
      const source = served.get(url) ?? readFileSync(fileURLToPath(url), 'utf8');
      const values = (await import(tagged(url))) as Record<string, unknown>;
      exporters.push({ file: relative(root, fileURLToPath(url)).split('\\').join('/'), values, types: new Set([...source.matchAll(TYPE_DECLARATION)].map((m) => m[1])) });
    }
    const shared = generated['shared-interfaces.ts'] === undefined ? undefined : await import(tagged(pathToFileURL(join(root, GENERATED_DIR, 'shared-interfaces.ts')).href));
    const sharedSchemas = shared?.SharedInterfaceSchemas ?? {};
    for (const id of Object.keys(sharedSchemas)) if (id in contracts.SCHEMA_REGISTRY && sharedSchemas[id]!==contracts.SCHEMA_REGISTRY[id]) throw new ContractsError([`shared interface schema ${id} clashes with the record registry`]);
    return { contracts, exporters, sharedSchemas };
  } catch (error) {
    throw new ContractsError([`contracts/src/index.ts failed to load with the regenerated vocabulary and protocol: ${(error as Error).message}`]);
  } finally {
    hooks.deregister();
  }
}

/**
 * Names two modules re-exported by index.ts both export. `export *` makes such a name ambiguous: TypeScript reports TS2308
 * and an ESM import of it fails to link. The same binding re-exported by a second module is not a clash.
 */
function exportClashes(exporters: Exporter[]): string[] {
  const owners = new Map<string, Exporter[]>();
  for (const e of exporters) for (const name of new Set([...Object.keys(e.values), ...e.types])) owners.set(name, [...(owners.get(name) ?? []), e]);
  const out: string[] = [];
  for (const [name, list] of owners) {
    if (list.length < 2) continue;
    const oneBinding = list.every((e) => Object.hasOwn(e.values, name) && e.values[name] === list[0].values[name]);
    if (oneBinding && list.filter((e) => e.types.has(name)).length <= 1) continue;
    out.push(`${name} is exported by ${list.map((e) => e.file).join(' and ')}; contracts/src/index.ts re-exports them with export *, so the name is ambiguous`);
  }
  return out;
}

function renderToolsAndSchemas(src: Contracts): Record<string, string> {
  const problems: string[] = [];
  const toJson = (schema: unknown, io: 'input' | 'output', what: string): unknown => {
    try {
      return z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12', io, unrepresentable: 'throw' });
    } catch (error) {
      problems.push(`${what}: no JSON Schema (${(error as Error).message})`);
      return {};
    }
  };
  const files: Record<string, string> = {};
  if (!Array.isArray(src.TOOLS) || !Array.isArray(src.EFFECT_CLASS) || !isRecord(src.SCHEMA_REGISTRY) || typeof src.annotationsFor !== 'function') {
    throw new ContractsError(['contracts/src/index.ts must export TOOLS, EFFECT_CLASS, SCHEMA_REGISTRY and annotationsFor']);
  }
  const names = src.TOOLS.map((t) => t.name);
  for (const d of duplicates(names)) problems.push(`TOOLS: tool ${d} appears twice`);
  const tools = src.TOOLS.map((t, i) => {
    const at = `TOOLS[${i}] (${String(t.name)})`;
    if (typeof t.name !== 'string' || !IDENT.test(t.name)) problems.push(`${at}: name must be snake_case`);
    if (!isText(t.title) || !isText(t.description)) problems.push(`${at}: title and description must be non-empty`);
    if (!src.EFFECT_CLASS.includes(t.effect)) problems.push(`${at}: effect ${JSON.stringify(t.effect)} is not an effect_class code`);
    if (typeof t.writesHubRecords !== 'boolean') problems.push(`${at}: writesHubRecords must be true or false`);
    for (const [key, schema] of [['input', t.input], ['output', t.output]] as const) {
      if (!(schema instanceof z.ZodObject)) problems.push(`${at}: ${key} must be a zod object (MCP tool schemas are objects)`);
    }
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: toJson(t.input, 'input', `${at} input`),
      outputSchema: toJson(t.output, 'output', `${at} output`),
      annotations: src.annotationsFor(t.effect, t.writesHubRecords, { readsExternal: t.readsExternal ?? false, idempotent: t.idempotent ?? false }),
    };
  });
  files['tools.json'] = `${JSON.stringify(tools, null, 2)}\n`;
  for (const id of Object.keys(src.SCHEMA_REGISTRY).sort()) {
    const m = SCHEMA_ID.exec(id);
    if (!m) {
      problems.push(`SCHEMA_REGISTRY: key ${JSON.stringify(id)} is not name@major`);
      continue;
    }
    files[`schemas/${m[1]}.v${m[2]}.schema.json`] = `${JSON.stringify(toJson(src.SCHEMA_REGISTRY[id], 'output', `SCHEMA_REGISTRY ${id}`), null, 2)}\n`;
  }
  if (problems.length > 0) throw new ContractsError(problems);
  return files;
}

/** The real path of a root that exists: Node identifies modules by real path, so the served URLs must use it too. */
function canonical(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    throw new ContractsError([`${root}: ${(error as Error).message}`]);
  }
}

/**
 * Renders every generated file in memory: name relative to contracts/generated -> content. Pure apart from reading the inputs
 * and importing contracts/src, which is loaded afresh on every call.
 */
export async function generate(root: string = REPO_ROOT): Promise<Record<string, string>> {
  root = canonical(root);
  const problems: string[] = [];
  const model = readJson(root, 'contracts/model.json', problems);
  const codes = readJson(root, 'contracts/codes.json', problems);
  if (problems.length === 0) problems.push(...validateInputs(model, codes));
  if (problems.length > 0) throw new ContractsError(problems);
  const files: Record<string, string> = {
    'vocabulary.ts': renderVocabulary(model as Model),
    'protocol-codes.ts': renderProtocolCodes(model as Model, codes as Codes),
    'protocol.ts': renderProtocol(model as Model, codes as Codes),
  };
  const shared = renderSharedInterfaces(model);
  if (shared !== undefined) {files['shared-interfaces.ts'] = shared;files['feeding-offset.ts']=renderSharedInterfaces(model,'FeedingOffset')!;}
  const grammarPath=join(root,'contracts/src/command-grammar.ts');
  if(existsSync(grammarPath))files['command-grammar.ts']='// Generated by tools/gen-contracts.ts; do not edit\n'+readFileSync(grammarPath,'utf8').replaceAll("from './tables.ts'","from '../src/tables.ts'").replaceAll("from '../generated/vocabulary.ts'","from './vocabulary.ts'").replaceAll("import('../generated/shared-interfaces.ts')","import('./shared-interfaces.ts')");
  const { contracts, exporters, sharedSchemas } = await loadContracts(root, files);
  const clashes = exportClashes(exporters);
  if (clashes.length > 0) throw new ContractsError(clashes);
  Object.assign(files, renderToolsAndSchemas(contracts));
  for (const [id, schema] of Object.entries(sharedSchemas)) {
    const match = SCHEMA_ID.exec(id)!;
    files[`schemas/${match[1]}.v${match[2]}.schema.json`] = `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }), null, 2)}\n`;
  }
  return files;
}

/** Lock and temporary files of a run that writes; never generated content. */
const transient = (name: string): boolean => name === LOCK_FILE || TEMP_FILE.test(basename(name));

function filesOnDisk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return filesOnDisk(join(dir, e.name), `${prefix}${e.name}/`);
    return transient(e.name) ? [] : [`${prefix}${e.name}`];
  });
}

function transientFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? transientFiles(join(dir, e.name)) : TEMP_FILE.test(e.name) ? [join(dir, e.name)] : []));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes contracts/generated/.gen-contracts.lock; a lock left by a process that has ended is taken over. Returns the release. */
function lock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8'), 10);
    } catch {
      continue;
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) {
      throw new WriteError(`another gen-contracts run (pid ${holder}) is writing ${GENERATED_DIR}; run it again when that one has finished`);
    }
    rmSync(path, { force: true });
  }
  throw new WriteError(`cannot take ${GENERATED_DIR}/${LOCK_FILE}`);
}

/** Replaces a file by renaming a complete sibling copy over it, so a reader sees the old or the new content, never a part. */
function replace(path: string, content: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function firstDifference(expected: string, actual: string): number {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line++;
  return line + 1;
}

/** Every missing, out-of-date or stale file under contracts/generated, sorted; empty when the directory matches. */
// The same two folders as contracts/src/skills.ts, which this tool cannot import: it writes what that file's imports read.
const SKILL_MODULES_DIR = 'functions/modules/';
const EMBEDDED_SKILLS_DIR = 'functions/generated/skills/';

/** Every pack directory under packs/, by its pack.json. Pack data folders are not searched. */
function packDirectories(root: string, relative = 'packs', depth = 0): string[] {
  const out: string[] = [];
  if (existsSync(join(root, relative, 'pack.json'))) out.push(relative);
  if (depth >= 4) return out;
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory() && !['functions', 'tools', 'tables', 'samples', 'examples', 'testing', 'policies', 'node_modules'].includes(entry.name)) out.push(...packDirectories(root, `${relative}/${entry.name}`, depth + 1));
  }
  return out;
}

const filesUnder = (dir: string, relative = ''): string[] => readdirSync(join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
  const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
  return entry.isDirectory() ? filesUnder(dir, path) : entry.isFile() ? [path] : [];
});

/** A module is copied as a folder, so no import may leave it: a relative path out of the folder would break in the copy. */
function moduleEscapes(name: string, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    const depth = posix.normalize(posix.join(posix.dirname(name), match[1]));
    if (depth.startsWith('..')) out.push(`${name} imports ${match[1]}, outside its module`);
  }
  return out;
}

/** T01 R[6]: the module files each pack's pack.json embeds, from the skill sources. Tests stay in the skill. */
export function embeddedPackFiles(root: string, generated: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const problems: string[] = [];
  for (const consumer of packDirectories(root)) {
    const manifest = JSON.parse(readFileSync(join(root, consumer, 'pack.json'), 'utf8')) as { embeds?: Array<{ pack: string; version: string; module: string }> };
    for (const row of manifest.embeds ?? []) {
      const skillDir = `packs/skill/${row.pack}`;
      const moduleDir = join(root, skillDir, SKILL_MODULES_DIR, row.module);
      if (!existsSync(moduleDir)) { problems.push(`${consumer}/pack.json embeds ${row.pack}/${row.module}, which has no folder ${skillDir}/${SKILL_MODULES_DIR}${row.module}`); continue; }
      const version = (JSON.parse(readFileSync(join(root, skillDir, 'pack.json'), 'utf8')) as { version: string }).version;
      if (version !== row.version) problems.push(`${consumer}/pack.json embeds ${row.pack}@${row.version}, the skill is at ${version}`);
      const prefix = `${skillDir}/${SKILL_MODULES_DIR}${row.module}/`;
      const names = new Set([...filesUnder(moduleDir), ...Object.keys(generated).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))]);
      for (const name of [...names].filter((path) => !path.endsWith('.test.ts')).sort()) {
        const text = generated[`${skillDir}/${SKILL_MODULES_DIR}${row.module}/${name}`] ?? readFileSync(join(moduleDir, name), 'utf8');
        problems.push(...moduleEscapes(name, text).map((problem) => `${skillDir}: ${problem}`));
        out[`${consumer}/${EMBEDDED_SKILLS_DIR}${row.pack}/${row.module}/${name}`] = text;
      }
    }
  }
  if (problems.length > 0) throw new ContractsError(problems);
  return out;
}

/** Files on disk in the embedded folders of the packs, generated earlier; those no pack.json names any more are stale. */
function embeddedOnDisk(root: string): string[] {
  return packDirectories(root).flatMap((consumer) => {
    const dir = join(root, consumer, EMBEDDED_SKILLS_DIR);
    return existsSync(dir) ? filesUnder(dir).map((name) => `${consumer}/${EMBEDDED_SKILLS_DIR}${name}`) : [];
  });
}

export function drift(root: string, files: Record<string, string>, packFiles: Record<string, string> = {}): string[] {
  const dir = join(canonical(root), GENERATED_DIR);
  const out: string[] = [];
  for (const name of Object.keys(files).sort()) {
    const path = join(dir, name);
    if (!existsSync(path)) out.push(`missing: ${GENERATED_DIR}/${name}`);
    else {
      const actual = readFileSync(path, 'utf8');
      if (actual !== files[name]) out.push(`out of date: ${GENERATED_DIR}/${name} (first difference at line ${firstDifference(files[name], actual)})`);
    }
  }
  for (const name of filesOnDisk(dir).sort()) if (!(name in files)) out.push(`stale: ${GENERATED_DIR}/${name}`);
  for (const [name, expected] of Object.entries(packFiles)) {
    const path = join(canonical(root), name);
    if (!existsSync(path)) out.push(`missing: ${name}`);
    else {
      const actual = readFileSync(path, 'utf8');
      if (actual !== expected) out.push(`out of date: ${name} (first difference at line ${firstDifference(expected, actual)})`);
    }
  }
  // Only a caller that passes the pack files can tell what is stale; generate() alone knows no pack file.
  if (Object.keys(packFiles).length > 0) for (const name of embeddedOnDisk(canonical(root))) if (!(name in packFiles)) out.push(`stale: ${name}`);
  return out;
}

/**
 * Writes the files that changed and removes everything else under contracts/generated, holding the lock throughout.
 * Throws WriteError when another run holds the lock; I/O errors are thrown as they are.
 */
export function write(root: string, files: Record<string, string>, packFiles: Record<string, string> = {}): { written: string[]; removed: string[]; unchanged: number } {
  const dir = join(canonical(root), GENERATED_DIR);
  const release = lock(dir);
  try {
    const written: string[] = [];
    const removed: string[] = [];
    let unchanged = 0;
    // Temporary files left by a run that ended without cleaning up; no other run is writing while the lock is held.
    for (const leftover of transientFiles(dir)) rmSync(leftover, { force: true });
    for (const name of Object.keys(files).sort()) {
      const path = join(dir, name);
      if (existsSync(path) && readFileSync(path, 'utf8') === files[name]) {
        unchanged++;
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      replace(path, files[name]);
      written.push(name);
    }
    for (const name of filesOnDisk(dir).sort()) {
      if (name in files) continue;
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
    const prune = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(join(d, e.name));
      if (d !== dir && readdirSync(d).length === 0) rmdirSync(d);
    };
    prune(dir);
    for (const name of embeddedOnDisk(canonical(root))) {
      if (name in packFiles) continue;
      rmSync(join(canonical(root), name), { force: true });
      removed.push(name);
    }
    for (const [name, expected] of Object.entries(packFiles)) {
      const path = join(canonical(root), name);
      if (existsSync(path) && readFileSync(path, 'utf8') === expected) { unchanged++; continue; }
      mkdirSync(dirname(path), { recursive: true });
      replace(path, expected);
      written.push(relative(dir, path));
    }
    return { written, removed, unchanged };
  } finally {
    release();
  }
}

const USAGE = 'usage: node tools/gen-contracts.ts [--check]\n  --check  write nothing; list every missing, out-of-date or stale contract file and every package vocabulary snapshot';

/** Protocol codes mirrored into each format skill pack; generated subset files contain only these names and type. */
export const SKILL_PROTOCOL_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'packs/skill/mindmap-format': ['SOURCE_UNPARSEABLE', 'REFERENCE_UNRESOLVED'],
  'packs/skill/workbook-format': ['SOURCE_UNPARSEABLE', 'REFERENCE_UNRESOLVED'],
  'packs/skill/xml-format': ['SOURCE_UNPARSEABLE', 'REFERENCE_UNRESOLVED'],
  'packs/skill/html-format': ['SOURCE_UNPARSEABLE', 'REFERENCE_UNRESOLVED'],
};

const CODE_LIKE = /^[A-Z][A-Z0-9_]+$/;

function propertyKeyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function stringLiteralText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function tsFilesUnder(dir: string, skipDirNames: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirNames.has(entry.name)) out.push(...tsFilesUnder(full, skipDirNames));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Validates format-pack protocol subsets and fails if any pack throws or references a code outside its subset. */
export function validateSkillProtocolUsage(root: string, model: Model): string[] {
  const registered = new Set(model.formatProposals.protocolCodes.map((c) => c.code));
  const problems: string[] = [];
  for (const [packDir, subset] of Object.entries(SKILL_PROTOCOL_TARGETS)) {
    for (const code of subset) {
      if (!registered.has(code)) problems.push(`${packDir}: declared subset code ${code} is missing from contracts/model.json`);
    }
    const allowed = new Set(subset);
    const functionsDir = join(root, packDir, 'functions');
    if (!existsSync(functionsDir)) continue;
    for (const filePath of tsFilesUnder(functionsDir, new Set(['generated', 'node_modules'])).sort()) {
      const rel = relative(root, filePath).split('\\').join('/');
      const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const report = (node: ts.Node, message: string): void => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        problems.push(`${rel}:${line + 1}: ${message}`);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (registered.has(node.text) && !allowed.has(node.text)) {
            report(node, `protocol code ${node.text} is outside ${packDir}'s SKILL_PROTOCOL_TARGETS subset (${subset.join(', ')})`);
          }
        } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'PROTOCOL_CODES') {
          if (CODE_LIKE.test(node.name.text) && !allowed.has(node.name.text)) {
            report(node, `PROTOCOL_CODES.${node.name.text} is outside ${packDir}'s SKILL_PROTOCOL_TARGETS subset (${subset.join(', ')})`);
          }
        } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'PROTOCOL_CODES' && node.argumentExpression !== undefined) {
          const key = stringLiteralText(node.argumentExpression);
          if (key !== undefined && !allowed.has(key)) {
            report(node, `PROTOCOL_CODES[${JSON.stringify(key)}] is outside ${packDir}'s SKILL_PROTOCOL_TARGETS subset (${subset.join(', ')})`);
          }
        } else if ((ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && propertyKeyName(node.name) === 'code' && node.initializer !== undefined) {
          const val = stringLiteralText(node.initializer);
          if (val !== undefined && CODE_LIKE.test(val) && !allowed.has(val)) {
            report(node, `code ${val} is outside ${packDir}'s SKILL_PROTOCOL_TARGETS subset (${subset.join(', ')})`);
          }
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'code') {
          const val = stringLiteralText(node.right);
          if (val !== undefined && CODE_LIKE.test(val) && !allowed.has(val)) {
            report(node, `code ${val} is outside ${packDir}'s SKILL_PROTOCOL_TARGETS subset (${subset.join(', ')})`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return problems;
}

function renderSkillProtocolSubset(codes: readonly string[]): string {
  const lines = codes.map((c) => `  ${q(c)},`).join('\n');
  return `${HEADER}export const PROTOCOL_CODES = [\n${lines}\n] as const;\n\nexport type ProtocolCode = (typeof PROTOCOL_CODES)[number];\n`;
}

export function skillProtocolFiles(root: string, model: Model): Record<string, string> {
  const problems = validateSkillProtocolUsage(root, model);
  if (problems.length > 0) throw new ContractsError(problems);
  const out: Record<string, string> = {};
  for (const [packDir, subset] of Object.entries(SKILL_PROTOCOL_TARGETS)) {
    out[`${packDir}/functions/generated/protocol.ts`] = renderSkillProtocolSubset(subset);
  }
  return out;
}

export async function main(args: string[], root: string = REPO_ROOT): Promise<number> {
  const unknown = args.filter((a) => a !== '--check' && a !== '--help' && a !== '-h');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (unknown.length > 0) {
    console.error(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}\n${USAGE}`);
    return 2;
  }
  let files: Record<string, string>;
  let packFiles: Record<string, string>;
  try {
    files = await generate(root);
    packFiles = packVocabularyFiles(root);
    for (const [target,source] of Object.entries({
      'packs/workflow/template-gap/tables/command-identity.schema.json':'schemas/command-identity.v1.schema.json',
      'packs/workflow/knowledge-contribution/tables/knowledge-structure.json':'schemas/knowledge-structure.v1.schema.json',
      'packs/workflow/case-compile/tables/command-identity.schema.json':'schemas/command-identity.v1.schema.json',
      'packs/workflow/case-compile/tables/declared-type.schema.json':'schemas/declared-parameter-type.v1.schema.json',
      'packs/workflow/case-compile/tables/declared-role.schema.json':'schemas/declared-parameter-role.v1.schema.json',
      'packs/workflow/case-compile/tables/typed-address.schema.json':'schemas/typed-address-value.v1.schema.json',
      'packs/workflow/template-gap/tables/category-judgment.schema.json':'schemas/category-judgment.v1.schema.json',
      'packs/workflow/defect-to-case/tables/command-identity.schema.json':'schemas/command-identity.v1.schema.json',
      'packs/workflow/defect-to-case/tables/expected-quote-identity.schema.json':'schemas/expected-quote-identity.v1.schema.json',
    })) if(files[source]!==undefined)packFiles[target]=files[source];
  } catch (error) {
    const problems = error instanceof ContractsError ? error.problems : [(error as Error).stack ?? String(error)];
    console.error(`cannot generate contracts (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 2;
  }
  const expectationSlots='packs/workflow/case-compile/slots.schema.json';
  if(existsSync(join(root,expectationSlots))){const schema=JSON.parse(readFileSync(join(root,expectationSlots),'utf8'));const model=JSON.parse(readFileSync(join(root,'contracts/model.json'),'utf8'));const axis=model.vocabulary.find((axis:{axis:string})=>axis.axis==='expectation_basis');if(axis&&schema.item?.plan?.data?.properties?.expects?.items?.properties?.basis){schema.item.plan.data.properties.expects.items.properties.basis.enum=axis.values.map((value:{code:string})=>value.code);packFiles[expectationSlots]=JSON.stringify(schema,null,2)+'\n';}}
  try {
    const skillProtocolModel = JSON.parse(readFileSync(join(root, 'contracts/model.json'), 'utf8')) as Model;
    Object.assign(packFiles, skillProtocolFiles(root, skillProtocolModel));
  } catch (error) {
    if (!(error instanceof ContractsError)) throw error;
    console.error(`cannot generate protocol subsets (${error.problems.length} problem${error.problems.length > 1 ? 's' : ''}):`);
    for (const problem of error.problems) console.error(`  ${problem}`);
    return 2;
  }
  if(files['command-grammar.ts'])for(const pack of ['packs/product/famx'])packFiles[pack+'/functions/generated/command-grammar.ts']=files['command-grammar.ts'].replaceAll("from '../src/tables.ts'","from '../../../../../contracts/src/tables.ts'").replaceAll("from './vocabulary.ts'","from '../../../../../contracts/generated/vocabulary.ts'").replaceAll("import('./shared-interfaces.ts')","import('../../../../../contracts/generated/shared-interfaces.ts')");
  // The module copy has no way back to contracts/ (a module folder is self-contained), so it names the types loosely; the source
  // in contracts/src is where they are checked.
  if(files['command-grammar.ts'])packFiles['packs/skill/command-tools/functions/modules/command-check/grammar.ts']='// @ts-nocheck\n'+files['command-grammar.ts'].replace("import type {CatalogParam,CatalogSignature} from '../src/tables.ts';\n","type CatalogParam = any;\ntype CatalogSignature = any;\n").replace("import type {CommandParseStatus} from './vocabulary.ts';\n","type CommandParseStatus = any;\n").replace(/import\('\.\/shared-interfaces\.ts'\)\.\w+/g,'any');
  const adocDirectory=join(root,'packs/skill/adoc-format/functions/directory.ts');
  if(existsSync(adocDirectory))packFiles['packs/product/famx/functions/generated/adoc-directory.ts']='// Generated by tools/gen-contracts.ts from packs/skill/adoc-format/functions/directory.ts; do not edit\n'+readFileSync(adocDirectory,'utf8');
  if(files['schemas/contribution-input.v1.schema.json']){
    const schema=JSON.parse(files['schemas/contribution-input.v1.schema.json']);
    const model=JSON.parse(readFileSync(join(root,'contracts/model.json'),'utf8'));const kinds=model.vocabulary.find((axis:{axis:string})=>axis.axis==='document_output_kind').values;
    packFiles['packs/workflow/knowledge-contribution/slots.schema.json']=JSON.stringify(contributionSlots(schema,kinds),null,2)+'\n';
  }
  try { Object.assign(packFiles, embeddedPackFiles(root, packFiles)); }
  catch (error) {
    if (!(error instanceof ContractsError)) throw error;
    console.error(`cannot embed skill modules (${error.problems.length} problem${error.problems.length > 1 ? 's' : ''}):`);
    for (const problem of error.problems) console.error(`  ${problem}`);
    return 2;
  }
  const count = Object.keys(files).length + Object.keys(packFiles).length;
  if (args.includes('--check')) {
    const problems = drift(root, files, packFiles);
    if (problems.length > 0) {
      console.error(`${GENERATED_DIR} does not match the model (${problems.length} file${problems.length > 1 ? 's' : ''}):`);
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('run npm run gen:contracts');
      return 1;
    }
    console.log(`${GENERATED_DIR} matches the model (${count} files)`);
    return 0;
  }
  let result: ReturnType<typeof write>;
  try {
    result = write(root, files, packFiles);
  } catch (error) {
    console.error(error instanceof WriteError ? error.message : `cannot write ${GENERATED_DIR}: ${(error as Error).message}`);
    return 3;
  }
  console.log(`${GENERATED_DIR}: ${result.written.length} written, ${result.removed.length} removed, ${result.unchanged} unchanged (${count} files)`);
  for (const name of result.written) console.log(`  wrote ${join(GENERATED_DIR, name)}`);
  for (const name of result.removed) console.log(`  removed ${join(GENERATED_DIR, name)}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
