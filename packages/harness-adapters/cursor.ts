import type {
  AdapterWarning,
  ExportResult,
  HubHook,
  HubManifest,
  HubProvider,
  ImportResult,
  VirtualFiles,
} from './neutral.ts';
import { hubManifestSchema } from './neutral.ts';
import {
  baseName,
  canonicalJson,
  dirName,
  normalizedFiles,
  sha256Hex,
  toText,
} from './files.ts';
import {
  deriveMarkdown,
  exportMarkdownFile,
  markdownHarnessSpecific,
  type MarkdownKind,
  type MarkdownSpec,
} from './markdown.ts';
import {
  exportMcpServersJson,
  importMcpServersJson,
  parseJsonFile,
  sanitizeHookCommand,
} from './configs.ts';

const HARNESS = 'cursor';
const HOOKS_PATH = '.cursor/hooks.json';
const MCP_PATH = '.cursor/mcp.json';

// Cursor (docs/design/harness-formats.md). Skills: `.cursor/skills/` at any
// depth (the directory holding SKILL.md is the identity) plus the documented
// `.agents/skills/` project location. Agents: `.cursor/agents/`. Instruction:
// `.cursor/rules/*.mdc` (globs map to applies) and AGENTS.md. Hooks:
// `.cursor/hooks.json` (flat entries per event). MCP: `.cursor/mcp.json`.
// Commands have no documented user/workspace directory — not imported.
// User-level (~/.cursor) files are never part of the virtual file table.
const SKILL_LOCATIONS = [
  /(^|\/)\.cursor\/skills\/(.+)\/SKILL\.md$/,
  /(^|\/)\.agents\/skills\/(.+)\/SKILL\.md$/,
  /(^|\/)\.claude\/skills\/(.+)\/SKILL\.md$/,
  /(^|\/)\.codex\/skills\/(.+)\/SKILL\.md$/,
];
const AGENT_FILE = /(^|\/)\.cursor\/agents\/([^/]+)\.md$/;
const RULES_FILE = /^\.cursor\/rules\/[^/]+\.mdc$/;
const INSTRUCTION_FILE = /(^|\/)AGENTS\.md$/;

const SKILL_SPEC: MarkdownSpec = {
  kind: 'hub-skill/1',
  fields: { name: 'name', description: 'description' },
  specific: {},
  frontmatterName: true,
};
const AGENT_SPEC: MarkdownSpec = {
  kind: 'hub-agent/1',
  fields: { name: 'name', description: 'description', model: 'model' },
  specific: {},
  frontmatterName: true,
};
const RULES_SPEC: MarkdownSpec = {
  kind: 'hub-instruction/1',
  fields: { globs: 'applies' },
  specific: {},
  frontmatterName: false,
};
const INSTRUCTION_SPEC: MarkdownSpec = {
  kind: 'hub-instruction/1',
  fields: {},
  specific: {},
  frontmatterName: false,
};

function importSkills(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = SKILL_LOCATIONS.map((pattern) => pattern.exec(path)).find((hit) => hit !== null);
    if (!match) continue;
    claimed.add(path);
    const directory = dirName(path);
    const fileRefs = [{ path, sha256: sha256Hex(value) }];
    for (const [other, otherValue] of Object.entries(files)) {
      if (other !== path && other.startsWith(`${directory}/`)) {
        claimed.add(other);
        fileRefs.push({ path: other, sha256: sha256Hex(otherValue) });
      }
    }
    const derived = deriveMarkdown(path, toText(value), baseName(directory), SKILL_SPEC, warnings);
    manifests.push({
      kind: 'hub-skill/1',
      name: derived.neutral.name!,
      description: derived.neutral.description ?? '',
      entry: 'SKILL.md',
      tools: [],
      inputs: [],
      outputs: [],
      triggers: [],
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: fileRefs,
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

function importAgents(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = AGENT_FILE.exec(path);
    if (!match) continue;
    claimed.add(path);
    const derived = deriveMarkdown(path, toText(value), match[2], AGENT_SPEC, warnings);
    manifests.push({
      kind: 'hub-agent/1',
      name: derived.neutral.name!,
      description: derived.neutral.description ?? '',
      tools: [],
      ...(derived.neutral.model !== undefined ? { model: derived.neutral.model } : {}),
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [{ path, sha256: sha256Hex(value) }],
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

function importInstructions(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    const isRulesFile = RULES_FILE.test(path);
    if (!isRulesFile && !INSTRUCTION_FILE.test(path)) continue;
    claimed.add(path);
    const spec = isRulesFile ? RULES_SPEC : INSTRUCTION_SPEC;
    const derived = deriveMarkdown(path, toText(value), undefined, spec, warnings);
    manifests.push({
      kind: 'hub-instruction/1',
      applies: derived.neutral.applies ?? [],
      fileName: baseName(path),
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [{ path, sha256: sha256Hex(value) }],
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

// Cursor hooks.json: { version: 1, hooks: { event: [ { command, type?,
// timeout, ... } ] } } — flat entries, no matcher groups. Entries without a
// type default to command. Language stays empty: the doc does not pin the
// runtime of a command string.
function importHooks(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(HOOKS_PATH in files)) return;
  claimed.add(HOOKS_PATH);
  const text = toText(files[HOOKS_PATH]);
  if (text.trim() === '') {
    warnings.push({ code: 'EMPTY_CONFIG', path: HOOKS_PATH, detail: 'file is empty; no hooks imported' });
    return;
  }
  const record = parseJsonFile(HOOKS_PATH, text, warnings);
  if (record === undefined) return;
  const extraKeys = Object.keys(record).filter((key) => key !== 'hooks' && key !== 'version');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path: HOOKS_PATH,
      detail: `keys not governed as hub hooks and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  if (record.hooks !== undefined && (typeof record.hooks !== 'object' || record.hooks === null || Array.isArray(record.hooks))) {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path: HOOKS_PATH, detail: 'hooks is not an object; no hooks imported' });
    return;
  }
  const hooks = (record.hooks ?? {}) as Record<string, unknown>;
  if (Object.keys(hooks).length === 0) {
    warnings.push({ code: 'EMPTY_CONFIG', path: HOOKS_PATH, detail: 'hooks section is empty; no hooks imported' });
    return;
  }
  const fileRef = { path: HOOKS_PATH, sha256: sha256Hex(files[HOOKS_PATH]) };
  let eventIndex = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: HOOKS_PATH, detail: `hooks.${event} is not a list of entries` });
      eventIndex += 1;
      continue;
    }
    warnings.push({
      code: 'HOOK_EVENT_UNMAPPED',
      path: HOOKS_PATH,
      detail: `hooks.${event}: harness event name kept as-is; the spec defines no mapping to hub hook points`,
    });
    entries.forEach((entry, entryIndex) => {
      const recordEntry = entry as Record<string, unknown> | null;
      if (!recordEntry || typeof recordEntry !== 'object' || Array.isArray(recordEntry)) {
        warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: HOOKS_PATH, detail: `hooks.${event}[${entryIndex}] is not an object` });
        return;
      }
      const type = recordEntry.type ?? 'command';
      if (type !== 'command' || typeof recordEntry.command !== 'string' || recordEntry.command === '') {
        warnings.push({
          code: 'HOOK_ENTRY_SKIPPED',
          path: HOOKS_PATH,
          detail: `hooks.${event}[${entryIndex}] ${typeof type === 'string' ? `has type "${type}"` : 'is malformed'}; only command entries are imported`,
        });
        return;
      }
      const location = `hooks.${event}[${entryIndex}]`;
      const command = sanitizeHookCommand(recordEntry.command, HOOKS_PATH, location, warnings);
      manifests.push({
        kind: 'hub-hook/1',
        event,
        handler: command,
        sourceHarness: HARNESS,
        knownCompatible: [],
        files: [fileRef],
        harnessSpecific: {
          filePath: HOOKS_PATH,
          eventIndex,
          entryIndex,
          entryKeys: Object.keys(recordEntry),
        },
      });
    });
    eventIndex += 1;
  }
}

function decideTransport(
  entry: Record<string, unknown>,
  name: string,
  warnings: AdapterWarning[],
): { transport?: 'stdio' | 'streamable-http'; skip?: boolean } {
  const hasCommand = typeof entry.command === 'string' && entry.command !== '';
  const hasUrl = typeof entry.url === 'string' && entry.url !== '';
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  if (hasCommand && hasUrl) {
    warnings.push({
      code: 'PROVIDER_ENTRY_INVALID',
      path: MCP_PATH,
      detail: `mcpServers.${name}: entry has both command and url; the entry is skipped`,
    });
    return { skip: true };
  }
  if (hasCommand) {
    if (type !== undefined && type !== 'stdio') {
      warnings.push({
        code: 'PROVIDER_ENTRY_INVALID',
        path: MCP_PATH,
        detail: `mcpServers.${name}: command entry carries a conflicting type key; the entry is skipped`,
      });
      return { skip: true };
    }
    // The field table requires type: stdio, the page's own local examples omit
    // it; both are stdio.
    return { transport: 'stdio' };
  }
  if (hasUrl) {
    // The doc writes url entries as "HTTP or SSE"; not pinned down, so the
    // transport stays empty.
    warnings.push({
      code: 'PROVIDER_TRANSPORT_UNKNOWN',
      path: MCP_PATH,
      detail: `mcpServers.${name} uses url (documented as HTTP or SSE); transport left empty`,
    });
    return {};
  }
  warnings.push({
    code: 'PROVIDER_SHAPE_UNKNOWN',
    path: MCP_PATH,
    detail: `mcpServers.${name} has neither command nor url; transport left empty`,
  });
  return {};
}

export function importCursor(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importAgents(files, manifests, warnings, claimed);
  importInstructions(files, manifests, warnings, claimed);
  importHooks(files, manifests, warnings, claimed);
  importMcpServersJson(HARNESS, MCP_PATH, files, manifests, warnings, claimed, {
    decideTransport: (entry, { name, warnings: w }) => decideTransport(entry, name, w),
  });
  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) {
      warnings.push({
        code: 'UNRECOGNIZED_FILE',
        path,
        detail: 'file matches no Cursor primitive location and was not imported',
      });
    }
  }
  return { manifests, warnings };
}

function manifestPath(manifest: HubManifest): string {
  const specific = manifest.harnessSpecific as Record<string, unknown> | undefined;
  const path = specific?.path ?? specific?.filePath;
  return typeof path === 'string' ? path : '';
}

const MARKDOWN_SPECS: Partial<Record<MarkdownKind, MarkdownSpec>> = {
  'hub-skill/1': SKILL_SPEC,
  'hub-agent/1': AGENT_SPEC,
  'hub-instruction/1': INSTRUCTION_SPEC,
};

function defaultNameFor(kind: MarkdownKind, path: string): string | undefined {
  if (kind === 'hub-skill/1') return baseName(dirName(path));
  if (kind === 'hub-agent/1') return baseName(path).replace(/\.md$/, '');
  return undefined;
}

function exportMarkdown(
  manifest: HubManifest,
  spec: MarkdownSpec,
  source: VirtualFiles,
  out: VirtualFiles,
  warnings: AdapterWarning[],
): void {
  const path = manifestPath(manifest);
  const original = path === '' ? undefined : source[path];
  if (path === '' || original === undefined) {
    warnings.push({
      code: 'SOURCE_FILE_MISSING',
      path,
      detail: `${manifest.kind} manifest points at a file that is not in the export file table; nothing exported`,
    });
    return;
  }
  const effectiveSpec = spec.kind === 'hub-instruction/1' && RULES_FILE.test(path) ? RULES_SPEC : spec;
  out[path] = exportMarkdownFile(manifest, effectiveSpec, defaultNameFor(spec.kind, path), toText(original), path);
  if (manifest.kind === 'hub-skill/1') {
    for (const ref of manifest.files) {
      if (ref.path === path) continue;
      if (!(ref.path in source)) {
        warnings.push({
          code: 'SOURCE_FILE_MISSING',
          path: ref.path,
          detail: 'skill file is not in the export file table; not exported',
        });
        continue;
      }
      out[ref.path] = source[ref.path];
    }
  }
}

// Rebuild hooks.json: version comes from the original file. Entries that
// were skipped at import (non-command types, malformed) carry no manifest;
// they are preserved verbatim from the original bytes so a round trip never
// loses entries. If the original file is missing, that is impossible and
// reported.
function exportHooks(hooks: HubHook[], source: VirtualFiles, out: VirtualFiles, warnings: AdapterWarning[]): void {
  const byPath = new Map<string, HubHook[]>();
  for (const hook of hooks) {
    const path = manifestPath(hook) || HOOKS_PATH;
    const list = byPath.get(path) ?? [];
    list.push(hook);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const sourceText = source[path] === undefined ? undefined : toText(source[path]);
    const original = sourceText === undefined ? undefined : parseJsonFile(path, sourceText, warnings);
    if (original === undefined) {
      warnings.push({
        code: 'HOOK_ENTRY_DROPPED_ON_EXPORT',
        path,
        detail: 'original hooks file is not in the export file table; entries skipped at import cannot be preserved',
      });
    }
    const originalHooks =
      original && original.hooks && typeof original.hooks === 'object' && !Array.isArray(original.hooks)
        ? (original.hooks as Record<string, unknown>)
        : undefined;
    const byEvent = new Map<string, Map<number, HubHook>>();
    for (const hook of list) {
      const specific = hook.harnessSpecific as { entryIndex?: number };
      const entries = byEvent.get(hook.event) ?? new Map<number, HubHook>();
      entries.set(specific.entryIndex ?? 0, hook);
      byEvent.set(hook.event, entries);
    }
    const events: Record<string, unknown[]> = {};
    // Original event order first (with skipped entries preserved), then any
    // events that only exist in manifests.
    const eventOrder: string[] = [];
    if (originalHooks) {
      for (const event of Object.keys(originalHooks)) eventOrder.push(event);
    }
    for (const hook of list) {
      if (!eventOrder.includes(hook.event)) eventOrder.push(hook.event);
    }
    for (const event of eventOrder) {
      const manifestEntries = byEvent.get(event) ?? new Map<number, HubHook>();
      const originalEntries = originalHooks?.[event];
      if (Array.isArray(originalEntries)) {
        const rebuilt: unknown[] = [];
        originalEntries.forEach((originalEntry, entryIndex) => {
          const hook = manifestEntries.get(entryIndex);
          manifestEntries.delete(entryIndex);
          if (hook === undefined) {
            rebuilt.push(originalEntry);
            return;
          }
          const entry: Record<string, unknown> = {};
          if (originalEntry && typeof originalEntry === 'object' && !Array.isArray(originalEntry)) {
            for (const [key, value] of Object.entries(originalEntry as Record<string, unknown>)) {
              entry[key] = key === 'command' ? hook.handler : value;
            }
          }
          if (!('command' in entry)) entry.command = hook.handler;
          rebuilt.push(entry);
        });
        // Manifests positioned beyond the original array append at the end.
        for (const hook of [...manifestEntries.values()].sort((a, b) => {
          const ai = (a.harnessSpecific as { entryIndex?: number }).entryIndex ?? 0;
          const bi = (b.harnessSpecific as { entryIndex?: number }).entryIndex ?? 0;
          return ai - bi;
        })) {
          rebuilt.push({ command: hook.handler });
        }
        events[event] = rebuilt;
      } else {
        const sorted = [...manifestEntries.values()].sort((a, b) => {
          const ai = (a.harnessSpecific as { entryIndex?: number }).entryIndex ?? 0;
          const bi = (b.harnessSpecific as { entryIndex?: number }).entryIndex ?? 0;
          return ai - bi;
        });
        events[event] = sorted.map((hook) => ({ command: hook.handler }));
      }
    }
    const composed: Record<string, unknown> = {};
    if (original !== undefined && 'version' in original) composed.version = original.version;
    composed.hooks = events;
    out[path] = canonicalJson(composed);
  }
}

export function exportCursor(manifests: HubManifest[], files: VirtualFiles): ExportResult {
  const source = normalizedFiles(files);
  const out: VirtualFiles = {};
  const warnings: AdapterWarning[] = [];
  const hooks: HubHook[] = [];
  const providers: HubProvider[] = [];
  for (const manifest of manifests) {
    const parsed = hubManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      warnings.push({
        code: 'MANIFEST_INVALID',
        path: manifest && typeof manifest === 'object' ? manifestPath(manifest as HubManifest) : '',
        detail: `manifest fails the neutral schema: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      });
      continue;
    }
    const valid = parsed.data;
    if (valid.sourceHarness !== HARNESS) {
      warnings.push({
        code: 'CROSS_HARNESS_EXPORT',
        path: manifestPath(valid),
        detail: `manifest sourceHarness is "${valid.sourceHarness}"; this exporter only writes ${HARNESS} files, skipped`,
      });
      continue;
    }
    const spec = MARKDOWN_SPECS[valid.kind as MarkdownKind];
    if (spec !== undefined) {
      exportMarkdown(valid, spec, source, out, warnings);
    } else if (valid.kind === 'hub-hook/1') {
      hooks.push(valid);
    } else if (valid.kind === 'hub-provider/1') {
      providers.push(valid);
    } else {
      // hub-command/1 included: Cursor has no documented command directory.
      warnings.push({
        code: 'NO_HARNESS_PROJECTION',
        path: manifestPath(valid),
        detail: `${valid.kind} has no file projection in Cursor`,
      });
    }
  }
  exportHooks(hooks, source, out, warnings);
  exportMcpServersJson(MCP_PATH, providers, source, out, warnings);
  return { files: out, warnings };
}
