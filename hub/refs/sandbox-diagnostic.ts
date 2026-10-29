import { scanForCredentials } from '../records/api.ts';
import { SandboxError } from '../rules/api.ts';

/** Only host-supplied parser declarations may appear here; never print a child error, output or source. */
export interface ParserSite {
  parser: string;
  pack: string;
  module: string;
  export: string;
  phase: 'parse' | 'locate';
}

export function withParserSite(error: unknown, site: ParserSite): unknown {
  if (error instanceof SandboxError) error.detail.parser_site = site;
  return error;
}

function safeIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const scan = scanForCredentials(Buffer.from(value));
  return scan.inspected && !scan.truncated && scan.findings.length === 0 ? value : null;
}

/** Fixed diagnostics; plugin-controlled error messages, stdout, stderr and arbitrary detail fields are not used. */
export function sandboxReadDiagnostic(error: SandboxError): { message: string; fix: string; admin: string } {
  const cache = error.detail.limit === 'document_cache_bytes';
  const operation = error.code === 'SANDBOX_TIMEOUT' && error.detail.limit === 'operation';
  const childWall = error.code === 'SANDBOX_TIMEOUT' && error.detail.limit === 'time';
  const childCpu = error.code === 'SANDBOX_TIMEOUT' && error.detail.limit === 'cpu';
  const label = cache ? '文档缓存估算超过预算'
    : operation ? '文档解析或定位的整次操作超过时限，无法据此判断单个函数是否超时'
    : childWall ? '技能包函数调用超过时间上限（含子进程启动）'
    : childCpu ? '技能包函数调用超过 CPU 时间上限'
    : '来源片段暂时未核对：技能包沙箱';
  const fix = cache ? '请来源维护者拆分原件，或请解析器维护者缩小保留结构后重读'
    : operation ? '管理员查看本次追踪及来源读取耗时，核对后重新读取；不要推定是某个函数超时'
    : '管理员核对技能包和沙箱状态，恢复后重新读取';
  const site = error.detail.parser_site;
  let where = '';
  if (site && typeof site === 'object' && !Array.isArray(site)) {
    const row = site as Record<string, unknown>;
    const parser = safeIdentity(row.parser), pack = safeIdentity(row.pack), module = safeIdentity(row.module), name = safeIdentity(row.export);
    const phase = row.phase === 'parse' ? '解析' : row.phase === 'locate' ? '定位' : null;
    const relative = module && !module.startsWith('/') && !module.includes('\\') && module.split('/').every(part => part !== '' && part !== '.' && part !== '..');
    if (parser && !parser.includes('/') && pack && !pack.includes('/') && name && !name.includes('/') && relative && phase) where = `；${phase} ${parser}，${pack}/${module}#${name}`;
  }
  const category = cache ? '文档缓存预算' : operation ? '整次文档操作时限' : childWall ? '函数调用时限' : childCpu ? '函数调用 CPU 时限' : '技能包函数失败';
  return { message: `${label}：${error.code}`, fix, admin: `${category}：${error.code}${where}` };
}
