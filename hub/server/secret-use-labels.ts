import type { SecretCipherIdentity, VariableUse } from '../../contracts/src/variables.ts';
import { VaultReadinessError, type Principal } from '../records/api.ts';

export interface SecretUseLabelReaders {
  variables: { history(by: Principal, kind: 'var', name: string): Promise<readonly { version: number; decision: { digest: string } }[]> };
  vault: { secretIdentity(name: string): Promise<SecretCipherIdentity | null> };
}

/** Reads only version metadata; secret versions never become record references or credential reads. */
export async function secretUseLabels(readers: SecretUseLabelReaders, by: Principal, uses: readonly VariableUse[]): Promise<string[]> {
  const labels: string[] = [];
  for (const use of uses) {
    if (use.kind === 'secret') {
      let identity: SecretCipherIdentity | null = null;
      try { identity = await readers.vault.secretIdentity(use.name); }
      catch (error) { if (!(error instanceof VaultReadinessError)) throw error; }
      const metadata = identity?.name === use.name && identity.version === use.version && identity.sealed_sha256 === use.sealed_sha256;
      labels.push(`${use.name} 第 ${use.version} 版${metadata ? '' : '（密钥库元数据未知）'}`);
    } else {
      const version = (await readers.variables.history(by, 'var', use.name)).find(row => row.decision.digest === use.decision);
      labels.push(version ? `${use.name} 第 ${version.version} 版` : `${use.name} 版本未知`);
    }
  }
  return labels;
}
