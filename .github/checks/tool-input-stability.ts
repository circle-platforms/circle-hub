// Enforces that the input schemas of the six MCP tools stay backward compatible against a
// frozen baseline: a declared field is never removed, never changes type, never turns from
// optional into required, and no new required field appears. Adding an optional field is
// allowed. The comparison is structural (parsed JSON), never textual. Update the baseline
// only with an approved contract change:
//   node .github/checks/tool-input-stability.ts --update-baseline
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_PATH = '.github/checks/tool-input-baseline.json';
export const TOOLS_PATH = 'contracts/generated/tools.json';

export type InputViolationKind = 'field-removed' | 'type-changed' | 'turned-required' | 'required-added';

export interface InputViolation {
  readonly tool: string;
  readonly field: string;
  readonly kind: InputViolationKind;
  readonly detail: string;
}

export interface ToolInputEntry {
  readonly fields: Record<string, string>;
  readonly required: readonly string[];
}

export type ToolInputBaseline = Record<string, ToolInputEntry>;

function schemaTypeName(schema: unknown): string {
  if (schema === null || typeof schema !== 'object') return 'any';
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.type)) return (node.type as unknown[]).map(String).sort().join('|');
  if (typeof node.type === 'string') return node.type;
  if (node.enum !== undefined) return 'enum';
  return 'any';
}

function collectFields(schema: unknown, prefix: string, out: Record<string, string>): void {
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  const properties = node.properties;
  if (properties !== null && typeof properties === 'object') {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      const path = prefix === '' ? name : `${prefix}.${name}`;
      out[path] = schemaTypeName(child);
      collectFields(child, path, out);
    }
  }
  if (node.items !== undefined) collectFields(node.items, `${prefix}[]`, out);
  if (node.additionalProperties !== null && typeof node.additionalProperties === 'object') {
    collectFields(node.additionalProperties, `${prefix}.*`, out);
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        const path = prefix === '' ? `${key}[${index}]` : `${prefix}.${key}[${index}]`;
        out[path] = schemaTypeName(branch);
        collectFields(branch, path, out);
      });
    }
  }
}

function requiredSet(schema: unknown): Set<string> {
  if (schema === null || typeof schema !== 'object') return new Set();
  const node = schema as Record<string, unknown>;
  return new Set(Array.isArray(node.required) ? (node.required as unknown[]).map(String) : []);
}

export function buildBaseline(tools: readonly Record<string, unknown>[]): ToolInputBaseline {
  const baseline: Record<string, ToolInputEntry> = {};
  for (const tool of tools) {
    const name = String(tool.name);
    const schema = tool.inputSchema;
    const fields: Record<string, string> = {};
    collectFields(schema, '', fields);
    baseline[name] = { fields, required: [...requiredSet(schema)].sort() };
  }
  return baseline;
}

export function compareInputSchemas(baseline: ToolInputBaseline, current: ToolInputBaseline): InputViolation[] {
  const violations: InputViolation[] = [];
  for (const [tool, before] of Object.entries(baseline)) {
    const after = current[tool];
    if (after === undefined) {
      violations.push({ tool, field: '(tool)', kind: 'field-removed', detail: `工具 ${tool} 整个不见了` });
      continue;
    }
    const requiredNow = new Set(after.required);
    for (const [field, type] of Object.entries(before.fields)) {
      const typeNow = after.fields[field];
      if (typeNow === undefined) {
        violations.push({ tool, field, kind: 'field-removed', detail: `已有字段被删掉（原来是 ${type}）` });
      } else if (typeNow !== type) {
        violations.push({ tool, field, kind: 'type-changed', detail: `类型从 ${type} 变成 ${typeNow}` });
      }
      const wasRequired = before.required.includes(field);
      if (!wasRequired && requiredNow.has(field)) {
        violations.push({ tool, field, kind: 'turned-required', detail: '从可选变成了必填' });
      }
    }
    for (const field of after.required) {
      if (!before.required.includes(field) && before.fields[field] === undefined) {
        violations.push({ tool, field, kind: 'required-added', detail: `新增了必填字段（类型 ${after.fields[field]}）` });
      }
    }
  }
  for (const tool of Object.keys(current)) {
    if (baseline[tool] === undefined) {
      violations.push({ tool, field: '(tool)', kind: 'required-added', detail: '基线里没有这个工具；新增工具要先更新基线' });
    }
  }
  return violations;
}

export function parseToolsJson(raw: unknown): Record<string, unknown>[] | string {
  if (!Array.isArray(raw)) return `${TOOLS_PATH}: 期望是工具数组`;
  const tools = raw as Record<string, unknown>[];
  for (const tool of tools) {
    if (typeof tool.name !== 'string') return `${TOOLS_PATH}: 有工具缺 name`;
  }
  return tools;
}

const KIND_TEXT: Record<InputViolationKind, string> = {
  'field-removed': '删了已有字段',
  'type-changed': '改了字段类型',
  'turned-required': '可选变必填',
  'required-added': '新增必填字段',
};

export function violationLines(violations: readonly InputViolation[]): string[] {
  return violations.map(
    (v) => `工具 ${v.tool} 的字段 ${v.field}：${KIND_TEXT[v.kind]}——${v.detail}`,
  );
}

const UPDATE_HINT =
  '六个工具的输入格式是不变契约；更新基线等于宣布一次不兼容的改动，要所有者的决定。确经批准的变更用 node .github/checks/tool-input-stability.ts --update-baseline 重录基线，并让合约所有者评审生成的差异。';

export function toolInputStabilityProblems(root: string): string[] {
  const toolsFile = join(root, TOOLS_PATH);
  const baselineFile = join(root, BASELINE_PATH);
  let toolsRaw: unknown;
  let baselineRaw: unknown;
  try {
    toolsRaw = JSON.parse(readFileSync(toolsFile, 'utf8'));
  } catch {
    return [`${TOOLS_PATH}: 读不到或不是 JSON`];
  }
  try {
    baselineRaw = JSON.parse(readFileSync(baselineFile, 'utf8'));
  } catch {
    return [`${BASELINE_PATH}: 读不到或不是 JSON`, UPDATE_HINT];
  }
  const tools = parseToolsJson(toolsRaw);
  if (typeof tools === 'string') return [tools];
  const violations = compareInputSchemas(baselineRaw as ToolInputBaseline, buildBaseline(tools));
  if (violations.length === 0) return [];
  return [...violationLines(violations), UPDATE_HINT];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--update-baseline')) {
    const tools = parseToolsJson(JSON.parse(readFileSync(join(repoRoot, TOOLS_PATH), 'utf8')));
    if (typeof tools === 'string') {
      console.error(tools);
      process.exit(1);
    }
    writeFileSync(
      join(repoRoot, BASELINE_PATH),
      `${JSON.stringify(buildBaseline(tools), null, 2)}\n`,
      'utf8',
    );
    console.log(`已把 ${TOOLS_PATH} 的当前输入格式写进 ${BASELINE_PATH}`);
  } else {
    const problems = toolInputStabilityProblems(repoRoot);
    for (const line of problems) console.error(line);
    process.exit(problems.length === 0 ? 0 : 1);
  }
}
