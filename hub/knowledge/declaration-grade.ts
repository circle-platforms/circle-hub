import { scanForCredentials } from '../records/api.ts';
import { KnowledgeError } from './errors.ts';

const OPERATION_SCHEMAS = new Set(['fed-observation@1', 'fed-procedure@1', 'fed-pitfall@1']);

export function operationSchema(schema: unknown): boolean {
  return typeof schema === 'string' && OPERATION_SCHEMAS.has(schema);
}

/** A stored contribution or feeding claim whose body is one of the three operation records. */
export function declarationGradeBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const value = body as {feeding?: {schema?: unknown}; statement?: {data?: {feeding?: {schema?: unknown}}}};
  return operationSchema(value.feeding?.schema) || operationSchema(value.statement?.data?.feeding?.schema);
}

export const DECLARATION_GROUND = '声明级操作记录不能作核验、评分或放行的根据（决定 73）；改引锁定根里的原文';
export const CAPTURED_GROUND = '客户端捕获的原件只随操作记录进入回注层，不能作另一次提交的根据（决定 73）；改引锁定根里的原文';

/** A declaration-grade rec or an exactly bound captured source cannot be evidence for another workflow. */
export async function declarationGroundRefusal(
  ref: {scheme: string; record?: string},
  record: (digest: string) => Promise<{body: unknown} | null>,
  source?: {body: unknown} | null,
): Promise<string | null> {
  if (ref.scheme === 'src') {
    if (source?.body !== null && typeof source?.body === 'object' && (source.body as {provenance_type?:unknown}).provenance_type === 'client_captured') return CAPTURED_GROUND;
    return null;
  }
  if (ref.scheme !== 'rec' || !ref.record) return null;
  const stored = await record(ref.record);
  return stored && declarationGradeBody(stored.body) ? DECLARATION_GROUND : null;
}

const MAX_OPERATION_SCAN_DEPTH = 1024;
const MAX_OPERATION_SCAN_NODES = 200_000;

function operationPath(segments: readonly (string | number)[], field?: string): string {
  const pointer = [...segments, ...(field === undefined ? [] : [field])].map(segment => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
  return pointer.slice(0, 1024);
}

export function assertOperationFields(value: unknown): void {
  const pending: unknown[] = [value];
  const depths = [0];
  const paths: Array<readonly (string | number)[]> = [[]];
  const seen = new Set<object>();
  for (let index = 0, visited = 0; index < pending.length; index++) {
    if (++visited > MAX_OPERATION_SCAN_NODES) throw new KnowledgeError('操作记录扫描超过宽度上限；按提交结构拆分后重交', { code: 'SUBMISSION_SCHEMA_VIOLATION', detail: { path: operationPath(paths[index]!) } });
    const current = pending[index];
    const depth = depths[index]!;
    if (depth > MAX_OPERATION_SCAN_DEPTH) throw new KnowledgeError('操作记录扫描超过深度上限；按提交结构修正后重交', { code: 'SUBMISSION_SCHEMA_VIOLATION', detail: { path: operationPath(paths[index]!) } });
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const row = current as Record<string, unknown>;
    if (operationSchema(row.schema)) {
      for (const key of ['device', 'bed']) {
        const field = row[key];
        if (field === undefined) continue;
        if (typeof field !== 'string') throw new KnowledgeError(`操作记录的 ${key} 必须是字符串；按结构修正后重交`, { code: 'SUBMISSION_SCHEMA_VIOLATION', detail: { path: operationPath(paths[index]!, key) } });
        const scan = scanForCredentials(new TextEncoder().encode(field));
        if (!scan.inspected || scan.truncated || scan.findings.length > 0) {
          throw new KnowledgeError(`操作记录的 ${key} 未通过完整凭据扫描；清理该字段后重交`, { code: 'CREDENTIAL_IN_UPLOAD', detail: { path: operationPath(paths[index]!, key) } });
        }
      }
    }
    let width = 0;
    for (const key in row) {
      if (!Object.hasOwn(row, key)) continue;
      if (++width > MAX_OPERATION_SCAN_NODES) throw new KnowledgeError('操作记录扫描超过宽度上限；按提交结构拆分后重交', { code: 'SUBMISSION_SCHEMA_VIOLATION', detail: { path: operationPath(paths[index]!) } });
      pending.push(row[key]);
      depths.push(depth + 1);
      paths.push([...paths[index]!, key]);
    }
  }
}
