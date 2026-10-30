import { EGRESS, GENERATED } from './constants.ts';
import { errorCode, isRecord, need, sessionDirectory, sha256, text, validSession } from './common.ts';
import { sanitizeText } from './redact.ts';
import { HubClient, validateTokenFile } from './hub.ts';
import { appendCapture, appendUpload, logFailure, outputBytes, readEvents, readSettings, withLock, type Settings } from './state.ts';

async function uploadPending(dir: string, settings: Settings): Promise<void> {
  const events = await readEvents(dir, settings.session);
  const uploaded = new Set(events.flatMap(event => event.kind === 'upload' ? [event.capture] : []));
  const pending = events.filter(event => event.kind === 'capture' && !uploaded.has(event.sequence));
  if (pending.length === 0) return;
  const hub = new HubClient(settings.hub, settings.token_file, settings.session);
  for (const capture of pending) {
    if (capture.kind !== 'capture') continue;
    const bytes = await outputBytes(settings.session, capture);
    const current = await readSettings(settings.session);
    need(current?.enabled, 'sharing_disabled', '本会话共享已关闭，停止待传上传');
    const reference = await hub.upload(bytes, capture.sequence, capture.captured_at);
    await appendUpload(dir, capture, reference);
  }
}

export async function flushCaptures(session: string): Promise<number> {
  return withLock(sessionDirectory(session), async () => {
    const settings = await readSettings(session);
    need(settings?.enabled, 'sharing_disabled', '本会话未开启共享');
    const before = await readEvents(sessionDirectory(session), session);
    const pending = before.filter(event => event.kind === 'capture' && !before.some(other => other.kind === 'upload' && other.capture === event.sequence)).length;
    await uploadPending(sessionDirectory(session), settings);
    return pending;
  });
}

export async function captureAfterTool(value: unknown): Promise<void> {
  if (!isRecord(value) || value.event !== 'after_tool' || typeof value.session_id !== 'string') return;
  let session: string;
  try { session = validSession(value.session_id); } catch { return; }
  try {
    const settings = await readSettings(session);
    if (!settings?.enabled) return;
    need(isRecord(value.tool_input), 'invalid_hook_input', '工具参数不是对象');
    const output = text(value.tool_output, 'invalid_hook_input', '工具输出不是文本', EGRESS.max_capture_bytes, true);
    need(output.length > 0 && Buffer.byteLength(output) <= EGRESS.max_capture_bytes, 'capture_too_large', '工具输出为空或超过采集上限');
    const toolName = text(value.tool_name, 'invalid_hook_input', '工具名格式不对', 300);
    const toolStatus = text(value.tool_status, 'invalid_hook_input', '工具状态格式不对', 100);
    const token = await validateTokenFile(settings.token_file);
    const sanitized = sanitizeText(output, token);
    const rawInput = JSON.stringify(value.tool_input);
    need(Buffer.byteLength(rawInput) <= EGRESS.max_capture_bytes, 'input_too_large', '工具参数超过采集上限');
    const input = sanitizeText(rawInput, token);
    const characters = Array.from(input.text);
    const truncated = characters.length > EGRESS.max_input_summary_chars;
    const summary = truncated ? `${characters.slice(0, EGRESS.max_input_summary_chars).join('')}…` : input.text;
    const targets: Record<string, string> = {};
    for (const key of ['bed', 'bed_id', 'device', 'device_id', 'target']) {
      const target = value.tool_input[key];
      if (typeof target === 'string' || typeof target === 'number' && Number.isFinite(target)) targets[key] = sanitizeText(String(target), token).text;
    }
    const name = sanitizeText(toolName, token).text;
    const status = sanitizeText(toolStatus, token).text;
    const detectors = [...new Set([...sanitized.detectors, ...input.detectors])].sort();
    const dir = sessionDirectory(session);
    await withLock(dir, async () => {
      const current = await readSettings(session);
      need(current?.enabled, 'sharing_disabled', '本会话共享已关闭，停止新采集');
      await appendCapture(dir, {
        session,
        captured_at: new Date().toISOString(),
        tool: { name, status },
        input: { summary, sha256: sha256(input.text), truncated },
        targets,
        redaction: { scanner: GENERATED.scanner, status: sanitized.changed ? 'redacted' : 'unchanged', detectors },
        bytes: Buffer.from(sanitized.text, 'utf8'),
      });
      await uploadPending(dir, current);
    });
  } catch (error) {
    await logFailure(session, errorCode(error)).catch(() => undefined);
  }
}

export async function hook(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > EGRESS.max_capture_bytes * 2 + 1_000_000) return;
      chunks.push(bytes);
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    await captureAfterTool(value);
  } catch {
    return;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
