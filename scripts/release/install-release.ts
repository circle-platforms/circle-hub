// Local verified-directory installer. Downloads, untrusted archive extraction and service deployment are intentionally separate.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installRelease } from './operations.ts';
import { targetFor } from './integrity.ts';

export async function main(args: string[]): Promise<number> {
  if (args.length !== 5) { process.stderr.write('用法：node scripts/release/install-release.ts <发行目录> <安装目录> <数据目录> <预期版本> <预期提交>\n'); return 1; }
  const [root, prefix, dataRoot, version, commit] = args as [string, string, string, string, string];
  try {
    const result = await installRelease(resolve(root), { prefix: resolve(prefix), dataRoot: resolve(dataRoot), expected: { version, commit, target: targetFor() } });
    process.stdout.write(`应用文件已安装：${result.version}；服务部署需另行执行\n`);
    return 0;
  } catch {
    process.stderr.write('错误：应用文件安装失败；没有确认服务部署成功\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
