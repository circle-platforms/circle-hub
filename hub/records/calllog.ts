// Call log (B08): one line per MCP call, as a `call_log@1` record, a typed row for queries and a line in
// <log dir>/calls-YYYY-MM-DD.jsonl (UTC date). Arguments are reduced to the digest and size of their canonical JSON before
// anything is written, plus a preview only when the server gives one it redacted by the tool schema (B08 F[7]). Every call
// has its own W3C span id, so two equal calls stay two lines. The real reason behind a neutral answer is kept outside the
// record (table call_notes, admins only), so no digest a user sees covers it. It proves only that the call was received.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAcceptance, isCallResult } from '../../contracts/generated/vocabulary.ts';
import type { CallLog, CallLogEntry, CallLogInput, CallLogLine, CallLogQuery, Page, Principal, RecordStore } from './api.ts';
import { canonicalize } from './canonical.ts';
import { RECORD_SCHEMAS } from './constants.ts';
import { decodeCursor, encodeCursor, iso, normalizeTime, pageLimit } from './db.ts';
import type { Database, Row } from './db.ts';
import { recordDigest, sha256Hex } from './digest.ts';
import { IntegrityError, RecordsError } from './errors.ts';
import { scanForCredentials } from './scan.ts';

const TRACE = /^[0-9a-f]{32}$/;
const SPAN = /^[0-9a-f]{16}$/;
const TOOL = /^[A-Za-z0-9_./:-]{1,100}$/;
const SHORT_ID = /^[A-Za-z0-9_.:@-]{1,100}$/;
const SESSION = /^[\x21-\x7e]{1,200}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,100}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;
/** B08 F[7]: the first 1 KB of the arguments after schema-based redaction. */
export const MAX_ARGS_PREVIEW_BYTES = 1024;
const REPAIR_BATCH = 1000;

/** Digest and size of the canonical JSON of the arguments (JSON.stringify text when they are not canonical JSON). */
export function argumentDigest(args: unknown): { digest: string; size: number } {
  let text: string;
  try {
    text = canonicalize(args === undefined ? null : args);
  } catch {
    try {
      text = JSON.stringify(args) ?? 'null';
    } catch {
      text = Object.prototype.toString.call(args);
    }
  }
  return { digest: sha256Hex(text), size: Buffer.byteLength(text, 'utf8') };
}

/** A random W3C span id (8 bytes, lowercase hex, never all zero). */
export function newSpanId(): string {
  for (;;) {
    const id = randomBytes(8).toString('hex');
    if (!/^0+$/.test(id)) return id;
  }
}

function optionalId(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !SHORT_ID.test(value)) throw new TypeError(`${field} is not an id`);
  return value;
}

/** The header is client declared; anything outside printable ASCII is kept only as its digest. */
function sessionOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && SESSION.test(value) ? value : `sha256:${sha256Hex(String(value))}`;
}

/** A preview the credential scanner flags is not kept: the call log never stores a secret (B08 R[1]). */
function previewOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_ARGS_PREVIEW_BYTES) {
    throw new TypeError(`argsPreview is at most ${MAX_ARGS_PREVIEW_BYTES} bytes of well-formed text without NUL`);
  }
  return scanForCredentials(Buffer.from(value, 'utf8')).findings.length > 0 ? null : value;
}

/** Log reasons are not source artifacts: credential matches and uninspectable text never become log text. */
function privateReasonOf(text:string):string {
  const scan=scanForCredentials(Buffer.from(text,'utf8'));
  if(scan.findings.length>0)return '该条理由触发凭据扫描，原文未写日志；请管理员在原系统或受限原件中重现并私审';
  if(!scan.inspected || scan.truncated)return '该条理由未通过日志可记录性检查，原文未写日志；请管理员在原系统重现并核对';
  return text;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Digests of the lines already in a JSONL file, and whether the file ends inside a line (an interrupted write). */
async function fileState(file: string): Promise<{ digests: Set<string>; openLine: boolean }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return { digests: new Set(), openLine: false };
    throw error;
  }
  const digests = new Set<string>();
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      const digest = (JSON.parse(raw) as { digest?: unknown }).digest;
      if (typeof digest === 'string') digests.add(digest);
    } catch {
      // A line cut by a crash; its call is written again below.
    }
  }
  return { digests, openLine: text.length > 0 && !text.endsWith('\n') };
}

/** Files carry the public call receipt only; private database fields never pass either write path. */
function journalLine(line:CallLogLine):Omit<CallLogLine,'admin_note'|'admin_reasons'> {
  const {admin_note,admin_reasons,...receipt}=line;
  return receipt;
}

export class PgCallLog implements CallLog {
  readonly #db: Database;
  readonly #store: RecordStore;
  readonly #logDir: string;
  readonly #now: () => Date;
  /** Writes to one file run one after the other in this process, so check-then-append never writes a line twice. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(db: Database, store: RecordStore, logDir: string, now: () => Date) {
    this.#db = db;
    this.#store = store;
    this.#logDir = logDir;
    this.#now = now;
  }

  async append(input: CallLogInput): Promise<CallLogLine> {
    if (typeof input.traceId !== 'string' || !TRACE.test(input.traceId) || /^0+$/.test(input.traceId)) throw new TypeError('traceId must be a W3C trace-id');
    const spanId = input.spanId ?? newSpanId();
    if (typeof spanId !== 'string' || !SPAN.test(spanId) || /^0+$/.test(spanId)) throw new TypeError('spanId must be a W3C span id: 16 lowercase hex characters, not all zero');
    if (typeof input.tool !== 'string' || !TOOL.test(input.tool)) throw new TypeError('tool must be a tool name or protocol method');
    if (!isCallResult(input.callResult)) throw new TypeError('unknown call result');
    const acceptance = input.acceptance ?? null;
    if (acceptance !== null && !isAcceptance(acceptance)) throw new TypeError('unknown acceptance');
    const errorCode = input.errorCode ?? null;
    if (errorCode !== null && (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode))) throw new TypeError('errorCode is not a code');
    if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0 || input.durationMs > 2_147_483_647) {
      throw new TypeError('durationMs must be a non-negative number of milliseconds below 2^31');
    }
    let adminNote = input.adminNote ?? null;
    if (adminNote !== null && (typeof adminNote !== 'string' || adminNote.length === 0 || adminNote.length > 2000 || !adminNote.isWellFormed() || adminNote.includes('\0'))) {
      throw new TypeError('adminNote is 1 to 2000 characters of well-formed text');
    }
    const at = normalizeTime(input.at ?? this.#now(), 'at');
    const receivedReasons=input.adminReasons??[];
    const reasons=Array.isArray(receivedReasons)?[...receivedReasons]:receivedReasons;
    if(!Array.isArray(reasons) || reasons.some(reason=>typeof reason!=='string' || !reason.length || !reason.isWellFormed() || reason.includes('\0')))throw new TypeError('adminReasons are nonempty well-formed private reasons without NUL');
    const safeReasons=reasons.map(privateReasonOf);
    if(adminNote!==null)adminNote=safeReasons.some((reason,index)=>reason!==reasons[index])?'完整理由触发日志保护，敏感原文未保留；见逐条安全说明':privateReasonOf(adminNote);
    const args = argumentDigest(input.arguments);
    const entry: CallLogEntry = {
      at,
      trace_id: input.traceId,
      span_id: spanId,
      user: optionalId(input.userId, 'userId'),
      session: sessionOf(input.sessionId),
      tool: input.tool,
      run: optionalId(input.runId, 'runId'),
      args_digest: args.digest,
      args_size: args.size,
      args_preview: previewOf(input.argsPreview),
      call_result: input.callResult,
      acceptance,
      error_code: errorCode,
      duration_ms: Math.round(input.durationMs),
    };
    const { record, note } = await this.#store.withTransaction(async (tx) => {
      const stored = await this.#store.put<CallLogEntry>(
        { kind: 'call_log', schema: RECORD_SCHEMAS.call_log, provenance: 'observed', body: entry, created_at: at },
        tx,
      );
      if (stored.created) {
        await this.#db.query(
          `INSERT INTO call_logs (digest, at, trace_id, span_id, user_id, session_id, tool, run_id, args_digest, args_size, args_preview, call_result, acceptance, error_code, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [stored.digest, at, entry.trace_id, entry.span_id, entry.user, entry.session, entry.tool, entry.run, entry.args_digest, entry.args_size, entry.args_preview, entry.call_result, entry.acceptance, entry.error_code, entry.duration_ms],
          tx,
        );
      }
      if(stored.created && safeReasons.length) {
        await this.#db.query('INSERT INTO call_reasons (digest,ordinal,note,at) SELECT $1,(ordinality-1)::integer,note,$3::timestamptz FROM unnest($2::text[]) WITH ORDINALITY AS reasons(note,ordinality)',[stored.digest,safeReasons,at],tx);
      }
      if (adminNote !== null) {
        await this.#db.query('INSERT INTO call_notes (digest, note, at) VALUES ($1, $2, $3) ON CONFLICT (digest) DO NOTHING', [stored.digest, adminNote, at], tx);
      }
      const kept = (await this.#db.query('SELECT note FROM call_notes WHERE digest = $1', [stored.digest], tx)).rows[0];
      return { record: stored, note: kept === undefined ? null : String(kept.note) };
    });
    const line: CallLogLine = { ...entry, digest: record.digest, admin_note: note };
    try {
      await this.#writeLine(line, record.created);
    } catch (error) {
      throw new RecordsError('调用已经记入数据库，但写日志文件失败；用同一个 spanId 重试会补上这一行，或运行 repairFiles', {
        cause: error,
        detail: { digest: record.digest },
      });
    }
    return line;
  }

  async query(principal: Principal, query: CallLogQuery = {}): Promise<Page<CallLogLine>> {
    // The stored account decides, not the Principal a session kept: a demoted admin sees only their own calls.
    const viewer = await this.#viewer(principal);
    if (viewer === null) return { items: [], next: null };
    const admin = viewer.role === 'admin';
    const limit = pageLimit(query.limit);
    const after = decodeCursor(query.cursor);
    const descending = query.newestFirst ?? true;
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };
    if (!admin) {
      // A user sees only their own calls; asking for someone else's gives the same empty page as having none.
      if (query.userId !== undefined && query.userId !== viewer.id) return { items: [], next: null };
      add('c.user_id = ?', viewer.id);
    } else if (query.userId !== undefined) {
      add('c.user_id = ?', query.userId);
    }
    if (query.tool !== undefined) add('c.tool = ?', query.tool);
    if (query.runId !== undefined) add('c.run_id = ?', query.runId);
    if (query.from !== undefined) add('c.at >= ?', normalizeTime(query.from, 'from'));
    if (query.to !== undefined) add('c.at < ?', normalizeTime(query.to, 'to'));
    if (after !== null) add(`c.seq ${descending ? '<' : '>'} ?`, after);
    values.push(limit + 1);
    const notes = admin ? 'LEFT JOIN call_notes n ON n.digest = c.digest' : '';
    const rows = (
      await this.#db.query(
        `SELECT c.*${admin ? `, n.note AS admin_note, (SELECT json_agg(r.note ORDER BY r.ordinal) FROM call_reasons r WHERE r.digest=c.digest) AS admin_reasons` : ''} FROM call_logs c ${notes}
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY c.seq ${descending ? 'DESC' : 'ASC'} LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const items = rows.slice(0, limit).map((row) => {
      const line = lineOf(row);
      if(admin && Array.isArray(row.admin_reasons) && row.admin_reasons.length)line.admin_reasons=row.admin_reasons;
      if (admin) line.admin_note = row.admin_note === null || row.admin_note === undefined ? null : String(row.admin_note);
      return line;
    });
    return { items, next: rows.length > limit ? encodeCursor(String(rows[limit - 1].seq)) : null };
  }

  async repairFiles(range: { from: string; to: string }): Promise<number> {
    const from = normalizeTime(range.from, 'from');
    const to = normalizeTime(range.to, 'to');
    let written = 0;
    let after = '0';
    for (;;) {
      const rows = (
        await this.#db.query(
          `SELECT c.* FROM call_logs c
            WHERE c.at >= $1 AND c.at < $2 AND c.seq > $3 ORDER BY c.seq LIMIT $4`,
          [from, to, after, REPAIR_BATCH],
        )
      ).rows;
      if (rows.length === 0) return written;
      after = String(rows[rows.length - 1].seq);
      const byFile = new Map<string, CallLogLine[]>();
      for (const row of rows) {
        const line=lineOf(row);
        const file = this.#fileOf(line);
        byFile.set(file, [...(byFile.get(file) ?? []), line]);
      }
      for (const [file, lines] of byFile) {
        written += await this.#serial(file, async () => {
          await mkdir(this.#logDir, { recursive: true, mode: 0o700 });
          const state = await fileState(file);
          const missing = lines.filter((line) => !state.digests.has(line.digest));
          if (missing.length === 0) return 0;
          await appendFile(file, `${state.openLine ? '\n' : ''}${missing.map((line) => JSON.stringify(journalLine(line))).join('\n')}\n`, { mode: 0o600 });
          return missing.length;
        });
      }
    }
  }

  #fileOf(line: CallLogLine): string {
    return join(this.#logDir, `calls-${line.at.slice(0, 10)}.jsonl`);
  }

  /** A new call appends its line; a repeated append writes it only when the file does not have it yet (a failed write). */
  async #writeLine(line: CallLogLine, created: boolean): Promise<void> {
    const file = this.#fileOf(line);
    await this.#serial(file, async () => {
      await mkdir(this.#logDir, { recursive: true, mode: 0o700 });
      let prefix = '';
      if (!created) {
        const state = await fileState(file);
        if (state.digests.has(line.digest)) return;
        if (state.openLine) prefix = '\n';
      }
      await appendFile(file, `${prefix}${JSON.stringify(journalLine(line))}\n`, { mode: 0o600 });
    });
  }

  async #serial<T>(file: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(file) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    this.#queues.set(file, tail);
    try {
      return await run;
    } finally {
      if (this.#queues.get(file) === tail) this.#queues.delete(file);
    }
  }

  async #viewer(principal: Principal): Promise<{ id: string; role: string } | null> {
    const id = typeof principal?.id === 'string' && USER_ID.test(principal.id) ? principal.id : null;
    if (id === null) return null;
    const row = (await this.#db.query('SELECT id, role, disabled FROM users WHERE id = $1', [id])).rows[0];
    return row === undefined || row.disabled === true ? null : { id: String(row.id), role: String(row.role) };
  }
}

/** Rebuilds a line from its row and checks it against the digest of its call_log record. */
function lineOf(row: Row): CallLogLine {
  const entry: CallLogEntry = {
    at: iso(row.at),
    trace_id: String(row.trace_id),
    span_id: String(row.span_id),
    user: row.user_id === null ? null : String(row.user_id),
    session: row.session_id === null ? null : String(row.session_id),
    tool: String(row.tool),
    run: row.run_id === null ? null : String(row.run_id),
    args_digest: String(row.args_digest),
    args_size: Number(row.args_size),
    args_preview: row.args_preview === null ? null : String(row.args_preview),
    call_result: row.call_result as CallLogEntry['call_result'],
    acceptance: (row.acceptance ?? null) as CallLogEntry['acceptance'],
    error_code: row.error_code === null ? null : String(row.error_code),
    duration_ms: Number(row.duration_ms),
  };
  const digest = recordDigest({ kind: 'call_log', schema: RECORD_SCHEMAS.call_log, provenance: 'observed', created_at: entry.at, body: entry });
  if (digest !== row.digest) throw new IntegrityError('调用日志行与它的记录摘要不符', { detail: { digest: row.digest } });
  return { ...entry, digest };
}
