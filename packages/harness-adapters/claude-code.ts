import type {
  AdapterWarning,
  ExportResult,
  HubHook,
  HubManifest,
  HubProvider,
  ImportResult,
  Transport,
  VirtualFiles,
} from './neutral.ts';
import { hubManifestSchema } from './neutral.ts';
import type { StoredFile } from './files.ts';
import {
  baseName,
  canonicalJson,
  dirName,
  normalizedFiles,
  readStored,
  storeFile,
  storedText,
  toText,
} from './files.ts';
import { parseFrontmatter, parseNameList, scalar, splitFrontmatter } from './frontmatter.ts';

const HARNESS = 'claude-code';
const SETTINGS_PATH = '.claude/settings.json';
const MCP_PATH = '.mcp.json';
const REDACTED = '[redacted]';

const SKILL_ENTRY = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;
const COMMAND_FILE = /^\.claude\/commands\/([^/]+)\.md$/;
const AGENT_FILE = /^\.claude\/agents\/([^/]+)\.md$/;

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

type MarkdownSource = {
  path: string;
  source: StoredFile;
  frontmatter: Record<string, string | string[]>;
}

function markdownValues(
  path: string,
  text: string,
  warnings: AdapterWarning[],
): Record<string, string | string[]> {
  const split = splitFrontmatter(text);
  if (split.unclosed) {
    warnings.push({
      code: 'FRONTMATTER_UNCLOSED',
      path,
      detail: 'opening --- has no closing ---; the file is treated as plain markdown with no frontmatter fields',
    });
    return {};
  }
  if (!split.hasFrontmatter) return {};
  const parsed = parseFrontmatter(split.frontmatter);
  for (const line of parsed.badLines) {
    warnings.push({
      code: 'FRONTMATTER_LINE_SKIPPED',
      path,
      detail: `frontmatter line is outside the supported subset and was skipped: ${JSON.stringify(line)}`,
    });
  }
  return parsed.values;
}

function proprietary(
  values: Record<string, string | string[]>,
  consumed: string[],
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!consumed.includes(key)) result[key] = value;
  }
  return result;
}

function importSkills(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = SKILL_ENTRY.exec(path);
    if (!match) continue;
    claimed.add(path);
    const directory = dirName(path);
    const siblings: Record<string, StoredFile> = {};
    for (const [other, otherValue] of Object.entries(files)) {
      if (other !== path && other.startsWith(`${directory}/`)) {
        claimed.add(other);
        siblings[other.slice(directory.length + 1)] = storeFile(otherValue);
      }
    }
    const values = markdownValues(path, toText(value), warnings);
    let name = scalar(values.name);
    if (name === undefined || name === '') {
      name = match[1];
      warnings.push({
        code: 'NAME_DERIVED_FROM_PATH',
        path,
        detail: `frontmatter has no name; derived "${name}" from the skill directory`,
      });
    }
    manifests.push({
      kind: 'hub-skill/1',
      name,
      description: scalar(values.description) ?? '',
      entry: 'SKILL.md',
      tools: parseNameList(values['allowed-tools']),
      inputs: [],
      outputs: [],
      triggers: [],
      sourceHarness: HARNESS,
      knownCompatible: [],
      harnessSpecific: {
        path,
        source: storeFile(value),
        frontmatter: proprietary(values, ['name', 'description', 'allowed-tools']),
        files: siblings,
      },
    });
  }
}

function importMarkdown(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
  pattern: RegExp,
  kind: 'hub-agent/1' | 'hub-command/1',
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = pattern.exec(path);
    if (!match) continue;
    claimed.add(path);
    const values = markdownValues(path, toText(value), warnings);
    // Claude Code commands are named by file name and have no frontmatter
    // name; agents carry name in frontmatter, with the file name as fallback.
    let name = kind === 'hub-command/1' ? match[1] : scalar(values.name);
    if (name === undefined || name === '') {
      name = match[1];
      warnings.push({
        code: 'NAME_DERIVED_FROM_PATH',
        path,
        detail: `frontmatter has no name; derived "${name}" from the file name`,
      });
    }
    const harnessSpecific: MarkdownSource = {
      path,
      source: storeFile(value),
      frontmatter: proprietary(
        values,
        kind === 'hub-agent/1'
          ? ['name', 'description', 'tools', 'model']
          : ['description', 'argument-hint'],
      ),
    };
    if (kind === 'hub-agent/1') {
      manifests.push({
        kind,
        name,
        description: scalar(values.description) ?? '',
        tools: parseNameList(values.tools),
        ...(scalar(values.model) !== undefined ? { model: scalar(values.model) } : {}),
        sourceHarness: HARNESS,
        knownCompatible: [],
        harnessSpecific,
      });
    } else {
      manifests.push({
        kind,
        name,
        description: scalar(values.description) ?? '',
        ...(scalar(values['argument-hint']) !== undefined ? { arguments: scalar(values['argument-hint']) } : {}),
        sourceHarness: HARNESS,
        knownCompatible: [],
        harnessSpecific,
      });
    }
  }
}

function importInstructions(
  files: VirtualFiles,
  manifests: HubManifest[],
  _warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    if (path !== 'CLAUDE.md' && !path.endsWith('/CLAUDE.md')) continue;
    claimed.add(path);
    const directory = dirName(path);
    manifests.push({
      kind: 'hub-instruction/1',
      scope: 'project',
      applies: directory === '' ? [] : [directory],
      fileName: 'CLAUDE.md',
      sourceHarness: HARNESS,
      knownCompatible: [],
      harnessSpecific: { path, source: storeFile(value) },
    });
  }
}

function parseJsonFile(
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

function checkCanonical(
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

function importSettings(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(SETTINGS_PATH in files)) return;
  claimed.add(SETTINGS_PATH);
  const text = toText(files[SETTINGS_PATH]);
  const record = parseJsonFile(SETTINGS_PATH, text, warnings);
  if (record === undefined) return;
  const extraKeys = Object.keys(record).filter((key) => key !== 'hooks');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path: SETTINGS_PATH,
      detail: `settings.json keys not governed as hub hooks and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  if (record.hooks !== undefined && (typeof record.hooks !== 'object' || record.hooks === null || Array.isArray(record.hooks))) {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path: SETTINGS_PATH, detail: 'hooks is not an object; no hooks imported' });
    return;
  }
  const hooks = (record.hooks ?? {}) as Record<string, unknown>;
  let order = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: SETTINGS_PATH, detail: `hooks.${event} is not a list of matcher groups` });
      continue;
    }
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: SETTINGS_PATH, detail: `hooks.${event}[${groupIndex}] is not an object` });
        return;
      }
      const matcher = (group as Record<string, unknown>).matcher;
      const entries = (group as Record<string, unknown>).hooks;
      if (!Array.isArray(entries)) {
        warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: SETTINGS_PATH, detail: `hooks.${event}[${groupIndex}] has no hooks list` });
        return;
      }
      entries.forEach((entry, entryIndex) => {
        const recordEntry = entry as Record<string, unknown> | null;
        if (!recordEntry || typeof recordEntry !== 'object' || Array.isArray(recordEntry)) {
          warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: SETTINGS_PATH, detail: `hooks.${event}[${groupIndex}].hooks[${entryIndex}] is not an object` });
          return;
        }
        if (recordEntry.type !== 'command' || typeof recordEntry.command !== 'string' || recordEntry.command === '') {
          warnings.push({ code: 'HOOK_ENTRY_SKIPPED', path: SETTINGS_PATH, detail: `hooks.${event}[${groupIndex}].hooks[${entryIndex}] is not a {type: "command", command} entry` });
          return;
        }
        manifests.push({
          kind: 'hub-hook/1',
          event,
          order,
          handler: recordEntry.command,
          language: 'shell',
          deterministic: false,
          sourceHarness: HARNESS,
          knownCompatible: [],
          harnessSpecific: {
            filePath: SETTINGS_PATH,
            ...(typeof matcher === 'string' ? { matcher } : {}),
            groupIndex,
            entryIndex,
            entry: recordEntry,
          },
        });
        warnings.push({
          code: 'HOOK_DETERMINISM_UNKNOWN',
          path: SETTINGS_PATH,
          detail: `hooks.${event}[${groupIndex}].hooks[${entryIndex}]: Claude Code hooks are arbitrary shell commands, determinism is not derivable; deterministic set to false`,
        });
        order += 1;
      });
    });
  }
  checkCanonical(SETTINGS_PATH, text, record, extraKeys, warnings);
}

function stripValueMap(
  entry: Record<string, unknown>,
  key: 'env' | 'headers',
): string[] {
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

function sanitizeArgs(
  args: unknown,
  path: string,
  server: string,
  warnings: AdapterWarning[],
): unknown {
  if (!Array.isArray(args)) return args;
  return args.map((arg, index) => {
    if (typeof arg === 'string' && (ABSOLUTE_PATH.test(arg) || URL_LIKE.test(arg))) {
      warnings.push({
        code: 'PROVIDER_ARG_REDACTED',
        path,
        detail: `mcpServers.${server} args[${index}] is an absolute path or endpoint and was replaced with ${REDACTED}`,
      });
      return REDACTED;
    }
    return arg;
  });
}

function importMcp(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(MCP_PATH in files)) return;
  claimed.add(MCP_PATH);
  const text = toText(files[MCP_PATH]);
  const record = parseJsonFile(MCP_PATH, text, warnings);
  if (record === undefined) return;
  const extraKeys = Object.keys(record).filter((key) => key !== 'mcpServers');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path: MCP_PATH,
      detail: `.mcp.json keys not governed as hub providers and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  if (record.mcpServers !== undefined && (typeof record.mcpServers !== 'object' || record.mcpServers === null || Array.isArray(record.mcpServers))) {
    warnings.push({ code: 'CONFIG_JSON_INVALID', path: MCP_PATH, detail: 'mcpServers is not an object; no providers imported' });
    return;
  }
  const servers = (record.mcpServers ?? {}) as Record<string, unknown>;
  for (const [name, rawEntry] of Object.entries(servers)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      warnings.push({ code: 'PROVIDER_SHAPE_UNKNOWN', path: MCP_PATH, detail: `mcpServers.${name} is not an object; skipped` });
      continue;
    }
    const shape: Record<string, unknown> = structuredClone(rawEntry) as Record<string, unknown>;
    const stripped: string[] = [];
    const credentials: string[] = [];
    for (const key of stripValueMap(shape, 'env')) {
      credentials.push(key);
      stripped.push(`env.${key}`);
    }
    for (const key of stripValueMap(shape, 'headers')) {
      credentials.push(key);
      stripped.push(`headers.${key}`);
    }
    let transport: Transport | undefined;
    if (typeof shape.command === 'string') {
      transport = 'stdio';
      if (ABSOLUTE_PATH.test(shape.command)) {
        warnings.push({
          code: 'PROVIDER_COMMAND_ABSOLUTE',
          path: MCP_PATH,
          detail: `mcpServers.${name} command is an absolute path; reduced to basename ${baseName(shape.command.replace(/\\/g, '/'))}`,
        });
        shape.command = baseName(shape.command.replace(/\\/g, '/'));
      }
      shape.args = sanitizeArgs(shape.args, MCP_PATH, name, warnings);
    } else if (typeof shape.url === 'string' || shape.type === 'http' || shape.type === 'sse') {
      if (shape.type === 'sse') {
        transport = undefined;
        warnings.push({
          code: 'PROVIDER_TRANSPORT_UNKNOWN',
          path: MCP_PATH,
          detail: `mcpServers.${name} uses the legacy sse transport, which has no hub-provider/1 transport; transport left empty`,
        });
      } else {
        transport = 'streamable-http';
      }
      if (typeof shape.url === 'string' && shape.url !== '') {
        stripped.push('url');
        shape.url = '';
      }
    } else {
      warnings.push({
        code: 'PROVIDER_SHAPE_UNKNOWN',
        path: MCP_PATH,
        detail: `mcpServers.${name} has neither command nor url; transport left empty`,
      });
    }
    if (stripped.length > 0) {
      warnings.push({
        code: 'PROVIDER_VALUES_STRIPPED',
        path: MCP_PATH,
        detail: `mcpServers.${name}: values kept out of the manifest (names and shapes preserved): ${stripped.join(', ')}`,
      });
    }
    manifests.push({
      kind: 'hub-provider/1',
      name,
      ...(transport !== undefined ? { transport } : {}),
      provides: { tools: [], resources: [], prompts: [] },
      reads: [],
      writes: [],
      credentials,
      ...(credentials.length > 0 ? { credentialMode: 'static' as const } : {}),
      sourceHarness: HARNESS,
      knownCompatible: [],
      harnessSpecific: { filePath: MCP_PATH, shape },
    });
  }
  checkCanonical(MCP_PATH, text, record, extraKeys, warnings);
}

export function importClaudeCode(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importMarkdown(files, manifests, warnings, claimed, COMMAND_FILE, 'hub-command/1');
  importMarkdown(files, manifests, warnings, claimed, AGENT_FILE, 'hub-agent/1');
  importInstructions(files, manifests, warnings, claimed);
  importSettings(files, manifests, warnings, claimed);
  importMcp(files, manifests, warnings, claimed);
  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) {
      warnings.push({
        code: 'UNRECOGNIZED_FILE',
        path,
        detail: 'file matches no Claude Code primitive location and was not imported',
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

function exportMarkdown(manifest: HubManifest, files: VirtualFiles, warnings: AdapterWarning[]): void {
  const specific = manifest.harnessSpecific as Partial<MarkdownSource>;
  const source = specific.source;
  const sourceOk =
    typeof source === 'string' ||
    (source !== null && typeof source === 'object' && typeof (source as { base64?: unknown }).base64 === 'string');
  if (typeof specific.path !== 'string' || !sourceOk) {
    warnings.push({
      code: 'MANIFEST_INVALID',
      path: manifestPath(manifest),
      detail: `${manifest.kind} manifest carries no harnessSpecific source bytes; nothing exported`,
    });
    return;
  }
  files[specific.path] = readStored(source as StoredFile);
  if (manifest.kind === 'hub-skill/1') {
    const siblings = (manifest.harnessSpecific as Record<string, unknown>).files;
    if (siblings && typeof siblings === 'object' && !Array.isArray(siblings)) {
      const directory = dirName(specific.path);
      for (const [relative, stored] of Object.entries(siblings as Record<string, StoredFile>)) {
        files[`${directory}/${relative}`] = readStored(stored);
      }
    }
  }
}

interface HookSpecific {
  filePath?: string;
  matcher?: string;
  groupIndex?: number;
  entryIndex?: number;
  entry?: Record<string, unknown>;
}

function exportHooks(hooks: HubHook[], files: VirtualFiles, _warnings: AdapterWarning[]): void {
  const byPath = new Map<string, HubHook[]>();
  for (const hook of hooks) {
    const specific = hook.harnessSpecific as HookSpecific;
    const path = typeof specific.filePath === 'string' ? specific.filePath : SETTINGS_PATH;
    const list = byPath.get(path) ?? [];
    list.push(hook);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
    files[path] = canonicalJson({ hooks: events });
  }
}

interface ProviderSpecific {
  filePath?: string;
  shape?: Record<string, unknown>;
}

function exportProviders(providers: HubProvider[], files: VirtualFiles, warnings: AdapterWarning[]): void {
  const byPath = new Map<string, HubProvider[]>();
  for (const provider of providers) {
    const specific = provider.harnessSpecific as ProviderSpecific;
    const path = typeof specific.filePath === 'string' ? specific.filePath : MCP_PATH;
    const list = byPath.get(path) ?? [];
    list.push(provider);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const mcpServers: Record<string, unknown> = {};
    for (const provider of list) {
      const specific = provider.harnessSpecific as ProviderSpecific;
      if (!specific.shape || typeof specific.shape !== 'object') {
        warnings.push({
          code: 'PROVIDER_SHAPE_UNKNOWN',
          path,
          detail: `provider ${provider.name} carries no harnessSpecific shape; not exported`,
        });
        continue;
      }
      mcpServers[provider.name] = specific.shape;
      const missing: string[] = [];
      const shape = specific.shape;
      for (const key of ['env', 'headers'] as const) {
        const map = shape[key];
        if (map && typeof map === 'object' && !Array.isArray(map)) {
          for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
            if (value === '') missing.push(`${key}.${name}`);
          }
        }
      }
      if (shape.url === '') missing.push('url');
      if (missing.length > 0) {
        warnings.push({
          code: 'PROVIDER_VALUES_EMPTY',
          path,
          detail: `mcpServers.${provider.name}: values were stripped at import and must be refilled before use: ${missing.join(', ')}`,
        });
      }
    }
    files[path] = canonicalJson({ mcpServers });
  }
}

export function exportClaudeCode(manifests: HubManifest[]): ExportResult {
  const files: VirtualFiles = {};
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
    switch (valid.kind) {
      case 'hub-skill/1':
      case 'hub-agent/1':
      case 'hub-command/1':
      case 'hub-instruction/1':
        exportMarkdown(valid, files, warnings);
        break;
      case 'hub-hook/1':
        hooks.push(valid);
        break;
      case 'hub-provider/1':
        providers.push(valid);
        break;
      case 'hub-tool/1':
        warnings.push({
          code: 'NO_HARNESS_PROJECTION',
          path: manifestPath(valid),
          detail: 'hub-tool/1 has no file projection in Claude Code; tools reach it through the hub MCP endpoint',
        });
        break;
    }
  }
  exportHooks(hooks, files, warnings);
  exportProviders(providers, files, warnings);
  return { files, warnings };
}
