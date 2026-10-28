// Public API of the source-read workflow pack (cross-package callers import this module only).
export {
  IDENTITY,
  PACK_DIR,
  computeManifest,
  manifestText,
  packFiles,
  stage,
  type Manifest,
  type ManifestEntry,
} from './pack-files.ts';
export { default as project, type ProjectionResult } from './functions/project.ts';
