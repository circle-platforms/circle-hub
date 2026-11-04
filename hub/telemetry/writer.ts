// The writer of trace_spans (decision 146, design section 6). A request only pushes to a bounded queue in memory: nothing
// on the request path waits for this file, and nothing here can fail a request. The queue is written every few seconds or
// as soon as a batch is full, on the writer's own connection, as one INSERT; a full queue drops the new row and counts it,
// a batch the database refuses is lost and counted, and the counts stay readable (stats). The rows are diagnostic data:
// no record, no digest, and a row lost here changes nothing but what a later reader can see.
import type { Environment } from '../../contracts/generated/vocabulary.ts';
import { withoutTrace, type SpanRow, type TraceSink } from './usage.ts';

export const FLUSH_MS = 5000;
export const BATCH_ROWS = 500;
export const QUEUE_ROWS = 10_000;
/** The operator's log hears about lost rows at most this often. */
const REPORT_EVERY_MS = 60_000;

/** A row as stored: SpanRow plus what is the same for the whole process. */
export type StoredSpanRow = SpanRow & { release: string | null; environment: Environment | null };

/** One statement for a whole batch: the rows travel as a single JSON parameter. */
export const INSERT_SPANS = `INSERT INTO trace_spans (trace_id, span_id, parent_span_id, is_root, name, type, started_at, ended_at, level, status_message, origin, user_id, session_id, run_id, client_name, client_version, release, environment, usage)
  SELECT trace_id, span_id, parent_span_id, is_root, name, type, started_at, ended_at, level, status_message, origin, user_id, session_id, run_id, client_name, client_version, release, environment, usage
    FROM jsonb_to_recordset($1::jsonb) AS span(trace_id text, span_id text, parent_span_id text, is_root boolean, name text, type text, started_at timestamptz, ended_at timestamptz, level text, status_message text, origin text, user_id text, session_id text, run_id text, client_name text, client_version text, release text, environment text, usage jsonb)
  ON CONFLICT (trace_id, span_id) DO NOTHING`;

export interface WriterOptions {
  /** Writes one batch; the telemetry's own connection in production, anything in a test. */
  insert: (rows: readonly StoredSpanRow[]) => Promise<void>;
  release: string | null;
  environment: Environment | null;
  log?: (line: string) => void;
  batchRows?: number;
  queueRows?: number;
}

export interface WriterStats {
  /** Rows waiting to be written. */
  queued: number;
  written: number;
  /** Rows the full queue had no room for, or that came after the writer closed. */
  dropped: number;
  /** Rows of batches the database refused. */
  failed: number;
}

export class TraceWriter implements TraceSink {
  readonly #options: WriterOptions;
  readonly #batchRows: number;
  readonly #queueRows: number;
  #queue: StoredSpanRow[] = [];
  #draining: Promise<void> | null = null;
  #written = 0;
  #dropped = 0;
  #failed = 0;
  #reported = 0;
  #closed = false;

  constructor(options: WriterOptions) {
    this.#options = options;
    this.#batchRows = options.batchRows ?? BATCH_ROWS;
    this.#queueRows = options.queueRows ?? QUEUE_ROWS;
  }

  push(row: SpanRow): void {
    if (this.#closed || this.#queue.length >= this.#queueRows) {
      this.#dropped += 1;
      this.#say(() => `运行观测的队列已满：到现在丢弃了 ${this.#dropped} 行，请求不受影响`);
      return;
    }
    this.#queue.push({ ...row, release: this.#options.release, environment: this.#options.environment });
    if (this.#queue.length >= this.#batchRows) void this.flush();
  }

  /** Writes what is queued, one batch at a time; never rejects. A failed batch ends the round: the next one tries again. */
  flush(): Promise<void> {
    return (this.#draining ??= withoutTrace(() => this.#drain()).finally(() => {
      this.#draining = null;
    }));
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#batchRows);
      try {
        await this.#options.insert(batch);
        this.#written += batch.length;
      } catch (error) {
        this.#failed += batch.length;
        // Only the driver's code: the message of a refused statement can quote a row.
        const code = (error as { code?: unknown } | null | undefined)?.code;
        this.#say(() => `运行观测写入失败（${typeof code === 'string' ? code : '没有错误码'}）：这一批 ${batch.length} 行已丢弃，请求不受影响`);
        return;
      }
    }
  }

  /** Tells the operator's log, not too often; what is lost stays counted whether the log works or not. */
  #say(line: () => string): void {
    const now = Date.now();
    if (now - this.#reported < REPORT_EVERY_MS) return;
    this.#reported = now;
    try {
      this.#options.log?.(line());
    } catch {
      // The operator's log failed too; the counts still say what was lost.
    }
  }

  /** Takes no more rows and writes the rest (one round: a batch that fails stays lost). */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#draining;
    await this.flush();
  }

  stats(): WriterStats {
    return { queued: this.#queue.length, written: this.#written, dropped: this.#dropped, failed: this.#failed };
  }
}
