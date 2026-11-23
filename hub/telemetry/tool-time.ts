const pad = (n: number): string => String(n).padStart(2, '0');

export function toolZoneOf(d: Date = new Date()): string {
  const m = -d.getTimezoneOffset();
  const a = Math.abs(m);
  const hours = Math.floor(a / 60);
  const minutes = a % 60;
  return minutes === 0 ? `UTC${m < 0 ? '-' : '+'}${hours}` : `UTC${m < 0 ? '-' : '+'}${pad(hours)}:${pad(minutes)}`;
}

export function toolLocalMinute(value: string): string {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return value;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${toolZoneOf(d)}）`;
}
