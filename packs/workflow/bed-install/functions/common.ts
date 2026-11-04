// Shared parts of the bed-install functions: the declared install table (policies/install.json), the deployment's install
// profile (a named document of shape bed-install-profile@1: the test framework's upgrade cases and the image extensions they
// handle) and the upgrade case's rule for image names. The projection reads the profile and freezes it with the run; the
// checks read only what was frozen, so the two cannot disagree.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const GENERATOR = 'bed-install.request@1';
export const REQUEST_SCHEMA = 'bed-install@1';
export const TABLE_SCHEMA = 'bed-install.install@2';

export interface InstallTable {
  /** The schema the install profile document must have. */
  profile_schema: string;
  /** Inventory device types the upgrade runs on (the bed's dispatch targets), compared by equality. */
  device_types: string[];
  /** Where each dispatch parameter sits in the install fact. */
  parameters: Record<string, string>;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry !== '') ? (value as string[]) : null;

export function readTable(value: unknown): InstallTable | null {
  if (!isRecord(value) || value.schema !== TABLE_SCHEMA || !isRecord(value.parameters)) return null;
  const device_types = strings(value.device_types);
  const profile_schema = typeof value.profile_schema === 'string' && value.profile_schema !== '' ? value.profile_schema : null;
  const parameters = Object.fromEntries(Object.entries(value.parameters).filter(([, path]) => typeof path === 'string' && path.startsWith('/'))) as Record<string, string>;
  if (!device_types || profile_schema === null || Object.keys(parameters).length !== Object.keys(value.parameters).length) return null;
  return { profile_schema, device_types, parameters };
}

export interface InstallProfile {
  /** The framework's upgrade case of the i-th dispatch-target device, in inventory order. */
  upgrade_cases: string[];
  /** Image file extensions the upgrade case handles, without the dot. */
  image_extensions: string[];
}

const PROFILE_KEYS = ['image_extensions', 'schema', 'upgrade_cases'];
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EXTENSION = /^[A-Za-z0-9]{1,16}$/;

/**
 * The install profile as published: exactly {schema, upgrade_cases, image_extensions}, distinct case ids and extensions.
 * Otherwise the problems, each naming the field and what it must be, so the administrator can correct and republish.
 */
export function readProfile(model: unknown, schema: string): { ok: true; profile: InstallProfile } | { ok: false; problems: string[] } {
  if (!isRecord(model)) return { ok: false, problems: ['档案不是 JSON 对象'] };
  const problems: string[] = [];
  const keys = Object.keys(model).sort();
  const extra = keys.filter((key) => !PROFILE_KEYS.includes(key));
  if (extra.length > 0) problems.push(`多了 ${extra.join('、')}（只写 schema、upgrade_cases、image_extensions）`);
  if (model.schema !== schema) problems.push(`schema 要写 ${schema}`);
  const list = (key: string, rule: RegExp, what: string): string[] => {
    const value = model[key];
    if (!Array.isArray(value) || value.length === 0) {
      problems.push(`缺 ${key}（${what}，至少一项）`);
      return [];
    }
    const bad = value.filter((entry) => typeof entry !== 'string' || !rule.test(entry));
    if (bad.length > 0) problems.push(`${key} 里有 ${bad.length} 项不是${what}`);
    if (new Set(value).size !== value.length) problems.push(`${key} 里有重复项`);
    return value.filter((entry): entry is string => typeof entry === 'string');
  };
  const upgrade_cases = list('upgrade_cases', CASE_ID, '升级用例号（字母、数字和 . _ : -，至多 200 字）');
  const image_extensions = list('image_extensions', EXTENSION, '不带点的镜像扩展名（字母和数字，至多 16 字）');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, profile: { upgrade_cases, image_extensions } };
}

const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * The target version the upgrade case derives from the image file name (the text after the first '-' up to the last '.',
 * with '_' read as '.'); null when the name is not an image file of a declared extension.
 */
export function imageVersion(image: string, extensions: readonly string[]): string | null {
  if (!IMAGE_NAME.test(image) || !extensions.some((extension) => image.endsWith(`.${extension}`))) return null;
  const match = /-(.+)\./.exec(image);
  return match ? match[1].replace(/_/g, '.') : null;
}

/** The same reading applied to a build name: what the upgrade case compares the device's version with when it installs `build`. */
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
