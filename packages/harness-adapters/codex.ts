import type {
  AdapterWarning,
  ExportResult,
  HubInstruction,
  HubManifest,
  HubProvider,
  ImportResult,
  Transport,
  VirtualFiles,
} from './neutral.ts';
import { hubManifestSchema } from './neutral.ts';
import type { StoredFile } from './files.ts';
import { baseName, dirName, normalizedFiles, readStored, storeFile, toText } from './files.ts';
import { emitToml, parseToml } from './toml.ts';

const HARNESS = 'codex';
const CONFIG_PATH = '.codex/config.toml';
const INSTRUCTION_NAME = 'AGENTS.md';

const ABSOLUTE_PATH = /^([/~]|[A-Za-z]:[\\/])/;
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const REDACTED = '[redacted]';

// Keys whose values may hold secrets; only the key names survive import.
const SECRET_MAP_KEYS = ['env', 'headers', 'http_headers'];

function importInstructions(
  files: VirtualFiles,
  manifests: HubManifest[],
  claimed: Set<string>,
): void {
  for (const [path, value] of Object.entries(files)) {
    if (path !== INSTRUCTION_NAME && !path.endsWith(`/${INSTRUCTION_NAME}`)) continue;
    claimed.add(path);
    const directory = dirName(path);
    manifests.push({
      kind: 'hub-instruction/1',
      scope: 'project',
      applies: directory === '' ? [] : [directory],
      fileName: INSTRUCTION_NAME,
      sourceHarness: HARNESS,
      knownCompatible: [],
      harnessSpecific: { path, source: storeFile(value) },
    });
  }
}

function stripValueMap(entry: Record<string, unknown>, key: string): string[] {
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
        detail: `mcp_servers.${server} args[${index}] is an absolute path or endpoint and was replaced with ${REDACTED}`,
      });
      return REDACTED;
    }
    return arg;
  });
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
      detail: `line ${badLine.line} is outside the supported TOML subset and was skipped: ${JSON.stringify(badLine.text)}`,
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
        credentials.push(name2);
        stripped.push(`${key}.${name2}`);
      }
    }
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
      shape.args = sanitizeArgs(shape.args, CONFIG_PATH, name, warnings);
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
      harnessSpecific: { filePath: CONFIG_PATH, shape },
    });
  }
}

export function importCodex(input: VirtualFiles): ImportResult {
  const files = normalizedFiles(input);
  const manifests: HubManifest[] = [];
  const warnings: AdapterWarning[] = [];
  const claimed = new Set<string>();
  importInstructions(files, manifests, claimed);
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

function exportInstruction(manifest: HubInstruction, files: VirtualFiles, warnings: AdapterWarning[]): void {
  const specific = manifest.harnessSpecific as { path?: unknown; source?: unknown };
  const source = specific.source as StoredFile | undefined;
  const sourceOk =
    typeof source === 'string' ||
    (source !== null && typeof source === 'object' && typeof (source as { base64?: unknown }).base64 === 'string');
  if (typeof specific.path !== 'string' || !sourceOk) {
    warnings.push({
      code: 'MANIFEST_INVALID',
      path: manifestPath(manifest),
      detail: 'hub-instruction/1 manifest carries no harnessSpecific source bytes; nothing exported',
    });
    return;
  }
  files[specific.path] = readStored(source as StoredFile);
}

function exportProviders(providers: HubProvider[], files: VirtualFiles, warnings: AdapterWarning[]): void {
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
      const shape = specific.shape as Record<string, unknown>;
      mcpServers[provider.name] = shape;
      const missing: string[] = [];
      for (const key of SECRET_MAP_KEYS) {
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
          detail: `mcp_servers.${provider.name}: values were stripped at import and must be refilled before use: ${missing.join(', ')}`,
        });
      }
    }
    files[path] = emitToml({ mcp_servers: mcpServers });
  }
}

export function exportCodex(manifests: HubManifest[]): ExportResult {
  const files: VirtualFiles = {};
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
        exportInstruction(valid, files, warnings);
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
  exportProviders(providers, files, warnings);
  return { files, warnings };
}
