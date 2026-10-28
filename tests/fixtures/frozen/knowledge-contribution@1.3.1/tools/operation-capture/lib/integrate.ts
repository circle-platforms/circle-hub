import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EGRESS, GENERATED, PACK } from './constants.ts';
import { canonical, exact, isRecord, need, sessionDirectory, sha256, splitTextLines, text } from './common.ts';
import { HubClient } from './hub.ts';
import { appendReceipt, outputBytes, readSettings, verifyState, withLock, type VerifiedCapture } from './state.ts';

interface Quote { reference: string; text: string }
interface Prepared {
  capture: VerifiedCapture;
  kind: keyof typeof GENERATED.operation_kinds;
  path: string;
  statement: string;
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

async function proposals(path: string, session: string, captures: VerifiedCapture[]): Promise<Prepared[]> {
  need(path.endsWith('.json'), 'invalid_proposals', '提案文件必须是 JSON 文件');
  const stat = await lstat(path).catch(() => null);
  need(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024, 'invalid_proposals', '提案文件必须是普通单链接 JSON 文件且不超过上限');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid_proposals'); }
  const document = exact(value, ['schema', 'session', 'items']);
  need(document.schema === GENERATED.proposal_schema && document.session === session && Array.isArray(document.items), 'invalid_proposals', '提案文档身份或会话不符');
  need(document.items.length >= 1 && document.items.length <= EGRESS.max_proposals, 'invalid_proposals', '提案条数必须在一到一百之间');
  const byDigest = new Map(captures.map(capture => [capture.capture.output.sha256, capture]));
  const prepared: Prepared[] = [];
  for (const item of document.items) {
    need(isRecord(item), 'invalid_proposals', '提案条目不是对象');
    const kind = text(item.kind, 'invalid_proposals', '提案缺类型');
    need(Object.hasOwn(GENERATED.operation_kinds, kind), 'unsupported_operation_kind', '只收 observation、procedure 或 pitfall');
    const common = exact(item, kind === 'observation'
      ? ['capture', 'kind', 'path', 'statement', 'action', 'quote']
      : kind === 'procedure'
        ? ['capture', 'kind', 'path', 'statement', 'goal', 'steps']
        : ['capture', 'kind', 'path', 'statement', 'phenomenon', 'suggestion', 'quote']);
    const digest = text(common.capture, 'invalid_proposals', '提案缺原件摘要', 64);
    need(/^[0-9a-f]{64}$/.test(digest), 'invalid_proposals', '原件摘要格式不对');
    const capture = byDigest.get(digest);
    need(capture?.upload, 'capture_not_uploaded', '原件尚未由钩子上传，不能整合');
    const bytes = await outputBytes(session, capture.capture);
    const base = {
      capture,
      kind: kind as Prepared['kind'],
      path: treePath(common.path),
      statement: text(common.statement, 'invalid_proposals', '提案缺陈述'),
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
    source: { system: 'upload', bytes: row.capture.capture.output.sha256 },
  };
  if (row.kind === 'observation') return { ...common, action: row.action, result: row.result };
  if (row.kind === 'procedure') return { ...common, goal: row.goal, steps: row.steps };
  return { ...common, phenomenon: row.phenomenon, suggestion: row.suggestion, quote: row.quote };
}

function primaryQuote(row: Prepared): Quote {
  return (row.kind === 'observation' ? row.result : row.kind === 'procedure' ? row.steps?.[0]?.quote : row.quote)!;
}

export async function submitProposals(session: string, proposalPath: string, product: string, build: string | undefined, model: string) {
  const settings = await readSettings(session);
  need(settings?.enabled, 'sharing_disabled', '本会话未开启共享');
  product = text(product, 'invalid_product', '需要操作者明确选择产品', 64);
  if (build !== undefined) build = text(build, 'invalid_build_target', '运行目标构建格式不对', 200);
  model = text(model, 'invalid_model', '需要声明整合模型的确切身份', 500);
  const captures = await verifyState(session);
  const rows = await proposals(resolve(proposalPath), session, captures);
  const hub = new HubClient(settings.hub, settings.token_file, session);
  const dir = sessionDirectory(session);
  const allowed = async <T>(action: () => Promise<T>): Promise<T> => withLock(dir, async () => {
    const current = await readSettings(session);
    need(current?.enabled, 'sharing_disabled', '本会话共享已关闭，停止整合提交');
    return action();
  });
  const manifest = { items: rows.map((_, index) => ({ id: `operation-${index + 1}`, title: `操作记录 ${index + 1}` })) };
  const subject = await allowed(() => hub.uploadDocument(manifest, 'circle-operation-manifest.json'));
  const originals = [...new Set(rows.map(row => `src:${row.capture.capture.output.sha256}`))].map(reference => ({ reference }));
  const clientKey = sha256(canonical({ schema: GENERATED.proposal_schema, session, subject, product, build: build ?? null, originals }));
  const started = await allowed(() => hub.call('start_run', {
    pack: PACK,
    product,
    ...(build === undefined ? {} : { build }),
    inputs: { subject: { reference: subject }, originals },
    client_key: clientKey,
  }));
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
  const result = await allowed(() => hub.call('submit_result', submission));
  await appendReceipt(session, result);
  return { result, texts: hub.lastText, submission, run };
}
