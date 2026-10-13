import type { ExportResult, HarnessId, HubManifest, ImportResult, VirtualFiles } from './neutral.ts';
import { exportClaudeCode, importClaudeCode } from './claude-code.ts';
import { exportCodex, importCodex } from './codex.ts';
import { exportOpencode, importOpencode } from './opencode.ts';
import { exportGemini, importGemini } from './gemini.ts';
import { exportCursor, importCursor } from './cursor.ts';

export * from './neutral.ts';
export {
  disposition,
  exportPermission,
  hubPermissionSchema,
  PERMISSION_ROLES,
  type Disposition,
  type HubPermission,
  type PermissionExport,
  type PermissionRole,
} from './permissions.ts';

// Read a harness's own file formats into neutral hub manifests. Input is a
// virtual file table ({path: bytes}); no filesystem, network, or environment
// access happens here.
export function importFrom(harness: HarnessId, files: VirtualFiles): ImportResult {
  switch (harness) {
    case 'claude-code':
      return importClaudeCode(files);
    case 'codex':
      return importCodex(files);
    case 'opencode':
      return importOpencode(files);
    case 'gemini':
      return importGemini(files);
    case 'cursor':
      return importCursor(files);
    default:
      throw new TypeError(`unknown harness: ${String(harness)}`);
  }
}

// Write neutral hub manifests back into a harness's file conventions.
// `files` is the original virtual file table the manifests were imported
// from: markdown bodies and skill sibling files are taken from it (bytes
// never live in manifests), while config files are regenerated from the
// manifests with placeholders for stripped values. Only manifests whose
// sourceHarness matches the target are exported; anything else is reported
// as CROSS_HARNESS_EXPORT and skipped.
export function exportTo(harness: HarnessId, manifests: HubManifest[], files: VirtualFiles): ExportResult {
  switch (harness) {
    case 'claude-code':
      return exportClaudeCode(manifests, files);
    case 'codex':
      return exportCodex(manifests, files);
    case 'opencode':
      return exportOpencode(manifests, files);
    case 'gemini':
      return exportGemini(manifests, files);
    case 'cursor':
      return exportCursor(manifests, files);
    default:
      throw new TypeError(`unknown harness: ${String(harness)}`);
  }
}
