import type { AdapterWarning, HubHook, HubManifest, VirtualFiles } from './neutral.ts';
import { baseName, canonicalJson, sha256Hex, toText } from './files.ts';

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

export function parseJsonFile(
  path: string,
  text: string,
  warnings: AdapterWarning[],
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'file is not valid JSON; nothing imported from it' });
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'top level is not a JSON object; nothing imported from it' });
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function checkCanonical(
  path: string,
  text: string,
  value: Record<string, unknown>,
  extraKeys: string[],
  warnings: AdapterWarning[],
): void {
  if (extraKeys.length > 0) return;
  if (canonicalJson(value) !== text) {
    warnings.push({
      code: 'CANONICAL_NORMALIZATION',
      path,
      detail: 'file is valid JSON but not in the adapter canonical form (2-space indent, trailing newline); export rewrites it in canonical form',
    });
  }
}

// Hooks files (Claude Code settings.json / settings.local.json, Codex
// hooks.json): { hooks: { event: [{ matcher?, hooks: [{type, command}] }] } }.
// One hub-hook/1 per command entry. Harness event names are kept as-is (the
// spec maps no client events onto hub hook points); order and deterministic
// stay empty — harness hooks run in parallel and determinism is not
// derivable from a shell command.
export function importHooksFile(
  harness: string,
  path: string,
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(path in files)) return;
  claimed.add(path);
  const text = toText(files[path]);
  if (text.trim() === '') {
    warnings.push({ code: 'EMPTY_CONFIG', path, detail: 'file is empty; no hooks imported' });
    return;
  }
  const record = parseJsonFile(path, text, warnings);
  if (record === undefined) return;
  const extraKeys = Object.keys(record).filter((key) => key !== 'hooks');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path,
      detail: `keys not governed as hub hooks and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  if (record.hooks !== undefined && (typeof record.hooks !== 'object' || record.hooks === null || Array.isArray(record.hooks))) {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'hooks is not an object; no hooks imported' });
    return;
  }
  const hooks = (record.hooks ?? {}) as Record<string, unknown>;
  if (Object.keys(hooks).length === 0) {
    warnings.push({ code: 'EMPTY_CONFIG', path, detail: 'hooks section is empty; no hooks imported' });
    return;
  }
  const fileRef = { path, sha256: sha256Hex(files[path]) };
  let eventIndex = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path, detail: `hooks.${event} is not a list of matcher groups` });
      eventIndex += 1;
      continue;
    }
    warnings.push({
      code: 'HOOK_EVENT_UNMAPPED',
      path,
      detail: `hooks.${event}: harness event name kept as-is; the spec defines no mapping to hub hook points`,
    });
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path, detail: `hooks.${event}[${groupIndex}] is not an object` });
        return;
      }
      const matcher = (group as Record<string, unknown>).matcher;
      const entries = (group as Record<string, unknown>).hooks;
      if (!Array.isArray(entries)) {
        warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path, detail: `hooks.${event}[${groupIndex}] has no hooks list` });
        return;
      }
      entries.forEach((entry, entryIndex) => {
        const recordEntry = entry as Record<string, unknown> | null;
        if (!recordEntry || typeof recordEntry !== 'object' || Array.isArray(recordEntry)) {
          warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path, detail: `hooks.${event}[${groupIndex}].hooks[${entryIndex}] is not an object` });
          return;
        }
        if (recordEntry.type !== 'command' || typeof recordEntry.command !== 'string' || recordEntry.command === '') {
          const type = recordEntry.type;
          warnings.push({
            code: 'HOOK_ENTRY_SKIPPED',
            path,
            detail: `hooks.${event}[${groupIndex}].hooks[${entryIndex}] ${typeof type === 'string' ? `has type "${type}"` : 'is malformed'}; only {type: "command"} entries are imported`,
          });
          return;
        }
        const command = sanitizeHookCommand(recordEntry.command, path, `hooks.${event}[${groupIndex}].hooks[${entryIndex}]`, warnings);
        manifests.push({
          kind: 'hub-hook/1',
          event,
          handler: command,
          language: 'shell',
          sourceHarness: harness,
          knownCompatible: [],
          files: [fileRef],
          harnessSpecific: {
            filePath: path,
            eventIndex,
            ...(typeof matcher === 'string' ? { matcher } : {}),
            groupIndex,
            entryIndex,
            entry: { ...recordEntry, command },
          },
        });
      });
    });
    eventIndex += 1;
  }
  checkCanonical(path, text, record, extraKeys, warnings);
}

export interface HookSpecific {
  filePath?: string;
  matcher?: string;
  eventIndex?: number;
  groupIndex?: number;
  entryIndex?: number;
  entry?: Record<string, unknown>;
}

// Rebuild a hooks file from hook manifests, grouped by event and matcher
// group in their original positions.
export function exportHooksFile(hooks: HubHook[], out: VirtualFiles, defaultPath: string): void {
  const byPath = new Map<string, HubHook[]>();
  for (const hook of hooks) {
    const specific = hook.harnessSpecific as HookSpecific;
    const path = typeof specific.filePath === 'string' ? specific.filePath : defaultPath;
    const list = byPath.get(path) ?? [];
    list.push(hook);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const position = (hook: HubHook): [number, number, number] => {
      const specific = hook.harnessSpecific as HookSpecific;
      return [specific.eventIndex ?? 0, specific.groupIndex ?? 0, specific.entryIndex ?? 0];
    };
    const sorted = [...list].sort((a, b) => {
      const pa = position(a);
      const pb = position(b);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    const events: Record<string, Array<Record<string, unknown>>> = {};
    const groupKeys = new Map<string, Map<number, Record<string, unknown>>>();
    for (const hook of sorted) {
      const specific = hook.harnessSpecific as HookSpecific;
      if (!(hook.event in events)) {
        events[hook.event] = [];
        groupKeys.set(hook.event, new Map());
      }
      const groups = groupKeys.get(hook.event)!;
      const groupIndex = specific.groupIndex ?? 0;
      if (!groups.has(groupIndex)) {
        const group: Record<string, unknown> = {
          ...(typeof specific.matcher === 'string' ? { matcher: specific.matcher } : {}),
          hooks: [],
        };
        groups.set(groupIndex, group);
        events[hook.event].push(group);
      }
      const entry =
        specific.entry && typeof specific.entry === 'object'
          ? specific.entry
          : { type: 'command', command: hook.handler };
      (groups.get(groupIndex)!.hooks as unknown[]).push(entry);
    }
    out[path] = canonicalJson({ hooks: events });
  }
}
