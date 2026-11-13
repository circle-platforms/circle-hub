import { MigrationError } from '../records/api.ts';

export interface RebuildRequiredState {
  required: true;
  reason: string;
  migrationVersions: readonly number[];
  nextAction: string;
}

/** Only structured migration identity failures select the restricted server; permission and program errors do not. */
export function rebuildRequiredState(error: unknown): RebuildRequiredState | null {
  if (!(error instanceof MigrationError)) return null;
  const version = error.detail.version, versions = error.detail.versions;
  const observed = typeof version === 'number' && Number.isSafeInteger(version) && version > 0
    ? [version]
    : Array.isArray(versions) && versions.length > 0 && versions.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      ? versions
      : null;
  if (observed === null) return null;
  return {
    required: true,
    reason: error.message,
    migrationVersions: observed,
    nextAction: '由本机操作账户授权后，在控制台归档并初始化；或在本机执行 circle-hub reset',
  };
}
