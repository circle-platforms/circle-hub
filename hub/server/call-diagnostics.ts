import { PackId, PackVersion, RunId, Sha256 } from '../../contracts/src/common.ts';
import { ExternalObjectId, ReferenceUri } from '../../contracts/src/reference.ts';
import { argumentDigest, personalOwnerOf, recordExistence, scanForCredentials, type Principal } from '../records/api.ts';
import { parseReference } from '../refs/api.ts';
import type { ServerDeps } from './api.ts';
import { PUBLISHED } from './tools.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_BYTES = 1024;
const TRUNCATED = '…（已截断）';

function* originalCalls(tool: string, args: unknown): Generator<[string, Row]> {
  const pending: [string, unknown][] = [[tool, args]];
  while (pending.length) {
    const [name, value] = pending.pop()!;
    if (!object(value)) continue;
    yield [name, value];
    if (name === 'get_nodes' && object(value.call_query)) {
      for (const mode of ['start_run', 'get_nodes']) if (Object.hasOwn(value.call_query, mode)) pending.push([mode, value.call_query[mode]]);
    }
  }
}

function involvesPersonalSpace(tool: string, args: unknown): boolean {
  for (const [name, value] of originalCalls(tool, args)) {
    if (value.pack_space !== undefined && value.pack_space !== 'team' || value.space !== undefined && value.space !== 'team') return true;
    if (name === 'upload_file' && ['memory', 'memory_share', 'personal_entry', 'share_entry', 'withdraw_entry'].some(k => Object.hasOwn(value, k))) return true;
    if (name !== 'get_nodes') continue;
    if (Object.hasOwn(value, 'memory') || Object.hasOwn(value, 'search') && value.scope !== 'team') return true;
    if (!['run', 'root', 'reference', 'pack', 'search', 'space', 'call_query', 'observability'].some(k => Object.hasOwn(value, k))) return true;
  }
  return false;
}

function* boundObjects(name: string, args: Row): Generator<[string, unknown]> {
  if (name === 'get_nodes' || name === 'resolve_reference') yield ['record', args.root];
  if (name === 'get_nodes') yield ['reference', args.reference];
  if (name === 'get_nodes' || name === 'resolve_reference' || name === 'submit_result') yield ['run', args.run];
  if (name !== 'start_run') return;
  yield ['run', args.predecessor];
  if (!object(args.inputs)) return;
  for (const slot of Object.values(args.inputs)) {
    for (const binding of Array.isArray(slot) ? slot : [slot]) {
      if (!object(binding)) continue;
      yield ['reference', binding.reference];
      yield ['record', binding.artifact];
      yield ['run', binding.run];
    }
  }
}

type DiagnosticPorts = Pick<ServerDeps, 'records'> & { workflows: Pick<ServerDeps['workflows'], 'summaries'> };

export async function privateDiagnosticScope(deps: DiagnosticPorts, principal: Principal, tool: string, args: unknown): Promise<boolean> {
  if (involvesPersonalSpace(tool, args)) return true;
  const { store, artifacts } = deps.records;
  const seen = new Set<string>();
  for (const [name, call] of originalCalls(tool, args)) {
    if (name === 'list_task_packs') {
      const packs = await deps.workflows.summaries(principal);
      if (packs.some(pack => pack.space && pack.space !== 'team' && (call.pack_id === undefined || call.pack_id === pack.id))) return true;
    }
    for (const [kind, raw] of boundObjects(name, call)) {
      if (typeof raw !== 'string' || seen.has(kind + ':' + raw)) continue;
      seen.add(kind + ':' + raw);
      let digest = raw;
      if (kind === 'reference') {
        if (!ReferenceUri.safeParse(raw).success) continue;
        const ref = parseReference(raw);
        if (ref.scheme === 'src') {
          if ((await artifacts.records(ref.sha256)).some(record => personalOwnerOf(record) !== null)) return true;
          continue;
        }
        digest = ref.scheme === 'tree' ? ref.root : ref.scheme === 'rec' ? ref.record : ref.entry;
      }
      const record = kind === 'run' && RunId.safeParse(raw).success
        ? (await store.find({ kind: 'run', key: 'runs.id', value: raw, limit: 1 })).items[0]
        : Sha256.safeParse(digest).success ? await store.get(digest) : null;
      if (record && await recordExistence(store, principal.id, record) === 'neutral') return true;
    }
  }
  return false;
}

function summary(value: unknown): string {
  const { digest, size } = argumentDigest(value);
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const length = Array.isArray(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : size;
  return JSON.stringify({ type, length, sha256: digest.slice(0, 12) });
}

function identifier(tool: string, path: string[], value: string): boolean {
  const key = path.at(-1);
  if (path.length === 1) {
    if (key === 'pack' || key === 'pack_id') {
      const parts = value.split('@');
      return parts.length <= 2 && PackId.safeParse(parts[0]).success && (parts.length === 1 || PackVersion.safeParse(parts[1]).success);
    }
    if (tool === 'start_run' && (key === 'product' || key === 'version' || key === 'build')) return true;
  }
  if (key === 'reference') return ReferenceUri.safeParse(value).success;
  if (key === 'external') return ExternalObjectId.safeParse(value).success;
  return (key === 'run' || key === 'predecessor') && RunId.safeParse(value).success;
}

function schemaBranches(schema: unknown, root: Row): Row[] {
  if (!object(schema)) return [];
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/') && object(root.$defs)) {
    return schemaBranches(root.$defs[schema.$ref.slice('#/$defs/'.length)], root);
  }
  return Array.isArray(schema.anyOf) ? schema.anyOf.flatMap(branch => schemaBranches(branch, root)) : [schema];
}

function properties(schemas: Row[], key: string, root: Row): Row[] {
  return schemas.flatMap(schema => schemaBranches(
    object(schema.properties) && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties,
    root,
  ));
}

function argumentPreview(tool: string, args: unknown, personal: boolean): string | null {
  const root = PUBLISHED.get(tool)?.inputSchema ?? {};
  function* parts(value: unknown, path: string[], schemas: Row[]): Generator<string> {
    if (object(value)) {
      yield '{';
      let first = true;
      for (const key of Object.keys(value)) {
        yield (first ? '' : ',') + JSON.stringify(key) + ':';
        first = false;
        yield* parts(value[key], [...path, key], properties(schemas, key, root));
      }
      yield '}';
    } else if (Array.isArray(value) && schemas.some(schema => object(schema.items))) {
      const elements = schemas.flatMap(schema => schemaBranches(schema.items, root));
      yield '[';
      for (let index = 0; index < value.length; index++) {
        if (index) yield ',';
        yield* parts(value[index], [...path, String(index)], elements);
      }
      yield ']';
    } else if (schemas.some(schema => typeof value === 'boolean' && schema.type === 'boolean' ||
      typeof value === 'number' && (schema.type === 'number' || schema.type === 'integer') ||
      typeof value === 'string' && (schema.const === value || Array.isArray(schema.enum) && schema.enum.includes(value) || schema.type === 'string' && identifier(tool, path, value)))) {
      yield JSON.stringify(value);
    } else {
      yield summary(value);
    }
  }
  let text = '';
  let bytes = 0;
  const suffixBytes = Buffer.byteLength(TRUNCATED);
  let beforeSuffix = '';
  for (const part of parts(args, [], personal ? [] : [root])) {
    bytes += Buffer.byteLength(part);
    if (bytes > MAX_BYTES) {
      text = beforeSuffix + TRUNCATED;
      break;
    }
    text += part;
    if (bytes + suffixBytes <= MAX_BYTES) beforeSuffix = text;
  }
  return scanForCredentials(Buffer.from(text)).findings.length ? null : text;
}

export function rejectedDiagnostics(tool: string, args: unknown, returned: unknown, personal: boolean): string[] {
  const preview = argumentPreview(tool, args, personal);
  const notes = preview === null ? [] : ['参数预览 ' + preview];
  const errors = Array.isArray(returned) ? returned : [];
  for (const error of errors) {
    if (!object(error) || typeof error.code !== 'string' && typeof error.code !== 'number') continue;
    const fields: Row = { code: error.code };
    if (typeof error.path === 'string') fields.path = error.path;
    notes.push('调用错误 ' + JSON.stringify(fields));
  }
  return notes;
}
