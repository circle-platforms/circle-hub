// Compact index representation and building for defect-to-case deduplication.
export const MAX_COMPACT_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB limit
export const MAX_COMPACT_TITLE_LENGTH = 80;
/** The core's per-key cap: a key listing exactly this many entries may have been cut (the note is the only signal). */
export const MAX_INDEX_PER_KEY = 2000;

export interface CompactCaseItem {
  document: string;
  node: string;
  title: string;
  reference: string;
  negative?: boolean;
  expected?: string[];
}

export interface CompactCaseIndex {
  schema: 'compact-case-index@1';
  by_commands: Record<string, CompactCaseItem[]>;
  total: number;
  dropped: number;
  complete: boolean;
  unplaced: number;
  /** Entries whose data carried no commands field (their command set is unknown, not empty). */
  unplacedCommands: number;
  /** The keys the source view was narrowed to (only=… of the bound URI), null when not narrowed. */
  only: string[] | null;
  /** Keys that listed exactly the per-key cap and may have been cut short by the core. */
  cappedKeys: string[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompactIndex(value: unknown): value is CompactCaseIndex {
  return isRecord(value) && value.schema === 'compact-case-index@1' && isRecord(value.by_commands);
}

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeCommand(cmd: string): string {
  return normalizeText(cmd.replace(/^\/commands\//, '').replace(/\//g, ' '));
}

export function commandSetKey(commands: Iterable<string>): string {
  const norm = new Set<string>();
  for (const c of commands) {
    if (typeof c === 'string') {
      const n = normalizeCommand(c);
      if (n !== '') norm.add(n);
    }
  }
  if (norm.size === 0) return '';
  return [...norm].sort().join(';');
}

/** The only=… values of a bound index URI, by the core's own rule: comma-separated, each percent-decoded, a trailing
 * revision (@<64 hex>, or two joined by ..) stripped first. Null when the URI carries no only parameter (not narrowed).
 * The view's own output has no machine-readable only field (README Needs); the bound URI is the source. */
export function onlyOfExternal(external: string | undefined | null): string[] | null {
  if (typeof external !== 'string' || external === '') return null;
  const atQuery = external.indexOf('?');
  if (atQuery < 0) return null;
  for (const part of external.slice(atQuery + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq) !== 'only') continue;
    const raw = part.slice(eq + 1);
    if (raw === '') return null;
    const keys = raw
      .split(',')
      .map((k) => {
        const stripped = /^[^@]+@([0-9a-f]{64}(?:\.\.[0-9a-f]{64})?)$/.test(k) ? k.slice(0, k.lastIndexOf('@')) : k;
        try {
          return decodeURIComponent(stripped);
        } catch {
          return stripped;
        }
      })
      .filter((k) => k !== '');
    return keys.length > 0 ? keys : null;
  }
  return null;
}

export function buildCompactIndex(
  indexModel: unknown,
  byteBudget: number = MAX_COMPACT_OUTPUT_BYTES - 64 * 1024,
  external: string | null = null,
): CompactCaseIndex {
  if (isCompactIndex(indexModel)) {
    return indexModel;
  }

  const model = isRecord(indexModel) ? indexModel : {};
  const only = onlyOfExternal(external);
  const sourceTruncated = model.truncated === true;
  const sourceSkipped = typeof model.skipped === 'number' ? model.skipped : 0;

  const rawEntries = isRecord(model.entries)
    ? Object.values(model.entries)
    : Array.isArray(model.entries)
      ? model.entries
      : [];

  // A key that lists exactly the per-key cap may have been cut (the core notes it in prose only): treat it as possibly
  // truncated. The compact item counts per key cannot show this (they sit under the byte budget), so read the source keys.
  const cappedKeys: string[] = [];
  if (isRecord(model.keys)) {
    for (const [key, digests] of Object.entries(model.keys)) {
      if (Array.isArray(digests) && digests.length >= MAX_INDEX_PER_KEY) cappedKeys.push(key);
    }
  }

  // Invert model.keys if entries do not have data.commands
  let entryCommandsMap: Map<string, string[]> | null = null;
  if (isRecord(model.keys)) {
    entryCommandsMap = new Map<string, string[]>();
    for (const [cmd, digests] of Object.entries(model.keys)) {
      if (Array.isArray(digests)) {
        for (const d of digests) {
          if (typeof d === 'string') {
            let list = entryCommandsMap.get(d);
            if (!list) {
              list = [];
              entryCommandsMap.set(d, list);
            }
            list.push(cmd);
          }
        }
      }
    }
  }

  const buckets = new Map<string, CompactCaseItem[]>();
  let total = 0;
  let unplaced = 0;
  let unplacedCommands = 0;

  for (let i = 0; i < rawEntries.length; i++) {
    const raw = rawEntries[i];
    if (!isRecord(raw)) continue;

    const data = isRecord(raw.data) ? raw.data : raw;
    const digest = typeof raw.entry === 'string' ? raw.entry : '';
    const reference = typeof raw.reference === 'string' ? raw.reference : '';

    let commands: string[] = [];
    let commandsKnown = false;
    if (Array.isArray(data.commands)) {
      commands = (data.commands as unknown[]).filter((c): c is string => typeof c === 'string');
      commandsKnown = true;
    } else if (only === null && digest && entryCommandsMap && entryCommandsMap.has(digest)) {
      // Without narrowing the keys rebuild the whole set; after narrowing an entry appears only under the listed
      // keys, so the keys no longer reconstruct it — the field is the only source.
      commands = entryCommandsMap.get(digest)!;
      commandsKnown = commands.length > 0;
    }

    const key = commandSetKey(commands);
    if (!commandsKnown) {
      unplacedCommands++;
      continue;
    }
    if (key === '') {
      unplaced++;
      continue;
    }

    total++;
    const rawTitle = typeof data.title === 'string' ? data.title : '';
    const title = rawTitle.length > MAX_COMPACT_TITLE_LENGTH ? rawTitle.slice(0, MAX_COMPACT_TITLE_LENGTH) : rawTitle;
    const document = typeof data.document === 'string' ? data.document : (typeof data.doc === 'string' ? data.doc : '');
    const node = typeof data.node === 'string' ? data.node : '';

    const item: CompactCaseItem = {
      document,
      node,
      title,
      reference,
    };

    if (data.negative === true) {
      item.negative = true;
    }

    // Case entries carry no expected-text field (see the product pack's cases producer): dedup compares what they do
    // carry (title, negative, document, node); the expected texts stay out of the index by design.
    void data;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(item);
  }

  const sortedKeys = Array.from(buckets.keys()).sort();
  const by_commands: Record<string, CompactCaseItem[]> = {};
  let currentBytes = 250; // base overhead for schema, counts, notes
  let keptCount = 0;

  for (let k = 0; k < sortedKeys.length; k++) {
    const key = sortedKeys[k];
    const items = buckets.get(key)!;
    const keyBytes = JSON.stringify(key).length + 3;
    let itemsBytes = 0;
    for (let j = 0; j < items.length; j++) {
      itemsBytes += JSON.stringify(items[j]).length + 1;
    }
    const totalKeyBytes = keyBytes + itemsBytes;

    if (currentBytes + totalKeyBytes <= byteBudget) {
      by_commands[key] = items;
      currentBytes += totalKeyBytes;
      keptCount += items.length;
    } else {
      break;
    }
  }

  let dropped = total - keptCount;
  // With narrowing (only=…), the listed keys' completeness is what the check needs; a truncated source beyond them
  // does not block the decidable drafts. Without narrowing, the old rule stands: the whole view must be complete.
  let complete = only !== null
    ? dropped === 0 && sourceSkipped === 0
    : dropped === 0 && !sourceTruncated && sourceSkipped === 0;

  const notes: string[] = [];
  if (unplacedCommands > 0) {
    notes.push(`有 ${unplacedCommands} 个用例没有带 commands 字段，命令集合未知，无法参与去重`);
  }
  if (unplaced > 0) {
    notes.push(`有 ${unplaced} 个用例没有命令（未归位），不参与去重`);
  }
  if (dropped > 0) {
    notes.push(`紧凑索引超出大小上限，按键顺序截断并丢弃 ${dropped} 个用例`);
  }
  if (sourceSkipped > 0) {
    notes.push(`用例索引缺少 ${sourceSkipped} 份列出的文档`);
  }
  if (cappedKeys.length > 0) {
    notes.push(`${cappedKeys.length} 个键的条目正好列到每键上限 ${MAX_INDEX_PER_KEY} 个，可能被截断`);
  }
  if (sourceTruncated) {
    notes.push('源用例索引已被截断');
  }

  const candidate: CompactCaseIndex = {
    schema: 'compact-case-index@1',
    by_commands,
    total,
    dropped,
    complete,
    unplaced,
    unplacedCommands,
    only,
    cappedKeys,
    notes,
  };

  // Final verification that serialized JSON strictly fits within byteBudget
  let jsonStr = JSON.stringify(candidate);
  while (Buffer.byteLength(jsonStr, 'utf8') > byteBudget && Object.keys(by_commands).length > 0) {
    const keys = Object.keys(by_commands);
    const lastKey = keys[keys.length - 1];
    const removed = by_commands[lastKey];
    delete by_commands[lastKey];
    keptCount -= removed.length;
    dropped = total - keptCount;
    candidate.dropped = dropped;
    candidate.complete = false;
    candidate.notes = candidate.notes.filter((n) => !n.includes('截断并丢弃'));
    candidate.notes.push(`紧凑索引超出大小上限，按键顺序截断并丢弃 ${dropped} 个用例`);
    jsonStr = JSON.stringify(candidate);
  }

  return candidate;
}
