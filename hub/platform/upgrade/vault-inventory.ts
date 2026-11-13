// Ciphertext-only inventory. Non-named operational entries remain opaque, at their exact original paths.
import { join } from 'node:path';
import { FileVault } from '../../records/api.ts';
import { VariableName } from '../../../contracts/src/variables.ts';
import { sha256File } from '../files.ts';
import type { UpgradeSecretFile } from './metadata.ts';
import type { UpgradeIssue } from './state.ts';

export interface VaultOriginal { entry: string; named: boolean; fingerprint: string; }
export async function vaultOriginals(directory: string, metadata: readonly UpgradeSecretFile[]): Promise<{ originals: VaultOriginal[]; issues: UpgradeIssue[] }> {
  const entries = await new FileVault(directory).list();
  const originals: VaultOriginal[] = [], issues: UpgradeIssue[] = [];
  const known = new Set(metadata.flatMap(file => file.versions.map(row => row.sealed_entry)));
  for (const [index, entry] of entries.entries()) {
    const fingerprint = await sha256File(join(directory, entry + '.sealed'));
    const match = /^secret\.([a-z][a-z0-9_]{0,63})\.[a-f0-9]{24}$/.exec(entry);
    originals.push({ entry, named: match !== null, fingerprint: fingerprint.sha256 });
    if (match && !known.has(entry)) {
      const name = VariableName.parse(match[1]!.toUpperCase());
      issues.push({ table: 'vault_metadata', row: index + 1, name, missing: ['version','digest_rule','current','set_by','set_at'], reason: '原封存存在，但旧设置决定没有给出可认证的完整非值事实', nextAction: '运行 circle-hub upgrade 从完整旧记录自动补齐；旧设置记录确实缺失时先恢复含该记录的备份，不能猜测或重输值掩盖' });
    }
  }
  return { originals, issues };
}
export async function verifyVaultOriginals(directory: string, originals: readonly VaultOriginal[]): Promise<void> {
  for (const original of originals) {
    if ((await sha256File(join(directory, original.entry + '.sealed'))).sha256 !== original.fingerprint) throw new Error('原封存密文字节发生变化，不能完成升级');
  }
}
