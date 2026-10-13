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
import { baseName, dirName, normalizedFiles, sha256Hex, toText } from './files.ts';
import {
  deriveMarkdown,
  exportMarkdownFile,
  markdownHarnessSpecific,
  type MarkdownSpec,
} from './markdown.ts';
import { emitToml, parseToml, commentLines } from './toml.ts';
import {
  entrySkeleton,
  exportHooksFile,
  importHooksFile,
  rebuildProviderEntry,
  sanitizeArgs,
  skeletonCredentials,
  skeletonStripped,
  REDACTED,
} from './configs.ts';

const HARNESS = 'codex';
const CONFIG_PATH = '.codex/config.toml';
const HOOKS_PATH = '.codex/hooks.json';

// Skills live in .agents/skills at any depth; AGENTS.md and
// AGENTS.override.md are the instruction files. `.codex/agents/*.toml` and
// `~/.codex/prompts` are out of scope for this round (see the brief's 待定).
// User-level (~/.codex) files are never part of the virtual file table.
const SKILL_ENTRY = /(^|\/)\.agents\/skills\/([^/]+)\/SKILL\.md$/;
const INSTRUCTION_FILE = /(^|\/)(AGENTS\.md|AGENTS\.override\.md)$/;

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;

const SKILL_SPEC: MarkdownSpec = {
  kind: 'hub-skill/1',
  fields: { name: 'name', description: 'description', model: 'model' },
  specific: { 'allowed-tools': 'allowedTools' },
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

function importConfig(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  if (!(CONFIG_PATH in files)) return;
  claimed.add(CONFIG_PATH);
  const text = toText(files[CONFIG_PATH]);
  const parsed = parseToml(text);
  for (const badLine of parsed.badLines) {
    warnings.push({
      code: 'TOML_LINE_SKIPPED',
      path: CONFIG_PATH,
      detail: `line ${badLine.line} is outside the supported TOML subset and was skipped`,
    });
  }
  // Comments cannot survive manifest regeneration; report their line numbers.
  const comments = commentLines(text);
  if (comments.length > 0) {
    warnings.push({
      code: 'TOML_COMMENT_DROPPED',
      path: CONFIG_PATH,
      detail: `comments on lines ${comments.join(', ')} are not preserved on export`,
    });
  }
  const extraKeys = Object.keys(parsed.values).filter((key) => key !== 'mcp_servers');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path: CONFIG_PATH,
      detail: `config.toml keys not governed as hub providers and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  const servers = parsed.values.mcp_servers;
  if (servers === undefined || (typeof servers === 'object' && servers !== null && !Array.isArray(servers) && Object.keys(servers).length === 0)) {
    warnings.push({ code: 'EMPTY_CONFIG', path: CONFIG_PATH, detail: 'no mcp_servers entries; no providers imported' });
    return;
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    warnings.push({ code: 'TOML_LINE_SKIPPED', path: CONFIG_PATH, detail: 'mcp_servers is not a table; no providers imported' });
    return;
  }
  const fileRef = { path: CONFIG_PATH, sha256: sha256Hex(files[CONFIG_PATH]) };
  for (const [name, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      warnings.push({ code: 'PROVIDER_SHAPE_UNKNOWN', path: CONFIG_PATH, detail: `mcp_servers.${name} is not a table; skipped` });
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const hasCommand = typeof entry.command === 'string' && entry.command !== '';
    const hasUrl = typeof entry.url === 'string' && entry.url !== '';
    let transport: Transport | undefined;
    if (hasCommand && hasUrl) {
      warnings.push({
        code: 'PROVIDER_ENTRY_INVALID',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name}: entry has both command and url; the entry is skipped`,
      });
      continue;
    }
    if (hasCommand) {
      transport = 'stdio';
      if (ABSOLUTE_PATH.test(entry.command as string)) {
        warnings.push({
          code: 'PROVIDER_COMMAND_ABSOLUTE',
          path: CONFIG_PATH,
          detail: `mcp_servers.${name} command is an absolute path; it is reduced to basename at export`,
        });
      }
      sanitizeArgs(entry.args, CONFIG_PATH, name, warnings, 'mcp_servers');
    } else if (hasUrl) {
      // Codex mcp_servers have no type key: a url-only entry is a legal
      // Streamable HTTP server (auth / bearer_token_env_var / http_headers /
      // env_http_headers are its optional companions).
      transport = 'streamable-http';
    } else {
      warnings.push({
        code: 'PROVIDER_SHAPE_UNKNOWN',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name} has neither command nor url; transport left empty`,
      });
    }
    if ('cwd' in entry) {
      warnings.push({
        code: 'PROVIDER_CWD_DROPPED',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name} cwd is a machine-local directory and was removed from the manifest`,
      });
    }
    const shape = entrySkeleton(entry);
    const credentials = skeletonCredentials(shape);
    const stripped = skeletonStripped(shape, hasUrl);
    if (stripped.length > 0) {
      warnings.push({
        code: 'PROVIDER_VALUES_STRIPPED',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name}: values kept out of the manifest (key names preserved): ${stripped.join(', ')}`,
      });
    }
    manifests.push({
      kind: 'hub-provider/1',
      name,
      ...(transport !== undefined ? { transport } : {}),
      reads: [],
      writes: [],
      credentials,
      sourceHarness: HARNESS,
      knownCompatible: [],
      files: [fileRef],
      harnessSpecific: { filePath: CONFIG_PATH, server: name, shape },
    });
  }
}

export function importCodex(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importInstructions(files, manifests, warnings, claimed);
  importHooksFile(HARNESS, HOOKS_PATH, files, manifests, warnings, claimed);
  importConfig(files, manifests, warnings, claimed);
  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) {
      warnings.push({
        code: 'UNRECOGNIZED_FILE',
        path,
        detail: 'file matches no Codex primitive location and was not imported',
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
  const defaultName = spec.kind === 'hub-skill/1' ? baseName(dirName(path)) : undefined;
  out[path] = exportMarkdownFile(manifest, spec, defaultName, toText(original), path);
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

function exportProviders(
  providers: HubProvider[],
  source: VirtualFiles,
  out: VirtualFiles,
  warnings: AdapterWarning[],
): void {
  const byPath = new Map<string, HubProvider[]>();
  for (const provider of providers) {
    const specific = provider.harnessSpecific as { filePath?: unknown };
    const path = typeof specific.filePath === 'string' ? specific.filePath : CONFIG_PATH;
    const list = byPath.get(path) ?? [];
    list.push(provider);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const sourceText = source[path] === undefined ? undefined : toText(source[path]);
    const parsed = sourceText === undefined ? undefined : parseToml(sourceText);
    const servers = parsed?.values.mcp_servers;
    const mcpServers: Record<string, unknown> = {};
    for (const provider of list) {
      const specific = provider.harnessSpecific as { filePath?: unknown; server?: unknown };
      const serverName = typeof specific.server === 'string' ? specific.server : provider.name;
      const original =
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? (servers as Record<string, unknown>)[serverName]
          : undefined;
      if (!original || typeof original !== 'object' || Array.isArray(original)) {
        warnings.push({
          code: 'SOURCE_FILE_MISSING',
          path,
          detail: `mcp_servers.${serverName}: entry not found in the export file table; provider ${provider.name} not exported`,
        });
        continue;
      }
      const { entry, missing } = rebuildProviderEntry(original as Record<string, unknown>, provider.name, path, 'mcp_servers', warnings);
      mcpServers[provider.name] = entry;
      if (missing.length > 0) {
        warnings.push({
          code: 'SECRET_PLACEHOLDER',
          path,
          detail: `mcp_servers.${provider.name}: stripped values written as ${REDACTED} placeholders, refill before use: ${missing.join(', ')}`,
        });
      }
    }
    if (Object.keys(mcpServers).length > 0) out[path] = emitToml({ mcp_servers: mcpServers });
  }
}

export function exportCodex(manifests: HubManifest[], files: VirtualFiles): ExportResult {
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
    switch (valid.kind) {
      case 'hub-skill/1':
        exportMarkdown(valid, SKILL_SPEC, source, out, warnings);
        break;
      case 'hub-instruction/1':
        exportMarkdown(valid, INSTRUCTION_SPEC, source, out, warnings);
        break;
      case 'hub-hook/1':
        hooks.push(valid);
        break;
      case 'hub-provider/1':
        providers.push(valid);
        break;
      default:
        warnings.push({
          code: 'NO_HARNESS_PROJECTION',
          path: manifestPath(valid),
          detail: `${valid.kind} has no file projection in the Codex adapter (skills, instructions, hooks and MCP servers only)`,
        });
        break;
    }
  }
  exportHooksFile(hooks, out, HOOKS_PATH, source, warnings);
  exportProviders(providers, source, out, warnings);
  return { files: out, warnings };
}
