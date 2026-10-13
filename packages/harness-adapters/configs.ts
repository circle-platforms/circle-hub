import type { AdapterWarning, HubHook, HubManifest, VirtualFiles } from './neutral.ts';
import { baseName, canonicalJson, sha256Hex, toText } from './files.ts';

// Structural sanitizing for MCP server entries and hook commands. Rules
// follow the entry structure, never value guessing:
// - manifests carry only the *shape* of config entries: key names (and, for
//   object-valued keys, the nested key names); every value stays out
// - export rebuilds values from the original file bytes and re-applies the
//   rules: object values become [redacted] placeholders, url becomes a
//   placeholder, cwd is dropped, args words matching the redaction rules are
//   replaced, absolute program paths are reduced to basenames
// - hook commands are tokenized with shell quoting rules first; each word is
//   then checked with the same rules as MCP args, plus the Bearer keyword
// Warning details carry paths, line numbers and key names only — never
// values or whole lines.

export const REDACTED = '[redacted]';

// Object-valued entry keys whose nested names are also credential names.
const CREDENTIAL_MAP_KEYS = ['env', 'headers', 'http_headers', 'env_http_headers'];

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;
const KEY_VALUE_ARG = /^--?[A-Za-z0-9_.-]+=/;

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

export function matchesArgRedaction(value: string): boolean {
  return value.includes('://') || value.startsWith('/') || value.startsWith('~') || KEY_VALUE_ARG.test(value);
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
    if (typeof arg === 'string' && matchesArgRedaction(arg)) {
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

// Shell word tokenizer: whitespace separates, single quotes are literal,
// double quotes keep backslash escapes, backslash escapes the next character.
// An unclosed quote runs to the end of the string.
interface ShellToken {
  raw: string;
  value: string;
  separator: boolean;
}

export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < command.length) {
    if (/\s/.test(command[index])) {
      let end = index;
      while (end < command.length && /\s/.test(command[end])) end += 1;
      tokens.push({ raw: command.slice(index, end), value: command.slice(index, end), separator: true });
      index = end;
      continue;
    }
    let raw = '';
    let value = '';
    while (index < command.length && !/\s/.test(command[index])) {
      const char = command[index];
      if (char === "'") {
        const end = command.indexOf("'", index + 1);
        const stop = end === -1 ? command.length : end + 1;
        raw += command.slice(index, stop);
        value += command.slice(index + 1, end === -1 ? command.length : end);
        index = stop;
      } else if (char === '"') {
        raw += char;
        index += 1;
        while (index < command.length && command[index] !== '"') {
          if (command[index] === '\\' && index + 1 < command.length) {
            raw += command[index] + command[index + 1];
            value += command[index + 1];
            index += 2;
          } else {
            raw += command[index];
            value += command[index];
            index += 1;
          }
        }
        if (index < command.length) {
          raw += '"';
          index += 1;
        }
      } else if (char === '\\' && index + 1 < command.length) {
        raw += command.slice(index, index + 2);
        value += command[index + 1];
        index += 2;
      } else {
        raw += char;
        value += char;
        index += 1;
      }
    }
    tokens.push({ raw, value, separator: false });
  }
  return tokens;
}

// Hook commands: the program word is reduced to its basename; every other
// word is checked with the MCP args rules (endpoint, leading / or ~,
// --key=value) plus the Bearer keyword (the word after "Bearer", or any word
// containing "Bearer <x>", is redacted). The handler keeps only the
// processed command; the original bytes stay in the file table.
export function sanitizeHookCommand(
  command: string,
  path: string,
  location: string,
  warnings: AdapterWarning[],
): string {
  const tokens = tokenizeShell(command);
  const out: string[] = [];
  let wordIndex = -1;
  let redactNext = false;
  for (const token of tokens) {
    if (token.separator) {
      out.push(token.raw);
      continue;
    }
    wordIndex += 1;
    if (wordIndex === 0) {
      const base = baseName(token.value);
      if (base !== token.value) {
        warnings.push({ code: 'HOOK_COMMAND_PATH', path, detail: `${location}: program path reduced to basename` });
      }
      out.push(base);
      continue;
    }
    if (redactNext) {
      redactNext = false;
      out.push(REDACTED);
      warnings.push({
        code: 'HOOK_ARG_REDACTED',
        path,
        detail: `${location}: word ${wordIndex} follows the Bearer keyword and was replaced with ${REDACTED}`,
      });
      continue;
    }
    if (token.value === 'Bearer') {
      redactNext = true;
      out.push(token.raw);
      continue;
    }
    if (/\bBearer\s+\S+/.test(token.value) || matchesArgRedaction(token.value)) {
      out.push(REDACTED);
      warnings.push({
        code: 'HOOK_ARG_REDACTED',
        path,
        detail: `${location}: word ${wordIndex} matches a redaction rule (Bearer, endpoint, absolute path, or key=value) and was replaced with ${REDACTED}`,
      });
      continue;
    }
    out.push(token.raw);
  }
  return out.join('');
}

// The manifest-side shape of a config entry: every key name, and for
// object-valued keys the nested key names. Values never enter the manifest.
export type EntrySkeleton = Record<string, string[] | true>;

export function entrySkeleton(entry: Record<string, unknown>): EntrySkeleton {
  const shape: EntrySkeleton = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'cwd') continue;
    shape[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : true;
  }
  return shape;
}

export function skeletonCredentials(shape: EntrySkeleton): string[] {
  const credentials: string[] = [];
  for (const key of CREDENTIAL_MAP_KEYS) {
    const names = shape[key];
    if (Array.isArray(names)) credentials.push(...names);
  }
  return credentials;
}

// Key names whose values come back as placeholders at export: every
// object-valued key, plus url. Used for the import-side disclosure warning.
export function skeletonStripped(shape: EntrySkeleton, hasUrl: boolean): string[] {
  const stripped: string[] = [];
  for (const [key, names] of Object.entries(shape)) {
    if (Array.isArray(names)) for (const name of names) stripped.push(`${key}.${name}`);
  }
  if (hasUrl) stripped.push('url');
  return stripped;
}

// Export side: rebuild an entry from the original file's entry, re-applying
// every structural rule so redacted or secret values never leave as-is.
export function rebuildProviderEntry(
  original: Record<string, unknown>,
  name: string,
  path: string,
  serversKey: string,
  warnings: AdapterWarning[],
): { entry: Record<string, unknown>; missing: string[] } {
  const entry: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(original)) {
    if (key === 'cwd') {
      warnings.push({
        code: 'PROVIDER_CWD_DROPPED',
        path,
        detail: `${serversKey}.${name} cwd is a machine-local directory and was not exported`,
      });
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const names = Object.keys(value as Record<string, unknown>);
      entry[key] = Object.fromEntries(names.map((nested) => [nested, REDACTED]));
      for (const nested of names) missing.push(`${key}.${nested}`);
      continue;
    }
    if (key === 'url' && typeof value === 'string' && value !== '') {
      entry.url = REDACTED;
      missing.push('url');
      continue;
    }
    if (key === 'args') {
      entry.args = sanitizeArgs(value, path, name, warnings, serversKey);
      continue;
    }
    if (key === 'command' && typeof value === 'string') {
      if (ABSOLUTE_PATH.test(value)) {
        warnings.push({
          code: 'PROVIDER_COMMAND_ABSOLUTE',
          path,
          detail: `${serversKey}.${name} command is an absolute path; reduced to basename ${baseName(value.replace(/\\/g, '/'))}`,
        });
        entry.command = baseName(value.replace(/\\/g, '/'));
      } else {
        entry.command = value;
      }
      continue;
    }
    entry[key] = value;
  }
  return { entry, missing };
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
        const location = `hooks.${event}[${groupIndex}].hooks[${entryIndex}]`;
        const command = sanitizeHookCommand(recordEntry.command, path, location, warnings);
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
            // Entry keys only (type, command, timeout, ...): values stay in
            // the original file and are merged back at export.
            entryKeys: Object.keys(recordEntry),
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
}

// Rebuild a hooks file from hook manifests, grouped by event and matcher
// group in their original positions. The command comes from the (sanitized)
// manifest handler; extra entry keys are merged back from the original file.
export function exportHooksFile(
  hooks: HubHook[],
  out: VirtualFiles,
  defaultPath: string,
  source: VirtualFiles,
  warnings: AdapterWarning[],
): void {
  const byPath = new Map<string, HubHook[]>();
  for (const hook of hooks) {
    const specific = hook.harnessSpecific as HookSpecific;
    const path = typeof specific.filePath === 'string' ? specific.filePath : defaultPath;
    const list = byPath.get(path) ?? [];
    list.push(hook);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const originalText = source[path] === undefined ? undefined : toText(source[path]);
    const original = originalText === undefined ? undefined : parseJsonFile(path, originalText, warnings);
    if (original === undefined) {
      warnings.push({
        code: 'SOURCE_FILE_MISSING',
        path,
        detail: 'original hooks file is not in the export file table; extra entry keys (timeout, ...) cannot be recovered',
      });
    }
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
      const entry: Record<string, unknown> = { type: 'command', command: hook.handler };
      const originalEntry = originalHookEntry(original, hook);
      if (originalEntry !== undefined) {
        for (const [key, value] of Object.entries(originalEntry)) {
          if (key !== 'type' && key !== 'command') entry[key] = value;
        }
      }
      (groups.get(groupIndex)!.hooks as unknown[]).push(entry);
    }
    out[path] = canonicalJson({ hooks: events });
  }
}

function originalHookEntry(
  original: Record<string, unknown> | undefined,
  hook: HubHook,
): Record<string, unknown> | undefined {
  if (original === undefined) return undefined;
  const specific = hook.harnessSpecific as HookSpecific;
  const hooks = original.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
  const groups = (hooks as Record<string, unknown>)[hook.event];
  if (!Array.isArray(groups)) return undefined;
  const group = groups[specific.groupIndex ?? 0];
  if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
  const entries = (group as Record<string, unknown>).hooks;
  if (!Array.isArray(entries)) return undefined;
  const entry = entries[specific.entryIndex ?? 0];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}
