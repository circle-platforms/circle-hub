// Tiny synthetic system packs for connector tests, written into a temporary directory at test time (system.json plus the
// function modules of testing/functions), and a fake PacksPort that serves them. The systems are invented; they imitate the
// structures of the architecture brief, section 8.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { PackHandle, PacksPort, ProductHandle } from '../../ports.ts';

export const FUNCTIONS_DIR = new URL('./functions/', import.meta.url);

export interface SyntheticPack {
  id: string;
  version?: string;
  kind?: PackKind;
  /** system.json, written as given (so invalid profiles can be tested too). */
  system: unknown;
  /** Files of testing/functions copied to functions/ of the pack. */
  functions?: string[];
}

/** Writes the pack into `<root>/<id>-<version>/` and returns its handle; the digest covers every file. */
export async function writePack(root: string, pack: SyntheticPack): Promise<PackHandle> {
  const version = pack.version ?? '1.0.0';
  const directory = join(root, `${pack.id}-${version}`);
  await mkdir(join(directory, 'functions'), { recursive: true });
  const systemText = JSON.stringify(pack.system, null, 2);
  await writeFile(join(directory, 'system.json'), systemText);
  const hash = createHash('sha256').update(`${pack.id}@${version}\n`).update(systemText);
  for (const name of pack.functions ?? []) {
    await copyFile(new URL(name, FUNCTIONS_DIR), join(directory, 'functions', name));
    hash.update(name).update(await readFile(new URL(name, FUNCTIONS_DIR)));
  }
  return { id: pack.id, version, digest: hash.digest('hex'), kind: pack.kind ?? 'system', directory };
}

export interface FakePacks extends PacksPort {
  set(handle: PackHandle): void;
  remove(id: string): void;
  calls: string[];
}

/** A PacksPort over the given handles: `id` gives the newest version written, `id@version` that version. */
export function fakePacks(handles: PackHandle[] = []): FakePacks {
  const byRef = new Map<string, PackHandle>();
  const calls: string[] = [];
  const set = (handle: PackHandle) => {
    byRef.set(`${handle.id}@${handle.version}`, handle);
    byRef.set(handle.id, handle);
  };
  handles.forEach(set);
  return {
    calls,
    set,
    remove(id: string) {
      for (const key of [...byRef.keys()]) if (key === id || key.startsWith(`${id}@`)) byRef.delete(key);
    },
    async pack(ref: string) {
      calls.push(ref);
      return byRef.get(ref) ?? null;
    },
    async productByName(): Promise<ProductHandle | null> {
      return null;
    },
    async productById(): Promise<ProductHandle | null> {
      return null;
    },
    async products(): Promise<ProductHandle[]> {
      return [];
    },
    async readableProducts() {
      return new Set<string>();
    },
  };
}

const idBody = (key: string, items = false) =>
  items
    ? {
        type: 'object',
        properties: { [key]: { type: 'array', items: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', maxLength: 12, pattern: '^[0-9]{1,12}$' }] }, minItems: 1, maxItems: 100 } },
        required: [key],
        additionalProperties: false,
      }
    : { type: 'object', properties: { [key]: { type: 'string', maxLength: 40, pattern: '^[0-9a-z]{1,40}$' } }, required: [key], additionalProperties: false };

const tokenLogin = (role: string) => ({
  kind: 'login_token',
  header: { name: 'Authorization', scheme: 'raw' },
  roles: [] as string[],
  credentials: [
    { name: 'username', digest: 'plain' },
    { name: 'password', digest: 'sha512_base64' },
  ],
  login: {
    role,
    method: 'POST',
    path: '/oauth/login/',
    body: { username: '{username}', password: '{password}' },
    token: '/data/token',
    expiry: { pointer: '/data/expire', unit: 'epoch_seconds' },
    envelope: { code: '/code', ok: [1000], message: '/msg' },
  },
});

const ENVELOPE = { code: '/code', ok: [1000], expired: [1001], message: '/msg' };

/** The agile-like system: login token, envelope routes (POST reads), trees and mind maps. */
export function agileSystem(): Record<string, unknown> {
  return {
    schema: 'system@1',
    title: '合成敏捷测试平台',
    roles: [{ name: 'agile-oauth' }, { name: 'agile-api' }],
    auth: { ...tokenLogin('agile-oauth'), roles: ['agile-api'] },
    envelope: ENVELOPE,
    routes: [
      {
        id: 'roots',
        role: 'agile-api',
        method: 'POST',
        path: '/agile/get_root_node/',
        body: { type: 'object', properties: { page: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['page'], additionalProperties: false },
        response: 'json',
        envelope: true,
        max_bytes: 1024 * 1024,
        read: true,
      },
      { id: 'subtree', role: 'agile-api', method: 'POST', path: '/agile/get_child_node_task/', body: idBody('id'), response: 'json', envelope: true, max_bytes: 16 * 1024 * 1024, read: true },
      { id: 'case-data', role: 'agile-api', method: 'POST', path: '/agile/get_case_data/', body: idBody('id'), response: 'json', envelope: true, max_bytes: 16 * 1024 * 1024, read: true },
    ],
    reads: [
      { name: 'tree', external: 'agile:tree', plan: { module: 'functions/agile-tree-plan.ts' }, project: { module: 'functions/agile-tree-project.ts' } },
      { name: 'mindmap', external: 'agile:mindmap', plan: { module: 'functions/agile-mindmap-plan.ts' }, project: { module: 'functions/agile-mindmap-project.ts' } },
    ],
  };
}
export const AGILE_FUNCTIONS = ['agile-tree-plan.ts', 'agile-tree-project.ts', 'agile-mindmap-plan.ts', 'agile-mindmap-project.ts'];

/** The PLM-like system: the same login, reads by GET and POST, a plain-array answer; the write route is NOT listed. */
export function plmSystem(): Record<string, unknown> {
  const read = (name: string, external: string, plan: string, project = true) => ({
    name,
    external,
    plan: { module: 'functions/plm.ts', export: plan },
    ...(project ? { project: { module: 'functions/plm.ts', export: 'project' } } : {}),
  });
  return {
    schema: 'system@1',
    title: '合成 PLM 查询服务',
    roles: [{ name: 'plm-oauth' }, { name: 'plm-api' }],
    auth: { ...tokenLogin('plm-oauth'), roles: ['plm-api'] },
    envelope: ENVELOPE,
    routes: [
      { id: 'products', role: 'plm-api', method: 'GET', path: '/plmquery/product/all/', response: 'json', envelope: true, max_bytes: 1024 * 1024, read: true },
      {
        id: 'builds',
        role: 'plm-api',
        method: 'GET',
        path: '/plmquery/build/',
        query: { type: 'object', properties: { product: { type: 'string', maxLength: 9, pattern: '^[0-9]{1,9}$' } }, required: ['product'], additionalProperties: false },
        response: 'json',
        max_bytes: 8 * 1024 * 1024,
        read: true,
      },
      { id: 'bug-detail', role: 'plm-api', method: 'POST', path: '/plmquery/bug/detail/', body: idBody('bug_ids', true), response: 'json', envelope: true, max_bytes: 8 * 1024 * 1024, read: true },
      { id: 'story-detail', role: 'plm-api', method: 'POST', path: '/plmquery/story/detail/', body: idBody('story_ids', true), response: 'json', envelope: true, max_bytes: 8 * 1024 * 1024, read: true },
    ],
    reads: [
      read('bug', 'plm:bug', 'bugPlan'),
      read('story', 'plm:story', 'storyPlan'),
      { name: 'builds', external: 'plm:builds', request: { route: 'builds', query: { product: '{id}' } } },
      { name: 'products', external: 'plm:products', request: { route: 'products' } },
      read('evil-route', 'plm:evil-route', 'evilRoute', false),
      read('evil-path', 'plm:evil-path', 'evilPath', false),
      read('evil-body', 'plm:evil-body', 'evilBody', false),
      read('evil-href', 'plm:evil-href', 'evilHref', false),
      read('evil-dots', 'plm:evil-dots', 'evilDots', false),
      read('loop', 'plm:loop', 'loop', false),
      read('broken', 'plm:broken', 'broken', false),
      read('throws', 'plm:throws', 'throws', false),
    ],
  };
}
export const PLM_FUNCTIONS = ['plm.ts'];

/** The build-site-like system: anonymous plain HTTP, HTML pages parsed with html@1, command tree files. */
export function buildSiteSystem(): Record<string, unknown> {
  return {
    schema: 'system@1',
    title: '合成构建站',
    roles: [{ name: 'build-site' }],
    auth: { kind: 'none' },
    routes: [
      { id: 'page', role: 'build-site', method: 'GET', path: '/{page}', response: 'html', parse: 'html@1', max_bytes: 4 * 1024 * 1024, read: true },
      { id: 'tree-file', role: 'build-site', method: 'GET', path: '/builds/{build}/{file}', response: 'xml', max_bytes: 4 * 1024 * 1024, read: true },
    ],
    reads: [
      { name: 'listing', external: 'buildsite:listing', request: { route: 'page', params: { page: '{id}' } } },
      { name: 'command-tree', external: 'buildsite:command-tree', request: { route: 'tree-file', params: { build: '{id}', file: 'command_tree-{id}.xml' } } },
      { name: 'hub', external: 'buildsite:hub', plan: { module: 'functions/buildsite.ts', export: 'hubPlan' }, project: { module: 'functions/buildsite.ts', export: 'hubProject' } },
    ],
  };
}
export const BUILDSITE_FUNCTIONS = ['buildsite.ts'];

/** The WebDAV-like document store: PROPFIND Depth 1 on collections (trailing slash), GET of files. */
export function docStoreSystem(): Record<string, unknown> {
  return {
    schema: 'system@1',
    title: '合成手册库',
    roles: [{ name: 'manual-store' }],
    auth: { kind: 'none' },
    routes: [
      { id: 'list', role: 'manual-store', method: 'PROPFIND', path: '/{path*}/', headers: { Depth: '1' }, response: 'xml', parse: 'xml@1', max_bytes: 4 * 1024 * 1024, read: true },
      { id: 'file', role: 'manual-store', method: 'GET', path: '/{path*}', response: 'text', max_bytes: 8 * 1024 * 1024, read: true },
    ],
    reads: [
      { name: 'file', external: 'manual:file', request: { route: 'file', params: { path: '{id}' } } },
      { name: 'spec-search', external: 'manual:spec-search', plan: { module: 'functions/docstore.ts', export: 'searchPlan' }, project: { module: 'functions/docstore.ts', export: 'searchProject' } },
      { name: 'climb', external: 'manual:climb', plan: { module: 'functions/docstore.ts', export: 'climb' } },
      { name: 'broken-projection', external: 'manual:broken', request: { route: 'file', params: { path: '{id}' } }, project: { module: 'functions/docstore.ts', export: 'projectThrows' } },
      { name: 'revision', external: 'manual:rev', request: { route: 'file', params: { path: '{id}' } }, project: { module: 'functions/docstore.ts', export: 'fixedRevision' } },
      { name: 'bad-revision', external: 'manual:badrev', request: { route: 'file', params: { path: '{id}' } }, project: { module: 'functions/docstore.ts', export: 'badRevision' } },
      { name: 'bad-media', external: 'manual:badmedia', request: { route: 'file', params: { path: '{id}' } }, project: { module: 'functions/docstore.ts', export: 'badMediaType' } },
      { name: 'many', external: 'manual:many', plan: { module: 'functions/docstore.ts', export: 'manyRequests' } },
      { name: 'small', external: 'manual:small', request: { route: 'file', params: { path: '{id}' } }, max_bytes: 10 },
      { name: 'rows', external: 'manual:rows', request: { route: 'file', params: { path: '{id}' } }, project: { module: 'functions/docstore.ts', export: 'tableRows' } },
      { name: 'climb-semicolon', external: 'manual:climb-semicolon', plan: { module: 'functions/docstore.ts', export: 'climbSemicolon' } },
      { name: 'long-path', external: 'manual:long-path', plan: { module: 'functions/docstore.ts', export: 'longPath' } },
      { name: 'echo-path', external: 'manual:echo-path', plan: { module: 'functions/docstore.ts', export: 'echoPath' } },
    ],
  };
}
export const DOCSTORE_FUNCTIONS = ['docstore.ts'];

/**
 * The document store behind a static header credential (an API key sent as `X-Api-Key: Bearer <key>`). Its {path*} routes
 * carry the credential, so each path segment is held to a pattern.
 */
export function keyedStoreSystem(): Record<string, unknown> {
  const base = docStoreSystem() as { routes: Record<string, unknown>[] };
  return {
    ...base,
    title: '合成带密钥的手册库',
    auth: { kind: 'static_header', header: { name: 'X-Api-Key', scheme: 'bearer' }, roles: ['manual-store'], credential: 'token' },
    routes: base.routes.map((route) => ({ ...route, params: { path: { type: 'string', maxLength: 255, pattern: '^[^;]{1,255}$' } } })),
  };
}
