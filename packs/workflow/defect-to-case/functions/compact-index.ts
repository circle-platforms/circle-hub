// Compact index representation and building for defect-to-case deduplication.
export const MAX_COMPACT_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB limit
export const MAX_COMPACT_TITLE_LENGTH = 80;

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

export function buildCompactIndex(
  indexModel: unknown,
  byteBudget: number = MAX_COMPACT_OUTPUT_BYTES - 64 * 1024,
): CompactCaseIndex {
  if (isCompactIndex(indexModel)) {
    return indexModel;
  }

  const model = isRecord(indexModel) ? indexModel : {};
  const sourceTruncated = model.truncated === true;
  const sourceSkipped = typeof model.skipped === 'number' ? model.skipped : 0;

  const rawEntries = isRecord(model.entries)
    ? Object.values(model.entries)
    : Array.isArray(model.entries)
      ? model.entries
      : [];

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

  for (let i = 0; i < rawEntries.length; i++) {
    const raw = rawEntries[i];
    if (!isRecord(raw)) continue;

    const data = isRecord(raw.data) ? raw.data : raw;
    const digest = typeof raw.entry === 'string' ? raw.entry : '';
    const reference = typeof raw.reference === 'string' ? raw.reference : '';

    let commands: string[] = [];
    if (Array.isArray(data.commands)) {
      commands = (data.commands as unknown[]).filter((c): c is string => typeof c === 'string');
    } else if (digest && entryCommandsMap && entryCommandsMap.has(digest)) {
      commands = entryCommandsMap.get(digest)!;
    }

    const key = commandSetKey(commands);
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

    const expList = Array.isArray(data.expected_texts)
      ? (data.expected_texts as string[])
      : Array.isArray(data.expected)
        ? (data.expected as string[])
        : null;
    if (expList && expList.length > 0) {
      item.expected = expList.filter((e): e is string => typeof e === 'string');
    }

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
  let complete = dropped === 0 && !sourceTruncated && sourceSkipped === 0;

  const notes: string[] = [];
  if (unplaced > 0) {
    notes.push(`有 ${unplaced} 个用例没有命令（未归位），不参与去重`);
  }
  if (dropped > 0) {
    notes.push(`紧凑索引超出大小上限，按键顺序截断并丢弃 ${dropped} 个用例`);
  }
  if (sourceSkipped > 0) {
    notes.push(`用例索引缺少 ${sourceSkipped} 份列出的文档`);
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
