// Entry of the sandboxed child process. sandbox.ts starts it (permission model, and sandbox-exec on macOS) with one request on
// stdin. This file is trusted: it locks the process down, imports the pack module, calls the function once, writes a single
// result frame to fd 1 and exits. Pack code never sees the real stdio, the frame nonce or the request.
import { Console } from 'node:console';
import { readFileSync, writeSync } from 'node:fs';
import { isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { format } from 'node:util';
import type { SandboxErrorCode } from './errors.ts';
import { DECLARED_DEPENDENCIES, DEPENDENCY_BUILTINS, PACK_MODULE_FORMATS, PURE_BUILTINS } from './policy.ts';

// Intrinsics captured before any pack code runs. Pack code shares this realm and may replace prototype methods or globals;
// everything this file does after the import goes through these captured functions (the primordials technique of Node core).
const call = Function.prototype.call;
const startsWith = call.bind(String.prototype.startsWith) as unknown as (s: string, prefix: string) => boolean;
const endsWith = call.bind(String.prototype.endsWith) as unknown as (s: string, suffix: string) => boolean;
const stringSlice = call.bind(String.prototype.slice) as unknown as (s: string, start: number, end?: number) => string;
const arrayPush = call.bind(Array.prototype.push) as unknown as <T>(array: T[], value: T) => number;
const arrayIncludes = call.bind(Array.prototype.includes) as unknown as (array: readonly unknown[], value: unknown) => boolean;
const setHas = call.bind(Set.prototype.has) as unknown as (set: Set<string>, value: string) => boolean;
const mapGet = call.bind(Map.prototype.get) as unknown as <V>(map: Map<string, V>, key: string) => V | undefined;
const typedLength = call.bind((Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length') as PropertyDescriptor).get as () => number) as unknown as (
  array: Uint8Array,
) => number;
const urlHref = call.bind((Object.getOwnPropertyDescriptor(URL.prototype, 'href') as PropertyDescriptor).get as () => string) as unknown as (url: URL) => string;
const urlProtocol = call.bind((Object.getOwnPropertyDescriptor(URL.prototype, 'protocol') as PropertyDescriptor).get as () => string) as unknown as (url: URL) => string;
const regexExec = call.bind(RegExp.prototype.exec) as unknown as (re: RegExp, s: string) => RegExpExecArray | null;
const stringify = JSON.stringify;
const arrayIsArray = Array.isArray;
const clockNow = performance.now.bind(performance);
const objectKeys = Object.keys;
const hasOwn = Object.hasOwn;
const byteLength = Buffer.byteLength;
const bufferFrom = Buffer.from;
const toText = String;
const atomicsWait = Atomics.wait;
const URLConstructor = URL;
const ErrorConstructor = Error;

interface Dependency {
  name: string;
  /** File URL of the package directory, with a trailing slash. */
  url: string;
  /** Parent URL used to resolve the package from pack code. */
  base: string;
}

interface Request {
  nonce: string;
  batch?: boolean;
  /** File URL of the extracted pack directory, with a trailing slash. */
  pack: string;
  entry: string;
  exportName: string;
  dependencies: Dependency[];
  /** File URLs (trailing slash) of every directory the dependencies may load from. */
  dependencyDirs: string[];
  outputBytes: number;
  logBytes: number;
  input: unknown;
}

/** Frame values: primitives and flat records of primitives, encoded without any toJSON lookup. */
type Scalar = string | number | boolean | null | undefined;
type Frame =
  | { status: 'ok'; output: string }
  | { status: 'error'; code: SandboxErrorCode; detail: Record<string, Scalar> };

// Exits without running exit listeners the function may have added. Explicitly typed so control flow knows it never returns.
const hardExit: (code: number) => never = (Reflect.get(process, 'reallyExit') as (code: number) => never).bind(process);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

let request: Request;
try {
  request = JSON.parse(readFileSync(0, 'utf8')) as Request;
} catch {
  hardExit(71);
}
const dependencies = new Map(request.dependencies.map((d) => [d.name, d] as const));
const loadable = [request.pack, ...request.dependencyDirs];

function writeAll(fd: number, text: string): void {
  const data = bufferFrom(text, 'utf8');
  const total = typedLength(data);
  let offset = 0;
  while (offset < total) {
    try {
      offset += writeSync(fd, data, offset, total - offset);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EAGAIN') throw error;
      atomicsWait(sleeper, 0, 0, 2);
    }
  }
}

function scalar(value: Scalar): string {
  return value === undefined ? 'null' : (stringify(value) as string);
}

function encode(record: Record<string, Scalar | Record<string, Scalar>>): string {
  let out = '';
  for (const key of objectKeys(record)) {
    const value = record[key];
    const encoded = value !== null && typeof value === 'object' ? encode(value) : scalar(value);
    out = out === '' ? `${stringify(key)}:${encoded}` : `${out},${stringify(key)}:${encoded}`;
  }
  return `{${out}}`;
}

class Capture {
  text = '';
  kept = 0;
  total = 0;
  truncated = false;
  readonly stream: string;
  constructor(stream: string) {
    this.stream = stream;
  }
  add(chunk: string): void {
    const bytes = byteLength(chunk);
    this.total += bytes;
    if (this.total > request.outputBytes) finish({ status: 'error', code: 'SANDBOX_OUTPUT_TOO_LARGE', detail: { limit: 'output', stream: this.stream } });
    if (this.truncated) return;
    if (this.kept + bytes <= request.logBytes) {
      this.text += chunk;
      this.kept += bytes;
      return;
    }
    // Keep a prefix by characters; a multi-byte character at the cut is dropped.
    let prefix = '';
    let size = 0;
    for (const ch of chunk) {
      const n = byteLength(ch);
      if (this.kept + size + n > request.logBytes) break;
      prefix += ch;
      size += n;
    }
    this.text += prefix;
    this.kept = request.logBytes;
    this.truncated = true;
  }
}

const out = new Capture('stdout');
const err = new Capture('stderr');
let finished = false;

function finish(frame: Frame): never {
  if (finished) hardExit(72);
  finished = true;
  try {
    const logs = { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
    const body =
      frame.status === 'ok'
        ? `{"status":"ok","stdout":${scalar(logs.stdout)},"stderr":${scalar(logs.stderr)},"truncated":${scalar(logs.truncated)},"output":${frame.output}}`
        : encode({ status: 'error', code: frame.code, detail: frame.detail, ...logs });
    writeAll(1, `${request.nonce}\n${body}\n`);
  } catch {
    hardExit(73);
  }
  hardExit(0);
}

// Every attempt to cross the boundary is recorded, so catching the error does not hide it.
const violations: { code: SandboxErrorCode; what: string }[] = [];

function deny(code: SandboxErrorCode, what: string): never {
  arrayPush(violations, { code, what });
  const error = new ErrorConstructor(`${code}: ${what}`);
  (error as { code?: string }).code = code;
  throw error;
}

function forbidden(what: string): () => never {
  return function forbiddenOperation(): never {
    return deny('SANDBOX_VIOLATION', what);
  };
}

function seal(target: object, key: PropertyKey, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: false, enumerable: false, configurable: false });
  } catch {
    // A property that cannot be redefined keeps its original; the permission model and sandbox-exec still apply.
  }
}

/** Name, message and stack of a thrown value. Its getters are pack code: each is read inside its own guard. */
function describe(error: unknown): Record<string, Scalar> {
  const text = (read: () => unknown, max: number): string | undefined => {
    try {
      const value = read();
      return value === undefined ? undefined : stringSlice(toText(value), 0, max);
    } catch {
      return undefined;
    }
  };
  if (typeof error === 'object' && error !== null) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
    // code is the pack's own structured error code (ManualSourceError and the like): a name, not content.
    const code = text(() => e.code, 200);
    return { name: text(() => e.name, 200), ...(code === undefined ? {} : { code }), message: text(() => e.message, 2000), stack: text(() => e.stack, 4000) };
  }
  return { message: text(() => error, 2000) };
}

/** Reading the thrown value runs pack code (getters): an attempt it makes on the way is still the result. */
function errorFrame(error: unknown, phase: string, extra: Record<string, Scalar> = {}): Extract<Frame, { status: 'error' }> {
  if (violations.length > 0) failViolation();
  let code: unknown;
  try {
    code = (error as { code?: unknown } | null)?.code;
  } catch {
    code = undefined;
  }
  const described = describe(error);
  if (violations.length > 0) failViolation();
  if (code === 'ERR_ACCESS_DENIED') finish({ status: 'error', code: 'SANDBOX_VIOLATION', detail: { phase, ...extra, ...described } });
  return { status: 'error', code: 'FUNCTION_THREW', detail: { phase, ...extra, ...described } };
}

function failFromError(error: unknown, phase: string, extra: Record<string, Scalar> = {}): never {
  finish(errorFrame(error, phase, extra));
}

function failViolation(): never {
  const first = violations[0];
  finish({ status: 'error', code: first.code, detail: { what: first.what, attempts: violations.length } });
}

// Standard streams: the function writes into capped in-memory captures; the real fds stay with this file.
const sink = (capture: Capture): Writable =>
  new Writable({
    decodeStrings: false,
    write(chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      capture.add(typeof chunk === 'string' ? chunk : bufferFrom(chunk as Uint8Array).toString('utf8'));
      done();
    },
  });
const stdoutSink = sink(out);
const stderrSink = sink(err);
const stdinEmpty = Readable.from([]);
for (const [key, value] of [
  ['stdout', stdoutSink],
  ['stderr', stderrSink],
  ['stdin', stdinEmpty],
] as const) {
  Object.defineProperty(process, key, { get: () => value, enumerable: true, configurable: false });
}
seal(globalThis, 'console', new Console({ stdout: stdoutSink, stderr: stderrSink, colorMode: false }));
seal(process, '_rawDebug', (...args: unknown[]) => err.add(`${format(...args)}\n`));

// Process control, native code, other processes and diagnostics that write files.
const realGetBuiltin = process.getBuiltinModule.bind(process);
for (const key of [
  'kill',
  '_kill',
  '_debugProcess',
  '_debugEnd',
  '_startProfilerIdleNotifier',
  '_stopProfilerIdleNotifier',
  'binding',
  '_linkedBinding',
  'dlopen',
  'execve',
  'chdir',
  'umask',
  'setuid',
  'setgid',
  'seteuid',
  'setegid',
  'setgroups',
  'initgroups',
  'abort',
  'reallyExit',
  'loadEnvFile',
  'openStdin',
  'setUncaughtExceptionCaptureCallback',
  '_getActiveHandles',
  '_getActiveRequests',
]) {
  seal(process, key, forbidden(`process.${key}`));
}
// Ending the process instead of returning is a failed call, not a boundary crossing (Node itself calls exit for an unsettled await).
seal(process, 'exit', function exit(): never {
  return finish({ status: 'error', code: 'FUNCTION_THREW', detail: { reason: 'process_exit' } });
});
seal(process, 'env', Object.freeze({}));
seal(
  process,
  'report',
  Object.freeze({ writeReport: forbidden('process.report.writeReport'), getReport: forbidden('process.report.getReport'), directory: '', filename: '' }),
);

// Network clients of the global scope, and the shared HTTP dispatcher they would use.
for (const key of ['fetch', 'WebSocket', 'EventSource', 'WebSocketStream']) seal(globalThis, key, forbidden(key));
const dispatcher = forbidden('network dispatcher');
seal(globalThis, Symbol.for('undici.globalDispatcher.1'), Object.freeze({ dispatch: dispatcher, request: dispatcher, connect: dispatcher, close: dispatcher, destroy: dispatcher }));

// Allowed builtins keep only their pure parts.
const crypto = realGetBuiltin('node:crypto') as Record<string, unknown>;
crypto.setEngine = forbidden('crypto.setEngine');
syncBuiltinESMExports();

const pure = new Set(PURE_BUILTINS);
const dependencyBuiltins = new Set([...PURE_BUILTINS, ...DEPENDENCY_BUILTINS]);
const declared = new Set(DECLARED_DEPENDENCIES);
const builtinName = (specifier: string): string => (startsWith(specifier, 'node:') ? stringSlice(specifier, 5) : specifier);
const inside = (url: string, dirs: readonly string[]): boolean => {
  for (let i = 0; i < dirs.length; i++) if (startsWith(url, dirs[i])) return true;
  return false;
};
// Same rules as isBareSpecifier and packageName in policy.ts, written with the captured intrinsics.
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const isBare = (s: string): boolean => {
  if (s === '' || s === '.' || s === '..' || s[0] === '/' || s[0] === '#') return false;
  if (startsWith(s, './') || startsWith(s, '../')) return false;
  return regexExec(SCHEME, s) === null;
};
const packageOf = (s: string): string => {
  let slashes = 0;
  const wanted = s[0] === '@' ? 2 : 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '/' && ++slashes === wanted) return stringSlice(s, 0, i);
  }
  return s;
};

seal(process, 'getBuiltinModule', function getBuiltinModule(id: unknown): unknown {
  const name = typeof id === 'string' && isBuiltin(id) ? builtinName(id) : undefined;
  if (name === undefined) return undefined;
  if (!setHas(pure, name)) deny('IMPORT_NOT_DECLARED', toText(id));
  return realGetBuiltin(id as string);
});

process.on('uncaughtException', (error) => failFromError(error, 'async'));
process.on('unhandledRejection', (reason) => failFromError(reason, 'async'));
// The event loop drained while the function's promise is still pending: it can never settle.
process.on('beforeExit', () => finish({ status: 'error', code: 'FUNCTION_THREW', detail: { reason: 'never_settled' } }));

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const fromPack = startsWith(parent, request.pack);
    if (isBuiltin(specifier)) {
      const name = builtinName(specifier);
      if (fromPack) {
        if (!setHas(pure, name)) deny('IMPORT_NOT_DECLARED', specifier);
      } else if (!(setHas(pure, name) || (setHas(dependencyBuiltins, name) && inside(parent, request.dependencyDirs)))) {
        // A dependency probing an optional builtin: refuse quietly, it is not the pack's attempt.
        const error = new ErrorConstructor(`IMPORT_NOT_DECLARED: ${specifier}`);
        (error as { code?: string }).code = 'IMPORT_NOT_DECLARED';
        throw error;
      }
      return nextResolve(specifier, context);
    }
    if (!fromPack) {
      const resolved = nextResolve(specifier, context);
      if (!inside(resolved.url, loadable) && !startsWith(resolved.url, 'node:')) deny('SANDBOX_VIOLATION', `load outside the pack: ${resolved.url}`);
      return resolved;
    }
    if (isBare(specifier)) {
      const name = packageOf(specifier);
      const dependency = mapGet(dependencies, name);
      if (!dependency || !setHas(declared, name)) deny('IMPORT_NOT_DECLARED', specifier);
      const resolved = nextResolve(specifier, { ...context, parentURL: dependency.base });
      if (!startsWith(resolved.url, dependency.url)) deny('IMPORT_NOT_DECLARED', specifier);
      return resolved;
    }
    let target: URL;
    try {
      target = new URLConstructor(specifier, parent);
    } catch {
      return deny('IMPORT_NOT_DECLARED', specifier);
    }
    if (urlProtocol(target) !== 'file:') deny('IMPORT_NOT_DECLARED', specifier);
    if (!startsWith(urlHref(target), request.pack)) deny('SANDBOX_VIOLATION', `import outside the pack: ${specifier}`);
    const resolved = nextResolve(specifier, context);
    if (!startsWith(resolved.url, request.pack) || endsWith(resolved.url, '.node')) deny('SANDBOX_VIOLATION', `import outside the pack: ${specifier}`);
    return resolved;
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (startsWith(url, request.pack) && !arrayIncludes(PACK_MODULE_FORMATS, loaded.format)) {
      deny('SANDBOX_VIOLATION', `pack module format ${toText(loaded.format)}: ${stringSlice(url, request.pack.length)}`);
    }
    return loaded;
  },
});

let fn: unknown;
try {
  const namespace = (await import(request.entry)) as Record<string, unknown>;
  fn = hasOwn(namespace, request.exportName) ? namespace[request.exportName] : undefined;
} catch (error) {
  failFromError(error, 'load');
}
if (violations.length > 0) failViolation();
if (typeof fn !== 'function') finish({ status: 'error', code: 'FUNCTION_NOT_FOUND', detail: { export: request.exportName } });

async function invoke(input: unknown): Promise<Frame> {
  let output: unknown;
  try { output = await (fn as (input: unknown) => unknown)(input); }
  catch (error) { return errorFrame(error, 'call'); }
  if (violations.length > 0) failViolation();
  let text: unknown;
  try { text = stringify(output); }
  catch (error) { return errorFrame(error, 'output', { reason: 'output_not_json' }); }
  if (violations.length > 0) failViolation();
  if (typeof text !== 'string') return { status: 'error', code: 'FUNCTION_THREW', detail: { phase: 'output', reason: 'output_not_json' } };
  if (byteLength(text) > request.outputBytes) return { status: 'error', code: 'SANDBOX_OUTPUT_TOO_LARGE', detail: { limit: 'output', stream: 'result' } };
  return { status: 'ok', output: text };
}

if (request.batch === true) {
  if (!arrayIsArray(request.input)) finish({ status: 'error', code: 'SANDBOX_VIOLATION', detail: { reason: 'invalid_batch_input' } });
  const inputs = request.input as unknown[];
  let packet = '['; let size = 2;
  for (let index = 0; index < inputs.length; index++) {
    if (index > 0) { out.text = ''; out.kept = 0; out.total = 0; out.truncated = false; err.text = ''; err.kept = 0; err.total = 0; err.truncated = false; }
    const started = clockNow();
    const result = await invoke(inputs[index]);
    const logs = { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, durationMs: clockNow() - started };
    const chunk = result.status === 'ok'
      ? `{"ok":true,"output":${result.output},"stdout":${scalar(logs.stdout)},"stderr":${scalar(logs.stderr)},"truncated":${scalar(logs.truncated)},"durationMs":${scalar(logs.durationMs)}}`
      : encode({ ok: false, code: result.code, detail: result.detail, ...logs });
    size += byteLength(chunk) + (index > 0 ? 1 : 0);
    if (size > request.outputBytes) finish({ status: 'error', code: 'SANDBOX_OUTPUT_TOO_LARGE', detail: { limit: 'output', stream: 'result', scope: 'batch' } });
    packet += (index > 0 ? ',' : '') + chunk;
  }
  finish({ status: 'ok', output: packet + ']' });
}
finish(await invoke(request.input));
