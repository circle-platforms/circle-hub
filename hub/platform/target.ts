// Pure target and lexical path rules. These do not establish native platform support or filesystem containment.
import { posix, win32 } from 'node:path';
import { PlatformError } from './errors.ts';

export function targetPaths(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

/** Only package names present in the pinned dependency tree; never substitute another architecture. */
export function embeddedPostgresPackage(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') {
    if (arch !== 'x64') {
      throw new PlatformError(`缺少已固定的 Windows ${arch} PostgreSQL 原生依赖，不使用 x64 模拟替代`, '先决定原生依赖或单独验证混合架构方案');
    }
    return '@embedded-postgres/windows-x64';
  }
  if ((platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) ||
      (platform === 'linux' && ['arm', 'arm64', 'ia32', 'ppc64', 'x64'].includes(arch))) {
    return `@embedded-postgres/${platform}-${arch}`;
  }
  throw new PlatformError(`缺少已固定的 PostgreSQL 依赖：${platform}/${arch}`);
}

/** Local drive paths only. Reject aliases before normalization can hide them; ACL/reparse-point checks are still missing. */
export function windowsLocalPath(value: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(value) || /[\x00-\x1f\x7f<>"|?*%!^&$`,']/.test(value)) {
    throw new PlatformError('Windows 路径必须是无特殊命令字符的本地盘符绝对路径');
  }
  const rest = value.slice(3).replaceAll('/', '\\');
  const segments = rest.split('\\');
  if (segments.at(-1) === '') segments.pop();
  if (segments.length === 0 || segments.some((part) => !part || part === '.' || part === '..' || /[. ]$|:/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new PlatformError('Windows 路径含空段、越界段、备用数据流、设备名或歧义结尾');
  }
  return win32.normalize(value);
}

export function assertUnixPostgres(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new PlatformError('Windows PostgreSQL 传输与认证尚未实现，拒绝使用 Unix socket/peer', '等待 Windows 原生认证、ACL 与服务验收');
  }
}
