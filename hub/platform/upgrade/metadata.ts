// This one-release exporter reads verified non-value definition objects, never sealed values or bearer tokens.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DigestRuleSchema } from '../../../contracts/generated/vocabulary.ts';
import { UserId, IsoTime, Sha256 } from '../../../contracts/src/common.ts';
import { VariableName, SecretMetadataFile, type SecretRecord } from '../../../contracts/src/variables.ts';
import { recordDigest } from '../../records/api.ts';
import { sha256File } from '../files.ts';
import { fields, type OldRecord, type UpgradeIssue } from './state.ts';

export type UpgradeSecretMetadata = SecretRecord;
export type UpgradeSecretFile = SecretMetadataFile;
export interface MetadataResult { files: UpgradeSecretFile[]; issues: UpgradeIssue[]; }
export interface MetadataSource {
  definition(hash: string): Promise<Uint8Array>;
  sealedFingerprint(entry: string): Promise<string | null>;
}

export function fileMetadataSource(objects: string, vault: string): MetadataSource {
  return {
    async definition(hash) {
      if (!Sha256.safeParse(hash).success) throw new Error('密钥非值定义摘要不合格式');
      const bytes = await readFile(join(objects, hash.slice(0, 2), hash));
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('密钥非值定义对象完整性不符');
      return bytes;
    },
    async sealedFingerprint(entry) {
      if (!/^secret\.[a-z][a-z0-9_]{0,63}\.[a-f0-9]{24}$/.test(entry)) throw new Error('密钥原件名称不合格式');
      try { return (await sha256File(join(vault, entry + '.sealed'))).sha256; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
  };
}

/** The old decision chain defines version/current; missing facts never become filesystem guesses. */
export async function exportSecretMetadata(decisions: readonly OldRecord[], source: MetadataSource): Promise<MetadataResult> {
  const grouped = new Map<string, OldRecord[]>(), issues: UpgradeIssue[] = [], files: UpgradeSecretFile[] = [];
  const issue = (row: OldRecord, reason: string) => issues.push({ table: 'records', row: decisions.indexOf(row) + 1, reason });
  for (const row of decisions) {
    try {
      const body = fields(row.body);
      if (row.kind !== 'authorization' || row.schema !== 'authorization@1' || recordDigest(row) !== row.digest || body.permission !== 'resource_config' || body.subject !== '*' || typeof body.object !== 'string' || !body.object.startsWith('secret:')) throw new Error();
      const name = VariableName.parse(body.object.slice(7));
      const list = grouped.get(name) ?? []; list.push(row); grouped.set(name, list);
    } catch { issue(row, '旧密钥决定的完整性或身份不符'); }
  }
  for (const [name, rows] of grouped) {
    rows.sort((a, b) => BigInt(a.seq) < BigInt(b.seq) ? -1 : 1);
    const versions: UpgradeSecretFile['versions'] = [];
    let previous: string | null = null;
    let revoked = false;
    for (const row of rows) {
      try {
        const decision = fields(row.body);
        if (decision.supersedes !== previous || typeof decision.revoked !== 'boolean') throw new Error();
        previous = row.digest;
        if (decision.revoked) {
          if (!versions.length) throw new Error();
          revoked = true; versions.at(-1)!.metadata.revoked = true; continue;
        }
        if (typeof decision.bound !== 'string') throw new Error();
        const bytes = await source.definition(decision.bound);
        if (createHash('sha256').update(bytes).digest('hex') !== decision.bound) throw new Error();
        const old = fields(JSON.parse(Buffer.from(bytes).toString('utf8')));
        if (old.schema !== 'secret@1' || old.name !== name || typeof old.entry !== 'string' || !new RegExp('^secret\\.' + name.toLowerCase() + '\\.[a-f0-9]{24}$').test(old.entry) || !DigestRuleSchema.safeParse(old.digest_rule).success || !Number.isInteger(old.length) || Number(old.length) < 1 || Number(old.length) > 4096) throw new Error();
        if (!UserId.safeParse(decision.decided_by).success || !IsoTime.safeParse(decision.decided_at).success) throw new Error();
        const fingerprint = await source.sealedFingerprint(old.entry);
        versions.push({ metadata: { schema: 'secret@1', name, entry: 'secret.' + name.toLowerCase(), digest_rule: DigestRuleSchema.parse(old.digest_rule), length: Number(old.length), version: versions.length + 1, set_by: String(decision.decided_by), set_at: String(decision.decided_at), revoked: false }, sealed_entry: old.entry, sealed_sha256: fingerprint, current: false });
        revoked = false;
      } catch { issue(row, '旧密钥的版本、摘要规则、设置事实或原件身份不完整'); }
    }
    if (!versions.length) continue;
    const last = versions.at(-1)!;
    last.current = true; last.metadata.revoked = revoked;
    if (!revoked && last.sealed_sha256 === null) { issue(rows.at(-1)!, '现行密钥原密文文件缺失'); continue; }
    const file = SecretMetadataFile.safeParse({ name, versions });
    if (file.success) files.push(file.data);
    else issue(rows.at(-1)!, '派生元数据不合C12唯一格式');
  }
  return { files, issues };
}
