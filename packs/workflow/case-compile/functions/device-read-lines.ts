// Which commands of a brief a booked device can be read for before the case is written, and how the pipeline names what it read.
// A brief lists, for each command its recomposition record points at, the command a read-only prefix of the product reaches with
// the same words. Those that take no parameter, or only optional ones, can be sent as the words alone. What the device prints for them, read before any case
// has configured it, shows how that output is written and laid out; it is no source of the run and no basis for an expected value.
// Disclosure only: the note names the files, and nothing in a plan is checked against them.

export const READS_DIRECTORY = 'device-reads';
export const READ_LINES_PER_CASE = 6;
const PLAIN_LINE = /^[A-Za-z][A-Za-z0-9_.:/-]*(?: [A-Za-z0-9_.:/-]+)*$/;

/** The read-only prefixes a brief states in its command_policy line, as tree paths ("/commands/show"). */
export function readOnlyPrefixes(brief: string): string[] {
  const stated = /只读前缀 ([^；。\n]+)[；。]/.exec(brief);
  return stated ? stated[1]!.split('、').map((part) => part.trim()).filter((part) => part.startsWith('/')) : [];
}

// A statement that is the command's words followed only by bracketed (optional) parameters: "show widget size [<unit:string>]".
const ONLY_OPTIONAL = /^(?: \[[^\[\]]*\])+$/;

/** The read-only commands of the brief that can be sent without a parameter, in the order the brief shows them, without repeats. */
export function readableLines(brief: string, limit = READ_LINES_PER_CASE): string[] {
  const prefixes = readOnlyPrefixes(brief), rows = brief.split('\n'), found: string[] = [];
  for (let at = 0; at < rows.length && found.length < limit; at++) {
    const header = /^# (\/\S+)$/.exec(rows[at]!);
    if (!header || !prefixes.some((prefix) => header[1] === prefix || header[1]!.startsWith(prefix + '/'))) continue;
    let line: string;
    try { line = header[1]!.split('/').slice(2).map((word) => decodeURIComponent(word)).join(' '); } catch { continue; }
    if (!PLAIN_LINE.test(line) || found.includes(line)) continue;
    // The entry of a command prints each of its statements on a line of its own: the words alone, or the words and parameters.
    for (let next = at + 1; next < rows.length && rows[next] !== '' && !rows[next]!.startsWith('#'); next++) {
      const row = rows[next]!;
      if (row === line || (row.startsWith(line + ' ') && ONLY_OPTIONAL.test(row.slice(line.length)))) { found.push(line); break; }
    }
  }
  return found;
}

/** The file one line's output is kept in: the words joined by hyphens. */
export function readFileName(line: string): string {
  return line.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) + '.txt';
}

/** What the writer of a case is told about the outputs read for it; nothing when there is none. */
export function deviceReadNote(device: string, reads: ReadonlyArray<{ line: string; file: string; lines?: number }>, coming: ReadonlyArray<{ line: string; file: string }> = []): string | undefined {
  if (!reads.length && !coming.length) return undefined;
  const read = reads.map((row) => `“${row.line}”在 ${row.file}${row.lines === undefined ? '' : `（${row.lines} 行）`}`);
  // A read asked for a moment ago is still on its way: its file appears when the device has answered, and never when it could not be read.
  const asked = coming.map((row) => `“${row.line}”读到后在 ${row.file}`);
  return `供参考：设备 ${device} 对本条简报里这些只读命令的输出，${[...read, ...asked].join('，')}${asked.length ? '；刚发出读取的，稍后没有这个文件就是没读成' : ''}。读的时候设备上没有用例的配置；这些输出只说明写法和排版，不是期望值的依据`;
}
