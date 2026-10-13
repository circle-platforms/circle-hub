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
import {
  baseName,
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
  exportHooksFile,
  exportMcpServersJson,
  importHooksFile,
  importMcpServersJson,
} from './configs.ts';

const HARNESS = 'claude-code';
const SETTINGS_PATHS = ['.claude/settings.json', '.claude/settings.local.json'];
const MCP_PATH = '.mcp.json';

// Skills are picked up at any nesting depth; commands, agents, rules and
// settings are project-level `.claude` files. Rules and agents directories
// are walked recursively (subdirectory rules are rules; a subdirectory agent
// keeps its plain name). User-level (`~/...`) files are never part of the
// virtual file table and are therefore never imported.
const SKILL_ENTRY = /(^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/;
const COMMAND_FILE = /^\.claude\/commands\/(.+)\.md$/;
const AGENT_FILE = /^\.claude\/agents\/(.+)\.md$/;
const RULES_FILE = /^\.claude\/rules\/.+\.md$/;
const INSTRUCTION_FILE = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/;

const SKILL_SPEC: MarkdownSpec = {
  kind: 'hub-skill/1',
  fields: { name: 'name', description: 'description', model: 'model' },
  // allowed-tools is a no-prompt permission hint, not a tool restriction, so
  // it is not mapped to hub-skill/1.tools.
  specific: { 'allowed-tools': 'allowedTools' },
  frontmatterName: true,
};
const COMMAND_SPEC: MarkdownSpec = {
  kind: 'hub-command/1',
  fields: { description: 'description', arguments: 'arguments' },
  specific: { 'argument-hint': 'argumentHint' },
  frontmatterName: false,
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
// .claude/rules files scope themselves with a frontmatter `paths` list.
const RULES_SPEC: MarkdownSpec = {
  kind: 'hub-instruction/1',
  fields: { paths: 'applies' },
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
    const derived = deriveMarkdown(path, toText(value), match[2], SKILL_SPEC, warnings);
    manifests.push({
      kind: 'hub-skill/1',
      name: derived.neutral.name!,
      description: derived.neutral.description ?? '',
      entry: 'SKILL.md',
      tools: [],
      inputs: [],
      outputs: [],
      triggers: [],
      ...(derived.neutral.model !== undefined ? { model: derived.neutral.model } : {}),
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: fileRefs,
      harnessSpecific: markdownHarnessSpecific(path, derived),
    });
  }
}

function importMarkdown(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
  pattern: RegExp,
  spec: MarkdownSpec,
  nameFor?: (match: RegExpExecArray) => string,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = pattern.exec(path);
    if (!match) continue;
    claimed.add(path);
    const derived = deriveMarkdown(path, toText(value), nameFor ? nameFor(match) : match[1], spec, warnings);
    if (spec.kind === 'hub-agent/1') {
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
    } else if (spec.kind === 'hub-command/1') {
      manifests.push({
        kind: 'hub-command/1',
        name: derived.neutral.name!,
        description: derived.neutral.description ?? '',
        ...(derived.neutral.arguments !== undefined ? { arguments: derived.neutral.arguments } : {}),
        sourceHarness: HARNESS,
        knownCompatible: [],
        files: [{ path, sha256: sha256Hex(value) }],
        harnessSpecific: markdownHarnessSpecific(path, derived),
      });
    }
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

function decideTransport(
  entry: Record<string, unknown>,
  name: string,
  warnings: AdapterWarning[],
): { transport?: Transport; skip?: boolean } {
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
    return { transport: 'stdio' };
  }
  if (hasUrl) {
    if (type === undefined) {
      warnings.push({
        code: 'PROVIDER_ENTRY_INVALID',
        path: MCP_PATH,
        detail: `mcpServers.${name}: url without a type key is ambiguous; the entry is skipped`,
      });
      return { skip: true };
    }
    // `streamable-http` is the documented alias of `http`.
    if (type === 'http' || type === 'streamable-http') return { transport: 'streamable-http' };
    warnings.push({
      code: 'PROVIDER_TRANSPORT_UNKNOWN',
      path: MCP_PATH,
      detail: `mcpServers.${name} type "${type}" has no hub-provider/1 transport; transport left empty`,
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

function importMcp(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  importMcpServersJson(HARNESS, MCP_PATH, files, manifests, warnings, claimed, {
    decideTransport: (entry, { name, warnings: w }) => decideTransport(entry, name, w),
  });
}

export function importClaudeCode(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importMarkdown(files, manifests, warnings, claimed, COMMAND_FILE, COMMAND_SPEC, (match) =>
    match[1].split('/').join(':'),
  );
  importMarkdown(files, manifests, warnings, claimed, AGENT_FILE, AGENT_SPEC, (match) => baseName(match[1]));
  importInstructions(files, manifests, warnings, claimed);
  for (const settingsPath of SETTINGS_PATHS) {
    // Claude's hook command is a shell command; `shell: powershell` entries
    // are the documented exception and keep the field empty.
    importHooksFile(HARNESS, settingsPath, files, manifests, warnings, claimed, {
      language: 'shell',
      languageFromEntry: (entry) => (entry.shell === 'powershell' ? undefined : 'shell'),
    });
  }
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

const MARKDOWN_SPECS: Partial<Record<MarkdownKind, MarkdownSpec>> = {
  'hub-skill/1': SKILL_SPEC,
  'hub-command/1': COMMAND_SPEC,
  'hub-agent/1': AGENT_SPEC,
  'hub-instruction/1': INSTRUCTION_SPEC,
};

function defaultNameFor(kind: MarkdownKind, path: string): string | undefined {
  if (kind === 'hub-skill/1') return baseName(dirName(path));
  if (kind === 'hub-command/1' || kind === 'hub-agent/1') return baseName(path).replace(/\.md$/, '');
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
          detail: `skill file is not in the export file table; not exported`,
        });
        continue;
      }
      out[ref.path] = source[ref.path];
    }
  }
}

export function exportClaudeCode(manifests: HubManifest[], files: VirtualFiles): ExportResult {
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
      warnings.push({
        code: 'NO_HARNESS_PROJECTION',
        path: manifestPath(valid),
        detail: `${valid.kind} has no file projection in Claude Code`,
      });
    }
  }
  exportHooksFile(hooks, out, SETTINGS_PATHS[0], source, warnings);
  exportMcpServersJson(MCP_PATH, providers, source, out, warnings);
  return { files: out, warnings };
}
