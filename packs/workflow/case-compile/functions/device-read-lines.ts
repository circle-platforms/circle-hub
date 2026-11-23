export const READS_DIRECTORY = 'device-reads';
export const READ_LINES_PER_CASE = 6;
const PLAIN_LINE = /^[A-Za-z][A-Za-z0-9_.:/-]*(?: [A-Za-z0-9_.:/-]+)*$/;

export function readOnlyPrefixes(brief: string): string[] {
  const stated = /只读前缀 ([^；。\n]+)[；。]/.exec(brief);
  return stated ? stated[1]!.split('、').map((part) => part.trim()).filter((part) => part.startsWith('/')) : [];
}

const ONLY_OPTIONAL = /^(?: \[[^\[\]]*\])+$/;

export function readableLines(brief: string, limit = READ_LINES_PER_CASE): string[] {
  const prefixes = readOnlyPrefixes(brief), rows = brief.split('\n'), found: string[] = [];
  for (let at = 0; at < rows.length && found.length < limit; at++) {
    const header = /^# (\/\S+)$/.exec(rows[at]!);
    if (!header || !prefixes.some((prefix) => header[1] === prefix || header[1]!.startsWith(prefix + '/'))) continue;
    let line: string;
    try { line = header[1]!.split('/').slice(2).map((word) => decodeURIComponent(word)).join(' '); } catch { continue; }
    if (!PLAIN_LINE.test(line) || found.includes(line)) continue;
    for (let next = at + 1; next < rows.length && rows[next] !== '' && !rows[next]!.startsWith('#'); next++) {
      const row = rows[next]!;
      if (row === line || (row.startsWith(line + ' ') && ONLY_OPTIONAL.test(row.slice(line.length)))) { found.push(line); break; }
    }
  }
  return found;
}

export function readFileName(line: string): string {
  return line.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) + '.txt';
}

export function deviceReadNote(device: string, reads: ReadonlyArray<{ line: string; file: string; lines?: number }>, coming: ReadonlyArray<{ line: string; file: string }> = []): string | undefined {
  if (!reads.length && !coming.length) return undefined;
  const read = reads.map((row) => `“${row.line}”在 ${row.file}${row.lines === undefined ? '' : `（${row.lines} 行）`}`);
  const asked = coming.map((row) => `“${row.line}”读到后在 ${row.file}`);
  return `供参考：设备 ${device} 对本条简报里这些只读命令的输出，${[...read, ...asked].join('，')}${asked.length ? '；刚发出读取的，稍后没有这个文件就是没读成' : ''}。读的时候设备上没有用例的配置；这些输出只说明写法和排版，不是期望值的依据`;
}
