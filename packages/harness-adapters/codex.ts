import type {
  AdapterWarning,
  ExportResult,
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
import { emitToml, parseToml } from './toml.ts';
import {
  dropCwd,
  placeholderShape,
  sanitizeArgs,
  stripValueMap,
  REDACTED,
  SECRET_MAP_KEYS,
} from './configs.ts';

const HARNESS = 'codex';
const CONFIG_PATH = '.codex/config.toml';
const INSTRUCTION_NAME = 'AGENTS.md';

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;

const INSTRUCTION_SPEC: MarkdownSpec = {
  kind: 'hub-instruction/1',
  fields: {},
  specific: {},
  frontmatterName: false,
};

function importInstructions(
  files: VirtualFiles,
  manifests: HubManifest[],
  warnings: AdapterWarning[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    if (path !== INSTRUCTION_NAME && !path.endsWith(`/${INSTRUCTION_NAME}`)) continue;
    claimed.add(path);
    const derived = deriveMarkdown(path, toText(value), undefined, INSTRUCTION_SPEC, warnings);
    manifests.push({
      kind: 'hub-instruction/1',
      scope: 'project',
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
  const extraKeys = Object.keys(parsed.values).filter((key) => key !== 'mcp_servers');
  if (extraKeys.length > 0) {
    warnings.push({
      code: 'CONFIG_EXTRA_KEYS',
      path: CONFIG_PATH,
      detail: `config.toml keys not governed as hub providers and dropped on export: ${extraKeys.join(', ')}`,
    });
  }
  const servers = parsed.values.mcp_servers;
  if (servers === undefined) return;
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
    const shape: Record<string, unknown> = structuredClone(rawEntry) as Record<string, unknown>;
    const stripped: string[] = [];
    const credentials: string[] = [];
    for (const key of SECRET_MAP_KEYS) {
      for (const name2 of stripValueMap(shape, key)) {
        if (key !== 'oauth') credentials.push(name2);
        stripped.push(`${key}.${name2}`);
      }
    }
    dropCwd(shape, CONFIG_PATH, name, warnings, 'mcp_servers');
    let transport: Transport | undefined;
    if (typeof shape.command === 'string') {
      transport = 'stdio';
      if (ABSOLUTE_PATH.test(shape.command)) {
        warnings.push({
          code: 'PROVIDER_COMMAND_ABSOLUTE',
          path: CONFIG_PATH,
          detail: `mcp_servers.${name} command is an absolute path; reduced to basename ${baseName(shape.command.replace(/\\/g, '/'))}`,
        });
        shape.command = baseName(shape.command.replace(/\\/g, '/'));
      }
      shape.args = sanitizeArgs(shape.args, CONFIG_PATH, name, warnings, 'mcp_servers');
    } else if (typeof shape.url === 'string') {
      transport = 'streamable-http';
      if (shape.url !== '') {
        stripped.push('url');
        shape.url = '';
      }
    } else {
      warnings.push({
        code: 'PROVIDER_SHAPE_UNKNOWN',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name} has neither command nor url; transport left empty`,
      });
    }
    if (stripped.length > 0) {
      warnings.push({
        code: 'PROVIDER_VALUES_STRIPPED',
        path: CONFIG_PATH,
        detail: `mcp_servers.${name}: values kept out of the manifest (names and shapes preserved): ${stripped.join(', ')}`,
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
      files: [fileRef],
      harnessSpecific: { filePath: CONFIG_PATH, shape },
    });
  }
}

export function importCodex(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importInstructions(files, manifests, warnings, claimed);
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

function exportInstruction(
  manifest: HubManifest,
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
      detail: 'hub-instruction/1 manifest points at a file that is not in the export file table; nothing exported',
    });
    return;
  }
  out[path] = exportMarkdownFile(manifest, INSTRUCTION_SPEC, undefined, toText(original), path);
}

function exportProviders(providers: HubProvider[], out: VirtualFiles, warnings: AdapterWarning[]): void {
  const byPath = new Map<string, HubProvider[]>();
  for (const provider of providers) {
    const specific = provider.harnessSpecific as { filePath?: unknown };
    const path = typeof specific.filePath === 'string' ? specific.filePath : CONFIG_PATH;
    const list = byPath.get(path) ?? [];
    list.push(provider);
    byPath.set(path, list);
  }
  for (const [path, list] of byPath) {
    const mcpServers: Record<string, unknown> = {};
    for (const provider of list) {
      const specific = provider.harnessSpecific as { shape?: unknown };
      if (!specific.shape || typeof specific.shape !== 'object' || Array.isArray(specific.shape)) {
        warnings.push({
          code: 'PROVIDER_SHAPE_UNKNOWN',
          path,
          detail: `provider ${provider.name} carries no harnessSpecific shape; not exported`,
        });
        continue;
      }
      const { out: shape, missing } = placeholderShape(specific.shape as Record<string, unknown>);
      mcpServers[provider.name] = shape;
      if (missing.length > 0) {
        warnings.push({
          code: 'SECRET_PLACEHOLDER',
          path,
          detail: `mcp_servers.${provider.name}: stripped values written as ${REDACTED} placeholders, refill before use: ${missing.join(', ')}`,
        });
      }
    }
    out[path] = emitToml({ mcp_servers: mcpServers });
  }
}

export function exportCodex(manifests: HubManifest[], files: VirtualFiles): ExportResult {
  const source = normalizedFiles(files);
  const out: VirtualFiles = {};
  const warnings: AdapterWarning[] = [];
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
      case 'hub-instruction/1':
        exportInstruction(valid, source, out, warnings);
        break;
      case 'hub-provider/1':
        providers.push(valid);
        break;
      default:
        warnings.push({
          code: 'NO_HARNESS_PROJECTION',
          path: manifestPath(valid),
          detail: `${valid.kind} has no file projection in the Codex adapter; only instructions and MCP servers are covered`,
        });
        break;
    }
  }
  exportProviders(providers, out, warnings);
  return { files: out, warnings };
}
