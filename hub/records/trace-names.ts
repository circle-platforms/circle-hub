const MCP_STEPS = ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result', 'initialize', 'list-tools', 'handle-mcp'] as const;

const CONSOLE_STEPS = [
  'stream-console', 'serve-console', 'serve-overview', 'serve-results', 'serve-runs', 'serve-knowledge', 'serve-packs', 'serve-connections', 'serve-records',
  'serve-search', 'serve-settings', 'serve-health', 'serve-team', 'serve-operations', 'serve-admin', 'serve-api', 'serve-assets', 'serve-login', 'serve-logout',
  'serve-setup', 'serve-password', 'serve-authorize',
] as const;

const SYNC_STEPS = [
  'serve-sync', 'sync-state', 'sync-client', 'sync-session', 'sync-inventory', 'sync-missing', 'sync-upload', 'sync-download', 'sync-commit',
  'sync-operation', 'sync-abort', 'sync-mode-check', 'sync-mode', 'sync-share',
] as const;

export const BACKGROUND_STEPS = ['maintain-runs', 'index-citations', 'summarize-results', 'index-knowledge', 'sync-knowledge', 'poll-console', 'clean-staging', 'renew-lease', 'project-document', 'purge-traces'] as const;
export type BackgroundStep = (typeof BACKGROUND_STEPS)[number];

export const TIMED_BACKGROUND_STEPS = ['maintain-runs', 'index-citations', 'summarize-results', 'index-knowledge', 'poll-console', 'purge-traces'] as const satisfies readonly BackgroundStep[];

const COMMAND_STEPS = [
  'run-command', 'run-bot', 'run-serve', 'run-reset', 'run-user', 'run-token', 'run-logs', 'run-run', 'run-local-tools', 'run-setup-code',
  'run-apply', 'run-export', 'run-team', 'run-share', 'run-unshare', 'run-records', 'run-executor', 'run-job', 'run-bed', 'run-pack', 'run-resource', 'run-var', 'run-mask', 'run-secret',
  'run-original', 'run-lease', 'run-knowledge', 'run-doc', 'run-init-admin', 'run-operator-token', 'run-trace', 'run-health', 'run-crashes',
  'run-init', 'run-db', 'run-key', 'run-service', 'run-backup', 'run-restore', 'run-deploy', 'run-rollback', 'run-rehearse', 'run-status', 'run-tls',
] as const;

const INNER_STEPS = [
  'authenticate', 'check-permission', 'read-source', 'parse-document', 'run-function', 'run-check', 'validate-submission', 'append-record', 'compute-view', 'slow-query',
  'load-workflow', 'freeze-skills', 'resolve-target', 'bind-inputs', 'read-context', 'project-items', 'bind-expected', 'evaluate-run', 'list-packs',
  'list-runs', 'load-tasks', 'list-requests', 'read-call-log', 'read-systems', 'read-lines', 'read-storage',
] as const;

export const STEP_NAMES = [...MCP_STEPS, ...CONSOLE_STEPS, ...SYNC_STEPS, ...BACKGROUND_STEPS, ...COMMAND_STEPS, ...INNER_STEPS, 'serve-http'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export const USAGE_NAMES = [
  'db.queries', 'db.rows', 'db.bytes', 'db.ms', 'db.wait_ms',
  'sandbox.runs', 'sandbox.wait_ms', 'sandbox.ms',
  'source.reads', 'source.bytes', 'source.ms',
  'answer.bytes', 'self.ms', 'steps.dropped',
] as const;
export type UsageName = (typeof USAGE_NAMES)[number];

export const ACCOUNTED_USAGE = ['db.ms', 'db.wait_ms', 'sandbox.wait_ms', 'sandbox.ms', 'source.ms'] as const satisfies readonly UsageName[];

export const isUsageName = (value: string): value is UsageName => (USAGE_NAMES as readonly string[]).includes(value);

const pick = <T extends string>(names: readonly T[], name: string, otherwise: T): T => (names as readonly string[]).includes(name) ? (name as T) : otherwise;

export function mcpStep(method: unknown, tool: unknown): StepName {
  if (method === 'tools/call' && typeof tool === 'string') return pick(MCP_STEPS, tool, 'handle-mcp');
  return method === 'initialize' ? 'initialize' : method === 'tools/list' ? 'list-tools' : 'handle-mcp';
}

export function consoleStep(pathname: string): StepName {
  if (pathname === '/console/api/stream') return 'stream-console';
  return pick(CONSOLE_STEPS, `serve-${pathname.split('/')[2] ?? 'console'}`, 'serve-console');
}

export function syncStep(route: string): StepName {
  return pick(SYNC_STEPS, `sync-${route.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, 'serve-sync');
}

export function commandStep(command: string): StepName {
  return pick(COMMAND_STEPS, `run-${command}`, 'run-command');
}
