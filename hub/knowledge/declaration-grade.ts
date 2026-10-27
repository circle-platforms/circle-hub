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

/** A rec: of an operation record cannot be evidence. The upload it quotes stays citable by that record's own admission. */
export async function declarationGroundRefusal(
  ref: {scheme: string; record?: string},
  record: (digest: string) => Promise<{body: unknown} | null>,
): Promise<string | null> {
  if (ref.scheme !== 'rec' || !ref.record) return null;
  const stored = await record(ref.record);
  return stored && declarationGradeBody(stored.body) ? DECLARATION_GROUND : null;
}
