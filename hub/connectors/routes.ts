// The route allow-list (D01 R[10]): a request goes out only when a route of the system profile matches its method AND its path
// template AND the shapes of its query and body. Matching is one route at a time, never by prefix or by method, so a write
// route that shares a prefix with read routes is refused, and a read that uses POST is allowed only on its listed route.
// Paths are compared as sent (percent-encoded): no dot segments, no encoded slash, backslash or NUL, no empty segment. A `;`
// starts a path parameter for servlet containers, which drop it before they resolve dot segments, so a segment whose part
// before the first `;` is empty or a dot segment (`..;`, `.;x`) is refused, and a segment that fills a template parameter
// never holds a raw `;`. A parameter's segment shape (`params`) is checked on every decoded segment it fills.
import { parsePathTemplate, type HttpMethod, type PathTemplate, type RouteDeclaration } from '../../contracts/src/resources.ts';
import { ConnectorError } from './errors.ts';
import { shapeProblem } from './shape.ts';

export interface CompiledRoute {
  declaration: RouteDeclaration;
  template: PathTemplate;
}

export interface ConcreteRequest {
  method: HttpMethod;
  /** Route-space path: relative to the base URL of the route's role, percent-encoded, starting with /. */
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const RAW_SEGMENT = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})+$/;
const BAD_ESCAPE = /%(?:2f|5c|00)/i;
export const MAX_PATH = 4096;

export function compileRoutes(routes: readonly RouteDeclaration[]): CompiledRoute[] {
  return routes.map((declaration) => ({ declaration, template: parsePathTemplate(declaration.path) }));
}

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Raw segments of a route-space path and whether it ends with /, or a reason why it is not a canonical path. */
export function splitPath(path: string): { segments: string[]; trailingSlash: boolean } | string {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'a path starts with /';
  if (path.length > MAX_PATH) return `a path is at most ${MAX_PATH} characters`;
  if (path === '/') return { segments: [], trailingSlash: false };
  const trailingSlash = path.endsWith('/');
  const segments = path.slice(1, trailingSlash ? -1 : undefined).split('/');
  for (const segment of segments) {
    if (segment === '') return 'a path has no empty segment';
    if (!RAW_SEGMENT.test(segment)) return 'a path segment has a character that must be percent-encoded';
    if (BAD_ESCAPE.test(segment)) return 'a path segment never encodes /, \\ or NUL';
    const text = decoded(segment);
    if (text === null) return 'a path segment has an invalid percent escape';
    if (text === '.' || text === '..') return 'a path has no dot segment';
    const head = text.split(';', 1)[0];
    if (head === '' || head === '.' || head === '..') return 'a path segment never starts with ; or with a dot segment followed by ;';
  }
  return { segments, trailingSlash };
}

/** The raw parameter values when the path fits the template, else null. A segment filling a parameter has no raw `;`. */
export function matchTemplate(template: PathTemplate, path: string): Record<string, string> | null {
  const split = splitPath(path);
  if (typeof split === 'string') return null;
  if (split.trailingSlash !== template.trailingSlash) return null;
  const params: Record<string, string> = {};
  let index = 0;
  for (const part of template.parts) {
    if ('literal' in part) {
      if (split.segments[index] !== part.literal) return null;
      index += 1;
    } else if (part.rest) {
      if (index >= split.segments.length) return null;
      const filled = split.segments.slice(index);
      if (filled.some((segment) => segment.includes(';'))) return null;
      params[part.param] = filled.join('/');
      index = split.segments.length;
    } else {
      if (index >= split.segments.length || split.segments[index].includes(';')) return null;
      params[part.param] = split.segments[index];
      index += 1;
    }
  }
  return index === split.segments.length ? params : null;
}

/** The first problem of the parameter values (raw, as matched) against the route's segment shapes, or null. */
function segmentProblem(route: CompiledRoute, values: Readonly<Record<string, string>>): string | null {
  const shapes = route.declaration.params ?? {};
  for (const [name, raw] of Object.entries(values)) {
    const shape = shapes[name];
    if (shape === undefined) continue;
    for (const segment of raw.split('/')) {
      const problem = shapeProblem(shape, decoded(segment) ?? segment, `/${name}`);
      if (problem !== null) return problem;
    }
  }
  return null;
}

function describe(request: ConcreteRequest): string {
  return `${request.method} ${request.path}`;
}

/**
 * The route the request is allowed by. With `named`, that route must be the one that matches. Throws ROUTE_REFUSED (before
 * any network I/O) when no route of the profile matches method, path, query and body.
 */
export function matchRoute(routes: readonly CompiledRoute[], request: ConcreteRequest, named?: string): CompiledRoute {
  const candidates = routes.flatMap((route) => {
    if (route.declaration.method !== request.method) return [];
    const values = matchTemplate(route.template, request.path);
    return values === null ? [] : [{ route, values }];
  });
  const problems: string[] = [];
  for (const { route, values } of candidates) {
    const d = route.declaration;
    if (named !== undefined && d.id !== named) {
      problems.push(`它对应路由 ${d.id}，而不是所指的 ${named}`);
      continue;
    }
    const pathProblem = segmentProblem(route, values);
    if (pathProblem !== null) {
      problems.push(`路径段不符合路由 ${d.id} 的参数形状：${pathProblem}`);
      continue;
    }
    const queryProblem = d.query === undefined ? (Object.keys(request.query).length === 0 ? null : '这条路由不带查询参数') : shapeProblem(d.query, request.query);
    if (queryProblem !== null) {
      problems.push(`查询参数不符合路由 ${d.id}：${queryProblem}`);
      continue;
    }
    const bodyProblem = d.body === undefined ? (request.body === undefined ? null : '这条路由不带请求体') : request.body === undefined ? '这条路由要求请求体' : shapeProblem(d.body, request.body);
    if (bodyProblem !== null) {
      problems.push(`请求体不符合路由 ${d.id}：${bodyProblem}`);
      continue;
    }
    return route;
  }
  const reason = candidates.length === 0 ? `路由清单里没有与 ${describe(request)} 相符的读路由` : `${describe(request)}：${problems.join('；')}`;
  throw new ConnectorError('ROUTE_REFUSED', `${reason}；请求在发出前被拒绝`, { layer: 'transport', detail: { method: request.method, path: request.path, ...(named ? { route: named } : {}) } });
}

function encodeSegment(value: string, what: string): string {
  if (value === '' || value === '.' || value === '..') throw new ConnectorError('PLAN_INVALID', `${what} 不能为空，也不能是 . 或 ..`, { layer: 'plugin' });
  if (/[/\\\u0000]/.test(value)) throw new ConnectorError('PLAN_INVALID', `${what} 不能含 /、\\ 或 NUL`, { layer: 'plugin' });
  try {
    return encodeURIComponent(value);
  } catch {
    throw new ConnectorError('PLAN_INVALID', `${what} 不是合法的 Unicode 文本`, { layer: 'plugin' });
  }
}

/** Fills a template with plain (not encoded) parameter values; `{name*}` values are split at /. */
export function buildPath(route: CompiledRoute, params: Readonly<Record<string, string>>): string {
  const names = new Set(route.template.parts.flatMap((part) => ('param' in part ? [part.param] : [])));
  for (const key of Object.keys(params)) {
    if (!names.has(key)) throw new ConnectorError('PLAN_INVALID', `路由 ${route.declaration.id} 没有参数 ${key}`, { layer: 'plugin' });
  }
  const segments: string[] = [];
  for (const part of route.template.parts) {
    if ('literal' in part) {
      segments.push(part.literal);
      continue;
    }
    const value = params[part.param];
    if (typeof value !== 'string') throw new ConnectorError('PLAN_INVALID', `路由 ${route.declaration.id} 缺参数 ${part.param}`, { layer: 'plugin' });
    if (part.rest) segments.push(...value.split('/').map((segment) => encodeSegment(segment, `参数 ${part.param} 的一段`)));
    else segments.push(encodeSegment(value, `参数 ${part.param}`));
  }
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}${route.template.trailingSlash ? '/' : ''}`;
}
