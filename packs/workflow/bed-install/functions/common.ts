// Shared parts of the bed-install functions: the declared install table (policies/install.json) and InfoTest's upgrade
// case rule for image names. Both the projection and the checks read the same table, so they cannot disagree.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const GENERATOR = 'bed-install.request@1';
export const REQUEST_SCHEMA = 'bed-install@1';

export interface InstallTable {
  /** Inventory device types the upgrade runs on (the bed's dispatch targets), compared by equality. */
  device_types: string[];
  /** The framework's upgrade case of the i-th dispatch-target device. */
  cases: string[];
  /** Image file extensions the upgrade case handles. */
  image_extensions: string[];
  /** Where each dispatch parameter sits in the install fact. */
  parameters: Record<string, string>;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry !== '') ? (value as string[]) : null;

export function readTable(value: unknown): InstallTable | null {
  if (!isRecord(value) || value.schema !== 'bed-install.install@1' || !isRecord(value.parameters)) return null;
  const device_types = strings(value.device_types), cases = strings(value.cases), image_extensions = strings(value.image_extensions);
  const parameters = Object.fromEntries(Object.entries(value.parameters).filter(([, path]) => typeof path === 'string' && path.startsWith('/'))) as Record<string, string>;
  if (!device_types || !cases || !image_extensions || Object.keys(parameters).length !== Object.keys(value.parameters).length) return null;
  return { device_types, cases, image_extensions, parameters };
}

const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * The target version InfoTest's upgrade case derives from the image file name (999999990.py: the text after the first '-'
 * up to the last '.', with '_' read as '.'); null when the name is not an image file of a declared extension.
 */
export function imageVersion(image: string, extensions: readonly string[]): string | null {
  if (!IMAGE_NAME.test(image) || !extensions.some((extension) => image.endsWith(`.${extension}`))) return null;
  const match = /-(.+)\./.exec(image);
  return match ? match[1].replace(/_/g, '.') : null;
}

/** The same reading applied to a build name: what the upgrade case compares show version with when it installs `build`. */
export const versionOfBuild = (build: string): string => build.replace(/_/g, '.');

export interface Request {
  build: string;
  image: string;
  /** Which attempt this is: the same bytes are dispatched at most once, so another try is a new request saying so. */
  attempt?: number;
}

/** The uploaded request: {schema, build, image} and an optional attempt; the problem in words otherwise. */
export function readRequest(model: unknown): { ok: true; request: Request } | { ok: false; problem: string } {
  if (!isRecord(model)) return { ok: false, problem: '装构建请求不是 JSON 对象' };
  const keys = Object.keys(model).sort();
  const extra = keys.filter((key) => !['attempt', 'build', 'image', 'schema'].includes(key));
  if (extra.length > 0 || !['build', 'image', 'schema'].every((key) => keys.includes(key))) return { ok: false, problem: `装构建请求是 schema、build、image 三项，再装一次时加 attempt（现在是 ${keys.join('、') || '空的'}）` };
  if (model.schema !== REQUEST_SCHEMA) return { ok: false, problem: `装构建请求的 schema 要写 ${REQUEST_SCHEMA}` };
  if (typeof model.build !== 'string' || model.build === '' || typeof model.image !== 'string' || model.image === '') return { ok: false, problem: '装构建请求的 build 和 image 要是不空的文字' };
  if (model.attempt !== undefined && (typeof model.attempt !== 'number' || !Number.isInteger(model.attempt) || model.attempt < 1 || model.attempt > 1000)) return { ok: false, problem: '装构建请求的 attempt 是第几次装（1 到 1000 的整数）' };
  return { ok: true, request: { build: model.build, image: model.image, ...(model.attempt !== undefined ? { attempt: model.attempt as number } : {}) } };
}
