import { createHash } from 'node:crypto';

// Compact index representation and building for defect-to-case deduplication.
export const MAX_COMPACT_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MiB limit
export const MAX_COMPACT_TITLE_LENGTH = 80;
/** Legacy fallback: without cut_keys, a key listing this many entries may have been cut. */
export const MAX_INDEX_PER_KEY = 2000;

export interface CompactCaseItem {
  case_structure?:unknown;
  document: string;
  node: string;
  title: string;
  /** SHA-256 of the full normalized title; the clipped title is display only. */
  title_key?: string;
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
  /** The source view's only field, or the bound URI for legacy views; null when not narrowed. */
  only: string[] | null;
  /** The source view's cut_keys, or keys at the per-key cap for legacy views. */
  cappedKeys: string[];
  /** Requested keys absent from the source view, rather than explicitly present with no entries. */
  missingKeys?: string[];
  /** A source truncation can hide entire requested buckets. */
  sourceTruncated?: boolean;
  sourceSkipped?: number;
  invalidMetadata?: boolean;
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompactIndex(value: unknown): value is CompactCaseIndex {
  return isRecord(value) && value.schema === 'compact-case-index@1' && isRecord(value.by_commands);
}

export function normalizeText(text: string): string {
  return text;
}

export const titleKey = (text: string): string => createHash('sha256').update(normalizeText(text)).digest('hex');

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
 * Used only when the source view has no machine-readable only field. */
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
  const hasOnly = Object.hasOwn(model, 'only');
  const hasCutKeys = Object.hasOwn(model, 'cut_keys');
  const fieldKeys = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((key): key is string => typeof key === 'string') ? [...value] : null;
  const onlyField = fieldKeys(model.only);
  const cutField = fieldKeys(model.cut_keys);
  const invalidMetadata = (hasOnly && onlyField === null) || (hasCutKeys && cutField === null);
  // A present field is authoritative, including an empty array. Malformed fields cannot fall back to the URI.
  const only = hasOnly ? onlyField ?? [] : onlyOfExternal(external);
  const sourceTruncated = model.truncated === true;
  const returnedKeys = new Set(isRecord(model.keys) ? Object.keys(model.keys).map(normalizeCommand) : []);
  const sourceSkipped = typeof model.skipped === 'number' ? model.skipped : 0;
  // Complete views omit requested keys with no cases; only incomplete coverage makes absence unknown.
  const missingKeys = sourceTruncated
    ? only?.filter(key => !returnedKeys.has(normalizeCommand(key))) ?? []
    : [];

  const rawEntries = isRecord(model.entries)
    ? Object.values(model.entries)
    : Array.isArray(model.entries)
      ? model.entries
      : [];

  // Infer possibly-cut keys only for older views that omit cut_keys.
  const cappedKeys: string[] = hasCutKeys ? cutField ?? [] : [];
  if (!hasCutKeys && isRecord(model.keys)) {
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
    const cut = rawTitle.slice(0, MAX_COMPACT_TITLE_LENGTH);
    const title = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    const document = typeof data.document === 'string' ? data.document : (typeof data.doc === 'string' ? data.doc : '');
    const node = typeof data.node === 'string' ? data.node : '';

    const item: CompactCaseItem = {
      case_structure:data.case_structure,
      document,
      node,
      title,
      title_key: titleKey(rawTitle),
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
  // Neither narrowing nor an explicit request proves that an omitted bucket is empty.
  let complete = !invalidMetadata && dropped === 0 && !sourceTruncated && sourceSkipped === 0 && missingKeys.length === 0;

  const notes: string[] = [];
  if (!hasOnly || !hasCutKeys) {
    const missing = [!hasOnly ? 'only' : '', !hasCutKeys ? 'cut_keys' : ''].filter(Boolean);
    notes.push(`源视图缺少 ${missing.join('、')} 字段，按 URI 和上限推断（仅缺失字段）`);
  }
  if (invalidMetadata) notes.push('源视图的 only 或 cut_keys 字段形状无效，无法证明索引完整');
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
    notes.push(hasCutKeys
      ? `源视图 cut_keys 标明 ${cappedKeys.length} 个键的条目被每键上限截断`
      : `${cappedKeys.length} 个键的条目正好列到每键上限 ${MAX_INDEX_PER_KEY} 个，可能被截断`);
  }
  if (missingKeys.length > 0) notes.push(`源视图缺少请求的键：${missingKeys.join('、')}；请重新读取这些键`);
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
    missingKeys,
    sourceTruncated,
    sourceSkipped,
    invalidMetadata,
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
