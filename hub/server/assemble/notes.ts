// Where the packages' admin messages go. The server records the real reason behind one MCP call's answer as that call's
// admin note (CallContext.adminNote), joined and clipped to 2000 characters. The run engine writes its reasons to the note
// of the call it serves itself (it gets the CallContext); here they only go to the operator's log, with their trace and
// run. The connectors and the pack registry report through process-wide callbacks without a call context, so the call one
// of their messages belongs to is found through an AsyncLocalStorage around every RunsService call, never by trace id
// (two calls of one trace may run at once). A call's note gets registry problems and the connectors' failure events only
// (at most a few per call): success events (logins, reads) would push the engine's reason out of the clipped note. Every
// message also goes to the operator's log, one line each, made safe for a terminal (the engine's details quote callers'
// arguments, which must neither fake a line nor steer the terminal of an operator who reads the log). Nothing here
// formats a secret: connector events are redacted by the connectors, the engine's details are its own well-formed text.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConnectorLogEvent } from '../../connectors/api.ts';
import type { CallContext } from '../../ports.ts';
import type { AdminLogEntry, RunsEngine, TamperEvent } from '../../runs/api.ts';
import { messageOf } from './errors.ts';
import { terminalSafe } from './terminal.ts';

/** Longest single message handed to an admin note or the operator's log; the call log clips notes again. */
const MAX_MESSAGE = 1000;
/** Longest connector event in a call's note. */
const MAX_CONNECTOR_NOTE = 240;
/**
 * Connector failure events one call's note takes; later ones are only in the operator's log (one line says so). With these
 * two limits connector events take at most about 800 of the note's 2000 characters, the rest is the engine's and the server's.
 */
export const MAX_CONNECTOR_NOTES = 3;

function clip(text: string, max = MAX_MESSAGE): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Connector events too frequent to be worth a line: one per request (the read manifest keeps every request). */
const QUIET_CONNECTOR_EVENTS = new Set(['http']);
/**
 * Connector events that report a failure (hub/connectors: a read, a login, a credential, a stored manifest or session, a
 * resource that cannot be read): the only ones a call's note takes. The others (login_attempt, login_ok, read_ok,
 * login_expiry_unusable, the admin actions) are in the operator's log only.
 */
const FAILURE_CONNECTOR_EVENTS = new Set([
  'read_failed',
  'read_unresolved',
  'login_failed',
  'login_stopped',
  'credential_refused',
  'secret_echoed',
  'accepts_failed',
  'session_store_failed',
  'manifest_shape',
  'manifest_store_failed',
  'resource_unreadable',
]);

/** One call in progress: its context and how many connector events its note took. */
interface CallState {
  context: CallContext;
  connectorNotes: number;
  connectorDropped: boolean;
}

export class CallNotes {
  readonly #calls = new AsyncLocalStorage<CallState>();
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = (line) => {
      try {
        log(line);
      } catch {
        // The operator's log must never change an answer.
      }
    };
  }

  /** Runs `fn` as part of the call `context`: connector and registry messages raised inside it become that call's admin notes. */
  within<T>(context: CallContext, fn: () => Promise<T>): Promise<T> {
    return this.#calls.run({ context, connectorNotes: 0, connectorDropped: false }, fn);
  }

  /** Adds to the admin note of `call` (default the current one), when there is one. */
  #note(text: string, max = MAX_MESSAGE, call: CallState | undefined = this.#calls.getStore()): void {
    const note = call?.context.adminNote;
    if (typeof note !== 'function') return;
    try {
      note(clip(text, max));
    } catch {
      // A note that cannot be kept changes nothing.
    }
  }

  /** The operator's log: one line, every control character (line breaks included) shown as an escape. */
  log(line: string): void {
    this.#log(terminalSafe(clip(line, 4000)));
  }

  /**
   * RunsEngineDeps.adminLog: the operator's log with the trace and the run. The call's admin note is the engine's own business
   * (CallContext.adminNote): noting it here too would say every reason twice.
   */
  readonly engine = (entry: AdminLogEntry): void => {
    this.log(`运行引擎（追踪 ${entry.traceId ?? '无'}，运行 ${entry.run ?? '无'}）：${entry.what}: ${entry.detail}`);
  };

  /** ConnectorsOptions.log: every event but the per-request ones to the operator's log; failures also to the call's note. */
  readonly connector = (event: ConnectorLogEvent): void => {
    if (QUIET_CONNECTOR_EVENTS.has(event.event)) return;
    const { at: _at, event: name, resource, ...detail } = event;
    let text: string;
    try {
      text = `${name}${resource === null ? '' : ` ${resource}`}${Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : ''}`;
    } catch {
      text = `${name}${resource === null ? '' : ` ${resource}`}`;
    }
    this.log(`连接器：${text}`);
    const call = this.#calls.getStore();
    if (call === undefined || !FAILURE_CONNECTOR_EVENTS.has(name)) return;
    if (call.connectorNotes < MAX_CONNECTOR_NOTES) {
      call.connectorNotes += 1;
      this.#note(`connector ${text}`, MAX_CONNECTOR_NOTE, call);
    } else if (!call.connectorDropped) {
      call.connectorDropped = true;
      this.#note(`connector: further failure events of this call are in the operator's log only`, MAX_CONNECTOR_NOTE, call);
    }
  };

  /** PackRegistryOptions.onError. */
  readonly registryError = (error: unknown, context: string): void => {
    const text = `${context}: ${messageOf(error)}`;
    this.#note(`packs ${text}`);
    this.log(`任务包：${text}`);
  };

  /** PackRegistryOptions.onTamper: an extracted pack did not match its digests (moved aside and rebuilt). */
  readonly tamper = (event: TamperEvent): void => {
    this.log(`任务包 ${event.digest} 的解包目录与摘要不符，已${event.quarantine === null ? '删除' : `移到 ${event.quarantine}`}并重建：${event.problems.join('；')}`);
  };
}

/**
 * The engine with every call that carries a CallContext run inside it, so that the connectors' and the registry's messages
 * raised while it serves the call reach the call's admin note (the engine's own reasons it notes itself).
 */
export function withCallNotes(engine: RunsEngine, notes: CallNotes): RunsEngine {
  return {
    ...engine,
    startRun: (user, input, context) => notes.within(context, () => engine.startRun(user, input, context)),
    startRunDetailed: (user, input, context) => notes.within(context, () => engine.startRunDetailed(user, input, context)),
    startHubRun: (configurer, input, context) => notes.within(context, () => engine.startHubRun(configurer, input, context)),
    submitResult: (user, args, context) => notes.within(context, () => engine.submitResult(user, args, context)),
    resolveReference: (user, input, context) => notes.within(context, () => engine.resolveReference(user, input, context)),
  };
}
