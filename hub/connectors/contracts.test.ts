// The shapes of contracts/src/resources.ts: system@1 (profiles of the synthetic packs, and every refinement), resource@1,
// the read function inputs and outputs, path templates, linear patterns, and that every registered shape is representable
// in JSON Schema (the generator publishes them).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  DerivedArtifact,
  PlannedRequest,
  ReadProjectionOutput,
  ResourceRecord,
  Shape,
  SystemProfile,
  baseUrlProblem,
  parsePathTemplate,
  schemas,
  simplePatternProblem,
} from '../../contracts/src/resources.ts';
import { agileSystem, buildSiteSystem, docStoreSystem, keyedStoreSystem, plmSystem } from './testing/packs.ts';

const clone = <T>(value: T): T => structuredClone(value);
const problems = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((issue) => `/${issue.path.map(String).join('/')}: ${issue.message}`);

test('the synthetic system profiles are valid system@1', () => {
  for (const profile of [agileSystem(), plmSystem(), buildSiteSystem(), docStoreSystem()]) {
    assert.deepEqual(problems(SystemProfile.safeParse(profile)), []);
  }
});

test('every route is a read: a route without read: true is refused', () => {
  const p = clone(plmSystem()) as { routes: Record<string, unknown>[] };
  delete p.routes[0].read;
  assert.equal(SystemProfile.safeParse(p).success, false);
  (p.routes[0] as Record<string, unknown>).read = false;
  assert.equal(SystemProfile.safeParse(p).success, false);
});

test('system@1 refinements: each mistake is reported with its path', () => {
  const cases: [string, (p: any) => void, RegExp][] = [
    ['duplicate route id', (p) => p.routes.push({ ...p.routes[0] }), /route products is declared twice/],
    ['unknown role', (p) => (p.routes[0].role = 'nobody'), /role nobody is not declared/],
    ['GET with a body', (p) => (p.routes[0].body = { type: 'null' }), /GET route has no body/],
    ['envelope without a profile envelope', (p) => delete p.envelope, /declares no envelope/],
    ['reserved header', (p) => (p.routes[0].headers = { Cookie: 'x' }), /set by the transport/],
    ['credential header as fixed header', (p) => (p.routes[0].headers = { authorization: 'x' }), /set by the transport/],
    ['query of non-strings', (p) => (p.routes[1].query = { type: 'object', properties: { product: { type: 'integer' } }, additionalProperties: false }), /properties are strings/],
    ['empty segment', (p) => (p.routes[0].path = '/a//b'), /no empty segment/],
    ['parameter twice', (p) => (p.routes[0].path = '/{x}/{x}'), /appears twice/],
    ['rest parameter not last', (p) => (p.routes[0].path = '/{p*}/x'), /must be the last segment/],
    ['dot segment', (p) => (p.routes[0].path = '/a/../b'), /not a literal path segment/],
    ['unknown credential in the login body', (p) => (p.auth.login.body = { user: '{account}' }), /\{account\} is not a declared credential/],
    ['login path with parameters', (p) => (p.auth.login.path = '/login/{x}'), /no parameters/],
    ['plan and request together', (p) => (p.reads[2].plan = { module: 'functions/plm.ts' }), /not both and not neither/],
    ['request filling other parameters', (p) => (p.reads[2].request = { route: 'builds', params: { x: '{id}' } }), /exactly the parameters/],
    ['request body for a route without one', (p) => (p.reads[3].request = { route: 'products', body: { a: 1 } }), /takes no body/],
    ['one type served twice', (p) => (p.reads[1].external = 'plm:bug'), /served by two reads/],
    ['two routes, same method and path', (p) => p.routes.push({ ...p.routes[0], id: 'products-again' }), /two routes of plm-api are GET/],
    ['reserved credential name', (p) => (p.auth.credentials[0].name = 'session'), /reserved/],
    ['parse on a JSON route', (p) => (p.routes[0].parse = 'xml@1'), /parse is for text/],
  ];
  for (const [name, change, expected] of cases) {
    const profile = clone(plmSystem());
    change(profile);
    const found = problems(SystemProfile.safeParse(profile));
    assert.ok(found.some((problem) => expected.test(problem)), `${name}: ${found.join(' | ') || 'accepted'}`);
  }
});

test('routes are allow-listed one by one: literal POST paths, parameters on GET and PROPFIND, patterned rest parameters with a credential', () => {
  const body = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false };
  const cases: [string, (p: any) => void, RegExp][] = [
    ['POST with a parameter', (p) => (p.routes[2].path = '/plmquery/{what}/detail/'), /POST route has a literal path/],
    ['POST with a rest parameter', (p) => p.routes.push({ id: 'details', role: 'plm-api', method: 'POST', path: '/plmquery/{what*}/', body, response: 'json', max_bytes: 10, read: true }), /POST route has a literal path/],
    ['rest parameter on a role that carries the credential, without a segment pattern', (p) => p.routes.push({ id: 'files', role: 'plm-api', method: 'GET', path: '/files/{path*}', response: 'text', max_bytes: 10, read: true }), /segment pattern/],
    ['segment pattern for a name the template lacks', (p) => (p.routes[0].params = { x: { type: 'string', maxLength: 3, pattern: '^[a-z]{1,3}$' } }), /not a parameter/],
    ['segment shape that is not a string', (p) => p.routes.push({ id: 'files', role: 'plm-api', method: 'GET', path: '/files/{path*}', params: { path: { type: 'integer' } }, response: 'text', max_bytes: 10, read: true }), /string shape/],
    ['the login exchange as a read route', (p) => p.routes.push({ id: 'login-again', role: 'plm-oauth', method: 'POST', path: '/oauth/login/', body, response: 'json', max_bytes: 10, read: true }), /login/],
    ['a template of the login role that reaches the login path', (p) => p.routes.push({ id: 'login-get', role: 'plm-oauth', method: 'GET', path: '/OAuth/{step}', response: 'json', max_bytes: 10, read: true }), /login/],
    ['when_present on a text answer', (p) => p.routes.push({ id: 'texty', role: 'plm-api', method: 'GET', path: '/texty/', response: 'text', envelope: 'when_present', max_bytes: 10, read: true }), /only a JSON answer/],
    ['an envelope mode that does not exist', (p) => (p.routes[0].envelope = 'sometimes'), /envelope/],
  ];
  for (const header of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override', 'X-Original-URL', 'X-Rewrite-URL', 'Forwarded', 'X-Forwarded-Host', 'X-Forwarded-For', 'Range', 'Destination']) {
    cases.push([`fixed header ${header}`, (p) => (p.routes[0].headers = { [header]: 'x' }), /set by the transport/]);
  }
  for (const name of ['_method', 'X-HTTP-Method-Override']) {
    cases.push([`body member ${name}`, (p) => (p.routes[2].body = { type: 'object', properties: { bug_ids: { type: 'array', items: { type: 'integer' }, maxItems: 5 }, [name]: { type: 'string', maxLength: 10 } }, additionalProperties: false }), /method override/]);
    cases.push([`query member ${name}`, (p) => (p.routes[1].query = { type: 'object', properties: { product: { type: 'string', maxLength: 9 }, [name]: { type: 'string', maxLength: 10 } }, additionalProperties: false }), /method override/]);
  }
  for (const [name, change, expected] of cases) {
    const profile = clone(plmSystem());
    change(profile);
    const found = problems(SystemProfile.safeParse(profile));
    assert.ok(found.some((problem) => expected.test(problem)), `${name}: ${found.join(' | ') || 'accepted'}`);
  }
  // Allowed: GET parameters, PROPFIND rest parameters of an anonymous role, patterned rest parameters with a credential.
  assert.deepEqual(problems(SystemProfile.safeParse(docStoreSystem())), []);
  assert.deepEqual(problems(SystemProfile.safeParse(keyedStoreSystem())), []);
  const present = clone(plmSystem()) as { routes: Record<string, unknown>[] };
  present.routes[1].envelope = 'when_present';
  assert.deepEqual(problems(SystemProfile.safeParse(present)), []);
  // Another role reaches the login path only when the deployment gives both roles one base URL: the transport refuses that
  // request by its URL (http.test.ts), the profile does not forbid the template.
  const otherRole = clone(plmSystem()) as { routes: Record<string, unknown>[] };
  otherRole.routes.push({ id: 'pages', role: 'plm-api', method: 'GET', path: '/oauth/{step}/', response: 'json', max_bytes: 10, read: true });
  assert.deepEqual(problems(SystemProfile.safeParse(otherRole)), []);
});

test('shapes are closed and bounded, and their patterns linear', () => {
  const ok = (shape: unknown) => Shape.safeParse(shape).success;
  assert.equal(ok({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } }, additionalProperties: false }), true);
  assert.equal(ok({ type: 'object', properties: {} }), false, 'an open object');
  assert.equal(ok({ type: 'object', additionalProperties: true }), false, 'an open object');
  assert.equal(ok({ type: 'array', items: { type: 'null' } }), false, 'an unbounded array');
  assert.equal(ok({ type: 'string' }), false, 'an unbounded string');
  assert.equal(ok({ type: 'string', maxLength: 5, minLength: 6 }), false);
  assert.equal(ok({ type: 'object', properties: {}, required: ['x'], additionalProperties: false }), false, 'required but not a property');
  assert.equal(ok({ type: 'string', maxLength: 9, pattern: '^[0-9]{1,9}$' }), true);
  assert.equal(ok({ type: 'string', maxLength: 9, pattern: '(a+)+$' }), false);
  assert.equal(ok({ anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 3 }] }), true);
  assert.equal(ok({ type: 'string', maxLength: 3, format: 'email' }), false, 'no unknown keyword');
});

test('linear patterns: one class with one quantifier, anchored', () => {
  for (const pattern of ['^[0-9]+$', '^[0-9a-z]{1,40}$', '^Rel_[A-Za-z0-9_]+$', '^[^/]{1,200}$', '^[A-Za-z0-9_.\\-]*$', '^[\\]\\[]{2}$']) {
    assert.equal(simplePatternProblem(pattern), null, pattern);
  }
  for (const pattern of ['(a+)+$', '^[a-z]+[a-z]+$', '^(x|y)$', '^(?=a)[a-z]+$', '[0-9]+', '^[0-9]+', '^a+$', '^[z-a]+$', `^[a]{1}${'$'.repeat(2)}`, '^[\\d]+$']) {
    assert.notEqual(simplePatternProblem(pattern), null, pattern);
  }
});

test('path templates', () => {
  assert.deepEqual(parsePathTemplate('/'), { parts: [], trailingSlash: false });
  assert.deepEqual(parsePathTemplate('/a/{b}/c/'), { parts: [{ literal: 'a' }, { param: 'b', rest: false }, { literal: 'c' }], trailingSlash: true });
  assert.deepEqual(parsePathTemplate('/{path*}/'), { parts: [{ param: 'path', rest: true }], trailingSlash: true });
  assert.deepEqual(parsePathTemplate('/okm:root/a%20b'), { parts: [{ literal: 'okm:root' }, { literal: 'a%20b' }], trailingSlash: false });
  for (const bad of ['', 'a', '/a b', '/{B}', '/{a}{b}', '/x?y', '/x#y', '/%zz', '//']) assert.throws(() => parsePathTemplate(bad), Error, bad);
});

const resource = {
  schema: 'resource@1',
  id: 'res_01jacd5z8q3w7v9h2k4m6n8p0t',
  system_pack: 'plm-test@1.0.0',
  system_pack_digest: 'a'.repeat(64),
  name: '合成 PLM',
  environment: 'test',
  origins: { 'plm-api': 'http://192.0.2.10:8080', 'plm-oauth': 'https://192.0.2.11/base' },
  allow_plaintext: ['http://192.0.2.10:8080'],
  credentials: { username: 'connector.res_01jacd5z8q3w7v9h2k4m6n8p0t.username' },
  credential_digests: { username: 'plain' },
  settings: { roots: ['7714'] },
  created_by: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t',
  created_at: '2026-10-22T08:00:00.000Z',
};

test('resource@1: the exact system pack version and digest, and the digest rule of every credential', () => {
  assert.deepEqual(problems(ResourceRecord.safeParse(resource)), []);
  assert.equal(ResourceRecord.safeParse({ ...resource, system_pack: 'plm-test' }).success, false, 'a version is bound, never "the latest"');
  assert.equal(ResourceRecord.safeParse({ ...resource, system_pack_digest: 'x' }).success, false);
  assert.equal(ResourceRecord.safeParse({ ...resource, credential_digests: {} }).success, false, 'a rule for every credential');
  assert.equal(ResourceRecord.safeParse({ ...resource, credential_digests: { username: 'plain', password: 'plain' } }).success, false, 'no rule without a credential');
  assert.equal(ResourceRecord.safeParse({ ...resource, credential_digests: { username: 'rot13' } }).success, false);
});

test('resource@1: base URLs and plaintext declarations', () => {
  assert.deepEqual(problems(ResourceRecord.safeParse(resource)), []);
  for (const url of ['http://192.0.2.10:8080/', ["http:/","/user:","pw@192",".0.2.1","0"].join(''), 'http://192.0.2.10/?q=1', 'ftp://192.0.2.10', 'HTTP://192.0.2.10', 'http://192.0.2.10:80', 'not a url']) {
    assert.notEqual(baseUrlProblem(url), null, url);
    assert.equal(ResourceRecord.safeParse({ ...resource, origins: { ...resource.origins, 'plm-api': url } }).success, false, url);
  }
  assert.equal(baseUrlProblem('http://192.0.2.10/OpenStore/webdav/root:a'), null);
  assert.equal(ResourceRecord.safeParse({ ...resource, allow_plaintext: ['http://192.0.2.99'] }).success, false, 'not one of the origins');
  assert.equal(ResourceRecord.safeParse({ ...resource, allow_plaintext: ['https://192.0.2.11'] }).success, false, 'an https origin is not plaintext');
  assert.equal(ResourceRecord.safeParse({ ...resource, environment: 'staging' }).success, false, 'environment from the vocabulary only');
  assert.equal(ResourceRecord.safeParse({ ...resource, settings: { big: 'x'.repeat(70_000) } }).success, false, 'settings are small');
  assert.equal(ResourceRecord.safeParse({ ...resource, password: 'x' }).success, false, 'closed');
});

test('planned requests and derived artifacts have one form each', () => {
  assert.equal(PlannedRequest.safeParse({ key: 'a', route: 'r', params: { x: 'y' }, path: '/x' }).success, false);
  assert.equal(PlannedRequest.safeParse({ key: 'a', route: 'r', against: 'b' }).success, false);
  assert.equal(PlannedRequest.safeParse({ key: 'a', route: 'r', href: 'x.html', against: 'b' }).success, true);
  assert.equal(PlannedRequest.safeParse({ key: '-a', route: 'r' }).success, false);
  assert.equal(DerivedArtifact.safeParse({ name: 'content', media_type: 'application/json', text: '{}', json: {} }).success, false);
  assert.equal(DerivedArtifact.safeParse({ name: 'content', media_type: 'application/json' }).success, false);
  assert.equal(DerivedArtifact.safeParse({ name: 'original', media_type: 'text/plain', text: 'x' }).success, false, 'original names the response');
  assert.equal(ReadProjectionOutput.safeParse({ error: { code: 'x.y', message: 'm' } }).success, true);
  assert.equal(ReadProjectionOutput.safeParse({ artifacts: [], extra: 1 }).success, false);
});

test('every registered connectors shape is representable in JSON Schema 2020-12', () => {
  for (const [id, schema] of Object.entries(schemas)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }) as Record<string, unknown>;
    assert.equal(typeof json, 'object', id);
  }
  assert.deepEqual(Object.keys(schemas).sort(), ['effect@1', 'executor@1', 'read-manifest@1', 'read-plan-input@1', 'read-plan-output@1', 'read-projection-input@1', 'read-projection-output@1', 'resource@1', 'system@1', 'write-declaration@1']);
});
