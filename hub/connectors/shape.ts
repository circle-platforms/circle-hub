// Checks a query or a JSON body against the shape a route declares (the JSON Schema subset of contracts/src/resources.ts).
// Total and bounded: objects are closed, strings and arrays have maxima checked before anything else, a pattern is one
// bracket class with one quantifier (linear time) and runs only on a string already within its maximum length.
import { MAX_SHAPE_DEPTH, simplePatternProblem, type Shape } from '../../contracts/src/resources.ts';

const compiled = new Map<string, RegExp>();

function regex(pattern: string): RegExp | null {
  let found = compiled.get(pattern);
  if (found === undefined) {
    if (simplePatternProblem(pattern) !== null) return null;
    found = new RegExp(pattern, 'u');
    if (compiled.size > 1000) compiled.clear();
    compiled.set(pattern, found);
  }
  return found;
}

const pointer = (at: string, key: string | number): string => `${at}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

/** Code points of a string, stopping once `max` is passed. */
function codePoints(text: string, max: number): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
    if (count > max) break;
  }
  return count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The first problem of `value` against `shape` as `<JSON Pointer>: <reason>`, or null when it fits. */
export function shapeProblem(shape: Shape, value: unknown, at = '', depth = 0): string | null {
  if (depth > MAX_SHAPE_DEPTH) return `${at || '/'}: nested deeper than ${MAX_SHAPE_DEPTH}`;
  if ('anyOf' in shape) {
    for (const option of shape.anyOf) if (shapeProblem(option, value, at, depth + 1) === null) return null;
    return `${at || '/'}: fits none of the allowed forms`;
  }
  const where = at || '/';
  switch (shape.type) {
    case 'object': {
      if (!isPlainObject(value)) return `${where}: not an object`;
      const properties = shape.properties ?? {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return `${pointer(at, key)}: not an allowed member`;
      }
      for (const key of shape.required ?? []) {
        if (!Object.hasOwn(value, key)) return `${pointer(at, key)}: required`;
      }
      for (const [key, inner] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const problem = shapeProblem(inner, value[key], pointer(at, key), depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${where}: not an array`;
      if (value.length > shape.maxItems) return `${where}: more than ${shape.maxItems} items`;
      if (shape.minItems !== undefined && value.length < shape.minItems) return `${where}: fewer than ${shape.minItems} items`;
      for (let i = 0; i < value.length; i++) {
        const problem = shapeProblem(shape.items, value[i], pointer(at, i), depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${where}: not a string`;
      // UTF-16 length bounds the code points from above, so very long input is refused before it is walked.
      if (value.length > shape.maxLength * 2) return `${where}: longer than ${shape.maxLength}`;
      const length = codePoints(value, shape.maxLength);
      if (length > shape.maxLength) return `${where}: longer than ${shape.maxLength}`;
      if (shape.minLength !== undefined && length < shape.minLength) return `${where}: shorter than ${shape.minLength}`;
      if (shape.const !== undefined && value !== shape.const) return `${where}: not the required value`;
      if (shape.enum !== undefined && !shape.enum.includes(value)) return `${where}: not one of the allowed values`;
      if (shape.pattern !== undefined) {
        const re = regex(shape.pattern);
        if (re === null) return `${where}: the pattern is not linear`;
        if (!re.test(value)) return `${where}: does not match ${shape.pattern}`;
      }
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `${where}: not an integer`;
      if (shape.minimum !== undefined && value < shape.minimum) return `${where}: below ${shape.minimum}`;
      if (shape.maximum !== undefined && value > shape.maximum) return `${where}: above ${shape.maximum}`;
      if (shape.enum !== undefined && !shape.enum.includes(value)) return `${where}: not one of the allowed values`;
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${where}: not a number`;
      if (shape.minimum !== undefined && value < shape.minimum) return `${where}: below ${shape.minimum}`;
      if (shape.maximum !== undefined && value > shape.maximum) return `${where}: above ${shape.maximum}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${where}: not a boolean`;
    case 'null':
      return value === null ? null : `${where}: not null`;
    default:
      return `${where}: unknown shape`;
  }
}
