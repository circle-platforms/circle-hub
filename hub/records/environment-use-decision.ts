import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { Principal, Transaction } from './api.ts';
import { IntegrityError } from './errors.ts';

/** A null check was not established; it is never an inferred negative grant or registration. */
export interface TestEnvironmentUseChecks {
  actor_exists: boolean | null;
  actor_disabled: boolean | null;
  actor_deleted: boolean | null;
  is_test_environment: boolean | null;
  environment_registered: boolean | null;
  environment_enabled: boolean | null;
  registration_unique: boolean | null;
  assignment_present: boolean | null;
  executor_registered: boolean | null;
  executor_enabled: boolean | null;
  executor_linked: boolean | null;
  target_matches: boolean | null;
  resources_match: boolean | null;
}

export type TestEnvironmentUseRequest =
  | { environment: string; executor: string; keys?: readonly string[] }
  | { environment: string; keys: readonly string[]; executor?: string };

/** Internal checked facts, not a user-facing reason or a second permission source. */
export interface TestEnvironmentUseDecision {
  readonly observed_at: string | null;
  readonly actual_role: PermissionRole | null;
  readonly allowed: boolean | null;
  readonly checks: Readonly<TestEnvironmentUseChecks>;
  readonly failed_check: keyof TestEnvironmentUseChecks | null;
  readonly message: string;
  /** Only verified record references; consumers must apply audience visibility before exposing them. */
  readonly references: readonly string[];
}

/** Draft admission surface; implementations must accumulate facts in the existing checked transaction once. */
export interface TestEnvironmentUseDecisionPort {
  useDecision(by: Principal, input: TestEnvironmentUseRequest, tx?: Transaction): Promise<TestEnvironmentUseDecision>;
}

export function unobservedEnvironmentUse(): TestEnvironmentUseDecision {
  return {
    observed_at: null, actual_role: null, allowed: null, failed_check: null,
    message: '测试环境的使用许可尚未完成核对', references: [],
    checks: {
      actor_exists: null, actor_disabled: null, actor_deleted: null,
      is_test_environment: null, environment_registered: null, environment_enabled: null,
      registration_unique: null, assignment_present: null,
      executor_registered: null, executor_enabled: null, executor_linked: null,
      target_matches: null, resources_match: null,
    },
  };
}

/** Preserves the original unavailable boundary while carrying the same observation to the source caller. */
export class EnvironmentUseReadError extends IntegrityError {
  readonly environment_check: TestEnvironmentUseDecision;
  constructor(decision: TestEnvironmentUseDecision) {
    super(decision.message);
    this.name = 'EnvironmentUseReadError';
    this.environment_check = decision;
  }
}

/** No reads, inferred cause, reason selection or message parsing is performed by this compatibility projection. */
export function projectEnvironmentUse(decision: TestEnvironmentUseDecision): boolean {
  if (decision.allowed === null) throw new EnvironmentUseReadError(decision);
  return decision.allowed;
}
