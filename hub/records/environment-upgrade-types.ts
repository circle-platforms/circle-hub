import type { WorkflowFile } from '../../contracts/src/pack.ts';
import type { PackKind } from '../../contracts/generated/vocabulary.ts';
import type { User } from './api.ts';

export interface EnvironmentUpgradeSnapshot {
  boundary: string;
  at: string;
  members: ReadonlyArray<Pick<User, 'id' | 'disabled' | 'deleted_at' | 'created_at'> & { packs: readonly string[] }>;
  workflows: ReadonlyArray<{
    id: string; digest: string; kind: PackKind; publishedAt: string; available: boolean; space?: string;
    declaration: Pick<WorkflowFile, 'leases' | 'context'>;
  }>;
  executors: ReadonlyArray<{ id: string; registeredAt: string; keys: readonly string[] }>;
  holdings: ReadonlyArray<{ key: string; user: string; run: string; released: boolean; expires_at: string | null }>;
  /** Verified existing run/job-to-executor evidence, never inferred from lease keys or old grants. */
  holdingBindings?: ReadonlyArray<{ user: string; run: string; executor: string; record: string }>;
  effectiveAssignments: ReadonlyArray<{ user: string; executor: string }>;
  revokedAssignments: ReadonlyArray<{ user: string; executor: string }>;
}

export interface EnvironmentUpgradeGrant {
  user: string;
  executor: string;
  keys: string[];
  workflows: string[];
  holdingRuns: string[];
  note: string;
}
export interface EnvironmentUpgradePlan {
  boundary: string;
  alreadyCompleted: boolean;
  canApply: boolean;
  grants: EnvironmentUpgradeGrant[];
  missing: Array<{ user: string; executor?: string; key?: string; fact: string }>;
}

