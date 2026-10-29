import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EGRESS, GENERATED, PACK } from './constants.ts';
import { scanWithMatches } from './credentials.ts';
import { canonical, exact, isRecord, need, sessionDirectory, sha256, splitTextLines, text } from './common.ts';
import { HubClient, holdsToken, validateTokenFile } from './hub.ts';
import { appendReceipt, outputBytes, readSettings, verifyState, withLock, type VerifiedCapture } from './state.ts';

interface Quote { reference: string; text: string }
interface Prepared {
  capture: VerifiedCapture;
  kind: keyof typeof GENERATED.operation_kinds;
  path: string;
  statement: string;
  device?: string;
  bed?: string;
  action?: string;
  goal?: string;
  phenomenon?: string;
  suggestion?: string;
  quote?: Quote;
  result?: Quote;
  steps?: Array<{ text: string; quote: Quote }>;
}

function treePath(value: unknown): string {
  const path = text(value, 'invalid_path', '归位路径格式不对', 8192);
  need(!/[\p{Cc}\p{Cf}\p{Z}\uD800-\uDFFF]/u.test(path), 'invalid_path', '归位路径含未编码字符');
  if (path === '/') return path;
  need(path.startsWith('/') && !path.endsWith('/'), 'invalid_path', '归位路径不是规范绝对路径');
  for (const segment of path.slice(1).split('/')) {
    need(segment.length > 0 && !segment.includes('@'), 'invalid_path', '归位路径段为空或含结构字符');
    need(!segment.replace(/%[0-9A-F]{2}/g, '').includes('%'), 'invalid_path', '归位路径含非规范百分号转义');
  }
  return path;
}

function quoteOf(value: unknown, bytes: Uint8Array): Quote {
  const row = exact(value, ['line', 'text']);
  need(Number.isSafeInteger(row.line) && (row.line as number) >= 1 && (row.line as number) <= 999999999, 'invalid_quote', '引文行号格式不对');
  const quote = text(row.text, 'invalid_quote', '引文必须是非空文本', 1048576);
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('invalid_capture_encoding'); }
  const line = splitTextLines(source)[(row.line as number) - 1];
  need(line !== undefined && line.includes(quote), 'quote_mismatch', '引文没有逐字出自所标原件行');
  return { reference: `src:${sha256(bytes)}/text@1/l/${row.line}`, text: quote };
}

function targetText(raw: unknown, kind: 'bed' | 'device', token: string): string {
  const declared = text(raw, `invalid_${kind}`, `提案或采集清单的${kind === 'bed' ? '台架' : '设备'}名格式不对`, 200);
  need(declared.trim() === declared && !/[\p{Cc}\p{Cf}]/u.test(declared), `invalid_${kind}`, '目标名不含控制字符或首尾空白');
  need(!declared.includes(token), 'credential_in_target', `${kind} 含当前 Hub 令牌；清理该字段后重交`);
  const checked = scanWithMatches(new TextEncoder().encode(declared));
  need(checked.complete && checked.scan.inspected && checked.scan.clean && !checked.scan.truncated, 'credential_in_target', `${kind} 未通过完整凭据扫描；清理该字段后重交`);
  return declared;
}

function operationDevice(raw: unknown, targets: Record<string, string>, token: string): string | undefined {
  const known = targets.device ?? targets.device_id;
  need(targets.device === undefined || targets.device_id === undefined || targets.device === targets.device_id, 'invalid_device', '采集清单的 device 与 device_id 不一致；修正工具参数后重新采集');
  const declared = raw === undefined && known === undefined ? undefined : targetText(raw === undefined ? known : raw, 'device', token);
  need(declared === undefined || known === undefined || declared === known, 'device_mismatch', '提案设备与采集清单 targets.device 不一致；照清单修正或省略 device');
  return declared;
}

function operationBed(raw: unknown, targets: Record<string, string>, token: string): string | undefined {
  const known = targets.bed ?? targets.bed_id;
  need(targets.bed === undefined || targets.bed_id === undefined || targets.bed === targets.bed_id, 'invalid_bed', '采集清单的 bed 与 bed_id 不一致；修正工具参数后重新采集');
  const declared = raw === undefined && known === undefined ? undefined : targetText(raw === undefined ? known : raw, 'bed', token);
  need(declared === undefined || known === undefined || declared === known, 'bed_mismatch', '提案台架与采集清单 targets.bed 不一致；照清单修正或省略 bed');
  return declared;
}

async function proposals(path: string, session: string, captures: VerifiedCapture[], token: string): Promise<Prepared[]> {
  need(path.endsWith('.json'), 'invalid_proposals', '提案文件必须是 JSON 文件');
  const stat = await lstat(path).catch(() => null);
  need(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'invalid_proposals', '提案文件必须是普通单链接 JSON 文件且不超过上限');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid_proposals'); }
  const document = exact(value, ['schema', 'session', 'items']);
  need(document.schema === GENERATED.proposal_schema && document.session === session && Array.isArray(document.items), 'invalid_proposals', '提案文档身份或会话不符');
  need(document.items.length >= 1 && document.items.length <= EGRESS.max_proposals, 'invalid_proposals', '提案条数必须在一到一百之间');
  const byDigest = new Map<string, VerifiedCapture[]>();
  for (const capture of captures) {
    const digest = capture.capture.output.sha256;
    byDigest.set(digest, [...(byDigest.get(digest) ?? []), capture]);
  }
  const prepared: Prepared[] = [];
  for (const item of document.items) {
    need(isRecord(item), 'invalid_proposals', '提案条目不是对象');
    const kind = text(item.kind, 'invalid_proposals', '提案缺类型');
    need(Object.hasOwn(GENERATED.operation_kinds, kind), 'unsupported_operation_kind', '只收 observation、procedure 或 pitfall');
    const { device: declaredDevice, bed: declaredBed, artifact: declaredArtifact, ...fields } = item;
    const common = exact(fields, kind === 'observation'
      ? ['capture', 'kind', 'path', 'statement', 'action', 'quote']
      : kind === 'procedure'
        ? ['capture', 'kind', 'path', 'statement', 'goal', 'steps']
        : ['capture', 'kind', 'path', 'statement', 'phenomenon', 'suggestion', 'quote']);
    const digest = text(common.capture, 'invalid_proposals', '提案缺原件摘要', 64);
    need(/^[0-9a-f]{64}$/.test(digest), 'invalid_proposals', '原件摘要格式不对');
    const candidates = (byDigest.get(digest) ?? []).filter(candidate => candidate.upload);
    need(candidates.length > 0, 'capture_not_uploaded', '原件尚未由钩子上传，不能整合');
    if (declaredArtifact !== undefined) need(typeof declaredArtifact === 'string' && /^[0-9a-f]{64}$/.test(declaredArtifact), 'invalid_proposals', '提案原件记录格式不对');
    const matching = declaredArtifact === undefined ? candidates : candidates.filter(candidate => candidate.upload!.source.artifact === declaredArtifact);
    need(matching.length === 1, 'capture_identity_required', '同字节有多次采集或原件记录不符；从 list 的 upload.source.artifact 选择本次原件');
    const capture = matching[0]!;
    need(capture.upload, 'capture_not_uploaded', '原件尚未由钩子上传，不能整合');
    need(typeof capture.upload.source.artifact === 'string', 'capture_identity_required', '采集清单缺具体原件记录；用支持 artifact 的 Hub 重新采集上传，不能按字节猜采集时刻');
    const device = operationDevice(declaredDevice, capture.capture.targets, token);
    const bed = operationBed(declaredBed, capture.capture.targets, token);
    need(device !== undefined || bed === undefined, 'invalid_target', '声明台架时必须同时声明设备；补 device 或省略 bed');
    const bytes = await outputBytes(session, capture.capture);
    const base = {
      capture,
      kind: kind as Prepared['kind'],
      path: treePath(common.path),
      statement: text(common.statement, 'invalid_proposals', '提案缺陈述'),
      ...(device === undefined ? {} : { device }),
      ...(bed === undefined ? {} : { bed }),
    };
    if (kind === 'observation') {
      prepared.push({ ...base, action: text(common.action, 'invalid_proposals', '观察缺动作'), result: quoteOf(common.quote, bytes) });
    } else if (kind === 'procedure') {
      need(Array.isArray(common.steps) && common.steps.length >= 1 && common.steps.length <= 100, 'invalid_proposals', '步骤必须在一到一百之间');
      const steps = common.steps.map(step => {
        const row = exact(step, ['text', 'quote']);
        return { text: text(row.text, 'invalid_proposals', '步骤缺文字'), quote: quoteOf(row.quote, bytes) };
      });
      prepared.push({ ...base, goal: text(common.goal, 'invalid_proposals', '步骤缺目标'), steps });
    } else {
      prepared.push({
        ...base,
        phenomenon: text(common.phenomenon, 'invalid_proposals', '教训缺现象'),
        suggestion: text(common.suggestion, 'invalid_proposals', '教训缺建议'),
        quote: quoteOf(common.quote, bytes),
      });
    }
  }
  return prepared;
}

function feeding(row: Prepared, product: string, root: string): Record<string, unknown> {
  const common = {
    schema: GENERATED.operation_kinds[row.kind],
    product,
    root,
    path: row.path,
    source: { system: 'upload', bytes: row.capture.capture.output.sha256, artifact: row.capture.upload!.source.artifact! },
    ...(row.device === undefined ? {} : { device: row.device }),
    ...(row.bed === undefined ? {} : { bed: row.bed }),
  };
  if (row.kind === 'observation') return { ...common, action: row.action, result: row.result };
  if (row.kind === 'procedure') return { ...common, goal: row.goal, steps: row.steps };
  return { ...common, phenomenon: row.phenomenon, suggestion: row.suggestion, quote: row.quote };
}

function primaryQuote(row: Prepared): Quote {
  return (row.kind === 'observation' ? row.result : row.kind === 'procedure' ? row.steps?.[0]?.quote : row.quote)!;
}

function checkTargetTokens(rows: readonly Prepared[], token: string): void {
  for (const row of rows) {
    if (row.device !== undefined) targetText(row.device, 'device', token);
    if (row.bed !== undefined) targetText(row.bed, 'bed', token);
  }
  // Any text of a proposal, not only its target names, is refused before a run is started for it (round-six review).
  need(!holdsToken(JSON.stringify(rows), token), 'credential_in_request', '提案含当前 Hub 令牌；清理含令牌的文字后重交');
}

export async function submitProposals(session: string, proposalPath: string, product: string, build: string | undefined, model: string) {
  const settings = await readSettings(session);
  need(settings?.enabled, 'sharing_disabled', '本会话未开启共享');
  product = text(product, 'invalid_product', '需要操作者明确选择产品', 64);
  if (build !== undefined) build = text(build, 'invalid_build_target', '运行目标构建格式不对', 200);
  model = text(model, 'invalid_model', '需要声明整合模型的确切身份', 500);
  const captures = await verifyState(session);
  const token = await validateTokenFile(settings.token_file);
  const rows = await proposals(resolve(proposalPath), session, captures, token);
  const hub = new HubClient(settings.hub, settings.token_file, session);
  const dir = sessionDirectory(session);
  const allowed = async <T>(action: () => Promise<T>): Promise<T> => withLock(dir, async () => {
    const current = await readSettings(session);
    need(current?.enabled, 'sharing_disabled', '本会话共享已关闭，停止整合提交');
    return action();
  });
  const manifest = { items: rows.map((_, index) => ({ id: `operation-${index + 1}`, title: `操作记录 ${index + 1}` })) };
  const subject = await allowed(() => hub.uploadDocument(manifest, 'circle-operation-manifest.json'));
  const originals = [...new Map(rows.map(row => {
    const input = { reference: `src:${row.capture.capture.output.sha256}`, artifact: row.capture.upload!.source.artifact! };
    return [canonical(input), input];
  })).values()];
  const clientKey = sha256(canonical({ schema: GENERATED.proposal_schema, session, subject, product, build: build ?? null, originals }));
  const started = await allowed(async () => {
    return hub.callChecked('start_run', {
      pack: PACK,
      product,
      ...(build === undefined ? {} : { build }),
      inputs: { subject: { reference: subject }, originals },
      client_key: clientKey,
    }, token => checkTargetTokens(rows, token));
  });
  need(isRecord(started.run), 'invalid_run', 'Hub 没有返回回注运行');
  const run = started.run;
  const runId = text(run.run, 'invalid_run', '运行号格式不对', 100);
  const lockedProduct = text(run.product, 'invalid_run', '运行没有产品', 64);
  const root = text(run.root, 'invalid_run', '运行没有锁定根', 64);
  need(/^[0-9a-f]{64}$/.test(root) && typeof run.pack_digest === 'string' && /^[0-9a-f]{64}$/.test(run.pack_digest), 'invalid_run', '运行根或包摘要格式不对');
  const submission = {
    run: runId,
    model: `${model}（Circle 技能 operation-capture，${GENERATED.id}@${run.pack_digest}）`,
    items: rows.map((row, index) => ({
      item: `operation-${index + 1}`,
      handling: 'handled',
      slots: {
        contribution: [{
          code: GENERATED.assertion,
          text: row.statement,
          data: {
            root,
            path: row.path,
            source: { reference: primaryQuote(row).reference, quote: primaryQuote(row).text },
            feeding: feeding(row, lockedProduct, root),
          },
        }],
      },
    })),
  };
  const result = await allowed(() => hub.callChecked('submit_result', submission, token => checkTargetTokens(rows, token)));
  await appendReceipt(session, result);
  return { result, texts: hub.lastText, submission, run };
}
