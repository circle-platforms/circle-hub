// Import policy for pack functions, shared by the parent (sandbox.ts) and the child (bootstrap.ts). No imports: the child
// reads this file under the permission model before any lockdown is in place.

// Names carry the SHA-256 prefix of the exact worker rules; linux.ts verifies it before emitting a policy.
export const LINUX_WORKER_RULES = 'file,\nsignal,\nnetwork unix,\ndeny network inet,\ndeny network inet6,\ndeny /** w,\ndeny /** x,\n';
export const LINUX_POLICY_REVISION = '17338cfaea07';
export const LINUX_LAUNCH_PROFILE = `circle-hub-sandbox-launch-v2-${LINUX_POLICY_REVISION}`;
export const LINUX_WORKER_PROFILE = `circle-hub-sandbox-worker-v2-${LINUX_POLICY_REVISION}`;
export const LINUX_LABEL = `${LINUX_LAUNCH_PROFILE}//&${LINUX_WORKER_PROFILE} (enforce)`;
// Ubuntu 26 stacks the unconfined domain as an additional intersection.
export const LINUX_LABEL_UBUNTU26 = `${LINUX_LAUNCH_PROFILE}//&${LINUX_WORKER_PROFILE}//&unconfined (enforce)`;

/** Builtins pack code may import: computation only, no file, network, process or thread access. */
export const PURE_BUILTINS: readonly string[] = [
  'assert',
  'assert/strict',
  'buffer',
  'crypto',
  'events',
  'path',
  'path/posix',
  'path/win32',
  'querystring',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'util/types',
  'zlib',
];

/** Builtins the declared dependencies may import in addition (the Node build of fflate imports module for createRequire). */
export const DEPENDENCY_BUILTINS: readonly string[] = ['module'];

/** Packages pack code may import: the repository's declared parsing and validation dependencies, resolved from the Hub. */
export const DECLARED_DEPENDENCIES: readonly string[] = ['saxes', 'parse5', 'fflate', 'zod'];

/** Module formats a pack module may have: ECMAScript modules (JavaScript or TypeScript) and JSON data. */
export const PACK_MODULE_FORMATS: readonly string[] = ['module', 'module-typescript', 'json'];

/** File extensions a pack function entry may have. */
export const ENTRY_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.js', '.mjs'];
