import type { AdapterWarning } from './neutral.ts';
import { baseName } from './files.ts';

// Structural sanitizing for MCP server entries and hook commands. Rules
// follow the entry structure, never value guessing:
// - env / headers / http_headers / oauth: all values removed, key names kept
// - cwd: removed (it is a machine-local working directory)
// - args: elements containing "://", starting with / or ~, or shaped
//   --key=value / -k=value are replaced with [redacted]; the rest stay
// - hook commands: absolute path segments are reduced to basenames
// Warning details carry paths, line numbers and key names only — never
// values or whole lines.

export const REDACTED = '[redacted]';

export const SECRET_MAP_KEYS = ['env', 'headers', 'http_headers', 'oauth'] as const;

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;
const KEY_VALUE_ARG = /^--?[A-Za-z0-9_.-]+=/;

// Strips a secret-bearing map down to empty-string values; returns the key
// names. A non-object value is dropped entirely.
export function stripValueMap(entry: Record<string, unknown>, key: string): string[] {
  const value = entry[key];
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    delete entry[key];
    return [];
  }
  const names: string[] = [];
  const map = value as Record<string, unknown>;
  for (const name of Object.keys(map)) {
    names.push(name);
    map[name] = '';
  }
  return names;
}

export function dropCwd(
  entry: Record<string, unknown>,
  path: string,
  server: string,
  warnings: AdapterWarning[],
  serversKey: string,
): void {
  if ('cwd' in entry) {
    delete entry.cwd;
    warnings.push({
      code: 'PROVIDER_CWD_DROPPED',
      path,
      detail: `${serversKey}.${server} cwd is a machine-local directory and was removed from the manifest`,
    });
  }
}

export function sanitizeArgs(
  args: unknown,
  path: string,
  server: string,
  warnings: AdapterWarning[],
  serversKey: string,
): unknown {
  if (!Array.isArray(args)) return args;
  return args.map((arg, index) => {
    if (
      typeof arg === 'string' &&
      (arg.includes('://') || arg.startsWith('/') || arg.startsWith('~') || KEY_VALUE_ARG.test(arg))
    ) {
      warnings.push({
        code: 'PROVIDER_ARG_REDACTED',
        path,
        detail: `${serversKey}.${server} args[${index}] matches a redaction rule (endpoint, absolute path, or key=value) and was replaced with ${REDACTED}`,
      });
      return REDACTED;
    }
    return arg;
  });
}

const HOOK_PATH_SEGMENT = /(^|[=\s"'`(])(\/[^\s"'();|&]+|~\/[^\s"'();|&]+)/g;

export function sanitizeHookCommand(
  command: string,
  path: string,
  location: string,
  warnings: AdapterWarning[],
): string {
  let changed = false;
  const sanitized = command.replace(HOOK_PATH_SEGMENT, (_match, prefix: string, segment: string) => {
    changed = true;
    return `${prefix}${baseName(segment)}`;
  });
  if (changed) {
    warnings.push({
      code: 'HOOK_COMMAND_PATH',
      path,
      detail: `${location}: absolute path segments in the hook command were reduced to basenames`,
    });
  }
  return sanitized;
}

// Export side: write stripped values back as placeholders and report the key
// names that must be refilled.
export function placeholderShape(shape: Record<string, unknown>): { out: Record<string, unknown>; missing: string[] } {
  const out = structuredClone(shape) as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of SECRET_MAP_KEYS) {
    const map = out[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
        if (value === '') {
          (map as Record<string, unknown>)[name] = REDACTED;
          missing.push(`${key}.${name}`);
        }
      }
    }
  }
  if (out.url === '') {
    out.url = REDACTED;
    missing.push('url');
  }
  return { out, missing };
}
