// structure@1: required fields, value types and numeric ranges, array and child cardinality, uniqueness keys, rules per node
// kind. Works on one node, a list of items (nodes: $[*]) or a tree (children pointer). Violations are about the author's input.
import { CORE_VIOLATION_CODES, type CoreViolationCode } from '../../../contracts/generated/protocol.ts';
import { StructureTable, type CheckOutcome, type ValueType } from '../../../contracts/src/tables.ts';
import { getAt, joinPointer, locate, stableJson } from '../json.ts';
import { baseFor, quoted, refute, support, tierOf, unknown, type OutcomeBase } from '../outcome.ts';
import { codePoints, normalizeText, trimWhitespace } from '../text.ts';
import type { TableIssue } from '../types.ts';
import { defineInterpreter, pathIssues, rangeIssue } from './define.ts';

type Table = StructureTable;
type FieldRule = NonNullable<Table['rules'][number]['fields']>[number];
type Constraints = Pick<FieldRule, 'type' | 'minimum' | 'maximum' | 'minLength' | 'maxLength'>;

export const STRUCTURE_CODES = (Object.keys(CORE_VIOLATION_CODES) as CoreViolationCode[]).filter((c) => CORE_VIOLATION_CODES[c].interpreter === 'structure');

const TYPE_TEXT: Record<ValueType, string> = {
  string: '字符串',
  integer: '整数',
  number: '数值',
  boolean: '布尔值',
  array: '数组',
  object: '对象',
  null: 'null',
};

export const MAX_NODES = 100_000;
export const MAX_DEPTH = 64;
const MAX_OTHERS = 20;

function typeOf(value: unknown): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value as ValueType;
  return 'object';
}

function hasType(value: unknown, type: ValueType): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && trimWhitespace(value) === '') || (Array.isArray(value) && value.length === 0);

const bounds = (min: number | undefined, max: number | undefined): string =>
  min !== undefined && max !== undefined ? `${min} 到 ${max}` : min !== undefined ? `不少于 ${min}` : `不多于 ${max}`;

interface Violation {
  code: CoreViolationCode;
  detail: string;
  pointer: string;
  data?: Record<string, unknown>;
}

/** Type, numeric range and string length of one present, non-empty value. */
function checkValue(value: unknown, c: Constraints, at: string, label: string): Violation | undefined {
  if (c.type !== undefined && !hasType(value, c.type)) {
    return { code: 'core.structure.type_mismatch', detail: `${label} 应为${TYPE_TEXT[c.type]}，实际是${TYPE_TEXT[typeOf(value)]}`, pointer: at, data: { expected: c.type, actual: typeOf(value) } };
  }
  if (typeof value === 'number' && ((c.minimum !== undefined && value < c.minimum) || (c.maximum !== undefined && value > c.maximum))) {
    return {
      code: 'core.structure.type_mismatch',
      detail: `${label} 取值 ${value}，允许 ${bounds(c.minimum, c.maximum)}`,
      pointer: at,
      data: { constraint: 'range', value, minimum: c.minimum, maximum: c.maximum },
    };
  }
  if (typeof value === 'string' && (c.minLength !== undefined || c.maxLength !== undefined)) {
    const length = codePoints(value);
    if ((c.minLength !== undefined && length < c.minLength) || (c.maxLength !== undefined && length > c.maxLength)) {
      return {
        code: 'core.structure.type_mismatch',
        detail: `${label} 长度 ${length}，允许 ${bounds(c.minLength, c.maxLength)}`,
        pointer: at,
        data: { constraint: 'length', length, minLength: c.minLength, maxLength: c.maxLength },
      };
    }
  }
  return undefined;
}

function checkField(node: unknown, nodePointer: string, rule: FieldRule): Violation[] {
  const at = joinPointer(nodePointer, rule.path);
  const label = rule.path || '节点';
  const found = getAt(node, rule.path);
  const value = found.found ? found.value : undefined;
  if (isEmpty(value)) {
    if (rule.required !== true) return [];
    return [{ code: 'core.structure.required_empty', detail: `${label} ${found.found ? '为空' : '缺失'}`, pointer: at, data: { missing: !found.found } }];
  }
  const own = checkValue(value, rule, at, label);
  if (own) return [own];
  const out: Violation[] = [];
  if (Array.isArray(value)) {
    const n = value.length;
    if ((rule.minItems !== undefined && n < rule.minItems) || (rule.maxItems !== undefined && n > rule.maxItems)) {
      out.push({ code: 'core.structure.cardinality', detail: `${label} 有 ${n} 项，允许 ${bounds(rule.minItems, rule.maxItems)}`, pointer: at, data: { count: n, min: rule.minItems, max: rule.maxItems } });
    }
    if (rule.items) {
      value.forEach((element, i) => {
        const elementAt = `${at}/${i}`;
        const elementLabel = `${label}/${i}`;
        if (isEmpty(element)) {
          if (rule.items?.required === true) out.push({ code: 'core.structure.required_empty', detail: `${elementLabel} 为空`, pointer: elementAt, data: { missing: false } });
          return;
        }
        const v = checkValue(element, rule.items as Constraints, elementAt, elementLabel);
        if (v) out.push(v);
      });
    }
  }
  return out;
}

interface Visited {
  value: unknown;
  pointer: string;
  parent: number;
  kind?: string;
  base: OutcomeBase;
  violations: Violation[];
  checked: boolean;
}

function semantic(table: Table): TableIssue[] {
  const issues: TableIssue[] = pathIssues([['/nodes', table.nodes]]);
  table.rules.forEach((rule, r) => {
    if (rule.children && table.children === undefined) issues.push({ path: `/rules/${r}/children`, message: '子节点数的界限需要表的 children 指针' });
    if (rule.children) issues.push(...rangeIssue(`/rules/${r}/children`, rule.children.min, rule.children.max));
    if (rule.kinds && table.kind === undefined) issues.push({ path: `/rules/${r}/kinds`, message: '按节点种类的规则需要表的 kind 指针' });
    (rule.fields ?? []).forEach((f, i) => {
      const at = `/rules/${r}/fields/${i}`;
      issues.push(...rangeIssue(at, f.minimum, f.maximum), ...rangeIssue(at, f.minLength, f.maxLength), ...rangeIssue(at, f.minItems, f.maxItems));
    });
    (rule.unique ?? []).forEach((u, i) => {
      if ((u.within ?? 'all') === 'group' && !(u.group && u.group.length > 0)) issues.push({ path: `/rules/${r}/unique/${i}/group`, message: 'within 为 group 时要给出 group 字段' });
      if ((u.within ?? 'all') === 'siblings' && table.children === undefined && table.nodes === undefined) {
        issues.push({ path: `/rules/${r}/unique/${i}/within`, message: 'siblings 需要节点集合（nodes）或 children 指针' });
      }
    });
  });
  return issues;
}

export const structureInterpreter = defineInterpreter({
  id: 'structure@1',
  codes: STRUCTURE_CODES,
  schema: StructureTable,
  check: semantic,
  run(table, request) {
    const subject = request.subject;
    const fallback: OutcomeBase = { tier: tierOf(table), grounds: [] };
    const nodes = locate(subject, table.nodes ?? '$');
    if (nodes.missing) return [unknown(fallback, 'missing_input', `被判对象里没有 ${table.nodes ?? '$'}（缺失，不同于空列表）`)];
    if (nodes.selected.length === 0) return [support(fallback, `${table.nodes ?? '$'} 是空的，没有要核对的节点`, { data: { checked: 0, nodes: 0 } })];
    const visited: Visited[] = [];
    // The first subtree the limits kept out, and how many: what was not examined stays unknown, never silently skipped.
    let stopped: { pointer: string; depth: boolean } | undefined;
    let notExamined = 0;
    const visit = (value: unknown, pointer: string, parent: number, depth: number): void => {
      if (visited.length >= MAX_NODES || depth > MAX_DEPTH) {
        stopped ??= { pointer, depth: depth > MAX_DEPTH };
        notExamined += 1;
        return;
      }
      const index = visited.length;
      const kindFound = table.kind !== undefined ? getAt(value, table.kind) : { found: false };
      const kind = kindFound.found && typeof kindFound.value === 'string' ? kindFound.value : undefined;
      visited.push({ value, pointer, parent, kind, base: baseFor(value, table), violations: [], checked: false });
      if (table.children !== undefined) {
        const kids = getAt(value, table.children);
        if (kids.found && Array.isArray(kids.value)) kids.value.forEach((child, i) => visit(child, `${joinPointer(pointer, table.children as string)}/${i}`, index, depth + 1));
      }
    };
    for (const top of nodes.selected) visit(top.value, top.pointer, -1, 0);

    const applies = (kinds: string[] | undefined, node: Visited): boolean => kinds === undefined || (node.kind !== undefined && kinds.includes(node.kind));
    table.rules.forEach((rule) => {
      // unique rule index and group -> key text -> the key parts and the nodes that carry it
      const groups = new Map<string, Map<string, { parts: unknown[]; members: number[] }>>();
      visited.forEach((node, index) => {
        if (!applies(rule.kinds, node)) return;
        node.checked = true;
        for (const field of rule.fields ?? []) node.violations.push(...checkField(node.value, node.pointer, field));
        if (rule.children && table.children !== undefined) {
          const kids = getAt(node.value, table.children);
          const list = kids.found && Array.isArray(kids.value) ? kids.value : [];
          const counted = rule.children.kinds
            ? list.filter((child) => {
                const k = table.kind !== undefined ? getAt(child, table.kind) : { found: false };
                return k.found && typeof k.value === 'string' && (rule.children?.kinds ?? []).includes(k.value);
              }).length
            : list.length;
          const { min, max } = rule.children;
          if ((min !== undefined && counted < min) || (max !== undefined && counted > max)) {
            node.violations.push({
              code: 'core.structure.cardinality',
              detail: `有 ${counted} 个子节点，允许 ${bounds(min, max)}`,
              pointer: joinPointer(node.pointer, table.children),
              data: { count: counted, min, max },
            });
          }
        }
        (rule.unique ?? []).forEach((u, ui) => {
          const parts: unknown[] = [];
          for (const keyPointer of u.key) {
            const part = getAt(node.value, keyPointer);
            if (!part.found || isEmpty(part.value)) return;
            parts.push(typeof part.value === 'string' ? normalizeText(part.value, u.match) : part.value);
          }
          const within = u.within ?? 'all';
          let group = '';
          if (within === 'siblings') group = String(node.parent);
          else if (within === 'group') group = stableJson((u.group ?? []).map((g) => getAt(node.value, g).value ?? null));
          const scope = `${ui}\u0000${group}`;
          const byKey = groups.get(scope) ?? new Map<string, { parts: unknown[]; members: number[] }>();
          groups.set(scope, byKey);
          const key = stableJson(parts);
          const entry = byKey.get(key) ?? { parts, members: [] };
          entry.members.push(index);
          byKey.set(key, entry);
        });
      });
      for (const [scope, byKey] of groups) {
        const keyPointers = (rule.unique ?? [])[Number(scope.split('\u0000')[0])].key;
        for (const { parts, members } of byKey.values()) {
          if (members.length < 2) continue;
          for (const m of members) {
            // At most MAX_OTHERS other holders are listed, so many duplicates stay linear in size.
            const others: string[] = [];
            for (const o of members) {
              if (others.length >= MAX_OTHERS) break;
              if (o !== m) others.push(visited[o].base.item ?? visited[o].pointer);
            }
            visited[m].violations.push({
              code: 'core.structure.duplicate_key',
              detail: `键 ${quoted(parts.length === 1 ? parts[0] : parts)} 在 ${members.length} 个节点上重复`,
              pointer: joinPointer(visited[m].pointer, keyPointers[0]),
              data: { key: parts, fields: keyPointers, others, count: members.length },
            });
          }
        }
      }
    });

    const outcomes: CheckOutcome[] = [];
    for (const node of visited) {
      if (!node.checked) continue;
      if (node.violations.length === 0) {
        outcomes.push(support(node.base, '结构符合表中的规则', { pointer: node.pointer }));
        continue;
      }
      for (const v of node.violations) outcomes.push(refute(node.base, v.code, v.detail, { pointer: v.pointer, ...(v.data ? { data: v.data } : {}) }));
    }
    if (stopped) {
      const limit = stopped.depth ? `超过 ${MAX_DEPTH} 层` : `超过 ${MAX_NODES} 个节点`;
      outcomes.push(
        unknown(fallback, 'budget_exhausted', `结构检查在 ${stopped.pointer} 处停下（${limit}），之后的 ${notExamined} 棵子树没有核对，唯一键也只在已核对的节点里比较`, {
          pointer: stopped.pointer,
          data: { not_examined: notExamined, examined: visited.length, max_depth: MAX_DEPTH, max_nodes: MAX_NODES },
        }),
      );
    }
    if (outcomes.length === 0) return [support(fallback, '没有节点适用表中的规则，无需核对', { data: { checked: 0, nodes: visited.length } })];
    return outcomes;
  },
});
