// The hook protocol of a candidate Circle (1.18.0-local.2) for one event, PreToolUse: the input a hook is given and how its answer is read.
// Ported from that Circle's own source, not from memory: `src/hooks.ts` (`readHookAnswer`, `readOutput`, `interpretHookRun`,
// `combineOutcomes`, `runChosen`) and `docs/hooks.md`. The Circle 1.17.0 reading of the same event is `interpretGuardOutput` in guard.ts.
// Where this file and that source disagree, the source is right; the differential test in guard-compare.test.ts shows it.

/** What a gating hook's run comes to for one call. */
export interface Interpreted {
  decision: 'allow' | 'deny' | 'ask' | 'none';
  reason: string;
  /** The hook crashed, printed something unreadable or exited in a way that is no answer. */
  failed: boolean;
  /** A rewrite of the call's input came with a decision that lets the call run. */
  rewritten?: boolean;
  /** The answer used fields of the format before `hookSpecificOutput`. */
  legacy?: boolean;
}
export type Interpret = (exitCode: number | null, stdout: string, stderr: string) => Interpreted;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a hook's JSON said about a PreToolUse call. */
interface Answer {
  reason?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}
/** A hook's JSON, checked: a field of the wrong type makes the whole answer unreadable (`readHookAnswer` for PreToolUse). */
export function readPreToolUseAnswer(value: Record<string, unknown>): { answer: Answer; legacy: boolean } | { invalid: string } {
  const answer: Answer = {};
  let legacy = false;
  const text = (from: Record<string, unknown>, key: string, where = key): string | undefined => {
    const item = from[key];
    if (item === undefined || item === null)
      return undefined;
    if (typeof item !== 'string')
      throw new Error(`${where} must be text`);
    return item;
  };
  try {
    if (value.continue != null && typeof value.continue !== 'boolean')
      throw new Error('continue must be true or false');
    text(value, 'stopReason');
    text(value, 'systemMessage');
    if (value.suppressOutput != null && typeof value.suppressOutput !== 'boolean')
      throw new Error('suppressOutput must be true or false');
    text(value, 'terminalSequence');
    answer.reason = text(value, 'reason');
    const specific = value.hookSpecificOutput;
    if (specific != null) {
      if (!isRecord(specific))
        throw new Error('hookSpecificOutput must be an object');
      if (specific.hookEventName !== 'PreToolUse')
        throw new Error('hookSpecificOutput.hookEventName must be "PreToolUse"');
      text(specific, 'additionalContext', 'hookSpecificOutput.additionalContext');
      const decision = specific.permissionDecision;
      if (decision != null) {
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask' && decision !== 'defer')
          throw new Error('permissionDecision must be "allow", "deny", "ask" or "defer"');
        answer.permissionDecision = decision;
      }
      answer.permissionDecisionReason = text(specific, 'permissionDecisionReason', 'hookSpecificOutput.permissionDecisionReason');
      if (specific.updatedInput != null) {
        if (!isRecord(specific.updatedInput))
          throw new Error('updatedInput must be an object');
        answer.updatedInput = specific.updatedInput;
      }
    }
    const decision = value.decision;
    if (decision != null) {
      if (typeof decision !== 'string')
        throw new Error('decision must be text');
      // The top-level form this event used before `hookSpecificOutput`
      const mapped = decision === 'allow' || decision === 'approve' ? 'allow' : decision === 'deny' || decision === 'block' ? 'deny' : decision === 'ask' ? 'ask' : undefined;
      if (!mapped)
        throw new Error('decision must be "allow", "deny" or "ask"');
      legacy = true;
      answer.permissionDecision ??= mapped;
      answer.permissionDecisionReason ??= answer.reason;
    }
    // Fields of the format before this one, read so a hook not yet rewritten does not lose its effect
    if (value.updated_input !== undefined) {
      legacy = true;
      if (!isRecord(value.updated_input))
        throw new Error('updated_input must be an object');
      answer.updatedInput ??= value.updated_input;
    }
    for (const key of ['context', 'additional_context']) {
      if (text(value, key) === undefined)
        continue;
      legacy = true;
    }
    if (text(value, 'user_message') !== undefined)
      legacy = true;
  }
  catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
  for (const key of Object.keys(answer) as (keyof Answer)[])
    if (answer[key] === undefined)
      delete answer[key];
  return { answer, legacy };
}

type Reading = { answer?: Answer; plain: string; legacy: boolean; invalid?: never } | { invalid: string };
/** A hook's standard output (`readOutput`): nothing or plain text is no decision, a `{` must be a JSON object that reads. */
function readOutput(stdout: string): Reading {
  const text = stdout.trim();
  if (!text)
    return { plain: '', legacy: false };
  if (!text.startsWith('{'))
    return { plain: text, legacy: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  }
  catch (error) {
    return { invalid: `output is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(value))
    return { invalid: 'output is not a JSON object' };
  const read = readPreToolUseAnswer(value);
  if ('invalid' in read)
    return { invalid: read.invalid };
  return { answer: read.answer, plain: '', legacy: read.legacy };
}

const firstLine = (text: string): string => (text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '').slice(0, 500);

/**
 * What Circle 1.18.0-local.2 makes of one PreToolUse hook's exit code and output (`interpretHookRun` and `combineOutcomes` for a
 * command hook that is not legacy and not async, on a system where the hook runs as written). `onFailure: "block"` makes a failure deny
 * the call; without it a failure lets the call go ahead. A deny reads `Hook denied this call:` plus the reason in the tool result.
 */
export function interpretCircle118(hook: { name: string; onFailure?: 'block' | 'continue' }): Interpret {
  return (exitCode, stdout, stderr) => {
    const block = hook.onFailure === 'block';
    const failure = (cause: string): Interpreted => block
      ? { decision: 'deny', reason: `hook ${hook.name} failed; blocking because onFailure is "block": ${cause}`, failed: true }
      : { decision: 'none', reason: '', failed: true };
    const reading = readOutput(stdout);
    let answer: Answer | undefined;
    let legacy = false;
    if (exitCode === 2) {
      const blockText = stderr.trim() || 'hook exited 2';
      const decided = reading.invalid === undefined && reading.answer?.permissionDecision === 'deny' ? reading.answer.permissionDecisionReason || blockText : blockText;
      return { decision: 'deny', reason: decided, failed: false };
    }
    if (exitCode === 0) {
      if (reading.invalid !== undefined)
        return failure(reading.invalid);
      answer = reading.answer;
      legacy = reading.legacy;
    }
    else {
      // Another exit with a JSON answer: the answer decides, unless the hook blocks on failure
      if (reading.invalid === undefined && reading.answer && !block) {
        answer = reading.answer;
        legacy = reading.legacy;
      }
      else {
        const why = firstLine(stderr);
        return failure(`exited ${exitCode ?? 'unknown'}${why ? `: ${why}` : ''}`);
      }
    }
    // `defer` is ignored with a notice: Circle cannot hold a call for later
    const decision = answer?.permissionDecision && answer.permissionDecision !== 'defer' ? answer.permissionDecision : 'none';
    const reason = decision === 'none' ? '' : answer?.permissionDecisionReason || (decision === 'deny' ? 'hook denied' : '');
    return { decision, reason, failed: false, ...(answer?.updatedInput && answer.permissionDecision !== 'defer' && decision !== 'deny' ? { rewritten: true } : {}), ...(legacy ? { legacy: true } : {}) };
  };
}

/** The tool name Circle 1.18 gives a tool of an MCP server: `mcp__<server>__<tool>`, where 1.17.0 wrote `<server>_<tool>`. */
export function mcpToolName(tool: string, server: string): string {
  return tool.startsWith(`${server}_`) ? `mcp__${server}__${tool.slice(server.length + 1)}` : tool;
}

export interface PreToolUseCall {
  /** The conversation's session: in a subagent, still the root's, as Circle tells hooks. */
  root: string;
  /** The session the call is made in; its own id is the agent's when it is not the root. */
  session: string;
  /** The subagent's type (the task call's `subagent_type`), when `session` is a subagent. */
  agentType?: string;
  permissionMode: string;
  cwd: string;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  paths: unknown;
}
/** The JSON object a PreToolUse hook is given on standard input (`runChosen` in the 1.18 Circle's hooks.ts; docs/hooks.md, "What a hook receives"). */
export function preToolUseInput118(call: PreToolUseCall): Record<string, unknown> {
  const agent = call.session !== call.root;
  return {
    session_id: call.root,
    cwd: call.cwd,
    permission_mode: call.permissionMode,
    hook_event_name: 'PreToolUse',
    ...(agent ? { agent_id: call.session, agent_type: call.agentType ?? 'general-purpose' } : {}),
    tool_name: call.toolName,
    tool_input: call.toolInput ?? {},
    tool_use_id: call.toolUseId,
    paths: Array.isArray(call.paths) ? call.paths : [],
  };
}
/** The environment a hook's process gets from Circle on top of its filtered one: the project folder and whose call it judges. */
export function hookIdentityEnvironment(call: Pick<PreToolUseCall, 'root' | 'session' | 'cwd'>): Record<string, string> {
  return { CIRCLE_PROJECT_DIR: call.cwd, CIRCLE_SESSION_ID: call.root, ...(call.session !== call.root ? { CIRCLE_AGENT_ID: call.session } : {}) };
}

export interface HookRegistration {
  name: string;
  /** What a failure of the hook does: `block` denies the call, `continue` (Circle's default) lets it go ahead. */
  onFailure: 'block' | 'continue';
  timeoutSeconds?: number;
}
/** The PreToolUse command hook of a Circle 1.18 settings.json that runs `entry`: its name and what its failure does. Absent when no hook, or more than one, does. */
export function hookRegistration(settingsText: string, entry: string): HookRegistration | undefined {
  let settings: unknown;
  try { settings = JSON.parse(settingsText); }
  catch { return undefined; }
  const groups = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks.PreToolUse : undefined;
  if (!Array.isArray(groups))
    return undefined;
  const found: HookRegistration[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks))
      continue;
    for (const hook of group.hooks) {
      if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string')
        continue;
      const line = [hook.command, ...(Array.isArray(hook.args) ? hook.args.filter((item): item is string => typeof item === 'string') : [])].join(' ');
      if (!line.includes(entry))
        continue;
      found.push({ name: typeof hook.name === 'string' && hook.name ? hook.name : hook.command, onFailure: hook.onFailure === 'block' ? 'block' : 'continue', ...(typeof hook.timeout === 'number' ? { timeoutSeconds: hook.timeout } : {}) });
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
