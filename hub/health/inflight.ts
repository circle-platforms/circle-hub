// The in-flight request log: <data root>/logs/inflight.jsonl. A request's begin line is in the operating system's hands
// before the request runs, so it outlives the process (a heap exhaustion gives no chance to write anything, and the
// JavaScript stack is unavailable then); surviving the machine is not asked for, so nothing here fsyncs. Writes are
// synchronous for that reason: an asynchronous write may still be queued when the process dies. A write that fails is
// counted and never reaches the request. Lines carry the process's boot, so a start can tell its own from those of the
// process before it. The file holds the requests still running plus the recent past: past maxBytes it is rotated and the
// requests still running are written again at the head of the new one.
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestEntry } from './store.ts';

export const INFLIGHT_FILE = 'inflight.jsonl';
export const INFLIGHT_ROTATED = 'inflight.1.jsonl';
/** One generation is kept beside the current file, so the log never takes more than twice this. */
export const INFLIGHT_MAX_BYTES = 4 * 1024 * 1024;
const NAME_LIMIT = 200;

/** What identifies a request in the log. Fixed text and ids only: never arguments, never a value from a document. */
export interface RequestInfo {
  traceId: string | null;
  /** The entry: a code of the trace_origin axis. */
  origin: string;
  /** A route or tool name. */
  name: string;
  userId: string | null;
}

/** Ends the request. */
export interface RequestEnd {
  (): void;
  /** Adds what became known after the request began: the tool, the caller, the trace. */
  identify(info: Partial<Pick<RequestInfo, 'traceId' | 'name' | 'userId'>>): void;
}

export interface RequestLog {
  /** Appends the begin line and returns the function that appends the end line. Neither ever throws. */
  begin(info: RequestInfo): RequestEnd;
  /** Requests begun and not ended. */
  readonly inFlight: number;
}

/** What the log says about one earlier process. */
export interface RecoveredProcess {
  /** Requests with no end line, oldest first. */
  open: RequestEntry[];
  stoppedAt: string | null;
  /** The latest time on any of its lines. */
  lastAt: string | null;
}

export interface Recovered {
  /** False when the file could not be read: nothing is known. A missing file is read as having no processes. */
  readable: boolean;
  processes: Map<string, RecoveredProcess>;
  /** Lines that were not understood: a torn last line, or one a failed write left. */
  unreadableLines: number;
}

export interface RequestLogHandle extends RequestLog {
  /** Reads what earlier processes left. Never throws. */
  recover(): Recovered;
  /** Starts a fresh file; call once what `recover` found is safely recorded. Never throws. */
  rotate(): void;
  /** The clean-stop marker: written first, so a stop event the database refuses is still known at the next start. */
  markStopped(): void;
  /** Failed writes since the last call. */
  takeFailures(): number;
  close(): void;
}

export interface RequestLogOptions {
  directory: string;
  boot: string;
  now: () => Date;
  maxBytes?: number;
}

interface OpenEntry {
  id: number;
  entry: RequestEntry;
}

const clip = (text: string): string => (text.length <= NAME_LIMIT ? text : [...text].slice(0, NAME_LIMIT).join(''));

export function createRequestLog(options: RequestLogOptions): RequestLogHandle {
  const { boot, now } = options;
  const path = join(options.directory, INFLIGHT_FILE);
  const rotated = join(options.directory, INFLIGHT_ROTATED);
  const maxBytes = options.maxBytes ?? INFLIGHT_MAX_BYTES;
  const open = new Map<number, OpenEntry>();
  let fd: number | null = null;
  let bytes = 0;
  let next = 1;
  let failures = 0;
  let closed = false;
  let stopLine: string | null = null;

  const beginLine = ({ id, entry }: OpenEntry): string => JSON.stringify({ t: 'begin', boot, id, at: entry.started_at, trace: entry.trace, origin: entry.origin, name: entry.name, user: entry.user });

  const write = (line: string): void => {
    if (fd === null) throw new Error('the log is not open');
    bytes += writeSync(fd, `${line}\n`);
  };

  /** A fresh file holding what must survive it: this process's boot line, the requests it is running, its stop if it stopped. */
  const restart = (): void => {
    write(JSON.stringify({ t: 'boot', boot, at: now().toISOString() }));
    for (const entry of open.values()) write(beginLine(entry));
    if (stopLine !== null) write(stopLine);
  };

  const ensureOpen = (): void => {
    if (fd !== null) return;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    bytes = fstatSync(fd).size;
    restart();
  };

  const closeFile = (): void => {
    if (fd === null) return;
    const current = fd;
    fd = null;
    closeSync(current);
  };

  const rotate = (): void => {
    closeFile();
    try {
      renameSync(path, rotated);
    } catch {
      // A file that cannot be moved aside is emptied below: the bound holds, the recent past does not.
    }
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    ftruncateSync(fd, 0);
    bytes = 0;
    restart();
  };

  const append = (line: string): void => {
    if (closed) return;
    try {
      ensureOpen();
      write(line);
      if (bytes > maxBytes) rotate();
    } catch {
      failures += 1;
      try {
        closeFile();
      } catch {
        // The next line tries to open it again.
      }
    }
  };

  // Opened now, so a process that crashes before its first request still leaves its boot line: the next start can then say
  // nothing was running, instead of not knowing.
  try {
    ensureOpen();
  } catch {
    failures += 1;
  }

  return {
    get inFlight() {
      return open.size;
    },

    begin(info) {
      let id = 0;
      try {
        id = next;
        next += 1;
        const entry: RequestEntry = { trace: info.traceId, origin: info.origin, name: clip(info.name), user: info.userId, started_at: now().toISOString() };
        const item = { id, entry };
        open.set(id, item);
        append(beginLine(item));
      } catch {
        failures += 1;
      }
      const end = (() => {
        try {
          if (open.delete(id)) append(JSON.stringify({ t: 'end', boot, id, at: now().toISOString() }));
        } catch {
          failures += 1;
        }
      }) as RequestEnd;
      end.identify = (known) => {
        try {
          const item = open.get(id);
          if (item === undefined) return;
          if (known.traceId !== undefined) item.entry.trace = known.traceId;
          if (known.userId !== undefined) item.entry.user = known.userId;
          if (known.name !== undefined) item.entry.name = clip(known.name);
          append(JSON.stringify({ t: 'note', boot, id, at: now().toISOString(), trace: item.entry.trace, name: item.entry.name, user: item.entry.user }));
        } catch {
          failures += 1;
        }
      };
      return end;
    },

    recover() {
      const earlier = new Map<string, Omit<RecoveredProcess, 'open'> & { byId: Map<number, RequestEntry> }>();
      let unreadableLines = 0;
      let text: string;
      try {
        text = readTail(path, maxBytes * 2);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { readable: false, processes: new Map(), unreadableLines: 0 };
        text = '';
      }
      for (const raw of text.split('\n')) {
        if (raw === '') continue;
        const line = parseLine(raw);
        if (line === null) {
          unreadableLines += 1;
          continue;
        }
        if (line.boot === boot) continue;
        let seen = earlier.get(line.boot);
        if (seen === undefined) {
          seen = { stoppedAt: null, lastAt: null, byId: new Map() };
          earlier.set(line.boot, seen);
        }
        if (typeof line.at === 'string' && (seen.lastAt === null || line.at > seen.lastAt)) seen.lastAt = line.at;
        if (line.t === 'stop') seen.stoppedAt = typeof line.at === 'string' ? line.at : seen.lastAt;
        else if (line.t === 'end' && typeof line.id === 'number') seen.byId.delete(line.id);
        else if (line.t === 'begin' && typeof line.id === 'number') {
          seen.byId.set(line.id, { trace: textOrNull(line.trace), origin: textOrNull(line.origin), name: clip(String(line.name ?? '')), user: textOrNull(line.user), started_at: String(line.at ?? '') });
        } else if (line.t === 'note' && typeof line.id === 'number') {
          const entry = seen.byId.get(line.id);
          if (entry !== undefined) Object.assign(entry, { trace: textOrNull(line.trace), name: clip(String(line.name ?? entry.name)), user: textOrNull(line.user) });
        }
      }
      const processes = new Map([...earlier].map(([key, { byId, stoppedAt, lastAt }]) => [key, { open: [...byId.values()], stoppedAt, lastAt }]));
      return { readable: true, processes, unreadableLines };
    },

    rotate() {
      if (closed) return;
      try {
        rotate();
      } catch {
        failures += 1;
      }
    },

    markStopped() {
      stopLine = JSON.stringify({ t: 'stop', boot, at: now().toISOString() });
      append(stopLine);
    },

    takeFailures() {
      const count = failures;
      failures = 0;
      return count;
    },

    close() {
      closed = true;
      try {
        closeFile();
      } catch {
        failures += 1;
      }
    },
  };
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parseLine(raw: string): (Record<string, unknown> & { t: unknown; boot: string }) | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const line = value as Record<string, unknown>;
    return typeof line.boot === 'string' ? (line as Record<string, unknown> & { t: unknown; boot: string }) : null;
  } catch {
    return null;
  }
}

/** The file, or its last `limit` bytes when it somehow outgrew the bound. */
function readTail(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const read = readSync(fd, buffer, done, length - done, size - length + done);
      if (read === 0) break;
      done += read;
    }
    return buffer.subarray(0, done).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
