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
  buildHooksObject,
  buildMcpServersObject,
  importHooksFile,
  importMcpServersJson,
} from './configs.ts';
import { parseToml, emitToml } from './toml.ts';

const HARNESS = 'gemini';
const SETTINGS_PATH = '.gemini/settings.json';

// Gemini CLI (docs/design/harness-formats.md). Skills: `.gemini/skills/`
// (directory with SKILL.md). Commands: `.gemini/commands/**.toml`, names use
// `:`. Agents: `.gemini/agents/*.md`. Instruction: GEMINI.md (the
// settings.json `context.fileName` alternatives are not resolved — only the
// default name). Hooks and MCP servers share `.gemini/settings.json`.
// User-level (~/.gemini) files are never part of the virtual file table.
const SKILL_ENTRY = /^\.gemini\/skills\/([^/]+)\/SKILL\.md$/;
const COMMAND_FILE = /^\.gemini\/commands\/(.+)\.toml$/;
const AGENT_FILE = /^\.gemini\/agents\/([^/]+)\.md$/;
const INSTRUCTION_FILE = /(^|\/)GEMINI\.md$/;

const SKILL_SPEC: MarkdownSpec = {
  kind: 'hub-skill/1',
  fields: { name: 'name', description: 'description' },
  specific: {},
  frontmatterName: true,
};
const AGENT_SPEC: MarkdownSpec = {
  kind: 'hub-agent/1',
  fields: { name: 'name', description: 'description', tools: 'tools', model: 'model' },
  specific: {},
  frontmatterName: true,
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
    const match = SKILL_ENTRY.exec(path);
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
    const derived = deriveMarkdown(path, toText(value), match[1], SKILL_SPEC, warnings);
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
    const derived = deriveMarkdown(path, toText(value), match[1], AGENT_SPEC, warnings);
    manifests.push({
      kind: 'hub-agent/1',
      name: derived.neutral.name!,
      description: derived.neutral.description ?? '',
      tools: derived.neutral.tools ?? [],
      ...(derived.neutral.model !== undefined ? { model: derived.neutral.model } : {}),
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [{ path, sha256: sha256Hex(value) }],
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

// Commands are TOML: required `prompt` (the template body, stays in the file
// bytes) and optional `description` (the one mapped field).
function importCommands(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = COMMAND_FILE.exec(path);
    if (!match) continue;
    claimed.add(path);
    const parsed = parseToml(toText(value));
    for (const badLine of parsed.badLines) {
      warnings.push({
        code: 'TOML_LINE_SKIPPED',
        path,
        detail: `line ${badLine.line} is outside the supported TOML subset and was skipped`,
      });
    }
    const description = parsed.values.description;
    manifests.push({
      kind: 'hub-command/1',
      name: match[1].split('/').join(':'),
      description: typeof description === 'string' ? description : '',
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [{ path, sha256: sha256Hex(value) }],
      harnessSpecific: { path, keys: Object.keys(parsed.values) },
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
    if (!INSTRUCTION_FILE.test(path)) continue;
    claimed.add(path);
    const derived = deriveMarkdown(path, toText(value), undefined, INSTRUCTION_SPEC, warnings);
    manifests.push({
      kind: 'hub-instruction/1',
      applies: [],
      fileName: baseName(path),
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [{ path, sha256: sha256Hex(value) }],
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

function decideTransport(
  entry: Record<string, unknown>,
  name: string,
  warnings: AdapterWarning[],
): { transport?: 'stdio' | 'streamable-http'; skip?: boolean } {
  const present = ['command', 'url', 'httpUrl'].filter(
    (key) => typeof entry[key] === 'string' && (entry[key] as string) !== '',
  );
  if (present.length > 1) {
    warnings.push({
      code: 'PROVIDER_ENTRY_INVALID',
      path: SETTINGS_PATH,
      detail: `mcpServers.${name}: exactly one of command, url, httpUrl is allowed; the entry is skipped`,
    });
    return { skip: true };
  }
  if (present.length === 0) {
    warnings.push({
      code: 'PROVIDER_SHAPE_UNKNOWN',
      path: SETTINGS_PATH,
      detail: `mcpServers.${name} has none of command, url, httpUrl; transport left empty`,
    });
    return {};
  }
  if (present[0] === 'command') return { transport: 'stdio' };
  if (present[0] === 'httpUrl') return { transport: 'streamable-http' };
  // A bare `url` is SSE, which has no hub-provider/1 transport.
  warnings.push({
    code: 'PROVIDER_TRANSPORT_UNKNOWN',
    path: SETTINGS_PATH,
    detail: `mcpServers.${name} uses url (SSE), which has no hub-provider/1 transport; transport left empty`,
  });
  return {};
}

function importSettings(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(SETTINGS_PATH in files)) return;
  const text = toText(files[SETTINGS_PATH]);
  if (text.trim() === '') {
    claimed.add(SETTINGS_PATH);
    warnings.push({ code: 'EMPTY_CONFIG', path: SETTINGS_PATH, detail: 'file is empty; nothing imported from it' });
    return;
  }
  importHooksFile(HARNESS, SETTINGS_PATH, files, manifests, warnings, claimed, {
    language: 'shell',
    governedKeys: ['hooks', 'mcpServers'],
    emptyOk: true,
  });
  importMcpServersJson(HARNESS, SETTINGS_PATH, files, manifests, warnings, claimed, {
    governedKeys: ['hooks', 'mcpServers'],
    skipExtraKeysCheck: true,
    skipCanonicalCheck: true,
    emptyOk: true,
    decideTransport: (entry, { name, warnings: w }) => decideTransport(entry, name, w),
  });
}

export function importGemini(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importCommands(files, manifests, warnings, claimed);
  importAgents(files, manifests, warnings, claimed);
  importInstructions(files, manifests, warnings, claimed);
  importSettings(files, manifests, warnings, claimed);
  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) {
      warnings.push({
        code: 'UNRECOGNIZED_FILE',
        path,
        detail: 'file matches no Gemini CLI primitive location and was not imported',
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
  out[path] = exportMarkdownFile(manifest, spec, defaultNameFor(spec.kind, path), toText(original), path);
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

// Command export: an unchanged description returns the original file
// byte-identically; a changed one rewrites the description key in place and
// keeps prompt and everything else from the original bytes.
function exportCommand(manifest: HubManifest, source: VirtualFiles, out: VirtualFiles, warnings: AdapterWarning[]): void {
  const path = manifestPath(manifest);
  const original = path === '' ? undefined : source[path];
  if (path === '' || original === undefined) {
    warnings.push({
      code: 'SOURCE_FILE_MISSING',
      path,
      detail: 'hub-command/1 manifest points at a file that is not in the export file table; nothing exported',
    });
    return;
  }
  const text = toText(original);
  const parsed = parseToml(text);
  const originalDescription = typeof parsed.values.description === 'string' ? parsed.values.description : '';
  const command = manifest as { description?: string };
  if ((command.description ?? '') === originalDescription) {
    out[path] = original;
    return;
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.values)) {
    if (key === 'description') continue;
    values[key] = value;
  }
  const description = command.description ?? '';
  if (description !== '') {
    // Keep the original key order, replacing description in place.
    const ordered: Record<string, unknown> = {};
    let placed = false;
    for (const key of Object.keys(parsed.values)) {
      if (key === 'description') {
        ordered.description = description;
        placed = true;
      } else {
        ordered[key] = values[key];
      }
    }
    if (!placed) ordered.description = description;
    out[path] = emitToml(ordered);
    return;
  }
  out[path] = emitToml(values);
}

// settings.json holds both governed sections; they are rebuilt together and
// keep the original top-level key order.
function exportSettings(
  hooks: HubHook[],
  providers: HubProvider[],
  source: VirtualFiles,
  out: VirtualFiles,
  warnings: AdapterWarning[],
): void {
  const paths = new Set<string>();
  for (const hook of hooks) paths.add(manifestPath(hook) || SETTINGS_PATH);
  for (const provider of providers) paths.add(manifestPath(provider) || SETTINGS_PATH);
  for (const path of paths) {
    const sections: Record<string, unknown> = {};
    const fileHooks = hooks.filter((hook) => (manifestPath(hook) || SETTINGS_PATH) === path);
    const fileProviders = providers.filter((provider) => (manifestPath(provider) || SETTINGS_PATH) === path);
    if (fileHooks.length > 0) sections.hooks = buildHooksObject(fileHooks, path, source, warnings);
    if (fileProviders.length > 0) {
      const mcpServers = buildMcpServersObject(fileProviders, path, source, warnings, 'mcpServers');
      if (Object.keys(mcpServers).length > 0) sections.mcpServers = mcpServers;
    }
    if (Object.keys(sections).length === 0) continue;
    let order: string[] = [];
    const sourceText = source[path] === undefined ? undefined : toText(source[path]);
    if (sourceText !== undefined) {
      try {
        const original = JSON.parse(sourceText) as unknown;
        if (original && typeof original === 'object' && !Array.isArray(original)) {
          order = Object.keys(original as Record<string, unknown>).filter((key) => key in sections);
        }
      } catch {
        order = [];
      }
    }
    for (const key of ['hooks', 'mcpServers']) {
      if (key in sections && !order.includes(key)) order.push(key);
    }
    const composed: Record<string, unknown> = {};
    for (const key of order) composed[key] = sections[key];
    out[path] = canonicalJson(composed);
  }
}

export function exportGemini(manifests: HubManifest[], files: VirtualFiles): ExportResult {
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
    } else if (valid.kind === 'hub-command/1') {
      exportCommand(valid, source, out, warnings);
    } else if (valid.kind === 'hub-hook/1') {
      hooks.push(valid);
    } else if (valid.kind === 'hub-provider/1') {
      providers.push(valid);
    } else {
      warnings.push({
        code: 'NO_HARNESS_PROJECTION',
        path: manifestPath(valid),
        detail: `${valid.kind} has no file projection in Gemini CLI`,
      });
    }
  }
  exportSettings(hooks, providers, source, out, warnings);
  return { files: out, warnings };
}
