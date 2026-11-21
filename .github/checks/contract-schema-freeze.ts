import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedBaseline } from './pack-version.ts';

export const SCHEMAS_DIR = 'contracts/generated/schemas';

export type SchemaFreezeKind =
  | 'schema-deleted'
  | 'property-deleted'
  | 'turned-required'
  | 'required-added'
  | 'value-narrowed';

export interface SchemaFreezeViolation {
  readonly file: string;
  readonly path: string;
  readonly kind: SchemaFreezeKind;
  readonly detail: string;
}

type SchemaObject = Record<string, unknown>;
type RawSchema = SchemaObject | boolean;

const META_KEYS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'default']);

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): RawSchema | null {
  if (typeof value === 'boolean' || isPlainObject(value)) return value;
  return null;
}

function isUnconstrained(schema: RawSchema): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  return Object.keys(schema).every((key) => META_KEYS.has(key));
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepJsonEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => key in b && deepJsonEqual(a[key], b[key]));
}

function lookupPointer(root: RawSchema, pointer: string): RawSchema | null {
  if (pointer === '#') return root;
  if (!pointer.startsWith('#/')) return null;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return null;
      current = current[idx];
    } else if (isPlainObject(current) && segment in current) {
      current = current[segment];
    } else {
      return null;
    }
  }
  return asSchema(current);
}

interface ResolvedNode {
  readonly schema: RawSchema;
  readonly ptr: string;
}

function resolveNode(root: RawSchema, raw: RawSchema, ptr: string): ResolvedNode {
  let current = raw;
  let curPtr = ptr;
  for (let depth = 0; depth < 32; depth++) {
    if (!isPlainObject(current) || typeof current.$ref !== 'string' || !current.$ref.startsWith('#')) {
      return { schema: current, ptr: curPtr };
    }
    const target = lookupPointer(root, current.$ref);
    if (target === null) return { schema: current, ptr: curPtr };
    curPtr = current.$ref;
    current = target;
  }
  return { schema: current, ptr: curPtr };
}

function joinPath(prefix: string, segment: string): string {
  if (prefix === '') return segment;
  if (segment.startsWith('[')) return `${prefix}${segment}`;
  return `${prefix}.${segment}`;
}

function typeSet(rawType: unknown): Set<string> | null {
  if (typeof rawType === 'string') return new Set([rawType]);
  if (Array.isArray(rawType)) return new Set(rawType.map(String));
  return null;
}

function typeCovered(baseType: string, curTypes: Set<string>): boolean {
  if (curTypes.has(baseType)) return true;
  if (baseType === 'integer' && curTypes.has('number')) return true;
  return false;
}

function literalSet(node: SchemaObject): unknown[] | null {
  if ('const' in node) return [node.const];
  if (Array.isArray(node.enum)) return node.enum;
  return null;
}

function literalSatisfiesScalar(value: unknown, target: SchemaObject): boolean {
  const allowedTypes = typeSet(target.type);
  if (allowedTypes !== null) {
    const actual =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'number' && Number.isInteger(value)
            ? 'integer'
            : typeof value;
    if (!typeCovered(actual, allowedTypes)) return false;
  }
  if (typeof value === 'string') {
    if (typeof target.minLength === 'number' && [...value].length < target.minLength) return false;
    if (typeof target.maxLength === 'number' && [...value].length > target.maxLength) return false;
    if (typeof target.pattern === 'string') {
      try {
        if (!new RegExp(target.pattern, 'u').test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof target.minimum === 'number' && value < target.minimum) return false;
    if (typeof target.exclusiveMinimum === 'number' && value <= target.exclusiveMinimum) return false;
    if (typeof target.maximum === 'number' && value > target.maximum) return false;
    if (typeof target.exclusiveMaximum === 'number' && value >= target.exclusiveMaximum) return false;
  }
  return true;
}

interface Bound {
  readonly value: number;
  readonly inclusive: boolean;
}

function lowerBound(node: SchemaObject): Bound | null {
  const inc = typeof node.minimum === 'number' ? { value: node.minimum, inclusive: true } : null;
  const exc = typeof node.exclusiveMinimum === 'number' ? { value: node.exclusiveMinimum, inclusive: false } : null;
  if (inc === null) return exc;
  if (exc === null) return inc;
  if (exc.value > inc.value) return exc;
  if (inc.value > exc.value) return inc;
  return exc;
}

function upperBound(node: SchemaObject): Bound | null {
  const inc = typeof node.maximum === 'number' ? { value: node.maximum, inclusive: true } : null;
  const exc = typeof node.exclusiveMaximum === 'number' ? { value: node.exclusiveMaximum, inclusive: false } : null;
  if (inc === null) return exc;
  if (exc === null) return inc;
  if (exc.value < inc.value) return exc;
  if (inc.value < exc.value) return inc;
  return exc;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

interface BranchGroup {
  readonly kind: 'anyOf' | 'oneOf';
  readonly branches: readonly unknown[];
}

function branchesOf(node: SchemaObject): BranchGroup | null {
  if (Array.isArray(node.anyOf)) return { kind: 'anyOf', branches: node.anyOf };
  if (Array.isArray(node.oneOf)) return { kind: 'oneOf', branches: node.oneOf };
  return null;
}

function withoutUnion(node: SchemaObject): SchemaObject {
  const copy: SchemaObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k !== 'anyOf' && k !== 'oneOf') copy[k] = v;
  }
  return copy;
}

interface CompareContext {
  readonly file: string;
  readonly baseRoot: RawSchema;
  readonly curRoot: RawSchema;
  readonly active: Set<string>;
}

function discriminatorKey(node: unknown): string | null {
  if (!isPlainObject(node) || !isPlainObject(node.properties)) return null;
  for (const key of ['kind', 'schema', 'status', 'handling', 'type', 'action', 'outcome']) {
    const prop = node.properties[key];
    if (isPlainObject(prop) && 'const' in prop) return `${key}=${String(prop.const)}`;
  }
  return null;
}

function bestBranchViolation(
  ctx: CompareContext,
  baseBranch: RawSchema,
  basePtr: string,
  curBranches: readonly unknown[],
  curPrefix: string,
  preferredIndex: number,
  path: string,
): SchemaFreezeViolation[] | null {
  let best: SchemaFreezeViolation[] | null = null;
  const baseTag = discriminatorKey(baseBranch);
  const candidates: Array<{ branch: RawSchema; ptr: string; scoreBoost: number }> = [];
  curBranches.forEach((rawBranch, idx) => {
    const branch = asSchema(rawBranch);
    if (branch === null) return;
    let scoreBoost = 0;
    if (baseTag !== null && discriminatorKey(branch) === baseTag) scoreBoost += 1000;
    if (idx === preferredIndex) scoreBoost += 1;
    candidates.push({ branch, ptr: `${curPrefix}/${idx}`, scoreBoost });
  });
  candidates.sort((a, b) => b.scoreBoost - a.scoreBoost);
  for (const candidate of candidates) {
    const diff = comparePair(ctx, baseBranch, basePtr, candidate.branch, candidate.ptr, path);
    if (diff.length === 0) return null;
    if (best === null || diff.length < best.length) best = diff;
  }
  return best ?? [
    {
      file: ctx.file,
      path: path || '<root>',
      kind: 'value-narrowed',
      detail: '没有兼容的联合分支',
    },
  ];
}

function compareScalarAndStructure(
  ctx: CompareContext,
  baseNode: SchemaObject,
  basePtr: string,
  curNode: SchemaObject,
  curPtr: string,
  path: string,
): SchemaFreezeViolation[] {
  const out: SchemaFreezeViolation[] = [];
  const label = path || '<root>';

  const baseLits = literalSet(baseNode);
  const curLits = literalSet(curNode);
  if (curLits !== null) {
    if (baseLits === null) {
      out.push({
        file: ctx.file,
        path: label,
        kind: 'value-narrowed',
        detail: `取值被收窄为枚举/常量 ${JSON.stringify(curLits)}`,
      });
    } else {
      for (const literal of baseLits) {
        if (!curLits.some((item) => deepJsonEqual(literal, item))) {
          out.push({
            file: ctx.file,
            path: label,
            kind: 'value-narrowed',
            detail: `允许取值被收窄：移除了 ${JSON.stringify(literal)}`,
          });
        }
      }
    }
  }
  if (baseLits !== null) {
    for (const literal of baseLits) {
      if (!literalSatisfiesScalar(literal, curNode)) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `原允许取值 ${JSON.stringify(literal)} 不再满足新约束`,
        });
      }
    }
  } else {
    const baseTypes = typeSet(baseNode.type);
    const curTypes = typeSet(curNode.type);
    if (baseTypes === null && curTypes !== null) {
      out.push({
        file: ctx.file,
        path: label,
        kind: 'value-narrowed',
        detail: `类型从任意值收窄为 ${[...curTypes].join(' | ')}`,
      });
    } else if (baseTypes !== null && curTypes !== null) {
      const missing = [...baseTypes].filter((t) => !typeCovered(t, curTypes));
      if (missing.length > 0) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `类型被收窄：不再允许 ${missing.join(', ')}`,
        });
      }
    }

    const baseMin = lowerBound(baseNode);
    const curMin = lowerBound(curNode);
    if (curMin !== null) {
      const tightened =
        baseMin === null ||
        curMin.value > baseMin.value ||
        (curMin.value === baseMin.value && baseMin.inclusive && !curMin.inclusive);
      if (tightened) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `数值下界被收窄为 ${curMin.inclusive ? '>=' : '>'} ${curMin.value}`,
        });
      }
    }
    const baseMax = upperBound(baseNode);
    const curMax = upperBound(curNode);
    if (curMax !== null) {
      const tightened =
        baseMax === null ||
        curMax.value < baseMax.value ||
        (curMax.value === baseMax.value && baseMax.inclusive && !curMax.inclusive);
      if (tightened) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `数值上界被收窄为 ${curMax.inclusive ? '<=' : '<'} ${curMax.value}`,
        });
      }
    }

    for (const minKey of ['minLength', 'minItems'] as const) {
      const curVal = curNode[minKey];
      const baseVal = typeof baseNode[minKey] === 'number' ? (baseNode[minKey] as number) : 0;
      if (typeof curVal === 'number' && curVal > baseVal) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `${minKey} 从 ${baseVal} 收窄为 ${curVal}`,
        });
      }
    }
    for (const maxKey of ['maxLength', 'maxItems'] as const) {
      const curVal = curNode[maxKey];
      const baseVal = baseNode[maxKey];
      if (typeof curVal === 'number' && (typeof baseVal !== 'number' || curVal < baseVal)) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `${maxKey} ${typeof baseVal === 'number' ? `从 ${baseVal} ` : ''}收窄为 ${curVal}`,
        });
      }
    }

    if (typeof curNode.pattern === 'string') {
      if (baseNode.pattern !== curNode.pattern) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail:
            typeof baseNode.pattern === 'string'
              ? `pattern 发生变化（${baseNode.pattern} -> ${curNode.pattern}）`
              : `新增 pattern 约束（${curNode.pattern}）`,
        });
      }
    }
    if (typeof curNode.format === 'string' && baseNode.format !== curNode.format) {
      out.push({
        file: ctx.file,
        path: label,
        kind: 'value-narrowed',
        detail:
          typeof baseNode.format === 'string'
            ? `format 从 ${baseNode.format} 改为 ${curNode.format}`
            : `新增 format 约束（${curNode.format}）`,
      });
    }
  }

  const baseProps = isPlainObject(baseNode.properties) ? baseNode.properties : {};
  const curProps = isPlainObject(curNode.properties) ? curNode.properties : {};
  const baseReq = new Set(stringList(baseNode.required));
  const curReq = new Set(stringList(curNode.required));

  for (const [key, rawProp] of Object.entries(baseProps)) {
    const propLabel = joinPath(path, key);
    if (!(key in curProps)) {
      out.push({
        file: ctx.file,
        path: propLabel,
        kind: 'property-deleted',
        detail: `删掉了已发布属性 ${propLabel}`,
      });
      continue;
    }
    const baseSub = asSchema(rawProp);
    const curSub = asSchema(curProps[key]);
    if (baseSub !== null && curSub !== null) {
      out.push(
        ...comparePair(
          ctx,
          baseSub,
          `${basePtr}/properties/${key}`,
          curSub,
          `${curPtr}/properties/${key}`,
          propLabel,
        ),
      );
    }
  }

  for (const reqKey of curReq) {
    if (!baseReq.has(reqKey)) {
      const propLabel = joinPath(path, reqKey);
      if (reqKey in baseProps) {
        out.push({
          file: ctx.file,
          path: propLabel,
          kind: 'turned-required',
          detail: `把可选属性 ${propLabel} 改成了必需`,
        });
      } else {
        out.push({
          file: ctx.file,
          path: propLabel,
          kind: 'required-added',
          detail: `新增了必需属性 ${propLabel}`,
        });
      }
    }
  }

  const baseAP = baseNode.additionalProperties === undefined ? true : asSchema(baseNode.additionalProperties);
  const curAP = curNode.additionalProperties === undefined ? true : asSchema(curNode.additionalProperties);
  if (baseAP !== null && curAP !== null && baseAP !== false) {
    if (curAP === false) {
      out.push({
        file: ctx.file,
        path: joinPath(path, '*'),
        kind: 'value-narrowed',
        detail: 'additionalProperties 从允许收窄为 false',
      });
    } else if (!isUnconstrained(curAP)) {
      if (baseAP === true) {
        out.push({
          file: ctx.file,
          path: joinPath(path, '*'),
          kind: 'value-narrowed',
          detail: 'additionalProperties 新增了值约束',
        });
      } else {
        out.push(
          ...comparePair(
            ctx,
            baseAP,
            `${basePtr}/additionalProperties`,
            curAP,
            `${curPtr}/additionalProperties`,
            joinPath(path, '*'),
          ),
        );
      }
    }
  }

  if (curNode.propertyNames !== undefined) {
    const curPN = asSchema(curNode.propertyNames);
    if (curPN !== null && !isUnconstrained(curPN)) {
      const basePN = baseNode.propertyNames === undefined ? null : asSchema(baseNode.propertyNames);
      if (basePN === null) {
        out.push({
          file: ctx.file,
          path: joinPath(path, '<key>'),
          kind: 'value-narrowed',
          detail: '新增了属性名约束 propertyNames',
        });
      } else {
        out.push(
          ...comparePair(
            ctx,
            basePN,
            `${basePtr}/propertyNames`,
            curPN,
            `${curPtr}/propertyNames`,
            joinPath(path, '<key>'),
          ),
        );
      }
    }
  }

  const baseItems = baseNode.items === undefined ? true : asSchema(baseNode.items);
  const curItems = curNode.items === undefined ? true : asSchema(curNode.items);
  if (baseItems !== null && curItems !== null && !isUnconstrained(curItems)) {
    out.push(
      ...comparePair(ctx, baseItems, `${basePtr}/items`, curItems, `${curPtr}/items`, `${path}[]`),
    );
  }

  const basePrefix = Array.isArray(baseNode.prefixItems) ? baseNode.prefixItems : null;
  const curPrefix = Array.isArray(curNode.prefixItems) ? curNode.prefixItems : null;
  if (basePrefix !== null || curPrefix !== null) {
    const bLen = basePrefix?.length ?? 0;
    const cLen = curPrefix?.length ?? 0;
    const maxLen = Math.max(bLen, cLen);
    for (let idx = 0; idx < maxLen; idx++) {
      const bItem = idx < bLen ? asSchema(basePrefix![idx]) : baseItems;
      const cItem = idx < cLen ? asSchema(curPrefix![idx]) : curItems;
      if (bItem !== null && cItem !== null) {
        out.push(
          ...comparePair(
            ctx,
            bItem,
            idx < bLen ? `${basePtr}/prefixItems/${idx}` : `${basePtr}/items`,
            cItem,
            idx < cLen ? `${curPtr}/prefixItems/${idx}` : `${curPtr}/items`,
            joinPath(path, `[${idx}]`),
          ),
        );
      }
    }
  }

  if (curNode.if !== undefined) {
    if (baseNode.if === undefined) {
      out.push({
        file: ctx.file,
        path: label,
        kind: 'value-narrowed',
        detail: '新增了条件约束 if',
      });
    } else if (!deepJsonEqual(baseNode.if, curNode.if)) {
      out.push({
        file: ctx.file,
        path: label,
        kind: 'value-narrowed',
        detail: '条件约束 if 发生变化',
      });
    } else {
      for (const branchKey of ['then', 'else'] as const) {
        if (curNode[branchKey] !== undefined) {
          const curSub = asSchema(curNode[branchKey]);
          const baseSub = baseNode[branchKey] === undefined ? true : asSchema(baseNode[branchKey]);
          if (curSub !== null && baseSub !== null) {
            out.push(
              ...comparePair(
                ctx,
                baseSub,
                `${basePtr}/${branchKey}`,
                curSub,
                `${curPtr}/${branchKey}`,
                `${label}(${branchKey})`,
              ),
            );
          }
        }
      }
    }
  }

  if (curNode.not !== undefined) {
    const curNot = asSchema(curNode.not);
    const baseNot = asSchema(baseNode.not);
    if (curNot !== null) {
      if (baseNot === null) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: '新增了否定约束 not',
        });
      } else if (!deepJsonEqual(baseNot, curNot)) {
        const revCtx: CompareContext = {
          file: ctx.file,
          baseRoot: ctx.curRoot,
          curRoot: ctx.baseRoot,
          active: new Set(),
        };
        const notDiff = comparePair(
          revCtx,
          curNot,
          `${curPtr}/not`,
          baseNot,
          `${basePtr}/not`,
          `${label}(not)`,
        );
        if (notDiff.length > 0) {
          out.push({
            file: ctx.file,
            path: label,
            kind: 'value-narrowed',
            detail: '否定约束 not 扩大（排除了更多值）',
          });
        }
      }
    }
  }

  if (Array.isArray(curNode.allOf) && curNode.allOf.length > 0) {
    const baseAllOf = Array.isArray(baseNode.allOf) ? baseNode.allOf : [];
    curNode.allOf.forEach((rawCurClause, idx) => {
      const curClause = asSchema(rawCurClause);
      if (curClause === null || isUnconstrained(curClause)) return;
      if (baseAllOf.length === 0) {
        out.push({
          file: ctx.file,
          path: label,
          kind: 'value-narrowed',
          detail: `新增了复合约束 allOf[${idx}]`,
        });
        return;
      }
      let best: SchemaFreezeViolation[] | null = null;
      for (let bIdx = 0; bIdx < baseAllOf.length; bIdx++) {
        const baseClause = asSchema(baseAllOf[bIdx]);
        if (baseClause === null) continue;
        const diff = comparePair(
          ctx,
          baseClause,
          `${basePtr}/allOf/${bIdx}`,
          curClause,
          `${curPtr}/allOf/${idx}`,
          path,
        );
        if (diff.length === 0) {
          best = null;
          break;
        }
        if (best === null || bIdx === idx) best = diff;
      }
      if (best !== null) out.push(...best);
    });
  }

  return out;
}

function comparePair(
  ctx: CompareContext,
  rawBase: RawSchema,
  basePtr: string,
  rawCur: RawSchema,
  curPtr: string,
  path: string,
): SchemaFreezeViolation[] {
  const baseRes = resolveNode(ctx.baseRoot, rawBase, basePtr);
  const curRes = resolveNode(ctx.curRoot, rawCur, curPtr);
  const pairKey = `${baseRes.ptr}=>${curRes.ptr}`;
  if (ctx.active.has(pairKey)) return [];

  if (isUnconstrained(curRes.schema)) return [];
  if (curRes.schema === false) {
    return baseRes.schema === false
      ? []
      : [
          {
            file: ctx.file,
            path: path || '<root>',
            kind: 'value-narrowed',
            detail: '约束收窄为 false（不接受任何值）',
          },
        ];
  }
  if (baseRes.schema === false) return [];
  if (isUnconstrained(baseRes.schema)) {
    return [
      {
        file: ctx.file,
        path: path || '<root>',
        kind: 'value-narrowed',
        detail: '从无限制收窄为带约束形状',
      },
    ];
  }

  const baseNode = baseRes.schema as SchemaObject;
  const curNode = curRes.schema as SchemaObject;
  ctx.active.add(pairKey);
  try {
    const out: SchemaFreezeViolation[] = [];
    const baseUnion = branchesOf(baseNode);
    const curUnion = branchesOf(curNode);

    if (baseUnion !== null || curUnion !== null) {
      if (baseUnion !== null && curUnion !== null) {
        if (!isUnconstrained(withoutUnion(baseNode)) || !isUnconstrained(withoutUnion(curNode))) {
          out.push(
            ...compareScalarAndStructure(
              ctx,
              withoutUnion(baseNode),
              baseRes.ptr,
              withoutUnion(curNode),
              curRes.ptr,
              path,
            ),
          );
        }
        if (baseUnion.kind === 'anyOf' && curUnion.kind === 'oneOf' && curUnion.branches.length > 1) {
          out.push({
            file: ctx.file,
            path: path || '<root>',
            kind: 'value-narrowed',
            detail: '联合约束从 anyOf 收窄为互斥 oneOf',
          });
        }
        baseUnion.branches.forEach((rawBranch, idx) => {
          const branch = asSchema(rawBranch);
          if (branch === null) return;
          const failure = bestBranchViolation(
            ctx,
            branch,
            `${baseRes.ptr}/${baseUnion.kind}/${idx}`,
            curUnion.branches,
            `${curRes.ptr}/${curUnion.kind}`,
            idx,
            path,
          );
          if (failure !== null) out.push(...failure);
        });
      } else if (baseUnion !== null) {
        if (!isUnconstrained(withoutUnion(baseNode))) {
          out.push(
            ...compareScalarAndStructure(
              ctx,
              withoutUnion(baseNode),
              baseRes.ptr,
              withoutUnion(curNode),
              curRes.ptr,
              path,
            ),
          );
        }
        const curNoUnion = withoutUnion(curNode);
        baseUnion.branches.forEach((rawBranch, idx) => {
          const branch = asSchema(rawBranch);
          if (branch === null) return;
          out.push(
            ...comparePair(
              ctx,
              branch,
              `${baseRes.ptr}/${baseUnion.kind}/${idx}`,
              curNoUnion,
              curRes.ptr,
              path,
            ),
          );
        });
      } else if (curUnion !== null) {
        out.push(
          ...compareScalarAndStructure(
            ctx,
            withoutUnion(baseNode),
            baseRes.ptr,
            withoutUnion(curNode),
            curRes.ptr,
            path,
          ),
        );
        const baseNoUnion = withoutUnion(baseNode);
        const baseTypes = Array.isArray(baseNoUnion.type) ? baseNoUnion.type.map(String) : null;
        if (baseTypes !== null && baseTypes.length > 1) {
          for (const atomic of baseTypes) {
            const atomicBase: SchemaObject = { ...baseNoUnion, type: atomic };
            const failure = bestBranchViolation(
              ctx,
              atomicBase,
              baseRes.ptr,
              curUnion.branches,
              `${curRes.ptr}/${curUnion.kind}`,
              0,
              path,
            );
            if (failure !== null) out.push(...failure);
          }
        } else {
          const failure = bestBranchViolation(
            ctx,
            baseNoUnion,
            baseRes.ptr,
            curUnion.branches,
            `${curRes.ptr}/${curUnion.kind}`,
            0,
            path,
          );
          if (failure !== null) out.push(...failure);
        }
      }
      return out;
    }

    return compareScalarAndStructure(ctx, baseNode, baseRes.ptr, curNode, curRes.ptr, path);
  } finally {
    ctx.active.delete(pairKey);
  }
}

export function compareJsonSchemas(
  baseSchema: unknown,
  currentSchema: unknown,
  file = '<schema>',
): SchemaFreezeViolation[] {
  const baseRoot = asSchema(baseSchema);
  const curRoot = asSchema(currentSchema);
  if (baseRoot === null || curRoot === null) {
    return [
      {
        file,
        path: '<root>',
        kind: 'value-narrowed',
        detail: '形状根节点不是合法的 JSON Schema',
      },
    ];
  }
  const ctx: CompareContext = { file, baseRoot, curRoot, active: new Set() };
  return comparePair(ctx, baseRoot, '#', curRoot, '#', '');
}

export function contractSchemaFreezeViolations(root: string): {
  violations: SchemaFreezeViolation[];
  errors: string[];
} {
  let baseline: string;
  try {
    baseline = publishedBaseline(root);
  } catch (error) {
    return {
      violations: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const listed = git(root, ['ls-tree', '-r', '-z', '--name-only', baseline, '--', SCHEMAS_DIR]);
  if (listed === null) {
    return { violations: [], errors: [`git ls-tree 失败（基线 ${baseline.slice(0, 12)}）`] };
  }
  const schemaPaths = listed
    .split('\0')
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (schemaPaths.length === 0) return { violations: [], errors: [] };

  const violations: SchemaFreezeViolation[] = [];
  const errors: string[] = [];
  for (const schemaPath of schemaPaths) {
    const baseText = git(root, ['show', `${baseline}:${schemaPath}`]);
    if (baseText === null) {
      errors.push(`${schemaPath}: 基线 ${baseline.slice(0, 12)} 读取失败`);
      continue;
    }
    let curText: string;
    try {
      curText = readFileSync(join(root, schemaPath), 'utf8');
    } catch {
      violations.push({
        file: schemaPath,
        path: '<file>',
        kind: 'schema-deleted',
        detail: `已发布的合约形状文件在基线 ${baseline.slice(0, 12)} 上存在，当前工作区已删除`,
      });
      continue;
    }
    if (baseText === curText) continue;

    let baseJson: unknown;
    let curJson: unknown;
    try {
      baseJson = JSON.parse(baseText);
    } catch (error) {
      errors.push(`${schemaPath} (基线): JSON 无效 (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    try {
      curJson = JSON.parse(curText);
    } catch (error) {
      errors.push(`${schemaPath}: JSON 无效 (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    violations.push(...compareJsonSchemas(baseJson, curJson, schemaPath));
  }
  return { violations, errors };
}

export const EXCEPTIONS_PATH = '.github/checks/exceptions.json';
const CHECK = 'contract-schema-freeze';

export interface SchemaFreezeException {
  readonly path: string;
  readonly what: string;
  readonly reason: string;
  readonly removeWhen: string;
}

export const violationWhat = (v: SchemaFreezeViolation): string => `${v.kind}: ${v.path}`;

export function schemaFreezeExceptions(raw: unknown): { entries: SchemaFreezeException[]; problems: string[] } {
  if (!Array.isArray(raw)) return { entries: [], problems: [`${EXCEPTIONS_PATH}: 须是数组`] };
  const entries: SchemaFreezeException[] = [], problems: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || (item as { check?: unknown }).check !== CHECK) continue;
    const { path, what, reason, removeWhen } = item as Record<string, unknown>;
    if ([path, what, reason, removeWhen].some((field) => typeof field !== 'string' || !field.trim())) {
      problems.push(`${EXCEPTIONS_PATH}: ${CHECK} 的例外须写 path、what、reason、removeWhen`);
      continue;
    }
    entries.push({ path: path as string, what: what as string, reason: reason as string, removeWhen: removeWhen as string });
  }
  return { entries, problems };
}

export function reconcileSchemaFreeze(violations: readonly SchemaFreezeViolation[], exceptions: readonly SchemaFreezeException[]): string[] {
  const key = (file: string, what: string) => `${file}\u0000${what}`;
  const live = new Set(violations.map((v) => key(v.file, violationWhat(v))));
  const listed = new Map<string, number>();
  for (const e of exceptions) listed.set(key(e.path, e.what), (listed.get(key(e.path, e.what)) ?? 0) + 1);
  return [
    ...violations.filter((v) => !listed.has(key(v.file, violationWhat(v)))).map((v) => `${v.file}: ${v.detail}（${v.path}）`),
    ...exceptions.filter((e) => !live.has(key(e.path, e.what))).map((e) => `${EXCEPTIONS_PATH}: 例外 ${e.path} ${e.what} 已不再发生，请删除这一条`),
    ...[...listed].filter(([, count]) => count > 1).map(([k]) => `${EXCEPTIONS_PATH}: 例外重复 ${k.replace('\u0000', ' ')}`),
  ];
}

export function schemaFreezeProblems(root: string): string[] {
  const { violations, errors } = contractSchemaFreezeViolations(root);
  let raw: unknown = [];
  try {
    raw = JSON.parse(readFileSync(join(root, EXCEPTIONS_PATH), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [...errors, `${EXCEPTIONS_PATH}: 读取失败（${error instanceof Error ? error.message : String(error)}）`];
  }
  const { entries, problems } = schemaFreezeExceptions(raw);
  return [...errors, ...problems, ...reconcileSchemaFreeze(violations, entries)];
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const problems = schemaFreezeProblems(repoRoot);
  for (const line of problems) console.error(line);
  process.exit(problems.length === 0 ? 0 : 1);
}
