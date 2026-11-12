// The lease key of one device of a bed. The only place its format is written or read; conclude.ts and match.ts write and
// look up keys with it, and booking.ts parses them back, so the format cannot change in one place only.

/** The lease key of one device of a bed. */
export const bedDeviceKey = (bed: string, device: string): string => `bed/${bed}/${device}`;

/** A device lease key read back; null for any other key, including the address keys `bed/<bed>/ip/<address>`. */
export function parseBedDeviceKey(key: string): { bed: string; device: string } | null {
  const parts = key.split('/');
  return parts.length === 3 && parts[0] === 'bed' && parts[1] !== '' && parts[2] !== '' ? { bed: parts[1]!, device: parts[2]! } : null;
}
