// Subject builder of the bed-install checks (item-subject-input@1 -> the check's subject): the item, the build the
// submission names (slot reason), the group the projection froze (bed, devices, targets, digests, request model) and the
// run facts the check needs from the frozen context: the Hub's predecessor, the locked build and the lease rows of bed/.
import { isRecord } from './common.ts';

export interface InstallGroup {
  bed: string;
  devices: string[];
  targets: string[];
  manifest_sha256: string;
  bed_pointer: string;
  request_sha256: string;
  request: unknown;
}

export interface InstallSubject {
  item: { id: string; label: string; location: string; fields: Record<string, unknown> };
  claimed: string | null;
  group: InstallGroup | null;
  predecessor: string | null;
  build: string | null;
  leases: Array<{ key: string; run: string }>;
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

function groupOf(context: Record<string, unknown>): InstallGroup | null {
  const groups = Array.isArray(context.groups) ? context.groups : [];
  return groupFrom(groups.find((value) => isRecord(value) && value.kind === 'bed-install'));
}

/** A frozen install group with every field present, or null. */
export function groupFrom(group: unknown): InstallGroup | null {
  if (!isRecord(group)) return null;
  const text = (key: string): string => (typeof group[key] === 'string' ? (group[key] as string) : '');
  if (!text('bed') || !text('manifest_sha256') || !text('request_sha256') || !text('bed_pointer')) return null;
  return { bed: text('bed'), devices: names(group.devices), targets: names(group.targets), manifest_sha256: text('manifest_sha256'), bed_pointer: text('bed_pointer'), request_sha256: text('request_sha256'), request: group.request ?? null };
}

/** The build the submission says is to be installed: slots.reason[0].data.build. */
function claimedBuild(slots: unknown): string | null {
  const record = isRecord(slots) ? slots.reason : undefined;
  const first = Array.isArray(record) ? record[0] : record;
  const data = isRecord(first) && isRecord(first.data) ? first.data : first;
  return isRecord(data) && typeof data.build === 'string' && data.build !== '' ? data.build : null;
}

export function buildSubject(input: unknown): InstallSubject {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const item = isRecord(raw.item) ? raw.item : {};
  const leases = isRecord(context.leases) && Array.isArray(context.leases.entries) ? context.leases.entries : [];
  return {
    item: {
      id: typeof item.id === 'string' ? item.id : '',
      label: typeof item.label === 'string' ? item.label : '',
      location: typeof item.location === 'string' ? item.location : '',
      fields: isRecord(item.fields) ? item.fields : {},
    },
    claimed: claimedBuild(raw.slots),
    group: groupOf(context),
    predecessor: typeof context.predecessor === 'string' && context.predecessor !== '' ? context.predecessor : null,
    build: typeof context.build === 'string' && context.build !== '' ? context.build : null,
    leases: leases.flatMap((row) => (isRecord(row) && typeof row.key === 'string' && typeof row.run === 'string' ? [{ key: row.key, run: row.run }] : [])),
  };
}

export default function subject(input: unknown): unknown {
  try {
    return buildSubject(input);
  } catch {
    return { item: { id: '', label: '', location: '', fields: {} }, claimed: null, group: null, predecessor: null, build: null, leases: [] };
  }
}
