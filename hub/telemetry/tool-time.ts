// Clock times in tool returns (MCP text): Hub process zone, labeled, with month-day so a next-day due is readable.
// Console pages keep browser-local formatting. Device-output timestamps stay verbatim (Boss 20:53).

const pad = (n: number): string => String(n).padStart(2, '0');

/** Zone label as people write it: UTC+8, UTC+09:30. */
export function toolZoneOf(d: Date = new Date()): string {
  const m = -d.getTimezoneOffset();
  const a = Math.abs(m);
  const hours = Math.floor(a / 60);
  const minutes = a % 60;
  return minutes === 0 ? `UTC${m < 0 ? '-' : '+'}${hours}` : `UTC${m < 0 ? '-' : '+'}${pad(hours)}:${pad(minutes)}`;
}

/** Tool-facing instant: `11-14 17:35（UTC+8）`. */
export function toolLocalMinute(value: string): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${toolZoneOf(d)}）`;
}
