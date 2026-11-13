import type { VariableUse } from '../../contracts/src/variables.ts';
import type { Principal } from '../records/api.ts';

export interface SecretUseLabelReaders {
  variables: { history(by: Principal, kind: 'var', name: string): Promise<readonly { version: number; decision: { digest: string } }[]> };
  vault: { secretHistory(name: string): Promise<readonly { name: string; version: number }[]> };
}

/** Reads only version metadata; secret versions never become record references or credential reads. */
export async function secretUseLabels(readers: SecretUseLabelReaders, by: Principal, uses: readonly VariableUse[]): Promise<string[]> {
  const labels: string[] = [];
  for (const use of uses) {
    if (use.kind === 'secret') {
      const metadata = (await readers.vault.secretHistory(use.name)).find(row => row.name === use.name && row.version === use.version);
      labels.push(`${use.name} 第 ${use.version} 版${metadata ? '' : '（密钥库元数据未知）'}`);
    } else {
      const version = (await readers.variables.history(by, 'var', use.name)).find(row => row.decision.digest === use.decision);
      labels.push(version ? `${use.name} 第 ${version.version} 版` : `${use.name} 版本未知`);
    }
  }
  return labels;
}
