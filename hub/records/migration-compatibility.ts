import { Sha256 } from '../../contracts/src/common.ts';
import type { RecordMigrationReceipt, RecordsSchemaCompatibility } from './schema-compatibility.ts';

/** Columns of the owner-managed hub_migration_compatibility carrier. */
export interface MigrationCompatibilityDeclaration {
  migration_version: number;
  format_version: number;
  migration_name: string;
  migration_sha256: string;
  minimum_reader_level: number;
}
export interface MigrationCompatibilityObservation {
  available: boolean;
  applied: RecordMigrationReceipt[] | null;
  /** null means that the carrier does not exist, not that its read failed. */
  declarations: MigrationCompatibilityDeclaration[] | null;
  declarationsReadOnly: boolean | null;
}
export interface MigrationCompatibilityResult extends RecordsSchemaCompatibility {
  effectiveFloor: number | null;
  acceptedUnknown: RecordMigrationReceipt[];
}

export function validMigrationCompatibilityDeclaration(value: MigrationCompatibilityDeclaration): boolean {
  return Number.isSafeInteger(value.migration_version) && value.migration_version >= 1 && value.format_version === 1
    && typeof value.migration_name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value.migration_name)
    && Sha256.safeParse(value.migration_sha256).success
    && Number.isSafeInteger(value.minimum_reader_level) && value.minimum_reader_level >= 2;
}
function validReceipt(row: RecordMigrationReceipt): boolean {
  return Number.isSafeInteger(row.version) && typeof row.name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(row.name) && Sha256.safeParse(row.sha256).success;
}

/** Validate receipt bindings without making a claim about the calling binary's capabilities. */
export function checkMigrationCompatibilityDeclarations(applied: readonly RecordMigrationReceipt[], declarations: readonly MigrationCompatibilityDeclaration[]): { effectiveFloor: number | null; problem: string | null } {
  let effectiveFloor: number | null = null;
  const fail = (problem: string) => ({ effectiveFloor, problem });
  if (applied.length === 0 || applied.some((row, index) => !validReceipt(row) || row.version !== index + 1)) return fail('迁移回执缺项、重复或次序不完整；请核对迁移身份，保留现库');
  const seen = new Set<number>();
  for (const declaration of declarations) {
    if (!validMigrationCompatibilityDeclaration(declaration)) return fail('兼容声明格式或最低代码级别不受支持；请使用兼容发布，保留现库');
    const row = applied[declaration.migration_version - 1];
    if (seen.has(declaration.migration_version) || !row || row.name !== declaration.migration_name || row.sha256 !== declaration.migration_sha256) return fail('兼容声明重复或未与迁移版本、名称、摘要精确绑定；请核对迁移身份，保留现库');
    seen.add(declaration.migration_version);
    effectiveFloor = Math.max(effectiveFloor ?? 0, declaration.minimum_reader_level);
  }
  return { effectiveFloor, problem: null };
}

/** Code capability includes authorization semantics; receipt acceptance alone proves no preservation or rollback. */
export function evaluateMigrationCompatibility(expected: readonly RecordMigrationReceipt[], observation: MigrationCompatibilityObservation, readerLevel: number): MigrationCompatibilityResult {
  if (!Number.isSafeInteger(readerLevel) || readerLevel < 1) throw new TypeError('reader level must be a positive safe integer fixed by the calling code');
  if (expected.length === 0 || expected.some((row, index) => !validReceipt(row) || row.version !== index + 1)) throw new TypeError('expected migration receipts must be a complete ordered sequence');
  const result: MigrationCompatibilityResult = {
    status: 'incompatible', compatible: false, expected: expected.map(row => ({ ...row })),
    applied: observation.available ? observation.applied?.map(row => ({ ...row })) ?? null : null,
    problems: [], effectiveFloor: null, acceptedUnknown: [],
  };
  const refuse = (problem: string): MigrationCompatibilityResult => { result.problems.push(problem); return result; };
  if (!observation.available) {
    result.status = 'unavailable'; result.compatible = null;
    return refuse('无法观察迁移回执或兼容声明；请检查连接及读取权限后重试，保留现库，不执行重建');
  }
  const applied = observation.applied;
  if (applied === null || applied.length === 0) return refuse('记录库缺少迁移回执；请核对兼容发布与迁移路径，保留现库');
  if (applied.some((row, index) => !validReceipt(row) || row.version !== index + 1)) return refuse('迁移回执缺项、重复或次序不完整；请核对迁移身份，保留现库');
  for (const known of expected) {
    const row = applied[known.version - 1];
    if (!row || row.name !== known.name || row.sha256 !== known.sha256) return refuse(`已知迁移 ${known.version} 的名称或校验和不符或尚未应用；兼容声明不能豁免，请核对兼容发布，保留现库`);
  }
  const declarations = observation.declarations;
  if (declarations !== null && observation.declarationsReadOnly !== true) return refuse('兼容声明载体不满足运行角色只读约束；请检查所有者及授权，保留现库');
  const checked = checkMigrationCompatibilityDeclarations(applied, declarations ?? []);
  result.effectiveFloor = checked.effectiveFloor;
  if (checked.problem !== null) return refuse(checked.problem);
  const declaredVersions = new Set((declarations ?? []).map(row => row.migration_version));
  const unknown = applied.filter(row => row.version > expected.length);
  if (unknown.some(row => !declaredVersions.has(row.version))) return refuse('未知迁移缺少兼容声明；仍按严格规则拒绝，请使用认识这些迁移的兼容发布，保留现库');
  if (result.effectiveFloor !== null && readerLevel < result.effectiveFloor) return refuse(`当前代码级别 ${readerLevel} 低于所需级别 ${result.effectiveFloor}；请使用满足读写及权限语义的发布，不能直接降回，保留现库`);
  result.status = 'compatible'; result.compatible = true; result.acceptedUnknown = unknown.map(row => ({ ...row }));
  return result;
}

/** The caller supplies verified projected receipts and declarations; this does not execute migration SQL. */
export function previewMigrationCompatibility(expected: readonly RecordMigrationReceipt[], projectedObservation: MigrationCompatibilityObservation, targetReaderLevel: number): MigrationCompatibilityResult {
  return evaluateMigrationCompatibility(expected, projectedObservation, targetReaderLevel);
}
