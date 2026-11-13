// The producer owns the sole metadata codec; this adapter authenticates non-value facts and never opens value entries.
import { FileVault, canonicalize } from '../../records/api.ts';
import { hubKeyProvider } from '../service.ts';
import { exists, sha256File } from '../files.ts';
import { join } from 'node:path';
import type { PlatformContext } from '../context.ts';
import type { UpgradeMetadataWriter } from './host.ts';

export function producerMetadataWriter(context: PlatformContext): UpgradeMetadataWriter {
  const vault = new FileVault(context.layout.vault, hubKeyProvider({ ...context.env, CIRCLE_HUB_DATA_DIR: context.layout.root }));
  const unchangedCheck = async () => {
    // A missing root check would make FileVault authenticate by opening an original value. This upgrader refuses that.
    if (!await exists(join(context.layout.vault, 'key-check'))) throw new Error('缺少原密钥库认证事实，不解封业务值补造');
    return (await sha256File(join(context.layout.vault, 'key-check'))).sha256;
  };
  return {
    async write(file) {
      const before = await unchangedCheck();
      await vault.writeSecretMetadata(file);
      if (before !== await unchangedCheck()) throw new Error('原密钥库认证文件发生变化');
    },
    async verify(files) {
      await unchangedCheck();
      for (const file of files) {
        const history = await vault.secretHistory(file.name);
        if (canonicalize(history) !== canonicalize(file.versions.map(row => row.metadata).reverse())) throw new Error('认证元数据与旧设置事实不符');
        if (canonicalize(await vault.secretMetadata(file.name)) !== canonicalize(file.versions.at(-1)!.metadata)) throw new Error('密钥现行版本事实不符');
      }
    },
  };
}
