// Shapes owned by the connectors work package (D01, D02, D03 read part, D07 resources, B02 provenance, B05 read actions).
// - system@1: the system pack profile (system.json): roles, authentication, the route allow-list and the reads with their
//   planner and projection functions. Product dialect stays in the pack's functions and settings, never in the core.
// - resource@1: a deployment instance of a system (admin-managed, never in Git): base URL per role, the origins allowed to
//   carry credentials over plain HTTP, the vault entry names of its credentials and non-secret settings.
// - read-manifest@1: the action record of one read (B05): what was requested, through which routes, when, the digests of
//   every response and derived artifact, and the coverage the Hub computed.
// - read-plan-*@1, read-projection-*@1: inputs and outputs of the planner and projection functions of a system pack.
// The closed sets below (HTTP methods, response kinds, authentication kinds, password digest rules, header schemes, expiry
// units) are not vocabulary axes of the model; the connectors README lists them as a deviation awaiting axes.
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY.
import { z } from 'zod';
import { ActionKindSchema, ActionResultSchema, EnvironmentSchema, REFERENCE_SCHEME } from '../generated/vocabulary.ts';
import { Coverage, idOf, IsoTime, JsonPointer, PackId, PackVersion, RunId, Sha256, UserId, Versioned } from './common.ts';
import { PackFunctionRef } from './product.ts';
import { ExternalObjectId } from './reference.ts';

// ---------------------------------------------------------------- closed sets and limits

export const HTTP_METHODS = ['GET', 'POST', 'PROPFIND'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const RESPONSE_KINDS = ['json', 'text', 'xml', 'html', 'bytes'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];
export const AUTH_KINDS = ['none', 'static_header', 'login_token'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
/** How a credential is kept in the vault and sent: as given, or Base64(SHA-512(UTF-8 of the value)). */
export const DIGEST_RULES = ['plain', 'sha512_base64'] as const;
export type DigestRule = (typeof DIGEST_RULES)[number];
/** raw: the header value is the token itself; bearer: `Bearer <token>`. */
export const HEADER_SCHEMES = ['raw', 'bearer'] as const;
export type HeaderScheme = (typeof HEADER_SCHEMES)[number];
export const EXPIRY_UNITS = ['epoch_seconds', 'epoch_millis', 'iso8601'] as const;
export type ExpiryUnit = (typeof EXPIRY_UNITS)[number];

/** Media type stored for a response whose Content-Type is absent or not a valid media type. */
export const DEFAULT_MEDIA_TYPES = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  bytes: 'application/octet-stream',
} as const satisfies Record<ResponseKind, string>;

/** Rounds of a planner function (the brief: at most 5). */
export const MAX_READ_ROUNDS = 5;
/** Largest response a route may declare. */
export const MAX_ROUTE_BYTES = 256 * 1024 * 1024;
/** Requests one read may make (all rounds), and the default when the read declares none. */
export const MAX_READ_REQUESTS = 1000;
export const DEFAULT_READ_REQUESTS = 50;
/** Nested reads one read may ask for (all rounds). */
export const MAX_NESTED_READS = 20;
/** Derived artifacts one projection may return. */
export const MAX_DERIVED_ARTIFACTS = 20;
/** Credential name reserved for the token cache entry of a resource. */
export const RESERVED_CREDENTIAL = 'session';

// ---------------------------------------------------------------- names

export const ResourceId = idOf('res');
export type ResourceId = z.infer<typeof ResourceId>;
export const RoleName = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, 'lowercase letters, digits and hyphens');
export const RouteId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'lowercase letters, digits, _ and -');
export const ReadName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'lowercase letters, digits, _ and -');
export const CredentialName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and _')
  .refine((name) => name !== RESERVED_CREDENTIAL, `${RESERVED_CREDENTIAL} is reserved for the token cache`);
export const VaultEntryName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'a vault entry name');
/** `system:type`, the first two parts of an external object identity. */
export const ExternalType = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*$/, 'system:type')
  .refine((t) => !(REFERENCE_SCHEME as readonly string[]).includes(t.slice(0, t.indexOf(':'))), 'the system of an external object is never a reference scheme');
/** Key of one request of a read, chosen by the planner; responses are handed back under it. */
export const RequestKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, '1 to 64 letters, digits, _ . : -');
/** Name of a derived artifact (`content`, `meta`, ...); `original` is the response as received. */
export const ArtifactName = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'lowercase letters, digits, _ . -')
  .refine((name) => name !== 'original', 'original names the response as received');
/** A pack: `id` (latest published version) or `id@x.y.z`. */
export const PackRef = z.string().regex(/^[a-z][a-z0-9-]{1,40}(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/, 'pack id or id@x.y.z');
const HeaderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'an HTTP header name');
const HeaderValue = z.string().regex(/^[\x20-\x7e]{0,200}$/, 'printable ASCII, at most 200 characters');
const Description = z.string().min(1).max(500);

/** Headers a profile never sets itself: the transport owns them (credentials, framing, hop-by-hop, cross-site). */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'origin',
  'referer',
];

// ---------------------------------------------------------------- path templates

/** One part of a path template: a literal segment, `{name}` (one segment) or `{name*}` (one or more, last only). */
export type PathPart = { literal: string } | { param: string; rest: boolean };
export interface PathTemplate {
  parts: PathPart[];
  /** The path ends with `/` (a WebDAV collection, for example). */
  trailingSlash: boolean;
}

/** RFC 3986 pchar, percent escapes included; braces never. */
const PCHAR_SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;
const PARAM = /^\{([a-z][a-z0-9_]{0,31})(\*?)\}$/;

/**
 * Parses a route path template: `/` followed by segments separated by `/`, an optional trailing `/`. A segment is a literal
 * (RFC 3986 pchar, no `.` or `..`), `{name}` or, as the last segment only, `{name*}`. Throws an Error naming the problem.
 */
export function parsePathTemplate(template: string): PathTemplate {
  if (typeof template !== 'string' || !template.startsWith('/') || template.length > 1000) throw new Error('a path template starts with / and has at most 1000 characters');
  if (template === '/') return { parts: [], trailingSlash: false };
  const trailingSlash = template.endsWith('/');
  const body = template.slice(1, trailingSlash ? -1 : undefined);
  const parts: PathPart[] = [];
  const names = new Set<string>();
  const segments = body.split('/');
  segments.forEach((segment, index) => {
    if (segment === '') throw new Error('a path template has no empty segment');
    const param = PARAM.exec(segment);
    if (param !== null) {
      const [, name, star] = param;
      if (names.has(name)) throw new Error(`{${name}} appears twice`);
      names.add(name);
      const rest = star === '*';
      if (rest && index !== segments.length - 1) throw new Error(`{${name}*} must be the last segment`);
      parts.push({ param: name, rest });
      return;
    }
    if (!PCHAR_SEGMENT.test(segment) || segment === '.' || segment === '..') throw new Error(`segment ${JSON.stringify(segment)} is not a literal path segment`);
    parts.push({ literal: segment });
  });
  return { parts, trailingSlash };
}

/** Parameter names of a template, in order. */
export function templateParams(template: PathTemplate): string[] {
  return template.parts.flatMap((part) => ('param' in part ? [part.param] : []));
}

const SMALL_INT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------- shapes of queries and bodies (a JSON Schema subset)

/**
 * A pattern the transport can match in linear time: `^`, an optional literal prefix of letters, digits, `_` and `-`, one
 * bracket class (negation, ranges and the escapes `\\ \] \[ \- \. \^ \/` allowed) with one quantifier (`+`, `*`, `{m}`,
 * `{m,}`, `{m,n}`), `$`. For example `^[0-9]{1,12}$` or `^[A-Za-z0-9_.-]+$`.
 */
export const SIMPLE_PATTERN = /^\^[A-Za-z0-9_-]{0,64}\[\^?(?:[A-Za-z0-9 _.:@+~=,!#%&'()*/;<>?|$-]|\\[\\\][.\-^/])+\](?:[+*]|\{[0-9]{1,4}(?:,[0-9]{0,4})?\})\$$/;

export function simplePatternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length > 200 || !SIMPLE_PATTERN.test(pattern)) {
    return 'a pattern is ^, an optional literal prefix, one bracket class with one quantifier, and $ (linear-time matching)';
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'the pattern does not compile';
  }
  return null;
}

export type Shape =
  | { type: 'object'; properties?: Record<string, Shape>; required?: string[]; additionalProperties: false; description?: string }
  | { type: 'array'; items: Shape; minItems?: number; maxItems: number; description?: string }
  | { type: 'string'; minLength?: number; maxLength: number; pattern?: string; enum?: string[]; const?: string; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; enum?: number[]; description?: string }
  | { type: 'number'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { anyOf: Shape[]; description?: string };

const PropertyName = z.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/, 'no control characters');
const SafeNumber = z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/**
 * Shape of a query (an object of strings) or a JSON body, written in a subset of JSON Schema 2020-12: every object closed
 * (`additionalProperties: false`), every array and string bounded (`maxItems`, `maxLength`), patterns linear (SIMPLE_PATTERN).
 */
export const Shape: z.ZodType<Shape> = z.lazy(() =>
  z.union([
    z
      .strictObject({
        type: z.literal('object'),
        properties: z.record(PropertyName, Shape).optional(),
        required: z.array(PropertyName).max(64).optional(),
        additionalProperties: z.literal(false),
        description: Description.optional(),
      })
      .superRefine((s, ctx) => {
        for (const name of s.required ?? []) {
          if (!Object.hasOwn(s.properties ?? {}, name)) ctx.addIssue({ code: 'custom', path: ['required'], message: `${name} is required but not a property` });
        }
        if (Object.keys(s.properties ?? {}).length > 64) ctx.addIssue({ code: 'custom', path: ['properties'], message: 'at most 64 properties' });
      }),
    z
      .strictObject({
        type: z.literal('array'),
        items: Shape,
        minItems: SMALL_INT.optional(),
        maxItems: z.number().int().min(0).max(10_000),
        description: Description.optional(),
      })
      .refine((s) => s.minItems === undefined || s.minItems <= s.maxItems, { message: 'minItems exceeds maxItems', path: ['minItems'] }),
    z
      .strictObject({
        type: z.literal('string'),
        minLength: SMALL_INT.optional(),
        maxLength: z.number().int().min(0).max(65_536),
        pattern: z
          .string()
          .optional()
          .superRefine((p, ctx) => {
            const problem = p === undefined ? null : simplePatternProblem(p);
            if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
          }),
        enum: z.array(z.string().max(1000)).min(1).max(256).optional(),
        const: z.string().max(1000).optional(),
        description: Description.optional(),
      })
      .refine((s) => s.minLength === undefined || s.minLength <= s.maxLength, { message: 'minLength exceeds maxLength', path: ['minLength'] }),
    z.strictObject({
      type: z.literal('integer'),
      minimum: SafeNumber.optional(),
      maximum: SafeNumber.optional(),
      enum: z.array(z.number().int()).min(1).max(256).optional(),
      description: Description.optional(),
    }),
    z.strictObject({ type: z.literal('number'), minimum: SafeNumber.optional(), maximum: SafeNumber.optional(), description: Description.optional() }),
    z.strictObject({ type: z.literal('boolean'), description: Description.optional() }),
    z.strictObject({ type: z.literal('null'), description: Description.optional() }),
    z.strictObject({ anyOf: z.array(Shape).min(1).max(8), description: Description.optional() }),
  ]),
);

/** Nesting of a shape, counting every object, array and anyOf level (the validator refuses deeper shapes). */
export function shapeDepth(shape: Shape): number {
  if ('anyOf' in shape) return 1 + Math.max(...shape.anyOf.map(shapeDepth));
  if (shape.type === 'object') return 1 + Math.max(0, ...Object.values(shape.properties ?? {}).map(shapeDepth));
  if (shape.type === 'array') return 1 + shapeDepth(shape.items);
  return 1;
}
export const MAX_SHAPE_DEPTH = 16;

// ---------------------------------------------------------------- system.json (system@1)

const EnvelopeCode = z.union([z.number().int(), z.string().min(1).max(40)]);

/** The envelope a JSON API wraps its answers in, for example `{code, msg, data}` with HTTP 200 for every answer. */
export const EnvelopeDeclaration = z.strictObject({
  code: JsonPointer.describe('where the envelope code is'),
  ok: z.array(EnvelopeCode).min(1).describe('codes meaning success'),
  expired: z.array(EnvelopeCode).describe('codes meaning the login has expired (one login, then one repeat of the request)'),
  message: JsonPointer.optional().describe('where the error message is, for the admin log'),
});
export type EnvelopeDeclaration = z.infer<typeof EnvelopeDeclaration>;

export const RouteDeclaration = z
  .strictObject({
    id: RouteId,
    role: RoleName,
    method: z.enum(HTTP_METHODS),
    path: z.string().describe('path template relative to the base URL of the role: literal segments, {name}, a last {name*}, optional trailing /'),
    query: Shape.optional().describe('the query parameters (strings) as an object shape; without it no query is sent'),
    body: Shape.optional().describe('the JSON body; without it no body is sent'),
    headers: z.record(HeaderName, HeaderValue).optional().describe('fixed request headers, for example Depth: 1'),
    response: z.enum(RESPONSE_KINDS),
    max_bytes: z.number().int().min(1).max(MAX_ROUTE_BYTES).describe('a longer response is an error; it is never truncated'),
    timeout_ms: z.number().int().min(100).max(300_000).optional(),
    envelope: z.boolean().optional().describe('check the system envelope of a JSON answer'),
    parse: Versioned.optional().describe('a core parser whose model the read functions get besides the text'),
    read: z.literal(true).describe('every route is a read; a write route is never listed, so it is refused'),
    description: Description.optional(),
  })
  .superRefine((r, ctx) => {
    try {
      parsePathTemplate(r.path);
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: (error as Error).message });
    }
    if (r.method === 'GET' && r.body !== undefined) ctx.addIssue({ code: 'custom', path: ['body'], message: 'a GET route has no body' });
    if (r.query !== undefined) {
      const q = r.query;
      const strings = 'type' in q && q.type === 'object' && Object.values(q.properties ?? {}).every((p) => ('anyOf' in p ? p.anyOf.every((a) => 'type' in a && a.type === 'string') : p.type === 'string'));
      if (!strings) ctx.addIssue({ code: 'custom', path: ['query'], message: 'a query shape is an object whose properties are strings' });
    }
    if (r.query !== undefined && shapeDepth(r.query) > MAX_SHAPE_DEPTH) ctx.addIssue({ code: 'custom', path: ['query'], message: `nested deeper than ${MAX_SHAPE_DEPTH}` });
    if (r.body !== undefined && shapeDepth(r.body) > MAX_SHAPE_DEPTH) ctx.addIssue({ code: 'custom', path: ['body'], message: `nested deeper than ${MAX_SHAPE_DEPTH}` });
    if (r.envelope === true && r.response !== 'json') ctx.addIssue({ code: 'custom', path: ['envelope'], message: 'only a JSON answer has an envelope' });
    if (r.parse !== undefined && (r.response === 'json' || r.response === 'bytes')) ctx.addIssue({ code: 'custom', path: ['parse'], message: 'parse is for text, xml and html answers' });
    for (const name of Object.keys(r.headers ?? {})) {
      if (RESERVED_HEADERS.includes(name.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['headers', name], message: `${name} is set by the transport, never by a profile` });
    }
  });
export type RouteDeclaration = z.infer<typeof RouteDeclaration>;

export const HeaderDeclaration = z.strictObject({ name: HeaderName, scheme: z.enum(HEADER_SCHEMES) }).superRefine((h, ctx) => {
  const lower = h.name.toLowerCase();
  if (RESERVED_HEADERS.includes(lower) && lower !== 'authorization') ctx.addIssue({ code: 'custom', path: ['name'], message: `${h.name} cannot carry a credential` });
});

export const CredentialDeclaration = z.strictObject({
  name: CredentialName,
  digest: z.enum(DIGEST_RULES).describe('what the vault keeps and the request carries: the value as given, or Base64(SHA-512(value))'),
  description: Description.optional(),
});

/** The login exchange: never stored as a source, never logged, attempted once per expiry and never retried after a failure. */
export const LoginDeclaration = z
  .strictObject({
    role: RoleName,
    method: z.literal('POST'),
    path: z.string().describe('a literal path template, no parameters'),
    body: z.unknown().describe('JSON template: a string "{name}" anywhere is replaced by the credential of that name'),
    token: JsonPointer.describe('where the token is in the answer'),
    expiry: z.strictObject({ pointer: JsonPointer, unit: z.enum(EXPIRY_UNITS) }).optional().describe('where the token expiry is'),
    envelope: z.strictObject({ code: JsonPointer, ok: z.array(EnvelopeCode).min(1), message: JsonPointer.optional() }),
    max_bytes: z.number().int().min(1).max(1024 * 1024).optional(),
    timeout_ms: z.number().int().min(100).max(120_000).optional(),
  })
  .superRefine((l, ctx) => {
    try {
      if (parsePathTemplate(l.path).parts.some((part) => 'param' in part)) ctx.addIssue({ code: 'custom', path: ['path'], message: 'the login path has no parameters' });
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: (error as Error).message });
    }
  });
export type LoginDeclaration = z.infer<typeof LoginDeclaration>;

export const AuthDeclaration = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('static_header'),
    header: HeaderDeclaration,
    roles: z.array(RoleName).min(1).describe('roles whose requests carry the header'),
    credential: CredentialName.describe('the vault-held header value (raw) or token (bearer)'),
  }),
  z.strictObject({
    kind: z.literal('login_token'),
    header: HeaderDeclaration,
    roles: z.array(RoleName).min(1).describe('roles whose requests carry the token'),
    credentials: z.array(CredentialDeclaration).min(1).max(8),
    login: LoginDeclaration,
  }),
]);
export type AuthDeclaration = z.infer<typeof AuthDeclaration>;

/** Declarative request of a read without a planner: string values may contain {id}, the key of the external object. */
export const ReadRequestTemplate = z.strictObject({
  route: RouteId,
  params: z.record(z.string(), z.string().max(1000)).optional(),
  query: z.record(z.string(), z.string().max(1000)).optional(),
  body: z.unknown().optional(),
});

export const ReadDeclaration = z
  .strictObject({
    name: ReadName,
    external: ExternalType.describe('the external object type this read serves, system:type'),
    description: Description.optional(),
    plan: PackFunctionRef.optional().describe('ReadPlanInput -> ReadPlanOutput, called again with the responses so far, at most 5 rounds'),
    request: ReadRequestTemplate.optional().describe('one declared request instead of a planner'),
    project: PackFunctionRef.optional().describe('ReadProjectionInput -> ReadProjectionOutput: derived artifacts such as content and meta'),
    max_requests: z.number().int().min(1).max(MAX_READ_REQUESTS).optional(),
    max_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).optional().describe('all responses of one read together'),
  })
  .superRefine((r, ctx) => {
    if ((r.plan === undefined) === (r.request === undefined)) ctx.addIssue({ code: 'custom', path: ['plan'], message: 'a read has a planner function or one declared request, not both and not neither' });
  });
export type ReadDeclaration = z.infer<typeof ReadDeclaration>;

export const SystemProfile = z
  .strictObject({
    schema: z.literal('system@1'),
    title: z.string().min(1).max(200),
    description: Description.optional(),
    roles: z.array(z.strictObject({ name: RoleName, description: Description.optional() })).min(1).max(16),
    auth: AuthDeclaration,
    envelope: EnvelopeDeclaration.optional(),
    routes: z.array(RouteDeclaration).min(1).max(200),
    reads: z.array(ReadDeclaration).min(1).max(100),
  })
  .superRefine((p, ctx) => {
    const roles = new Set<string>();
    p.roles.forEach((role, i) => {
      if (roles.has(role.name)) ctx.addIssue({ code: 'custom', path: ['roles', i, 'name'], message: `role ${role.name} is declared twice` });
      roles.add(role.name);
    });
    const routes = new Map<string, RouteDeclaration>();
    const signatures = new Set<string>();
    p.routes.forEach((route, i) => {
      if (routes.has(route.id)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'id'], message: `route ${route.id} is declared twice` });
      routes.set(route.id, route);
      if (!roles.has(route.role)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'role'], message: `role ${route.role} is not declared` });
      if (route.envelope === true && p.envelope === undefined) ctx.addIssue({ code: 'custom', path: ['routes', i, 'envelope'], message: 'the profile declares no envelope' });
      const signature = `${route.role} ${route.method} ${route.path}`;
      if (signatures.has(signature)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'path'], message: `two routes of ${route.role} are ${route.method} ${route.path}` });
      signatures.add(signature);
      if (p.auth.kind !== 'none') {
        for (const name of Object.keys(route.headers ?? {})) {
          if (name.toLowerCase() === p.auth.header.name.toLowerCase()) ctx.addIssue({ code: 'custom', path: ['routes', i, 'headers', name], message: 'the credential header is set by the transport' });
        }
      }
    });
    if (p.auth.kind !== 'none') {
      p.auth.roles.forEach((role, i) => {
        if (!roles.has(role)) ctx.addIssue({ code: 'custom', path: ['auth', 'roles', i], message: `role ${role} is not declared` });
      });
    }
    if (p.auth.kind === 'login_token') {
      const auth = p.auth;
      const names = new Set<string>();
      auth.credentials.forEach((c, i) => {
        if (names.has(c.name)) ctx.addIssue({ code: 'custom', path: ['auth', 'credentials', i, 'name'], message: `credential ${c.name} is declared twice` });
        names.add(c.name);
      });
      if (!roles.has(auth.login.role)) ctx.addIssue({ code: 'custom', path: ['auth', 'login', 'role'], message: `role ${auth.login.role} is not declared` });
      for (const name of templateNames(auth.login.body)) {
        if (!names.has(name)) ctx.addIssue({ code: 'custom', path: ['auth', 'login', 'body'], message: `{${name}} is not a declared credential` });
      }
    }
    const reads = new Set<string>();
    const types = new Set<string>();
    p.reads.forEach((read, i) => {
      if (reads.has(read.name)) ctx.addIssue({ code: 'custom', path: ['reads', i, 'name'], message: `read ${read.name} is declared twice` });
      reads.add(read.name);
      if (types.has(read.external)) ctx.addIssue({ code: 'custom', path: ['reads', i, 'external'], message: `${read.external} is served by two reads` });
      types.add(read.external);
      if (read.request !== undefined) {
        const route = routes.get(read.request.route);
        if (route === undefined) {
          ctx.addIssue({ code: 'custom', path: ['reads', i, 'request', 'route'], message: `route ${read.request.route} is not declared` });
          return;
        }
        let params: string[] = [];
        try {
          params = templateParams(parsePathTemplate(route.path));
        } catch {
          return;
        }
        const given = Object.keys(read.request.params ?? {}).sort();
        if (given.join('\n') !== [...params].sort().join('\n')) ctx.addIssue({ code: 'custom', path: ['reads', i, 'request', 'params'], message: `the request fills exactly the parameters of ${route.path}` });
        if (read.request.body !== undefined && route.body === undefined) ctx.addIssue({ code: 'custom', path: ['reads', i, 'request', 'body'], message: `route ${route.id} takes no body` });
        if (read.request.query !== undefined && route.query === undefined) ctx.addIssue({ code: 'custom', path: ['reads', i, 'request', 'query'], message: `route ${route.id} takes no query` });
      }
    });
  });
export type SystemProfile = z.infer<typeof SystemProfile>;

/** `{name}` placeholders in the strings of a JSON template, in order of appearance. */
export function templateNames(template: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 32) return;
    if (typeof value === 'string') for (const m of value.matchAll(/\{([a-z][a-z0-9_]{0,31})\}/g)) out.push(m[1]);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  walk(template, 0);
  return out;
}

// ---------------------------------------------------------------- resource@1 (deployment instance, never in Git)

/** `http://host[:port][/base/path]`: no credentials, query or fragment; the stored form has no trailing slash. */
export function baseUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'only http and https';
  if (parsed.username !== '' || parsed.password !== '') return 'credentials never go into a base URL; use the vault';
  if (parsed.search !== '' || parsed.hash !== '' || url.includes('?') || url.includes('#')) return 'a base URL has no query or fragment';
  if (parsed.hostname === '') return 'a base URL names a host';
  if (url.endsWith('/') || `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}` !== url) return 'write the base URL normalized, without a trailing slash';
  return null;
}

export const BaseUrl = z
  .string()
  .max(2000)
  .superRefine((url, ctx) => {
    const problem = baseUrlProblem(url);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });

export const ResourceLimits = z.strictObject({
  concurrency: z.number().int().min(1).max(16).optional().describe('requests in flight at once, default 2'),
  interval_ms: z.number().int().min(0).max(60_000).optional().describe('least time between two request starts, default 0'),
  timeout_ms: z.number().int().min(100).max(300_000).optional().describe('per request unless the route says otherwise, default 30000'),
});
export type ResourceLimits = z.infer<typeof ResourceLimits>;

export const ResourceRecord = z
  .strictObject({
    schema: z.literal('resource@1'),
    id: ResourceId,
    system_pack: PackRef,
    name: z.string().min(1).max(200),
    environment: EnvironmentSchema,
    origins: z.record(RoleName, BaseUrl).describe('base URL of each role of the system pack'),
    allow_plaintext: z.array(z.string().max(300)).max(16).describe('origins (scheme://host[:port]) whose plain HTTP may carry credentials'),
    credentials: z.record(CredentialName, VaultEntryName).describe('vault entry of each credential the system pack declares'),
    settings: z.record(z.string(), z.unknown()).describe('non-secret deployment values handed to the read functions as input.settings'),
    limits: ResourceLimits.optional(),
    created_by: UserId,
    created_at: IsoTime,
  })
  .superRefine((r, ctx) => {
    const origins = new Set<string>();
    for (const url of Object.values(r.origins)) {
      try {
        origins.add(new URL(url).origin);
      } catch {
        // reported by BaseUrl
      }
    }
    r.allow_plaintext.forEach((origin, i) => {
      if (!origins.has(origin) || !origin.startsWith('http://')) ctx.addIssue({ code: 'custom', path: ['allow_plaintext', i], message: 'an entry is the http origin of one of the base URLs' });
    });
    let size = 0;
    try {
      size = JSON.stringify(r.settings).length;
    } catch {
      ctx.addIssue({ code: 'custom', path: ['settings'], message: 'settings are JSON' });
    }
    if (size > 64 * 1024) ctx.addIssue({ code: 'custom', path: ['settings'], message: 'settings are at most 64 KiB of JSON' });
  });
export type ResourceRecord = z.infer<typeof ResourceRecord>;

// ---------------------------------------------------------------- read functions: planner and projection

/** The external object a read is for. */
export const ReadSubject = z.strictObject({
  id: ExternalObjectId.describe('system:type:key as requested, without revision'),
  system: z.string(),
  type: z.string(),
  key: z.string().describe('the part after system:type:'),
  revision: z.string().nullable().describe('the revision asked for, or null'),
});
export type ReadSubject = z.infer<typeof ReadSubject>;

/** A response as the read functions see it (no URL, no header values, no credential). */
export const ReadResponse = z.strictObject({
  ok: z.boolean().describe('2xx, a valid body of the declared kind and, for an envelope route, an ok code'),
  route: RouteId,
  path: z.string().describe('the requested path relative to the base URL of the route role, as sent'),
  query: z.record(z.string(), z.string()),
  status: z.number().int().nullable(),
  media_type: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  sha256: Sha256.nullable().describe('digest of the stored response body'),
  etag: z.string().nullable(),
  json: z.unknown().optional().describe('the parsed answer of a json route'),
  text: z.string().optional().describe('the decoded answer of a text, xml or html route (or of a json route that did not parse)'),
  model: z.unknown().optional().describe('the model of the core parser the route names'),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type ReadResponse = z.infer<typeof ReadResponse>;

/** A read of another external object the planner asked for, served from the cache unless refreshed. */
export const NestedRead = z.strictObject({
  ok: z.boolean(),
  revision: z.string().nullable(),
  cached: z.boolean(),
  content: z.unknown().describe('the parsed content artifact (JSON) or its text; the original when there is no content artifact; null on failure'),
  meta: z.unknown().describe('the parsed meta artifact, or null'),
  reason: z.string().nullable(),
});
export type NestedRead = z.infer<typeof NestedRead>;

export const ReadPlanInput = z.strictObject({
  round: z.number().int().min(1).max(MAX_READ_ROUNDS),
  external: ReadSubject,
  args: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()),
  responses: z.record(z.string(), ReadResponse).describe('every response so far by request key, failures included'),
  reads: z.record(z.string(), NestedRead).describe('every nested read so far by external id'),
});
export type ReadPlanInput = z.infer<typeof ReadPlanInput>;

export const PlannedRequest = z
  .strictObject({
    key: RequestKey,
    route: RouteId,
    params: z.record(z.string(), z.string().max(4096)).optional().describe('fills the path template; a {name*} value may contain /'),
    path: z.string().max(4096).optional().describe('a path relative to the base URL, as a response path gives it'),
    href: z.string().max(4096).optional().describe('a link as found in a response, resolved against the response named by against (default the base URL)'),
    against: RequestKey.optional(),
    query: z.record(z.string(), z.union([z.string().max(4096), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
  })
  .superRefine((r, ctx) => {
    const forms = [r.params, r.path, r.href].filter((x) => x !== undefined).length;
    if (forms > 1) ctx.addIssue({ code: 'custom', path: ['params'], message: 'give params, path or href, not several' });
    if (r.against !== undefined && r.href === undefined) ctx.addIssue({ code: 'custom', path: ['against'], message: 'against goes with href' });
  });
export type PlannedRequest = z.infer<typeof PlannedRequest>;

export const ReadPlanOutput = z.strictObject({
  requests: z.array(PlannedRequest).max(MAX_READ_REQUESTS),
  reads: z.array(z.strictObject({ external: ExternalObjectId, refresh: z.boolean().optional() })).max(MAX_NESTED_READS).optional(),
  done: z.boolean().describe('true: execute these requests and reads, then stop; false: call the planner again with their answers'),
  original: RequestKey.optional().describe('the response that is the object as received; default the first request of round 1'),
});
export type ReadPlanOutput = z.infer<typeof ReadPlanOutput>;

export const ReadProjectionInput = z.strictObject({
  external: ReadSubject,
  args: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()),
  responses: z.record(z.string(), ReadResponse),
  reads: z.record(z.string(), NestedRead),
  original: RequestKey,
});
export type ReadProjectionInput = z.infer<typeof ReadProjectionInput>;

export const DerivedArtifact = z
  .strictObject({
    name: ArtifactName,
    media_type: z.string().min(3).max(200),
    text: z.string().optional().describe('stored as UTF-8'),
    json: z.unknown().optional().describe('stored as RFC 8785 canonical JSON'),
    response: RequestKey.optional().describe('names a stored response itself instead of new bytes'),
  })
  .superRefine((a, ctx) => {
    const forms = [a.text, a.json, a.response].filter((x) => x !== undefined).length;
    if (forms !== 1) ctx.addIssue({ code: 'custom', path: ['text'], message: 'give exactly one of text, json and response' });
  });
export type DerivedArtifact = z.infer<typeof DerivedArtifact>;

export const ReadProjectionOutput = z.union([
  z.strictObject({
    revision: z.string().min(1).max(200).nullable().optional().describe('the revision of the object, when the system has one'),
    artifacts: z.array(DerivedArtifact).max(MAX_DERIVED_ARTIFACTS),
    complete: z.boolean().optional().describe('false when the projection saw that the read did not cover the object; it never makes coverage complete'),
    note: z.string().max(500).optional(),
    warnings: z.array(z.string().max(500)).max(50).optional(),
  }),
  z.strictObject({
    error: z.strictObject({ code: z.string().min(1).max(100), message: z.string().max(2000) }),
    warnings: z.array(z.string().max(500)).max(50).optional(),
  }),
]);
export type ReadProjectionOutput = z.infer<typeof ReadProjectionOutput>;

// ---------------------------------------------------------------- read-manifest@1 (a B05 read action)

export const ReadRequestEntry = z.strictObject({
  key: RequestKey,
  round: z.number().int().min(1).max(MAX_READ_ROUNDS),
  route: RouteId,
  method: z.enum(HTTP_METHODS),
  path: z.string().max(4096),
  query: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
  started_at: IsoTime,
  ended_at: IsoTime,
  status: z.number().int().nullable(),
  ok: z.boolean(),
  error: z.string().nullable().describe('internal code of the failure, see the connectors README'),
  sha256: Sha256.nullable(),
  size: z.number().int().nonnegative().nullable(),
  media_type: z.string().nullable(),
  etag: z.string().max(300).nullable(),
  artifact: Sha256.nullable().describe('digest of the source_artifact record of the response'),
  after_login: z.boolean().describe('sent again once after a login, because the first answer said the login had expired'),
});
export type ReadRequestEntry = z.infer<typeof ReadRequestEntry>;

export const ReadManifest = z.strictObject({
  action: ActionKindSchema.extract(['read']),
  run: RunId.nullable(),
  item: z.null(),
  inputs: z.array(z.string()).describe('rec: references of the resource configuration and of the nested reads'),
  component: Versioned,
  lease: z.null(),
  started_at: IsoTime,
  ended_at: IsoTime,
  result: ActionResultSchema,
  error_code: z.string().nullable(),
  external: ExternalObjectId,
  revision: z.string().nullable(),
  resource: ResourceId,
  environment: EnvironmentSchema,
  system_pack: z.strictObject({ id: PackId, version: PackVersion, digest: Sha256 }),
  read: ReadName,
  principal: UserId,
  purpose: z.string().max(200),
  requests: z.array(ReadRequestEntry),
  reads: z.array(
    z.strictObject({ external: ExternalObjectId, ok: z.boolean(), cached: z.boolean(), revision: z.string().nullable(), manifest: Sha256.nullable() }),
  ),
  original: RequestKey.nullable(),
  artifacts: z.array(
    z.strictObject({ name: z.string(), record: Sha256, sha256: Sha256, media_type: z.string(), size: z.number().int().nonnegative() }),
  ),
  coverage: Coverage,
  reason: z.string().max(2000).nullable().describe('why the read failed, for the admin log'),
  warnings: z.array(z.string().max(500)).max(50),
});
export type ReadManifest = z.infer<typeof ReadManifest>;

export const schemas: Record<string, z.ZodType> = {
  'system@1': SystemProfile,
  'resource@1': ResourceRecord,
  'read-manifest@1': ReadManifest,
  'read-plan-input@1': ReadPlanInput,
  'read-plan-output@1': ReadPlanOutput,
  'read-projection-input@1': ReadProjectionInput,
  'read-projection-output@1': ReadProjectionOutput,
};
