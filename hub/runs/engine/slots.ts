// Slots (W05): the JSON Schema of one item's slot record that start_run hands to the model (RunSummary.slots), and the
// structural check of a submission's slot records and cross-item entries against the pack's slots file (T03 R[3]: a
// violation here keeps the whole submission from being accepted). Every problem is reported with its JSON Pointer.
import { z } from 'zod';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { SlotClaim, type RequirementTemplate, type SlotDeclaration, type SlotsFile } from '../../../contracts/src/pack.ts';
import type { ItemProjection, SlotSchema } from '../../../contracts/src/run.ts';
import { CrossItemSubmission, type Submission } from '../../../contracts/src/submission.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { protocolError } from './errors.ts';
import { clipPointer, isObject, pointerOf, pointerOfPath, wellFormed } from './util.ts';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

const BASE_CLAIM = withoutDialect(z.toJSONSchema(SlotClaim, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>);
const BASE_CROSS = withoutDialect(z.toJSONSchema(CrossItemSubmission, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>);

const listing = (set: { code: string; label: string }[]): string => set.map((v) => `${v.code} (${v.label})`).join(', ');

/** The JSON Schema of one statement of a slot: the SlotClaim shape narrowed to the pack's closed sets and data schema. */
function claimSchema(declaration: SlotDeclaration): Record<string, unknown> {
  const schema = structuredClone(BASE_CLAIM) as { properties: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  const required = new Set(schema.required ?? []);
  if (declaration.codes) {
    schema.properties.code = { type: 'string', enum: declaration.codes.map((c) => c.code), description: `One of: ${listing(declaration.codes)}` };
    required.add('code');
  } else delete schema.properties.code;
  if (declaration.ranks) {
    schema.properties.rank = { type: 'string', enum: declaration.ranks.map((r) => r.code), description: `Ranking level, strongest first: ${listing(declaration.ranks)}` };
    required.add('rank');
  } else delete schema.properties.rank;
  if (declaration.data) schema.properties.data = declaration.data;
  schema.required = [...required];
  if (declaration.evidence) {
    schema.anyOf = [
      { required: ['grounds'], properties: { grounds: { minItems: 1 } } },
      { required: ['quotes'], properties: { quotes: { minItems: 1 } } },
    ];
  }
  return schema;
}

function crossSchema(key: string, template: RequirementTemplate | undefined, declaration: SlotDeclaration): Record<string, unknown> {
  const count = `${declaration.min ?? 0} to ${declaration.max ?? 'any number of'} entries`;
  return {
    allOf: [BASE_CROSS],
    properties: {
      code: { type: 'string', enum: (declaration.codes ?? []).map((c) => c.code) },
      ...(declaration.ranks ? { rank: { type: 'string', enum: declaration.ranks.map((r) => r.code), description: `Ranking level, strongest first: ${listing(declaration.ranks)}` } } : {}),
    },
    required: ['code', ...(declaration.ranks ? ['rank'] : [])],
    description: `A cross_item entry of the run-level requirement ${key}${template ? ` (${template.name})` : ''}: its code is one of ${listing(declaration.codes ?? [])}; ${count} in one submission.`,
  };
}

/** RunSummary.slots: the slot record of one item, plus the run-level entries under $defs; absent when the pack declares no slots. */
export function slotSchemaOf(workflow: LoadedWorkflow): SlotSchema | undefined {
  const { item, run } = workflow.slots;
  const itemKeys = Object.keys(item);
  const runKeys = Object.keys(run);
  if (itemKeys.length === 0 && runKeys.length === 0) return undefined;
  const templates = new Map(workflow.requirements.map((r) => [r.key, r]));
  const properties: Record<string, unknown> = {};
  for (const key of itemKeys) {
    const declaration = item[key];
    const template = templates.get(key);
    properties[key] = {
      type: 'array',
      ...(template ? { description: `${template.name}: ${template.description}` } : {}),
      items: claimSchema(declaration),
      minItems: declaration.min ?? 0,
      ...(declaration.max !== undefined ? { maxItems: declaration.max } : {}),
    };
  }
  const defs: Record<string, unknown> = {};
  for (const key of runKeys) defs[`cross_item_${key}`] = crossSchema(key, templates.get(key), run[key]);
  const file = workflow.manifest.files.find((f) => f.path === 'slots.schema.json');
  if (file === undefined) throw new TypeError('the pack manifest does not list slots.schema.json');
  return {
    schema: {
      $schema: DRAFT,
      title: 'Slot record of one item',
      description:
        'Give one list per key for every handled item (an empty list when there is nothing to report). Statements that span items go to cross_item; the schemas of those entries are under $defs.',
      type: 'object',
      additionalProperties: false,
      required: itemKeys,
      properties,
      ...(runKeys.length > 0 ? { $defs: defs } : {}),
    },
    sha256: file.sha256,
  };
}

// ---------------------------------------------------------------- structural check

type Problem = ProtocolError;

const violation = (path: string, message: string, extra: { item?: string; requirement?: string } = {}): Problem =>
  protocolError('SUBMISSION_SCHEMA_VIOLATION', message, { path, ...extra });

function typeName(type: unknown): string {
  if (type === 'string') return '字符串';
  if (type === 'number') return '数字';
  if (type === 'boolean') return '布尔值';
  if (type === 'object') return '对象';
  if (type === 'array') return '数组';
  if (type === 'null') return 'null';
  if (type === 'undefined') return 'undefined';
  return String(type ?? '未知类型');
}

function receivedTypeName(issue: z.ZodIssue): string {
  const raw = (issue as { received?: unknown }).received ?? /received (\w+)/.exec(issue.message)?.[1];
  return typeName(raw);
}

function pointerTokens(path: string): string[] {
  let p = path;
  const match = /^\/items\/[^/]+\/slots(?:\/(.*))?$/.exec(p);
  if (match) {
    p = match[1] ? `/${match[1]}` : '';
  }
  if (!p || p === '/') return [];
  return p.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function resolveRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (ref.startsWith('#/$defs/') && isObject(root.$defs)) {
    const target = (root.$defs as Record<string, unknown>)[ref.slice('#/$defs/'.length)];
    return isObject(target) ? (target as Record<string, unknown>) : null;
  }
  if (ref.startsWith('#/definitions/') && isObject(root.definitions)) {
    const target = (root.definitions as Record<string, unknown>)[ref.slice('#/definitions/'.length)];
    return isObject(target) ? (target as Record<string, unknown>) : null;
  }
  return null;
}

export function findSubschema(rootSchema: Record<string, unknown> | undefined, path: string): Record<string, unknown> | null {
  if (!rootSchema || !isObject(rootSchema)) return null;
  const tokens = pointerTokens(path);
  if (tokens.length === 0) return rootSchema;

  if (tokens[0] === 'cross_item' && isObject(rootSchema.$defs)) {
    for (const def of Object.values(rootSchema.$defs as Record<string, unknown>)) {
      if (isObject(def)) {
        const sub = findSubschema(def as Record<string, unknown>, '/' + tokens.slice(2).join('/'));
        if (sub !== null) return sub;
      }
    }
  }

  let curr: unknown = rootSchema;

  if (isObject(curr) && isObject((curr as Record<string, unknown>).properties)) {
    const props = (curr as Record<string, unknown>).properties as Record<string, unknown>;
    if (!(tokens[0] in props)) {
      const idx = tokens.findIndex((t) => t in props);
      if (idx > 0) tokens.splice(0, idx);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (!isObject(curr)) return null;
    let node = curr as Record<string, unknown>;
    if (typeof node.$ref === 'string') {
      const resolved = resolveRef(rootSchema, node.$ref);
      if (resolved) node = resolved;
    }
    const token = tokens[i];

    if (/^\d+$/.test(token)) {
      if (Array.isArray(node.prefixItems)) {
        const idx = Number(token);
        if (idx < node.prefixItems.length && isObject(node.prefixItems[idx])) {
          curr = node.prefixItems[idx];
          continue;
        }
      }
      if (isObject(node.items)) {
        curr = node.items;
        continue;
      }
      if (Array.isArray(node.items)) {
        const idx = Number(token);
        if (idx < node.items.length && isObject(node.items[idx])) {
          curr = node.items[idx];
          continue;
        }
      }
      let found: unknown = null;
      for (const branchKey of ['allOf', 'anyOf', 'oneOf'] as const) {
        if (Array.isArray(node[branchKey])) {
          for (const branch of node[branchKey] as unknown[]) {
            if (isObject(branch) && isObject((branch as Record<string, unknown>).items)) {
              found = (branch as Record<string, unknown>).items;
              break;
            }
          }
        }
        if (found) break;
      }
      if (found) {
        curr = found;
        continue;
      }
      return null;
    }

    if (isObject(node.properties) && token in (node.properties as Record<string, unknown>)) {
      curr = (node.properties as Record<string, unknown>)[token];
      continue;
    }

    let foundProp: unknown = null;
    for (const branchKey of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (Array.isArray(node[branchKey])) {
        for (const branch of node[branchKey] as unknown[]) {
          if (isObject(branch) && isObject((branch as Record<string, unknown>).properties)) {
            const bp = (branch as Record<string, unknown>).properties as Record<string, unknown>;
            if (token in bp) {
              foundProp = bp[token];
              break;
            }
          }
        }
      }
      if (foundProp) break;
    }
    if (foundProp) {
      curr = foundProp;
      continue;
    }

    if (isObject(node.additionalProperties)) {
      curr = node.additionalProperties;
      continue;
    }

    return null;
  }

  if (isObject(curr) && typeof (curr as Record<string, unknown>).$ref === 'string') {
    const resolved = resolveRef(rootSchema, (curr as Record<string, unknown>).$ref as string);
    if (resolved) curr = resolved;
  }

  return isObject(curr) ? (curr as Record<string, unknown>) : null;
}

export function renderShape(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.filter(isObject).map((s) => renderShape(s as Record<string, unknown>)).join(' | ');
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter(isObject).map((s) => renderShape(s as Record<string, unknown>)).join(' | ');
  }
  const type = schema.type;
  if (type === 'string') return '"<string>"';
  if (type === 'boolean') return '<boolean>';
  if (type === 'number' || type === 'integer') return '<number>';
  if (type === 'array' || isObject(schema.items)) {
    if (isObject(schema.items)) {
      return `[${renderShape(schema.items as Record<string, unknown>)}]`;
    }
    return '[<any>]';
  }
  if (type === 'object' || isObject(schema.properties)) {
    if (isObject(schema.properties)) {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const entries = Object.entries(schema.properties).map(([key, prop]) => {
        const propShape = isObject(prop) ? renderShape(prop as Record<string, unknown>) : '<any>';
        const opt = required.has(key) ? '' : '?';
        return `"${key}"${opt}: ${propShape}`;
      });
      return `{${entries.join(', ')}}`;
    }
    return '{}';
  }
  return '<any>';
}

export function renderExpected(schema: Record<string, unknown>): string {
  if (schema.type === 'object' || (isObject(schema.properties) && schema.type !== 'array')) {
    return `对象 ${renderShape(schema)}`;
  }
  if (schema.type === 'array' || (isObject(schema.items) && schema.type !== 'object')) {
    return `数组 ${renderShape(schema)}`;
  }
  return renderShape(schema);
}

export function specificFix(path: string, issue: z.ZodIssue, schema?: Record<string, unknown>): { message: string; fix: string } | null {
  const received = receivedTypeName(issue);
  const targetSchema = findSubschema(schema, path);

  if (targetSchema !== null) {
    const expected = renderExpected(targetSchema);
    const text = `${path} 要的是${expected}，收到的是${received}`;
    return { message: text, fix: text };
  }

  if (issue.code === 'invalid_type') {
    const expected = typeName(issue.expected);
    const text = `${path} 要的是${expected}，收到的是${received}`;
    return { message: text, fix: text };
  }

  return null;
}

/** zod issues as structure violations with JSON Pointers into the submission (cut to a readable length). */
export function issuesOf(error: z.ZodError, base: string, schema?: Record<string, unknown>): Problem[] {
  return error.issues.map((issue) => {
    const keys = issue.code === 'unrecognized_keys' ? (issue as { keys?: string[] }).keys ?? [] : [];
    const path = clipPointer(wellFormed(`${base}${pointerOfPath(issue.path)}${keys.length === 1 ? pointerOf(keys[0]) : ''}`));
    const specific = specificFix(path, issue, schema);
    if (specific !== null) {
      return protocolError('SUBMISSION_SCHEMA_VIOLATION', `提交的结构不对：${specific.message}`, { path, fix: specific.fix });
    }
    const detail = keys.length > 0 ? `不认识的字段 ${keys.map((k) => wellFormed([...k].slice(0, 80).join(''))).join('、')}` : wellFormed(issue.message);
    return violation(path, `提交的结构不对：${detail}`);
  });
}

// ---------------------------------------------------------------- pack JSON Schemas (slot data, parameters)

/** Keywords whose value maps names to subschemas, holds one subschema, or a list of them (JSON Schema 2020-12 and draft 7). */
const SUBSCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
const SUBSCHEMA_ONE = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema']);
const SUBSCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Keywords that run a regular expression on the value. They would run as backtracking expressions inside the Hub process. */
const REGEX_KEYWORDS = new Set(['pattern', 'patternProperties']);
const MAX_SCHEMA_DEPTH = 32;

/**
 * Why a pack's JSON Schema cannot be enforced safely in the Hub, or null: a regular expression keyword (the Hub does not run a
 * pack's regular expressions on model input in its own process; pattern@1 checks run on the linear-time matcher instead), a
 * value that is no schema, or nesting deeper than MAX_SCHEMA_DEPTH. Property names are names, never keywords.
 */
export function unsafeSchema(schema: unknown): string | null {
  const stack: { node: unknown; path: string; depth: number }[] = [{ node: schema, path: '', depth: 0 }];
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    if (typeof node === 'boolean') continue;
    if (!isObject(node)) return `${path || '/'} 不是 JSON Schema`;
    if (depth > MAX_SCHEMA_DEPTH) return `${path} 嵌套超过 ${MAX_SCHEMA_DEPTH} 层`;
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}${pointerOf(key)}`;
      if (REGEX_KEYWORDS.has(key)) return `${at} 是正则表达式（${key}）`;
      const push = (sub: unknown, subPath: string): void => {
        stack.push({ node: sub, path: subPath, depth: depth + 1 });
      };
      if (SUBSCHEMA_MAPS.has(key) && isObject(value)) for (const [name, sub] of Object.entries(value)) push(sub, `${at}${pointerOf(name)}`);
      else if (key === 'dependencies' && isObject(value)) {
        for (const [name, sub] of Object.entries(value)) if (!Array.isArray(sub)) push(sub, `${at}${pointerOf(name)}`);
      } else if (SUBSCHEMA_LIST.has(key) && Array.isArray(value)) value.forEach((sub, i) => push(sub, `${at}/${i}`));
      else if (SUBSCHEMA_ONE.has(key)) {
        if (Array.isArray(value)) value.forEach((sub, i) => push(sub, `${at}/${i}`));
        else push(value, at);
      }
    }
  }
  return null;
}

/** A pack JSON Schema compiled for checking, or why it cannot be used. Fail closed: what cannot be checked is not accepted. */
export type PackSchema = { ok: true; schema: z.ZodType } | { ok: false; problem: string };

const packSchemas = new WeakMap<object, PackSchema>();

export function packSchema(json: Record<string, unknown>): PackSchema {
  const known = packSchemas.get(json);
  if (known !== undefined) return known;
  let result: PackSchema;
  const unsafe = unsafeSchema(json);
  if (unsafe !== null) result = { ok: false, problem: unsafe };
  else {
    try {
      result = { ok: true, schema: z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]) };
    } catch (error) {
      result = { ok: false, problem: `Hub 读不懂这个模式（${error instanceof Error ? error.message.slice(0, 200) : String(error)}）` };
    }
  }
  packSchemas.set(json, result);
  return result;
}

/** Every pack JSON Schema of a workflow the engine enforces that it cannot enforce safely (slot data, parameters). */
export function schemaProblems(workflow: LoadedWorkflow): string[] {
  const out: string[] = [];
  for (const [key, declaration] of Object.entries(workflow.slots.item)) {
    if (declaration.data === undefined) continue;
    const compiled = packSchema(declaration.data);
    if (!compiled.ok) out.push(`slots.schema.json /item/${key}/data：${compiled.problem}`);
  }
  workflow.workflow.parameters.forEach((p, i) => {
    if (p.schema === undefined) return;
    const compiled = packSchema(p.schema);
    if (!compiled.ok) out.push(`workflow.json /parameters/${i}/schema（参数 ${p.name}）：${compiled.problem}`);
  });
  return out;
}

function claimProblems(claim: unknown, path: string, key: string, declaration: SlotDeclaration, item?: string, rootSchema?: Record<string, unknown>): Problem[] {
  const extra = { ...(item !== undefined ? { item } : {}), requirement: key };
  const parsed = SlotClaim.safeParse(claim);
  if (!parsed.success) return issuesOf(parsed.error, path, rootSchema).map((p) => ({ ...p, ...extra }));
  const c = parsed.data;
  const out: Problem[] = [];
  if (declaration.codes) {
    const codes = declaration.codes.map((v) => v.code);
    if (c.code === undefined) out.push(violation(`${path}/code`, `要求项 ${key} 的每条陈述都要带码（${codes.join('、')}）`, extra));
    else if (!codes.includes(c.code)) out.push(violation(`${path}/code`, `码 ${c.code} 不在要求项 ${key} 声明的封闭集合里（${codes.join('、')}）`, extra));
  } else if (c.code !== undefined) out.push(violation(`${path}/code`, `要求项 ${key} 的陈述不带码`, extra));
  if (declaration.ranks) {
    const ranks = declaration.ranks.map((v) => v.code);
    if (c.rank === undefined) out.push(violation(`${path}/rank`, `要求项 ${key} 的每条陈述都要带等级（${ranks.join('、')}）`, extra));
    else if (!ranks.includes(c.rank)) out.push(violation(`${path}/rank`, `等级 ${c.rank} 不在要求项 ${key} 声明的封闭集合里（${ranks.join('、')}）`, extra));
  } else if (c.rank !== undefined) out.push(violation(`${path}/rank`, `要求项 ${key} 的陈述不带等级`, extra));
  if (declaration.data !== undefined) {
    const compiled = packSchema(declaration.data);
    if (!compiled.ok) {
      // Fail closed: data the pack's schema cannot check is not accepted (start_run refuses such packs; this is the backstop).
      out.push({ ...violation(`${path}/data`, `任务包为要求项 ${key} 的 data 声明的模式不能在 Hub 里执行，这条陈述无法核对`, extra), fix: '请联系任务包作者' });
    } else {
      const checked = compiled.schema.safeParse(c.data ?? {});
      if (!checked.success) out.push(...issuesOf(checked.error, `${path}/data`, declaration.data).map((p) => ({ ...p, ...extra, message: `data 不符合要求项 ${key} 声明的模式：${p.message}` })));
    }
  }
  if (declaration.evidence === true && (c.grounds ?? []).length === 0 && (c.quotes ?? []).length === 0) {
    out.push(violation(path, `要求项 ${key} 的每条陈述都要带自己的根据（grounds）或引文（quotes）`, extra));
  }
  return out;
}

function countProblems(count: number, path: string, key: string, declaration: SlotDeclaration, extra: { item?: string; requirement?: string }): Problem[] {
  const min = declaration.min ?? 0;
  if (count < min) return [violation(path, `要求项 ${key} 至少要有 ${min} 条陈述，现在 ${count} 条`, extra)];
  if (declaration.max !== undefined && count > declaration.max) return [violation(path, `要求项 ${key} 最多 ${declaration.max} 条陈述，现在 ${count} 条`, extra)];
  return [];
}

/** The run-level requirement a cross-item code belongs to (the slots file makes codes identify one requirement). */
export function runRequirementOf(slots: SlotsFile, code: string | undefined): string | null {
  if (code === undefined) return null;
  for (const [key, declaration] of Object.entries(slots.run)) if ((declaration.codes ?? []).some((c) => c.code === code)) return key;
  return null;
}

/** The message for a submitted id the run does not have: it teaches the form instead of only refusing. Real reviews
 * wrote the sequence number, the bare node id or an invented prefix four times in a row, so the message says how many
 * items the run has, that an id is written exactly as the first column of start_run's item list, and gives the run's
 * first id as an example. When the submitted text is exactly the tail of a real id (for instance only the part after the
 * colon), it adds the one id that ends with — never a guess beyond the run's own items. */
function unknownItemMessage(submitted: string, items: readonly ItemProjection[]): string {
  const ids = items.map((it) => it.id);
  const example = ids[0] ?? '（无）';
  let message = `条目 ${submitted} 不是本运行的条目：本运行有 ${ids.length} 个条目，编号照 start_run 回执里条目清单第一列原样写（例如 ${example}）`;
  const ending = ids.filter((id) => id !== submitted && id.endsWith(submitted) && submitted.length < id.length);
  if (ending.length === 1) message += `；是不是指 ${ending[0]}`;
  return message;
}

/**
 * T03 R[3] structure: every item known to the run, every handled item's slot record against the slots file (unknown keys,
 * keys of fact requirements, closed sets, counts, data, evidence), carry-overs only as start_run offered them (contracts
 * README, runs note), and every cross_item entry against the run-level requirement its code names.
 */
export function slotProblems(workflow: LoadedWorkflow, items: readonly ItemProjection[], submission: Submission): Problem[] {
  const rootSchema = slotSchemaOf(workflow)?.schema as Record<string, unknown> | undefined;
  const out: Problem[] = [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const templates = new Map(workflow.requirements.map((r) => [r.key, r]));
  const itemSlots = workflow.slots.item;
  const declaredKeys = Object.keys(itemSlots);
  submission.items.forEach((entry, i) => {
    const at = pointerOf('items', i);
    const item = byId.get(entry.item);
    if (item === undefined) {
      out.push(violation(`${at}/item`, unknownItemMessage(entry.item, items)));
      return;
    }
    if (entry.handling !== 'handled') return;
    if (entry.reuse !== undefined) {
      if (item.reuse === undefined || entry.reuse !== item.reuse) {
        out.push(violation(`${at}/reuse`, item.reuse === undefined ? `条目 ${entry.item} 没有可沿用的前驱片段，请给出槽位记录` : `沿用引用必须是 start_run 为条目 ${entry.item} 给出的 ${item.reuse}`, { item: entry.item }));
      }
      return;
    }
    if (entry.slots === undefined) {
      if (declaredKeys.length > 0) out.push(violation(at, `已处理的条目 ${entry.item} 要给出槽位记录（slots）或沿用引用（reuse）`, { item: entry.item }));
      return;
    }
    const slots = entry.slots;
    for (const key of Object.keys(slots)) {
      if (Object.hasOwn(itemSlots, key)) continue;
      const template = templates.get(key);
      const message =
        template?.accepted_producer === 'fact'
          ? `要求项 ${key} 是事实，由 Hub 计算，不能在槽位里填`
          : template?.target === 'run'
            ? `要求项 ${key} 是对整个目标的判断，写在 cross_item 里`
            : `槽位里没有 ${key}（可填：${declaredKeys.join('、') || '无'}）`;
      out.push(violation(`${at}/slots${pointerOf(key)}`, message, { item: entry.item }));
    }
    for (const key of declaredKeys) {
      const value = slots[key];
      const keyAt = `${at}/slots${pointerOf(key)}`;
      if (value === undefined) {
        out.push(violation(`${at}/slots`, `缺少要求项 ${key} 的槽位；没有要报告的就写空列表 []`, { item: entry.item, requirement: key }));
        continue;
      }
      if (!Array.isArray(value)) {
        out.push(violation(keyAt, `要求项 ${key} 的槽位是陈述的列表`, { item: entry.item, requirement: key }));
        continue;
      }
      out.push(...countProblems(value.length, keyAt, key, itemSlots[key], { item: entry.item, requirement: key }));
      value.forEach((claim, j) => out.push(...claimProblems(claim, pointerOf('items', i, 'slots', key, j), key, itemSlots[key], entry.item, rootSchema)));
    }
  });
  const counts = new Map<string, number>();
  (submission.cross_item ?? []).forEach((entry, j) => {
    const at = pointerOf('cross_item', j);
    if (entry.code === undefined) {
      if (entry.rank !== undefined) out.push(violation(`${at}/rank`, '不带码的跨条目主张不属于任何要求项，不能带等级'));
      return;
    }
    const key = runRequirementOf(workflow.slots, entry.code);
    if (key === null) {
      const codes = Object.values(workflow.slots.run).flatMap((d) => (d.codes ?? []).map((c) => c.code));
      out.push(violation(`${at}/code`, `码 ${entry.code} 不属于任何对整个目标的要求项（可用：${codes.join('、') || '无'}）`));
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const declaration = workflow.slots.run[key];
    if (declaration.ranks) {
      const ranks = declaration.ranks.map((r) => r.code);
      if (entry.rank === undefined) out.push(violation(`${at}/rank`, `要求项 ${key} 的跨条目主张要带等级（${ranks.join('、')}）`, { requirement: key }));
      else if (!ranks.includes(entry.rank)) out.push(violation(`${at}/rank`, `等级 ${entry.rank} 不在要求项 ${key} 声明的封闭集合里（${ranks.join('、')}）`, { requirement: key }));
    } else if (entry.rank !== undefined) out.push(violation(`${at}/rank`, `要求项 ${key} 的跨条目主张不带等级`, { requirement: key }));
  });
  for (const [key, declaration] of Object.entries(workflow.slots.run)) {
    out.push(...countProblems(counts.get(key) ?? 0, '/cross_item', key, declaration, { requirement: key }));
  }
  return out;
}

/** The requirement a JSON Pointer into the submission belongs to: an item slot key, or the run-level requirement of a cross_item code. */
export function requirementAt(workflow: LoadedWorkflow, submission: unknown, path: string | undefined): string | null {
  if (path === undefined) return null;
  const slot = /^\/items\/[0-9]+\/slots\/([^/]+)/.exec(path);
  if (slot) return slot[1].replaceAll('~1', '/').replaceAll('~0', '~');
  const cross = /^\/cross_item\/([0-9]+)/.exec(path);
  if (cross && isObject(submission) && Array.isArray(submission.cross_item)) {
    const entry = submission.cross_item[Number(cross[1])];
    return isObject(entry) && typeof entry.code === 'string' ? runRequirementOf(workflow.slots, entry.code) : null;
  }
  return null;
}
