import { VaultReadinessError, type VaultReadinessIssue } from '../../records/api.ts';

export async function primeStartupSecrets(
  connectors: { primeSecrets(): Promise<void> }, notices: string[], log: (line: string) => void,
): Promise<readonly VaultReadinessIssue[]> {
  try { await connectors.primeSecrets(); return []; }
  catch (error) {
    if (!(error instanceof VaultReadinessError)) throw error;
    notices.push(error.message);
    for (const issue of error.issues) log(`启动密钥库诊断：名字 ${issue.name ?? '无法确认'}；条目 ${issue.entry ?? '无法确认'}；缺失或不合规则 ${issue.missing.join('、')}；原因 ${issue.reason}；下一步 ${issue.next_action}`);
    return error.issues;
  }
}
