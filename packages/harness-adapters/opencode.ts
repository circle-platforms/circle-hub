import type {
  AdapterWarning,
  ExportResult,
  HubCommand,
  HubManifest,
  HubProvider,
  ImportResult,
  Transport,
  VirtualFiles,
} from './neutral.ts';
import { hubManifestSchema } from './neutral.ts';
import { baseName, canonicalJson, dirName, normalizedFiles, sha256Hex, toText } from './files.ts';
import {
  deriveMarkdown,
  exportMarkdownFile,
  markdownHarnessSpecific,
  type MarkdownSpec,
} from './markdown.ts';
import {
  entrySkeleton,
  checkCanonical,
  parseJsoncFile,
  rebuildProviderEntry,
  sanitizeCommandValue,
  skeletonCredentials,
  skeletonStripped,
  stripJsonc,
  REDACTED,
} from './configs.ts';

const HARNESS = 'opencode';

// OpenCode v2 (docs/design/harness-formats.md). Skills: `.opencode/skills/`
// with SKILL.md at any depth (id = last directory segment) or `<id>.md` at
// the skills root, plus the documented `.claude/skills/` and
// `.agents/skills/` compat locations. Commands: `.opencode/commands/` (and
// legacy `.opencode/command/`), nested names join with `/`; plus
// `commands.<name>` (with required `template`) in the config file — the same
// primitive in another spelling. Agents: `.opencode/agents/`, nested paths
// count into the id. Instruction: AGENTS.md only. Hooks: no standalone file
// (plugins register hooks in code) — nothing to import. Config:
// `opencode.json(c)` at the project root or in `.opencode/` only, key
// `mcp.servers`. User-level (~/.config/opencode) files are never part of the
// virtual file table.
const SKILL_ENTRY = /(^|\/)\.opencode\/skills\/(.+)\/SKILL\.md$/;
const SKILL_COMPAT = /(^|\/)\.(?:claude|agents)\/skills\/(.+)\/SKILL\.md$/;
const SKILL_ROOT_FILE = /(^|\/)\.opencode\/skills\/([^/]+)\.md$/;
const COMMAND_FILE = /(^|\/)\.opencode\/commands?\/(.+)\.md$/;
const AGENT_FILE = /(^|\/)\.opencode\/agents\/(.+)\.md$/;
const INSTRUCTION_FILE = /(^|\/)AGENTS\.md$/;
const CONFIG_FILE = /^(?:\.opencode\/)?opencode\.jsonc?$/;

const SKILL_SPEC: MarkdownSpec = {
  kind: 'hub-skill/1',
  // The frontmatter `name` is a display name only; the neutral name is the
  // path id, so `name` stays an unmapped (proprietary) key.
  fields: { description: 'description' },
  specific: {},
  frontmatterName: false,
};
const COMMAND_SPEC: MarkdownSpec = {
  kind: 'hub-command/1',
  fields: { description: 'description' },
  specific: {},
  frontmatterName: false,
};
const AGENT_SPEC: MarkdownSpec = {
  kind: 'hub-agent/1',
  fields: { description: 'description', model: 'model' },
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
    const directory = SKILL_ENTRY.exec(path) ?? SKILL_COMPAT.exec(path);
    if (directory) {
      claimed.add(path);
      const id = baseName(directory[2]);
      const directoryPath = dirName(path);
      const fileRefs = [{ path, sha256: sha256Hex(value) }];
      for (const [other, otherValue] of Object.entries(files)) {
        if (other !== path && other.startsWith(`${directoryPath}/`)) {
          claimed.add(other);
          fileRefs.push({ path: other, sha256: sha256Hex(otherValue) });
        }
      }
      const derived = deriveMarkdown(path, toText(value), id, SKILL_SPEC, warnings);
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
      continue;
    }
    const rootFile = SKILL_ROOT_FILE.exec(path);
    if (rootFile && rootFile[2] !== 'SKILL') {
      claimed.add(path);
      const derived = deriveMarkdown(path, toText(value), rootFile[2], SKILL_SPEC, warnings);
      manifests.push({
        kind: 'hub-skill/1',
        name: derived.neutral.name!,
        description: derived.neutral.description ?? '',
        entry: baseName(path),
        tools: [],
        inputs: [],
        outputs: [],
        triggers: [],
        sourceHarness: HARNESS,
        knownCompatible: [],
        files: [{ path, sha256: sha256Hex(value) }],
        harnessSpecific: markdownHarnessSpecific(path, derived),
      });
    }
  }
}

function importMarkdownKind(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
  pattern: RegExp,
  spec: MarkdownSpec,
): void {
  for (const [path, value] of Object.entries(files)) {
    const match = pattern.exec(path);
    if (!match) continue;
    claimed.add(path);
    // OpenCode ids come from the path; nested segments keep their `/`.
    const derived = deriveMarkdown(path, toText(value), match[2], spec, warnings);
    if (spec.kind === 'hub-agent/1') {
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
    } else if (spec.kind === 'hub-command/1') {
      manifests.push({
        kind: 'hub-command/1',
        name: derived.neutral.name!,
        description: derived.neutral.description ?? '',
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
  for (const [path, value] of Object.entries(files)) {
    if (!CONFIG_FILE.test(path)) continue;
    claimed.add(path);
    const text = toText(value);
    if (text.trim() === '') {
      warnings.push({ code: 'EMPTY_CONFIG', path, detail: 'file is empty; no providers imported' });
      continue;
    }
    const record = parseJsoncFile(path, text, warnings);
    if (record === undefined) continue;
    const extraKeys = Object.keys(record).filter((key) => key !== 'mcp' && key !== 'commands');
    if (extraKeys.length > 0) {
      warnings.push({
        code: 'CONFIG_EXTRA_KEYS',
        path,
        detail: `keys not governed as hub primitives and dropped on export: ${extraKeys.join(', ')}`,
      });
    }
    const mcp = record.mcp;
    if (mcp !== undefined && (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp))) {
      warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'mcp is not an object; no providers imported' });
      continue;
    }
    const mcpRecord = (mcp ?? {}) as Record<string, unknown>;
    const mcpExtra = Object.keys(mcpRecord).filter((key) => key !== 'servers');
    if (mcpExtra.length > 0) {
      warnings.push({
        code: 'CONFIG_EXTRA_KEYS',
        path,
        detail: `mcp keys not governed as hub providers and dropped on export: ${mcpExtra.join(', ')}`,
      });
    }
    const servers = mcpRecord.servers;
    const serversValid = servers && typeof servers === 'object' && !Array.isArray(servers);
    const commands = record.commands;
    const commandsValid = commands && typeof commands === 'object' && !Array.isArray(commands);
    const serversEmpty = !serversValid || Object.keys(servers as Record<string, unknown>).length === 0;
    const commandsEmpty = !commandsValid || Object.keys(commands as Record<string, unknown>).length === 0;
    if (servers !== undefined && !serversValid) {
      warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'mcp.servers is not an object; no providers imported' });
    }
    if (commands !== undefined && !commandsValid) {
      warnings.push({ code: 'CONFIG_JSON_INVALID', path, detail: 'commands is not an object; no commands imported' });
    }
    if (serversEmpty && commandsEmpty) {
      warnings.push({ code: 'EMPTY_CONFIG', path, detail: 'no mcp.servers or commands entries; nothing imported' });
      continue;
    }
    const fileRef = { path, sha256: sha256Hex(value) };
    if (commandsValid && !commandsEmpty) {
      for (const [name, rawEntry] of Object.entries(commands as Record<string, unknown>)) {
        const entry = rawEntry as Record<string, unknown> | null;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.template !== 'string') {
          warnings.push({
            code: 'CONFIG_JSON_INVALID',
            path,
            detail: `commands.${name} has no template string; skipped`,
          });
          continue;
        }
        manifests.push({
          kind: 'hub-command/1',
          name,
          description: typeof entry.description === 'string' ? entry.description : '',
          sourceHarness: HARNESS,
          knownCompatible: [],
          files: [fileRef],
          harnessSpecific: { path, configKey: name },
        });
      }
    }
    if (serversEmpty) {
      checkCanonical(path, stripJsonc(text), record, [...extraKeys, ...mcpExtra], warnings);
      continue;
    }
    for (const [name, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        warnings.push({ code: 'PROVIDER_SHAPE_UNKNOWN', path, detail: `mcp.servers.${name} is not an object; skipped` });
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const type = typeof entry.type === 'string' ? entry.type : undefined;
      const hasCommand = Array.isArray(entry.command) && entry.command.length > 0;
      const hasUrl = typeof entry.url === 'string' && entry.url !== '';
      let transport: Transport | undefined;
      if (type === 'local') {
        if (!hasCommand || hasUrl) {
          warnings.push({
            code: 'PROVIDER_ENTRY_INVALID',
            path,
            detail: `mcp.servers.${name}: local entries require a command array and no url; the entry is skipped`,
          });
          continue;
        }
        transport = 'stdio';
        sanitizeCommandValue(entry.command, path, name, warnings, 'mcp.servers');
      } else if (type === 'remote') {
        if (!hasUrl || hasCommand) {
          warnings.push({
            code: 'PROVIDER_ENTRY_INVALID',
            path,
            detail: `mcp.servers.${name}: remote entries require a url and no command; the entry is skipped`,
          });
          continue;
        }
        transport = 'streamable-http';
      } else if (type === undefined) {
        warnings.push({
          code: 'PROVIDER_SHAPE_UNKNOWN',
          path,
          detail: `mcp.servers.${name} has no type key; transport left empty`,
        });
      } else {
        warnings.push({
          code: 'PROVIDER_TRANSPORT_UNKNOWN',
          path,
          detail: `mcp.servers.${name} type "${type}" has no hub-provider/1 transport; transport left empty`,
        });
      }
      if ('cwd' in entry) {
        warnings.push({
          code: 'PROVIDER_CWD_DROPPED',
          path,
          detail: `mcp.servers.${name} cwd is a machine-local directory and was removed from the manifest`,
        });
      }
      const shape = entrySkeleton(entry);
      const credentials = skeletonCredentials(shape);
      const stripped = skeletonStripped(shape, hasUrl ? 'url' : undefined);
      if (stripped.length > 0) {
        warnings.push({
          code: 'PROVIDER_VALUES_STRIPPED',
          path,
          detail: `mcp.servers.${name}: values kept out of the manifest (key names preserved): ${stripped.join(', ')}`,
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
        harnessSpecific: { filePath: path, server: name, shape },
      });
    }
    checkCanonical(path, stripJsonc(text), record, [...extraKeys, ...mcpExtra], warnings);
  }
}

export function importOpencode(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importSkills(files, manifests, warnings, claimed);
  importMarkdownKind(files, manifests, warnings, claimed, COMMAND_FILE, COMMAND_SPEC);
  importMarkdownKind(files, manifests, warnings, claimed, AGENT_FILE, AGENT_SPEC);
  importInstructions(files, manifests, warnings, claimed);
  importConfig(files, manifests, warnings, claimed);
  for (const path of Object.keys(files)) {
    if (!claimed.has(path)) {
      warnings.push({
        code: 'UNRECOGNIZED_FILE',
        path,
        detail: 'file matches no OpenCode primitive location and was not imported',
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

const MARKDOWN_SPECS: Partial<Record<string, MarkdownSpec>> = {
  'hub-skill/1': SKILL_SPEC,
  'hub-command/1': COMMAND_SPEC,
  'hub-agent/1': AGENT_SPEC,
  'hub-instruction/1': INSTRUCTION_SPEC,
};

function defaultNameFor(kind: string, path: string): string | undefined {
  if (kind === 'hub-skill/1') {
    const base = baseName(path);
    return base === 'SKILL.md' ? baseName(dirName(path)) : base.replace(/\.md$/, '');
  }
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

// The config file carries two governed sections — mcp.servers and
// commands.<name> — rebuilt together in the original top-level key order.
// Commands entries take template and extra keys from the original file;
// description is the one mapped field. Original entries without a manifest
// (skipped at import) are preserved verbatim.
function exportConfig(
  commands: HubCommand[],
  providers: HubProvider[],
  source: VirtualFiles,
  out: VirtualFiles,
  warnings: AdapterWarning[],
): void {
  const paths = new Set<string>();
  for (const command of commands) paths.add(manifestPath(command) || 'opencode.json');
  for (const provider of providers) paths.add(manifestPath(provider) || 'opencode.json');
  for (const path of paths) {
    const sourceText = source[path] === undefined ? undefined : toText(source[path]);
    const record = sourceText === undefined ? undefined : parseJsoncFile(path, sourceText, warnings);
    const sections: Record<string, unknown> = {};
    const fileProviders = providers.filter((provider) => (manifestPath(provider) || 'opencode.json') === path);
    if (fileProviders.length > 0) {
      const servers = record?.mcp;
      const originalServers =
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? ((servers as Record<string, unknown>).servers as Record<string, unknown> | undefined)
          : undefined;
      const mcpServers: Record<string, unknown> = {};
      for (const provider of fileProviders) {
        const specific = provider.harnessSpecific as { server?: unknown };
        const serverName = typeof specific.server === 'string' ? specific.server : provider.name;
        const original = originalServers?.[serverName];
        if (!original || typeof original !== 'object' || Array.isArray(original)) {
          warnings.push({
            code: 'SOURCE_FILE_MISSING',
            path,
            detail: `mcp.servers.${serverName}: entry not found in the export file table; provider ${provider.name} not exported`,
          });
          continue;
        }
        const { entry, missing } = rebuildProviderEntry(original as Record<string, unknown>, provider.name, path, 'mcp.servers', warnings);
        mcpServers[provider.name] = entry;
        if (missing.length > 0) {
          warnings.push({
            code: 'SECRET_PLACEHOLDER',
            path,
            detail: `mcp.servers.${provider.name}: stripped values written as ${REDACTED} placeholders, refill before use: ${missing.join(', ')}`,
          });
        }
      }
      if (Object.keys(mcpServers).length > 0) sections.mcp = { servers: mcpServers };
    }
    const fileCommands = commands.filter((command) => (manifestPath(command) || 'opencode.json') === path);
    if (fileCommands.length > 0) {
      const originalCommands =
        record?.commands && typeof record.commands === 'object' && !Array.isArray(record.commands)
          ? (record.commands as Record<string, unknown>)
          : undefined;
      const rebuiltCommands: Record<string, unknown> = {};
      const remaining = new Map(fileCommands.map((command) => [command.name, command]));
      if (originalCommands !== undefined) {
        for (const [name, originalEntry] of Object.entries(originalCommands)) {
          const command = remaining.get(name);
          remaining.delete(name);
          if (command === undefined) {
            rebuiltCommands[name] = originalEntry;
            continue;
          }
          const entry: Record<string, unknown> = {};
          if (originalEntry && typeof originalEntry === 'object' && !Array.isArray(originalEntry)) {
            for (const [key, value] of Object.entries(originalEntry as Record<string, unknown>)) {
              if (key !== 'description') entry[key] = value;
            }
          }
          if (command.description !== '') {
            entry.description = command.description;
            // Keep the original key order with description back in place.
            const ordered: Record<string, unknown> = {};
            let placed = false;
            for (const key of Object.keys(originalEntry as Record<string, unknown>)) {
              if (key === 'description') {
                ordered.description = command.description;
                placed = true;
              } else {
                ordered[key] = entry[key];
              }
            }
            if (!placed) ordered.description = command.description;
            rebuiltCommands[name] = ordered;
          } else {
            rebuiltCommands[name] = entry;
          }
        }
      }
      for (const [name] of remaining) {
        warnings.push({
          code: 'SOURCE_FILE_MISSING',
          path,
          detail: `commands.${name}: entry not found in the export file table; command not exported`,
        });
      }
      if (Object.keys(rebuiltCommands).length > 0) sections.commands = rebuiltCommands;
    }
    if (Object.keys(sections).length === 0) continue;
    let order: string[] = [];
    if (record !== undefined) {
      order = Object.keys(record).filter((key) => key in sections);
    }
    for (const key of ['mcp', 'commands']) {
      if (key in sections && !order.includes(key)) order.push(key);
    }
    const composed: Record<string, unknown> = {};
    for (const key of order) composed[key] = sections[key];
    out[path] = canonicalJson(composed);
  }
}

export function exportOpencode(manifests: HubManifest[], files: VirtualFiles): ExportResult {
  const source = normalizedFiles(files);
  const out: VirtualFiles = {};
  const warnings: AdapterWarning[] = [];
  const configCommands: HubCommand[] = [];
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
    // Config-backed commands (commands.<name>) rebuild the config section;
    // markdown commands rewrite frontmatter like any markdown primitive.
    if (valid.kind === 'hub-command/1' && typeof (valid.harnessSpecific as { configKey?: unknown }).configKey === 'string') {
      configCommands.push(valid);
      continue;
    }
    const spec = MARKDOWN_SPECS[valid.kind];
    if (spec !== undefined) {
      exportMarkdown(valid, spec, source, out, warnings);
    } else if (valid.kind === 'hub-provider/1') {
      providers.push(valid);
    } else {
      // hub-hook/1 included: OpenCode registers hooks from plugin code, so
      // there is no hooks file to write.
      warnings.push({
        code: 'NO_HARNESS_PROJECTION',
        path: manifestPath(valid),
        detail: `${valid.kind} has no file projection in OpenCode`,
      });
    }
  }
  exportConfig(configCommands, providers, source, out, warnings);
  return { files: out, warnings };
}
