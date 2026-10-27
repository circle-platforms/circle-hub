// Shapes owned by the connectors work package (D01, D02, D03 read part, D07 resources, B02 provenance, B05 read actions).
// - system@1: the system pack profile (system.json): roles, authentication, the route allow-list and the reads with their
//   planner and projection functions. Product dialect stays in the pack's functions and settings, never in the core.
// - resource@1: a deployment instance of a system (admin-managed, never in Git): the exact system pack version and digest,
//   base URL per role, the origins allowed to carry credentials over plain HTTP, the vault entry names of
//   its credentials and non-secret settings.
// - read-manifest@1: the action record of one read (B05): what was requested, through which routes, when, the digests of
//   every response and derived artifact, and the coverage the Hub computed.
// - read-plan-*@1, read-projection-*@1: inputs and outputs of the planner and projection functions of a system pack.
// The closed sets below (HTTP methods, response kinds, authentication kinds, header schemes, expiry
// units, envelope modes) are not vocabulary axes of the model; the connectors README lists them as a deviation awaiting axes.
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY.
import { z } from 'zod';
import {MissingFact,UnknownExit,recoveryCondition} from './recovery.ts';
import {isIP} from 'node:net';
import {X509Certificate} from 'node:crypto';
import { SecretReference, VariableUse, referencesIn, resolve as resolveExecutorReferences, VariableInputError } from './variables.ts';
import {PROTOCOL_CODES,type ProtocolCode} from '../generated/protocol.ts';
import { AcceptanceSchema,EffectMarkSchema,EffectClassSchema,EffectOutcomeSchema,DynamicTerminalSchema,RetrySafetySchema,SigningSchema,WriteInteractionSchema,ActionKindSchema, ActionResultSchema, EnvironmentSchema, DigestRuleSchema, REFERENCE_SCHEME } from '../generated/vocabulary.ts';
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
/** One published version of a pack, `id@x.y.z`: what a resource configuration binds (B04 R[1]). */
export const ExactPackRef = z.string().regex(/^[a-z][a-z0-9-]{1,40}@[0-9]+\.[0-9]+\.[0-9]+$/, 'id@x.y.z');
const HeaderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'an HTTP header name');
const HeaderValue = z.string().regex(/^[\x20-\x7e]{0,200}$/, 'printable ASCII, at most 200 characters');
const Description = z.string().min(1).max(500);

/**
 * Headers a profile never sets itself: the transport owns them (credentials, framing, hop-by-hop, cross-site, content
 * coding and ranges, which would make a stored answer partial), and headers by which frameworks or proxies change the
 * method or the path of a request (method overrides, URL rewrites, forwarding) or which belong to WebDAV writes.
 */
export const RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'origin',
  'referer',
  'range',
  'if-range',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
  'x-original-method',
  'x-original-url',
  'x-rewrite-url',
  'x-original-host',
  'x-host',
  'x-real-ip',
  'forwarded',
  'via',
  'destination',
  'overwrite',
  'lock-token',
  'if',
];
/** Header name prefixes reserved in the same way (forwarding, proxies, browser-controlled headers). */
export const RESERVED_HEADER_PREFIXES: readonly string[] = ['x-forwarded-', 'proxy-', 'sec-'];

/** Whether a profile may not set this header (case-insensitive). */
export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.includes(lower) || RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Query or body members by which some frameworks turn a request into another method. */
const METHOD_OVERRIDE_MEMBER = /^(?:_method|x-http-method-override|x-http-method|x-method-override)$/i;

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

function segmentKey(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/**
 * Whether some path the template allows names the same resource as a literal path, compared the way lenient servers do:
 * decoded, case-insensitive and with or without the trailing slash. Used to keep the login exchange out of the route list.
 */
export function templateReaches(template: PathTemplate, literal: PathTemplate): boolean {
  const segments: string[] = [];
  for (const part of literal.parts) {
    if (!('literal' in part)) return false;
    segments.push(segmentKey(part.literal));
  }
  let index = 0;
  for (const part of template.parts) {
    if (index >= segments.length) return false;
    if ('literal' in part) {
      if (segments[index] !== segmentKey(part.literal)) return false;
      index += 1;
    } else {
      index = part.rest ? segments.length : index + 1;
    }
  }
  return index === segments.length;
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

/** Top-level members of an object shape (or of the objects of an anyOf). */
function topMembers(shape: Shape): string[] {
  if ('anyOf' in shape) return shape.anyOf.flatMap(topMembers);
  return shape.type === 'object' ? Object.keys(shape.properties ?? {}) : [];
}

/**
 * How a JSON route's answer is checked against the system envelope: `true` every answer is an envelope; `when_present` an
 * answer whose code member exists is an envelope (ok, expired and error codes checked), any other answer is accepted bare
 * (a list that the system answers plainly while its errors come in the envelope); `false` never. Without a declaration,
 * an answer to a request that carried the credential is still read for the expired codes, and only for them.
 */
export const EnvelopeMode = z.union([z.boolean(), z.literal('when_present')]);
export type EnvelopeMode = z.infer<typeof EnvelopeMode>;

export const RouteDeclaration = z
  .strictObject({
    id: RouteId,
    role: RoleName,
    method: z.enum(HTTP_METHODS),
    path: z
      .string()
      .describe('path template relative to the base URL of the role: literal segments, {name}, a last {name*}, optional trailing /; a POST route has a literal path'),
    params: z
      .record(z.string(), Shape)
      .optional()
      .describe('a string shape per template parameter, checked on every (decoded) segment it fills; required for a {name*} of a role that carries the credential'),
    query: Shape.optional().describe('the query parameters (strings) as an object shape; without it no query is sent'),
    body: Shape.optional().describe('the JSON body; without it no body is sent'),
    headers: z.record(HeaderName, HeaderValue).optional().describe('fixed request headers, for example Depth: 1'),
    response: z.enum(RESPONSE_KINDS),
    media_types_by_extension: z
      .record(
        z.string().regex(/^\.[a-z0-9_-]{1,32}$/, 'an extension starting with a dot, lowercase letters, digits, _ or -'),
        z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/, 'a MIME media type type/subtype')
      )
      .optional()
      .describe('media type by lowercase filename extension when the server returns application/octet-stream or omits Content-Type'),
    max_bytes: z.number().int().min(1).max(MAX_ROUTE_BYTES).describe('a longer response is an error; it is never truncated'),
    pagination:z.strictObject({max_pages:z.number().int().min(1).max(MAX_READ_REQUESTS)}).optional().describe('The planner may request further pages within this finite bound; no hidden fetch or truncated completion'),
    redirects:z.strictObject({same_origin:z.literal(true),max_hops:z.number().int().min(1).max(MAX_READ_REQUESTS)}).optional().describe('Each same-origin hop is another planned, recorded read request; never a transport auto-follow'),
    timeout_ms: z.number().int().min(100).max(300_000).optional(),
    envelope: EnvelopeMode.optional().describe('check the system envelope of a JSON answer: true, when_present or false'),
    parse: Versioned.optional().describe('a core parser whose model the read functions get besides the text'),
    read: z.literal(true).describe('every route is a read; a write route is never listed, so it is refused'),
    description: Description.optional(),
  })
  .superRefine((r, ctx) => {
    let names: string[] = [];
    try {
      names = templateParams(parsePathTemplate(r.path));
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: (error as Error).message });
    }
    // A read that uses POST is allow-listed by its exact path: a parameter would let it match a prefix, writes included.
    if (r.method === 'POST' && names.length > 0) ctx.addIssue({ code: 'custom', path: ['path'], message: 'a POST route has a literal path (no {name} or {name*})' });
    for (const [name, shape] of Object.entries(r.params ?? {})) {
      if (!names.includes(name)) ctx.addIssue({ code: 'custom', path: ['params', name], message: `${name} is not a parameter of ${r.path}` });
      if ('anyOf' in shape || shape.type !== 'string') ctx.addIssue({ code: 'custom', path: ['params', name], message: 'a segment shape is a string shape' });
    }
    for (const [where, shape] of [
      ['query', r.query],
      ['body', r.body],
    ] as const) {
      for (const member of shape === undefined ? [] : topMembers(shape)) {
        if (METHOD_OVERRIDE_MEMBER.test(member)) ctx.addIssue({ code: 'custom', path: [where, member], message: `${member} is a method override member` });
      }
    }
    if (r.method === 'GET' && r.body !== undefined) ctx.addIssue({ code: 'custom', path: ['body'], message: 'a GET route has no body' });
    if (r.query !== undefined) {
      const q = r.query;
      const strings = 'type' in q && q.type === 'object' && Object.values(q.properties ?? {}).every((p) => ('anyOf' in p ? p.anyOf.every((a) => 'type' in a && a.type === 'string') : p.type === 'string'));
      if (!strings) ctx.addIssue({ code: 'custom', path: ['query'], message: 'a query shape is an object whose properties are strings' });
    }
    if (r.query !== undefined && shapeDepth(r.query) > MAX_SHAPE_DEPTH) ctx.addIssue({ code: 'custom', path: ['query'], message: `nested deeper than ${MAX_SHAPE_DEPTH}` });
    if (r.body !== undefined && shapeDepth(r.body) > MAX_SHAPE_DEPTH) ctx.addIssue({ code: 'custom', path: ['body'], message: `nested deeper than ${MAX_SHAPE_DEPTH}` });
    if ((r.envelope === true || r.envelope === 'when_present') && r.response !== 'json') ctx.addIssue({ code: 'custom', path: ['envelope'], message: 'only a JSON answer has an envelope' });
    if (r.parse !== undefined && (r.response === 'json' || r.response === 'bytes')) ctx.addIssue({ code: 'custom', path: ['parse'], message: 'parse is for text, xml and html answers' });
    if (r.media_types_by_extension !== undefined && Object.keys(r.media_types_by_extension).length > 32) {
      ctx.addIssue({ code: 'custom', path: ['media_types_by_extension'], message: 'at most 32 extension mappings' });
    }
    for (const name of Object.keys(r.headers ?? {})) {
      if (isReservedHeader(name)) ctx.addIssue({ code: 'custom', path: ['headers', name], message: `${name} is set by the transport, never by a profile` });
    }
  });
export type RouteDeclaration = z.infer<typeof RouteDeclaration>;

export const HeaderDeclaration = z.strictObject({ name: HeaderName, scheme: z.enum(HEADER_SCHEMES) }).superRefine((h, ctx) => {
  const lower = h.name.toLowerCase();
  if (isReservedHeader(lower) && lower !== 'authorization') ctx.addIssue({ code: 'custom', path: ['name'], message: `${h.name} cannot carry a credential` });
});

export const CredentialDeclaration = z.strictObject({
  name: CredentialName,
  digest: DigestRuleSchema.describe('what the vault keeps and the request carries: the value as given, or Base64(SHA-512(value))'),
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
    absent_codes:z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe('Projection error codes that explicitly mean this whole object is absent; valid only with fully readable supporting responses'),
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
    const carrying = new Set(p.auth.kind === 'none' ? [] : p.auth.roles);
    let login: PathTemplate | null = null;
    if (p.auth.kind === 'login_token') {
      try {
        login = parsePathTemplate(p.auth.login.path);
      } catch {
        // reported by LoginDeclaration
      }
    }
    p.routes.forEach((route, i) => {
      if (routes.has(route.id)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'id'], message: `route ${route.id} is declared twice` });
      routes.set(route.id, route);
      if (!roles.has(route.role)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'role'], message: `role ${route.role} is not declared` });
      if ((route.envelope === true || route.envelope === 'when_present') && p.envelope === undefined) ctx.addIssue({ code: 'custom', path: ['routes', i, 'envelope'], message: 'the profile declares no envelope' });
      const signature = `${route.role} ${route.method} ${route.path}`;
      if (signatures.has(signature)) ctx.addIssue({ code: 'custom', path: ['routes', i, 'path'], message: `two routes of ${route.role} are ${route.method} ${route.path}` });
      signatures.add(signature);
      if (p.auth.kind !== 'none') {
        for (const name of Object.keys(route.headers ?? {})) {
          if (name.toLowerCase() === p.auth.header.name.toLowerCase()) ctx.addIssue({ code: 'custom', path: ['routes', i, 'headers', name], message: 'the credential header is set by the transport' });
        }
      }
      let template: PathTemplate;
      try {
        template = parsePathTemplate(route.path);
      } catch {
        return;
      }
      // A rest parameter that carries the credential reaches every path below its prefix: each segment is held to a pattern.
      for (const part of template.parts) {
        if (!('param' in part) || !part.rest || !carrying.has(route.role)) continue;
        const shape = route.params?.[part.param];
        if (shape === undefined || 'anyOf' in shape || shape.type !== 'string' || shape.pattern === undefined) {
          ctx.addIssue({ code: 'custom', path: ['routes', i, 'params'], message: `{${part.param}*} of role ${route.role}, which carries the credential, needs a segment pattern in params` });
        }
      }
      // The login exchange is sent by the Hub's login handling only, never as a read (its answer would be stored and logged).
      // A route of another role reaches it only when the deployment gives both roles one base URL; the transport refuses
      // such a request by its URL.
      if (login !== null && p.auth.kind === 'login_token' && route.role === p.auth.login.role && templateReaches(template, login)) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'path'], message: `route ${route.id} reaches the login path ${p.auth.login.path}` });
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
    system_pack: ExactPackRef.describe('the published system pack version this configuration binds; another version needs a new decision'),
    system_pack_digest: Sha256.describe('the content digest of that version when it was bound; other content is not used'),
    name: z.string().min(1).max(200),
    environment: EnvironmentSchema,
    origins: z.record(RoleName, BaseUrl).describe('base URL of each role of the system pack'),
    allow_plaintext: z.array(z.string().max(300)).max(16).describe('origins (scheme://host[:port]) whose plain HTTP may carry credentials'),
    credentials: z.record(CredentialName, z.union([VaultEntryName, SecretReference])).describe('named secret reference of each credential; legacy vault entry names are decoded only for history'),
    credential_digests: z.record(CredentialName, DigestRuleSchema).describe('the digest rule each credential is kept under in the vault'),
    settings: z.record(z.string(), z.unknown()).describe('non-secret deployment values handed to the read functions as input.settings'),
    limits: ResourceLimits.optional(),
    created_by: UserId,
    created_at: IsoTime,
  })
  .superRefine((r, ctx) => {
    const named = Object.keys(r.credentials).sort().join('\n');
    if (Object.keys(r.credential_digests).sort().join('\n') !== named) ctx.addIssue({ code: 'custom', path: ['credential_digests'], message: 'a digest rule for exactly the credentials' });
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
/** Activation/routing snapshot supplied by the registry, including the types declared by each bound system pack. */
export const ReadResourceRoutingSet=z.array(z.strictObject({resource:ResourceId,environment:EnvironmentSchema,enabled:z.boolean(),types:z.array(ExternalType).min(1)})).superRefine((resources,ctx)=>{
  const owners=new Map<string,string>();
  resources.forEach((resource,index)=>{if(!resource.enabled)return;resource.types.forEach((type,at)=>{
    const key=resource.environment+':'+type,old=owners.get(key);
    if(old!==undefined&&old!==resource.resource)ctx.addIssue({code:'custom',path:[index,'types',at],message:'an environment and external type have at most one enabled resource'});
    owners.set(key,resource.resource);
  });});
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

/**
 * A response as the read functions see it (no URL, no header values, no credential). An answer stored at read tier
 * retain_only (a credential hit, or the echo of a credential the Hub sent) has no json, text or model and `ok: false`.
 */
export const ReadResponse = z.strictObject({
  ok: z.boolean().describe('2xx, a valid body of the declared kind, for an envelope route an ok code, and readable by functions'),
  route: RouteId,
  path: z.string().describe('the requested path relative to the base URL of the route role, as sent'),
  query: z.record(z.string(), z.string()),
  status: z.number().int().nullable(),
  media_type: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  sha256: Sha256.nullable().describe('digest of the stored response body'),
  etag: z.string().nullable(),
  location:z.string().max(4096).optional().describe('Observed Location, only when safe to disclose; a redirect is followed only by a separately planned request'),
  location_redacted:z.literal(true).optional(),
  json: z.unknown().optional().describe('the parsed answer of a json route'),
  text: z.string().optional().describe('the decoded answer of a text, xml or html route (or of a json route that did not parse)'),
  model: z.unknown().optional().describe('the model of the core parser the route names'),
  error: z.strictObject({ code: z.string(), message: z.string(), retry_at:IsoTime.optional(), attempts:z.number().int().positive().optional() }).nullable(),
});
export type ReadResponse = z.infer<typeof ReadResponse>;

/** A read of another external object the planner asked for, served from the cache unless refreshed. */
export const NestedRead = z.strictObject({
  coverage:Coverage.optional(),
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
  concurrency:z.number().int().min(1).max(MAX_READ_REQUESTS).optional().describe('Optional lower in-flight limit for this plan; the resource limit still applies'),
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

/** A system-level observation of absence, not a permission-neutral failure. */
export const SourceAbsent=z.strictObject({
  code:z.literal('SOURCE_ABSENT' satisfies ProtocolCode),
  system:PackId,
  object:ExternalObjectId,
  observed_at:IsoTime,
  responses:z.array(RequestKey).min(1).optional().describe('Stored response keys that support the observation; the service verifies them against the current read'),
});
export type SourceAbsent=z.infer<typeof SourceAbsent>;

export const ReadProjectionOutput = z.union([
  z.strictObject({
    revision: z.string().min(1).max(200).nullable().optional().describe('the revision of the object, when the system has one'),
    artifacts: z.array(DerivedArtifact).max(MAX_DERIVED_ARTIFACTS),
    absent:SourceAbsent.optional().describe('A determinate authorized absence; the service binds its originals and never turns permission denial into this observation'),
    complete: z.boolean().optional().describe('false when the projection saw that the read did not cover the object; it never makes coverage complete'),
    note: z.string().max(500).optional(),
    warnings: z.array(z.string().max(500)).max(50).optional(),
  }).superRefine((output,ctx)=>{if(output.absent!==undefined){if(output.artifacts.length)ctx.addIssue({code:'custom',path:['artifacts'],message:'an absent object has no found-content artifacts'});if(output.complete===false)ctx.addIssue({code:'custom',path:['complete'],message:'an incomplete lookup cannot assert whole-object absence'});}}).meta({allOf:[{if:{required:['absent'],properties:{absent:{}}},then:{properties:{artifacts:{type:'array',maxItems:0},complete:{const:true}}}}]}),
  z.strictObject({
    error: z.strictObject({ code: z.string().min(1).max(100), message: z.string().max(2000) }),
    warnings: z.array(z.string().max(500)).max(50).optional(),
  }),
]);
export type ReadProjectionOutput = z.infer<typeof ReadProjectionOutput>;

// ---------------------------------------------------------------- read-manifest@1 (a B05 read action)

export const ReadRequestEntry = z.strictObject({
  attempt:z.number().int().positive().optional().describe('Physical attempt within this planned request, including the single login replay'),
  retry_at:IsoTime.optional().describe('Earliest scheduled retry time; long Retry-After values end the bounded wait instead of being shortened'),
  key: RequestKey,
  round: z.number().int().min(1).max(MAX_READ_ROUNDS),
  route: RouteId,
  method: z.enum(HTTP_METHODS),
  path: z.string().max(4096).describe('the path as sent; a refused longer one is cut and ends with …sha256:<digest of the whole path>'),
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
  location:z.string().max(4096).optional(),
  location_redacted:z.literal(true).optional(),
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
  variables: z.array(VariableUse).optional().describe('exact named deployment decisions used by this read'),
  reason: z.string().max(2000).nullable().describe('why the read failed, for the admin log'),
  warnings: z.array(z.string().max(500)).max(50),
});
export type ReadManifest = z.infer<typeof ReadManifest>;

// D03 write declarations; deployment data contains names, never a target-specific protocol in core code.
const WriteCall=z.strictObject({tool:z.string().min(1).max(128),arguments:z.record(z.string(),z.unknown()),timeout_ms:z.number().int().min(1).max(600000).default(30000)});
export const WriteDeclaration=z.strictObject({
 interaction:WriteInteractionSchema,
 effect_class:EffectClassSchema,retry_safety:RetrySafetySchema,signing:SigningSchema,reversible:z.boolean(),
 target_key:z.unknown().refine(value=>value!==undefined,{message:'target key binding is required'}),
 audience:z.string().min(1).max(500).nullable(),
 evidence:z.strictObject({call:z.string().min(1).max(128),pointer:JsonPointer}),
 before_state:z.strictObject({call:WriteCall,pointer:JsonPointer,expected:z.unknown().refine(value=>value!==undefined),conditional_write:z.boolean()}).optional(),
 refusal:z.strictObject({stage:JsonPointer,reached_device:JsonPointer}),
 writes_hub_records:z.boolean(),
});
export type WriteDeclaration=z.infer<typeof WriteDeclaration>;
function executorShapes(){
const valueRef = z.strictObject({ $value: z.string().min(1).max(100) });
const pointer = z.string().max(500).refine(p => p === '' || /^\/(?:[^~]|~[01])*$/.test(p));
const call = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()), timeout_ms: z.number().int().min(1).max(600000).default(30000) });
const certificate = z.strictObject({ version: z.string().min(1).max(200), evidence: z.array(z.string().regex(/^src:[a-f0-9]{64}$/)).min(1).max(20) });
const acceptance = z.record(z.string(), AcceptanceSchema);
const requestIdentity = z.strictObject({epoch:pointer,since:pointer,subject:pointer});
const state = z.strictObject({ action_result: ActionResultSchema.optional(), acceptance: AcceptanceSchema.optional(), effect_outcome: EffectOutcomeSchema.optional(), dynamic_terminal: DynamicTerminalSchema.optional() }).refine(s => Object.keys(s).length > 0);
const conditions = z.array(z.strictObject({ pointer, equals: z.unknown().optional(), at_least: z.union([z.number(), valueRef]).optional(), sha256: z.union([z.string().regex(/^[a-f0-9]{64}$/), valueRef]).optional() }).refine(c => Number(Object.hasOwn(c, 'equals')) + Number(c.at_least !== undefined) + Number(c.sha256 !== undefined) === 1)).max(100).default([]);
function compiled(pattern: string): boolean { try { new RegExp(pattern); return true; } catch { return false; } }
function oneNamedGroup(pattern: string): boolean {
  if (!compiled(pattern)) return false;
  let groups = 0, bracket = false;
  for (let i=0;i<pattern.length;i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] === '[') bracket=true; else if (pattern[i] === ']') bracket=false;
    if (!bracket && pattern.slice(i,i+3) === '(?<' && !['=','!'].includes(pattern[i+3])) groups++;
  }
  return groups === 1;
}
const extraction = z.strictObject({command:z.string().min(1).max(10000),pattern:z.string().min(1).max(2000).refine(oneNamedGroup)});
/**
 * Which of the bound manifest's devices commands are dispatched to (P07 R[1], C07 R[4]). Declared, never recognised: the
 * pointer to the type field of one device and the closed set of declared type values that are dispatch targets, compared
 * by exact equality. Only those devices need a probe seat; every other listed device keeps its manifest identity for the
 * topology and the address bindings, is not probed and is not dispatched to. Absent: every listed device is a target.
 */
const dispatchTargets = z.strictObject({ type_field: pointer.refine(p => p !== '', { message: '派发目标的类型字段需要设备内的指针' }), types: z.array(z.string().min(1).max(200)).min(1).max(50) });
const namedPointer = pointer.refine(p => p !== '', { message: '床面快照的解析指针不能是整份根' });
const bedFields = z.array(z.strictObject({ name: z.string().min(1).max(80), pointer: namedPointer })).min(1).max(16);
const textTableColumn = z.strictObject({
  name: z.string().min(1).max(80),
  start: z.number().int().min(0).default(0),
  end: z.number().int().min(0).optional(),
  cidr: z.boolean().default(false),
});
/** Read-only show snapshots. Parsers name structure; nothing here is matched by wording. */
const bedState = z.strictObject({
  bed: namedPointer.optional(),
  items: z.array(z.strictObject({
    id: z.string().min(1).max(80),
    seat: z.string().min(1).max(80).optional(),
    call,
    output: namedPointer.default('/output'),
    lead: z.array(z.string().min(1).max(500)).max(16).default([]),
    trail: z.array(z.string().min(1).max(500)).max(16).default([]),
    parser: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('address_table'),
        rows: namedPointer,
        address: namedPointer,
        manifest_device: namedPointer.optional(),
        manifest_devices: namedPointer.optional(),
        manifest_lists: z.array(namedPointer).min(1).max(4),
      }),
      z.strictObject({
        kind: z.literal('config_list'),
        rows: namedPointer,
        identity: namedPointer,
        fields: bedFields,
        snapshot_only: z.boolean().default(false),
        manifest_rows: namedPointer.optional(),
        manifest_identity: namedPointer.optional(),
        manifest_fields: bedFields.optional(),
      }),
      z.strictObject({
        kind: z.literal('text_table'),
        text: namedPointer.optional(),
        header: z.string().min(1).max(500).optional(),
        columns: z.array(textTableColumn).max(16).default([]),
        address: z.string().min(1).max(80).optional(),
        identity: z.string().min(1).max(80).optional(),
        fields: bedFields.optional(),
        snapshot_only: z.boolean().default(false),
        manifest_device: namedPointer.optional(),
        manifest_devices: namedPointer.optional(),
        manifest_lists: z.array(namedPointer).min(1).max(4).optional(),
        manifest_rows: namedPointer.optional(),
        manifest_identity: namedPointer.optional(),
        manifest_fields: bedFields.optional(),
      }),
    ]).optional(),
    cleanup: z.strictObject({ actor: z.string().min(1).max(200), command: z.string().min(1).max(500) }),
  })).min(1).max(20),
}).superRefine((state, ctx) => {
  if (new Set(state.items.map(item => item.id)).size !== state.items.length) ctx.addIssue({ code: 'custom', message: '床面快照项名称不得重复' });
  for (const item of state.items) {
    if (item.parser) {
      if (item.parser.kind === 'address_table') {
        if (!item.parser.manifest_device && !item.parser.manifest_devices) {
          ctx.addIssue({ code: 'custom', message: '地址表快照必须声明 manifest_device 或 manifest_devices' });
        }
      }
      if (item.parser.kind === 'config_list') {
        if (!item.parser.snapshot_only) {
          if (!item.parser.manifest_rows || !item.parser.manifest_identity || !item.parser.manifest_fields) {
            ctx.addIssue({ code: 'custom', message: '未声明 snapshot_only 的配置快照必须声明 manifest_rows、manifest_identity 和 manifest_fields' });
          } else {
            const names = item.parser.fields.map(field => field.name);
            const manifest = item.parser.manifest_fields.map(field => field.name);
            if (new Set(names).size !== names.length || names.join('\0') !== manifest.join('\0')) {
              ctx.addIssue({ code: 'custom', message: '配置快照的字段名必须与清单字段名一一对应且不重复' });
            }
          }
        }
      }
      if (item.parser.kind === 'text_table') {
        const colNames = item.parser.columns.map(c => c.name);
        if (new Set(colNames).size !== colNames.length) {
          ctx.addIssue({ code: 'custom', message: '文本表格的列名不得重复' });
        }
        if (item.parser.fields && item.parser.manifest_fields && !item.parser.snapshot_only) {
          const names = item.parser.fields.map(field => field.name);
          const manifest = item.parser.manifest_fields.map(field => field.name);
          if (new Set(names).size !== names.length || names.join('\0') !== manifest.join('\0')) {
            ctx.addIssue({ code: 'custom', message: '配置快照的字段名必须与清单字段名一一对应且不重复' });
          }
        }
      }
    }
  }
});
const probes = z.strictObject({devices:pointer.optional(),dispatch_targets:dispatchTargets.optional(),command_pattern:z.string().min(1).max(2000).refine(p=>p.startsWith('^') && p.endsWith('$') && compiled(p)),call,output:pointer,seats:z.array(z.strictObject({seat:z.string().min(1).max(200),index:z.number().int().min(0),manifest:z.strictObject({device:pointer,addresses:pointer,address:pointer}),version:extraction,interfaces:extraction})).min(1).max(100)}).superRefine((p,ctx)=>{
  const match = new RegExp(p.command_pattern);
  if (new Set(p.seats.map(s=>s.seat)).size !== p.seats.length || new Set(p.seats.map(s=>s.index)).size !== p.seats.length) ctx.addIssue({code:'custom',message:'探测座位名称和序号不得重复'});
  if (p.dispatch_targets && p.devices === undefined) ctx.addIssue({code:'custom',message:'派发目标声明需要设备集合指针 devices'});
  if (p.dispatch_targets && new Set(p.dispatch_targets.types).size !== p.dispatch_targets.types.length) ctx.addIssue({code:'custom',message:'派发目标的设备类型闭集不得重复取值'});
  for (const seat of p.seats) for (const step of [seat.version,seat.interfaces]) if (!match.test(step.command)) ctx.addIssue({code:'custom',message:'探测命令不符合声明的命令形状'});
});
const base = z.strictObject({
  credential: SecretReference.optional(),
  schema: z.literal('executor@1'), id: z.string().regex(/^exe_[0-9a-hjkmnp-tv-z]{26}$/).optional(), enabled: z.boolean().default(true),
  environment:EnvironmentSchema.optional(),
  retry_safety: RetrySafetySchema.default('unsafe'),
  target: z.string().min(1).max(200), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), endpoint: z.string().url().max(2048), ca: z.string().max(65536),
  premises: z.strictObject({ request_journal: certificate.optional(), result_ownership: certificate.optional(),retry_safety:certificate.optional(),conditional_write:certificate.optional(),window_resend:certificate.extend({window_ms:z.number().int().min(1).max(86400000000)}).optional() }).default({}),
  actor: z.strictObject({ header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/).refine(h => !h.toLowerCase().startsWith('mcp-') && !['authorization', 'cookie', 'host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'].includes(h.toLowerCase())), pattern: z.string().min(1).max(500).refine(p => { try { new RegExp(p); return p.startsWith('^') && p.endsWith('$'); } catch { return false; } }), max_length: z.number().int().min(1).max(512) }).optional(),
  limitations: z.array(z.string().min(1).max(1000)).max(50).default([]),
  precheck_context: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,199}$/)).max(100).default([]),
  max_run_ms: z.number().int().min(1).max(86400000), max_bytes: z.number().int().min(256).max(8388608).default(4194304),
  clock_skew_ms:z.number().int().min(0).max(600000).default(0),
  poll_ms: z.number().int().min(1).max(60000).default(2000), submit_timeout_ms: z.number().int().min(1).max(600000).default(300000),
  refused_tools: z.array(z.string().min(1).max(128)).max(100).default([]),
  allowed_tools: z.array(z.string().min(1).max(128)).min(1).max(100),
  payload_argument: pointer.refine(p => p !== ''),
  calls: z.strictObject({ acquire: call, heartbeat: call, release: call, precheck: call, submit: call.extend({write:WriteDeclaration.extend({effect_class:EffectClassSchema.extract(['job']),audience:z.null(),writes_hub_records:z.literal(true)}).optional()}), status: call, result: call, query: call.optional() }),
  lease: z.strictObject({ id: pointer, token: pointer, ttl_ms: pointer, ttl_scale_ms: z.number().positive().default(1), acceptance: pointer, map: acceptance }),
  receipt: z.strictObject({ identity:requestIdentity.optional(), stage: pointer.optional(), reached_device: pointer.optional(), stages: z.record(z.string(), EffectOutcomeSchema).default({}), request_id: pointer.optional(), acceptance: pointer, map: acceptance, id: pointer, sha256: pointer, items: pointer }),
  conformance: z.strictObject({ expiry_margin_ms:z.number().int().min(1).max(600000).default(5000), expected_stage:z.string().min(1).max(200), payloads: z.array(z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/)).length(2).refine(p => p[0] !== p[1] && p.every(s=>Buffer.from(s,'base64').length>0 && Buffer.from(s,'base64').toString('base64')===s)) }).optional(),
  reconciliation: z.strictObject({ identity:requestIdentity.optional(), protocol_versions:z.array(z.string().min(1).max(200)).max(100).default([]), pending_states:z.array(z.string().min(1).max(200)).max(100).default([]), found: pointer, state: pointer, request_id: pointer, sha256: pointer, id: pointer, stage: pointer, reached_device: pointer, gateway_time: pointer, gc_before: pointer, time_scale_ms: z.number().positive().optional(), map: z.record(z.string(),EffectOutcomeSchema) }).optional(),
  status: z.strictObject({ pointer, exit_code: pointer.optional(), map: z.record(z.string(), state) }),
  result: z.strictObject({ ownership:z.strictObject({pointer,value:z.string().min(1).max(200),reason:pointer}).optional(), request_id:pointer.optional(), log_stale:pointer.optional().describe('relative to one result.items entry'), closing_marker:z.string().min(1).max(2000).optional(), log:pointer.optional().describe('relative to one result.items entry'), sessions:pointer.optional().describe('optional per-item evidence; successful cases may omit sessions; never a prerequisite for a device verdict'), id: pointer, sha256: pointer, submitted_at: pointer, submitted_at_scale_ms: z.number().positive().optional(), items: pointer.describe('response-root pointer to the item array'), item_id: pointer.describe('pointer relative to one item, not the response root'), item_outcome: pointer.describe('pointer relative to one item, not the response root; its exact scalar must be declared in result.map'), complete: pointer, map: z.record(z.string(), DynamicTerminalSchema) }),
  probes: probes.optional(),
  bed_state: bedState.optional(),
  side_effects: z.array(z.strictObject({message:z.string().min(1).max(2000),marker:z.string().min(1).max(2000).optional()})).max(100).default([]),
  read_retry_when: conditions,
  conditions,
  capture_pointers: z.array(pointer).max(100).default([]),
  precheck_reads: z.array(call.extend({ conditions, capture_pointers: z.array(pointer).max(100).default([]) })).max(20).default([]),
  proof: z.strictObject({ package: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/), manifest_sha256: pointer, requirement: z.string().min(1), warrant_id: z.string().min(1).max(300).nullable().default(null), slot: z.string().min(1).max(100), plan_run: pointer, sha256: pointer, items: pointer, target: pointer, build: pointer, generator: pointer }),
});
const definition=base.superRefine((d, ctx) => {
  if(d.calls.submit.write) {
    const w=d.calls.submit.write;
    if(w.effect_class!=='job')ctx.addIssue({code:'custom',path:['calls','submit','write','effect_class'],message:'执行器只能声明作业'});
    if(w.audience!==null)ctx.addIssue({code:'custom',path:['calls','submit','write','audience'],message:'作业没有对外受众空间'});
    if(!w.writes_hub_records)ctx.addIssue({code:'custom',path:['calls','submit','write','writes_hub_records'],message:'作业必须记录意图和效果'});
    if(w.evidence.call!==d.calls.result.tool || w.evidence.pointer!==d.result.sha256)ctx.addIssue({code:'custom',path:['calls','submit','write','evidence'],message:'回读证据须对应结果调用和摘要指针'});
    if(w.refusal.stage!==d.receipt.stage || w.refusal.reached_device!==d.receipt.reached_device)ctx.addIssue({code:'custom',path:['calls','submit','write','refusal'],message:'拒绝阶段须对应投递回执的声明'});
    if(w.before_state && (w.before_state.call.tool===d.calls.submit.tool || !d.allowed_tools.includes(w.before_state.call.tool)))ctx.addIssue({code:'custom',path:['calls','submit','write','before_state','call'],message:'前状态调用不在允许清单内'});
    if(w.before_state?.conditional_write && countBindings(d.calls.submit.arguments,'before_state')!==1)ctx.addIssue({code:'custom',path:['calls','submit','arguments'],message:'条件写必须且只能绑定一次 before_state'});
  } else if(d.retry_safety!=='unsafe' && d.retry_safety!=='dedup_window')ctx.addIssue({code:'custom',path:['retry_safety'],message:'其他重试类须提供完整写声明'});
  const u = new URL(d.endpoint); const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))) ctx.addIssue({ code: 'custom', message: '端点必须固定为 HTTPS，明文只允许回环，地址不带凭据、查询或片段' });
  if (u.protocol === 'https:') try { new X509Certificate(d.ca); } catch { ctx.addIssue({ code: 'custom', message: 'HTTPS 需要固定 CA 证书' }); }
  if (new Set(d.resources).size !== d.resources.length || new Set(d.allowed_tools).size !== d.allowed_tools.length) ctx.addIssue({ code: 'custom', message: '资源键和允许工具不得重复' });
  const bedCalls = d.bed_state?.items.map(item => item.call) ?? [];
  for (const c of [...Object.values(d.calls), ...d.precheck_reads, ...(d.probes ? [d.probes.call] : []), ...bedCalls]) if (!d.allowed_tools.includes(c.tool)) ctx.addIssue({ code: 'custom', message: '生命周期调用不在允许工具清单内' });
  if (d.refused_tools.some(name=>d.allowed_tools.includes(name))) ctx.addIssue({code:'custom',message:'同一工具不能既被允许又被拒绝'});
  { // Every dispatch carries its durable request/sequence identity, including unsafe legacy executors.
    if (['request_id','dispatch_sequence','sequence_scope'].some(name=>countBindings(d.calls.submit.arguments,name)!==1)) ctx.addIssue({code:'custom',message:'请求协议必须各绑定一次请求身份、派发序号与执行器序号流；绝对截止不由目标判定'});
  }
  if (d.reconciliation && (!d.calls.query || !d.receipt.request_id || countBindings(d.calls.query.arguments,'request_id') !== 1)) ctx.addIssue({code:'custom',message:'查账必须绑定原请求身份并登记回执身份指针'});
  if (d.probes && ['command','seat_index','lease_id'].some(key=>countBindings(d.probes!.call.arguments,key)!==1))ctx.addIssue({code:'custom',message:'座位探测必须各绑定一次命令、座位序号和本次租约身份'});
  if (d.bed_state?.items.some(item => countBindings(item.call.arguments, 'lease_id') !== 1)) ctx.addIssue({ code: 'custom', message: '床面快照必须且只能绑定一次本次租约身份' });
  if(Object.entries(d.calls).some(([role,c])=>role!=='submit' && c?.tool===d.calls.submit.tool) || d.precheck_reads.some(c=>c.tool===d.calls.submit.tool) || d.probes?.call.tool===d.calls.submit.tool || d.bed_state?.items.some(item => item.call.tool === d.calls.submit.tool))ctx.addIssue({code:'custom',message:'提交工具不能同时作为租约、读取或探测工具'});
  const payload = at(d.calls.submit.arguments, d.payload_argument);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || (payload as Record<string, unknown>).$value !== 'payload_base64' || countPayloadBindings(d.calls.submit.arguments) !== 1) ctx.addIssue({ code: 'custom', message: '提交内容参数必须且只能绑定一次已核验字节' });
  for (const [role, c] of Object.entries(d.calls)) if (role !== 'submit' && countPayloadBindings(c.arguments)) ctx.addIssue({ code: 'custom', message: '非提交角色不能携带工作内容字节' });
  if ([...d.precheck_reads,...(d.probes ? [d.probes.call] : []), ...(d.bed_state?.items.map(item => item.call) ?? [])].some(c => countPayloadBindings(c.arguments))) ctx.addIssue({ code: 'custom', message: '只读核对不能携带工作内容字节' });
});
function at(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current = value;
  for (const segment of pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
function countBindings(value:unknown,key:string):number {
  if(Array.isArray(value))return value.reduce((n,v)=>n+countBindings(v,key),0);
  if(value && typeof value==='object') {
    const o=value as Record<string,unknown>;
    if(Object.keys(o).length===1 && o.$value===key)return 1;
    return Object.values(o).reduce<number>((n,v)=>n+countBindings(v,key),0);
  }
  return 0;
}
function countPayloadBindings(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, v) => n + countPayloadBindings(v), 0);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && o.$value === 'payload_base64') return 1;
    return Object.values(o).reduce<number>((n, v) => n + countPayloadBindings(v), 0);
  }
  return 0;
}


return {base,definition,call,conditions,valueRef};
}
const executor=executorShapes();
export const ExecutorDefinition=executor.definition;
export type ExecutorDefinition=z.infer<typeof ExecutorDefinition>;
// Source definitions permit ordinary variables only in expected values; write declarations and environment stay literal.
function executorExpected(pointer:string):boolean {return pointer==='/target'||pointer==='/manifest_sha256'||/^\/(?:conditions\/\d+|precheck_reads\/\d+\/conditions\/\d+)\/(?:equals(?:\/.*)?|at_least|sha256)$/.test(pointer);}
export function checkedExecutorReferences(input:unknown){const refs=referencesIn(input);for(const ref of refs){const segments=ref.at.split('/').slice(1).map(s=>s.replaceAll('~1','/').replaceAll('~0','~'));if(segments.includes('$value'))throw new VariableInputError('期望值只能是字面值或整值变量；引用不能进入 $value 调用绑定，请修正执行器源定义后重新登记',ref.at);if(!(ref.kind==='secret'&&ref.at==='/credential')&&!(ref.kind==='var'&&executorExpected(ref.at)))throw new VariableInputError('这一处不许引用变量；只有期望值可引用普通变量，credential 只引用密钥',ref.at);}return refs;}
const ExecutorVariableReference=z.string().regex(/^\$\{var:[A-Z][A-Z0-9_]{0,63}\}$/);
const SourceConditions=z.array(z.strictObject({pointer:JsonPointer,equals:z.unknown().optional(),at_least:z.union([z.number(),executor.valueRef,ExecutorVariableReference]).optional(),sha256:z.union([Sha256,executor.valueRef,ExecutorVariableReference]).optional()}).refine(c=>Number(Object.hasOwn(c,'equals'))+Number(c.at_least!==undefined)+Number(c.sha256!==undefined)===1)).max(100).default([]);
export const ExecutorSource=executor.base.extend({manifest_sha256:z.union([Sha256,ExecutorVariableReference]).nullable().default(null),conditions:SourceConditions,precheck_reads:z.array(executor.call.extend({conditions:SourceConditions,capture_pointers:z.array(JsonPointer).max(100).default([])})).max(20).default([])}).superRefine((input,ctx)=>{
 try {
  checkedExecutorReferences(input);
  const candidate=resolveExecutorReferences(input,(kind,name,pointer)=>kind==='secret'?'${secret:'+name+'}':pointer==='/target'?'DEMO_TARGET':pointer==='/manifest_sha256'||pointer.endsWith('/sha256')?'0'.repeat(64):pointer.endsWith('/at_least')?0:null);
  const parsed=ExecutorDefinition.safeParse(candidate);
  if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue({code:'custom',path:issue.path,message:issue.message});
 }catch(error){ctx.addIssue({code:'custom',message:error instanceof VariableInputError?error.message:'定义不是可安全解析的 JSON'});}
});
export type ExecutorSource=z.infer<typeof ExecutorSource>;

/** Append-only B06 snapshots; early refusals have no allocated intent or request identity. */
export const EffectRecord=z.strictObject({
 schema:z.literal('effect@1'),job:Sha256,run:RunId.nullable(),intent_key:Sha256.nullable(),request_id:z.string().min(1).nullable(),not_after:IsoTime.nullable(),dispatch_sequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),sequence_scope:z.string().min(1).nullable().optional(),
 action_digest:Sha256.nullable(),target_key:Sha256,covered_items:z.array(z.string().min(1)),
 effect_class:EffectClassSchema,retry_safety:RetrySafetySchema,signing:SigningSchema,
 content_sha256:Sha256.nullable(),before_state:z.strictObject({bound:z.boolean(),sha256:Sha256.nullable(),reference:z.string().nullable()}),
 writing_identity:z.strictObject({credential:SecretReference.nullable(),on_behalf_of:UserId,subject:z.unknown()}),
 audience:z.null(),outcome:EffectOutcomeSchema,marks:z.array(EffectMarkSchema),previous:Sha256.nullable(),
 boundary:z.strictObject({clause:z.number().int().min(1).max(9),code:z.enum(Object.keys(PROTOCOL_CODES) as [ProtocolCode,...ProtocolCode[]]),row:z.string().nullable()}).nullable(),
 missing:MissingFact.optional(),exit:UnknownExit.optional(),
}).superRefine((effect,ctx)=>{if(effect.outcome==='unknown'){if(!effect.missing)ctx.addIssue({code:'custom',path:['missing'],message:'an unknown effect names its missing fact'});if(!effect.exit)ctx.addIssue({code:'custom',path:['exit'],message:'an unknown effect names its next action'});}}).meta(recoveryCondition('outcome',['unknown'],['missing','exit']));
export type EffectRecord=z.infer<typeof EffectRecord>;

export const schemas: Record<string, z.ZodType> = {
  'effect@1':EffectRecord,
  'write-declaration@1':WriteDeclaration,
  'executor@1':ExecutorSource,
  'system@1': SystemProfile,
  'resource@1': ResourceRecord,
  'read-manifest@1': ReadManifest,
  'read-plan-input@1': ReadPlanInput,
  'read-plan-output@1': ReadPlanOutput,
  'read-projection-input@1': ReadProjectionInput,
  'read-projection-output@1': ReadProjectionOutput,
};
