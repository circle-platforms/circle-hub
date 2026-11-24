import type { Bundle } from './submissions-bundle.ts';
import type { RecordedExport } from './submissions-recorded.ts';

export interface Gap {
  what: string;
  for: string;
  detail: string;
}

export interface PreflightReport {
  gaps: Gap[];
  counts: { validations: number; with_call: number; packs: number; roots: number; objects: number; users: number };
}

const SRC = /^src:([0-9a-f]{64})/;
const REC = /^rec:([0-9a-f]{64})/;

export async function preflight(recorded: RecordedExport, bundle: Bundle): Promise<PreflightReport> {
  const gaps: Gap[] = [];
  const validations = new Map<number, string>();
  const withCall = new Set<string>();
  const packs = new Set<string>();
  const roots = new Set<string>();
  const digests = new Set<string>();
  for await (const row of bundle.rows('records')) {
    const kind = String(row.kind);
    digests.add(String(row.digest));
    if (kind === 'validation_result') validations.set(Number(row.seq), String(row.digest));
    else if (kind === 'pack_version') packs.add((JSON.parse(String(row.body)) as { digest?: string }).digest ?? '');
    else if (kind === 'tree_root') roots.add((JSON.parse(String(row.body)) as { root?: string }).root ?? '');
    else if (kind === 'action' && String(row.body).includes('"action":"validate"')) {
      const result = (JSON.parse(String(row.body)) as { detail?: { result?: unknown } }).detail?.result;
      if (typeof result === 'string') withCall.add(result);
    }
  }
  const users = new Set<string>();
  for await (const row of bundle.rows('users')) users.add(String(row.id));
  const objects = new Set<string>();
  for await (const row of bundle.rows('objects')) if ((await bundle.objectFile(String(row.sha256))) !== null) objects.add(String(row.sha256));

  for (const task of recorded.tasks) {
    const stored = validations.get(task.seq);
    if (stored === undefined) gaps.push({ what: 'validation', for: String(task.seq), detail: `数据包里没有位置 ${task.seq} 的 validation_result 记录` });
    else if (task.submission !== null && !withCall.has(stored)) gaps.push({ what: 'validation', for: String(task.seq), detail: `数据包里没有存下这条结果的 validate 动作（会话和模型未知）` });
  }
  const seen = new Set<string>();
  for (const [run, entry] of recorded.runs) {
    const body = (await recorded.read(entry)) as { runner?: string; configurer?: string; pack?: string; pack_digest?: string; root?: string; skills?: Array<{ pack: string; version: string; digest: string }>; product_pack_digest?: string; sources?: Array<{ reference: string; artifact?: string }>; input_defaults?: Array<{ reference?: string }> };
    const who = body.runner ?? body.configurer;
    if (who !== undefined && !users.has(who)) gaps.push({ what: 'principal', for: run, detail: `账户 ${who} 不在数据包的 users 里` });
    const need = (key: string, ok: boolean, gap: Gap): void => {
      if (ok || seen.has(key)) return;
      seen.add(key);
      gaps.push(gap);
    };
    if (body.pack_digest !== undefined) need(`pack:${body.pack_digest}`, packs.has(body.pack_digest), { what: 'pack', for: run, detail: `任务包 ${body.pack} 摘要 ${body.pack_digest} 没有 pack_version 记录` });
    if (body.product_pack_digest !== undefined) need(`pack:${body.product_pack_digest}`, packs.has(body.product_pack_digest), { what: 'pack', for: run, detail: `产品包摘要 ${body.product_pack_digest} 没有 pack_version 记录` });
    for (const skill of body.skills ?? []) need(`pack:${skill.digest}`, packs.has(skill.digest), { what: 'skill', for: run, detail: `技能 ${skill.pack}@${skill.version} 摘要 ${skill.digest} 没有 pack_version 记录` });
    if (body.root !== undefined) need(`root:${body.root}`, roots.has(body.root), { what: 'root', for: run, detail: `知识根 ${body.root} 没有 tree_root 记录（组成）` });
    for (const source of body.sources ?? []) {
      const src = SRC.exec(source.reference)?.[1];
      if (src !== undefined) need(`object:${src}`, objects.has(src), { what: 'object', for: run, detail: `来源原件 src:${src} 的字节不在数据包里` });
      if (source.artifact !== undefined) need(`record:${source.artifact}`, digests.has(source.artifact), { what: 'record', for: run, detail: `来源记录 ${source.artifact} 不在数据包里` });
      const rec = REC.exec(source.reference)?.[1];
      if (rec !== undefined) need(`record:${rec}`, digests.has(rec), { what: 'record', for: run, detail: `绑定的记录 rec:${rec} 不在数据包里` });
    }
    for (const input of body.input_defaults ?? []) {
      const rec = REC.exec(input.reference ?? '')?.[1];
      if (rec !== undefined) need(`record:${rec}`, digests.has(rec), { what: 'record', for: run, detail: `前序结果 rec:${rec} 不在数据包里` });
    }
  }
  return { gaps, counts: { validations: validations.size, with_call: withCall.size, packs: packs.size, roots: roots.size, objects: objects.size, users: users.size } };
}
