// Reading a bound input as an index-view@1 of the expected kind and key. The model (the parsed bytes the Hub stored for the
// read) is authoritative; the external id is not re-parsed. A view that is not the expected one, or is malformed, is a
// refusal the caller can fix; a digest a key lists without entry content is counted and warned about (its absence is the
// view's, not the defect's or case's).
import { isRecord, strings } from './text.ts';
import type { BoundInput, IndexViewData, PackWarning, ViewEntry } from './types.ts';

const HEX = /^[0-9a-f]{64}$/;

export type ViewFailure = { ok: false; code: string; message: string; fix: string };
export type ViewRead = { ok: true; view: IndexViewData; warnings: PackWarning[] } | ViewFailure;

function failure(message: string, fix: string): ViewFailure {
  return { ok: false, code: 'wrong_view', message, fix };
}

function isHexKeyed(record: unknown): record is Record<string, unknown> {
  return isRecord(record) && Object.keys(record).every((key) => HEX.test(key));
}

/**
 * Reads the bound input of a slot as the index view the slot expects (kind and key). Never throws: the projection turns a
 * failure into a refusal with the fix.
 */
export function readIndexView(input: BoundInput, slot: string, expect: { kind: string; key: string }): ViewRead {
  const fix = `在输入槽 ${slot} 里绑定 knowledge:index:<产品>:<构建>?kind=${expect.kind}&key=${expect.key} 视图（构建的任一名称族的写法都可以）`;
  const model: unknown = isRecord(input) ? input.model : undefined;
  if (!isRecord(model)) return failure('绑定的源不是 JSON 对象', fix);
  if (model.schema !== 'index-view@1') return failure(`绑定的视图不是 index-view@1（schema 是 ${typeof model.schema === 'string' ? model.schema : '（无）'}）`, fix);
  if (model.kind !== expect.kind || model.key !== expect.key) {
    return failure(`绑定的是 kind=${typeof model.kind === 'string' ? model.kind : '（无）'}、key=${typeof model.key === 'string' ? model.key : '（无）'} 的索引视图，这个槽要 kind=${expect.kind}、key=${expect.key}`, fix);
  }
  if (typeof model.product !== 'string' || model.product === '') return failure('视图没有产品', fix);
  const buildRaw = model.build;
  if (!isRecord(buildRaw)) return failure('视图没有有效的构建名或知识根', fix);
  const buildName = buildRaw.build;
  const buildRoot = buildRaw.root;
  if (typeof buildName !== 'string' || buildName === '' || typeof buildRoot !== 'string' || !HEX.test(buildRoot)) {
    return failure('视图没有有效的构建名或知识根', fix);
  }
  if (!isRecord(model.keys) || !Object.values(model.keys).every((list) => Array.isArray(list) && list.every((d) => typeof d === 'string' && HEX.test(d)))) {
    return failure('视图的 keys 不是“取值到条目摘要列表”的对应', fix);
  }
  if (!isHexKeyed(model.entries)) return failure('视图的 entries 不是“条目摘要到条目”的对应', fix);
  const entries: Record<string, ViewEntry> = {};
  for (const [digest, raw] of Object.entries(model.entries)) {
    if (!isRecord(raw) || raw.entry !== digest || typeof raw.kind !== 'string' || typeof raw.statement !== 'string' || !isRecord(raw.data) || typeof raw.reference !== 'string') {
      return failure(`视图的条目 ${digest.slice(0, 12)} 不完整（entry、kind、statement、data、reference 都要在，entry 要和摘要一致）`, fix);
    }
    if (raw.kind !== model.kind) return failure(`视图的条目 ${digest.slice(0, 12)} 的种类 ${raw.kind} 不是视图的种类 ${model.kind as string}`, fix);
    entries[digest] = raw as unknown as ViewEntry;
  }
  for (const name of ['total_keys', 'total_entries', 'skipped'] as const) {
    if (!Number.isInteger(model[name]) || (model[name] as number) < 0) return failure(`视图的 ${name} 不是非负整数`, fix);
  }
  if (typeof model.truncated !== 'boolean') return failure('视图的 truncated 不是布尔值', fix);
  const keys = model.keys as Record<string, string[]>;
  let missing = 0;
  for (const list of Object.values(keys)) for (const digest of list) if (entries[digest] === undefined) missing++;
  const warnings: PackWarning[] = [];
  if (missing > 0) {
    warnings.push({
      code: 'story-traceability.entry_missing',
      message: `视图 ${slot} 里有 ${missing} 个条目摘要列在键下却没有条目内容：它们按“键在、内容未知”处理`,
      data: { missing },
    });
  }
  const digest = input.sha256;
  if (typeof digest !== 'string' || !HEX.test(digest)) return failure('绑定的输入没有有效的源文件摘要', fix);
  const view: IndexViewData = {
    product: model.product,
    build: buildName,
    root: buildRoot,
    kind: model.kind as string,
    key: model.key as string,
    keys,
    entries,
    total_keys: model.total_keys as number,
    total_entries: model.total_entries as number,
    truncated: model.truncated,
    cut_keys: strings(model.cut_keys),
    only: Array.isArray(model.only) ? strings(model.only) : null,
    skipped: model.skipped as number,
    notes: strings(model.notes),
    missing,
    digest,
    source: `src:${digest}`,
  };
  return { ok: true, view, warnings };
}
