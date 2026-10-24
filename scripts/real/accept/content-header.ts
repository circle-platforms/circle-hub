// Circle may prepend its allow-hook receipt. No other nonempty prelude is trusted.
export function contentHeader(result: string): { reference: string; tier: string; lines: string[] } | null {
  let text = result;
  if (text.trimStart().startsWith('"')) {
    try { const decoded: unknown = JSON.parse(text); if (typeof decoded !== 'string') return null; text = decoded; }
    catch { return null; }
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^内容 (\S+)：(.+)$/.exec(line);
    if (match) return { reference: match[1], tier: match[2], lines: lines.slice(index) };
    if (line.trim() !== '' && line !== 'Hook allowed this call.') return null;
  }
  return null;
}
