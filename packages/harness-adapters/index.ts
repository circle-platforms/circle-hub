import type { ExportResult, HarnessId, HubManifest, ImportResult, VirtualFiles } from './neutral.ts';
import { exportClaudeCode, importClaudeCode } from './claude-code.ts';
import { exportCodex, importCodex } from './codex.ts';

export * from './neutral.ts';

// Read a harness's own file formats into neutral hub manifests. Input is a
// virtual file table ({path: bytes}); no filesystem, network, or environment
// access happens here.
export function importFrom(harness: HarnessId, files: VirtualFiles): ImportResult {
  switch (harness) {
    case 'claude-code':
      return importClaudeCode(files);
    case 'codex':
      return importCodex(files);
    default:
      throw new TypeError(`unknown harness: ${String(harness)}`);
  }
}

// Write neutral hub manifests back into a harness's file conventions. Only
// manifests whose sourceHarness matches the target are exported; anything
// else is reported as CROSS_HARNESS_EXPORT and skipped.
export function exportTo(harness: HarnessId, manifests: HubManifest[]): ExportResult {
  switch (harness) {
    case 'claude-code':
      return exportClaudeCode(manifests);
    case 'codex':
      return exportCodex(manifests);
    default:
      throw new TypeError(`unknown harness: ${String(harness)}`);
  }
}
