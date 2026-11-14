// Production wiring uses the token owner, owner-run preservation and the independent runtime-role compatibility reader.
import { readFile } from 'node:fs/promises';
import {
  authenticateEnvironmentUpgradeActor,
  previewEnvironmentAssignmentUpgrade,
  applyEnvironmentAssignmentUpgrade,
  readEnvironmentAssignmentActivation,
  diagnoseRecordsSchema,
  RECORDS_READER_LEVEL,
  parseStrictJson,
  EnvironmentUpgradeRequiredError,
  type RecordsSchemaCompatibility,
} from '../records/api.ts';
import type { HubConfig } from '../config/index.ts';
import { environmentAssignmentUpgradeSources } from './environment-assignment-upgrade-sources.ts';
import { upgradeCommand, type UpgradeCommandPorts, type UpgradeCommandSession } from './cli-upgrade.ts';
import { upgradeStartupDecision, environmentUpgradeNextActions, type UpgradeStartupObservation } from './upgrade-startup.ts';
import { CliError } from './errors.ts';

/** This reader includes the level-two environment-assignment enforcement; it is never raised by an input or environment. */
export const UPGRADE_READER_LEVEL = RECORDS_READER_LEVEL;

export async function readProductionMigrationCompatibility(config: HubConfig): Promise<RecordsSchemaCompatibility> {
  return diagnoseRecordsSchema(config);
}

export function productionUpgradePorts(): UpgradeCommandPorts {
  const sources = environmentAssignmentUpgradeSources();
  return {
    authenticate: (config, authorization) => authenticateEnvironmentUpgradeActor(config, authorization),
    preview: (config, actor) => previewEnvironmentAssignmentUpgrade(config, actor, sources),
    apply: (config, actor, preview, runtimeRole) => applyEnvironmentAssignmentUpgrade(config, actor, sources, preview, { runtimeRole }),
    compatibility: readProductionMigrationCompatibility,
    readPreview: async path => parseStrictJson(await readFile(path, 'utf8')),
  };
}

export function productionUpgradeCommand(session: UpgradeCommandSession, args: readonly string[]): Promise<number> {
  return upgradeCommand(session, args, productionUpgradePorts());
}

export async function readProductionUpgradeStartup(config: HubConfig): Promise<UpgradeStartupObservation> {
  const compatibility = await readProductionMigrationCompatibility(config);
  let environmentAssignmentCompleted: boolean | null;
  try { await readEnvironmentAssignmentActivation(config); environmentAssignmentCompleted = true; }
  catch (error) { environmentAssignmentCompleted = error instanceof EnvironmentUpgradeRequiredError ? false : null; }
  return { compatibility, environmentAssignmentCompleted };
}

export function environmentUpgradeRequired(): CliError {
  return new CliError('运行环境保权升级尚未完成；未启用新守卫、未启动业务', environmentUpgradeNextActions().join('；'));
}

export async function requireProductionUpgradeActivation(config: HubConfig): Promise<boolean> {
  const decision = upgradeStartupDecision(await readProductionUpgradeStartup(config));
  if (!decision.canServe) throw new CliError(decision.problems.join('；'), decision.nextActions.join('；'));
  return decision.enforceEnvironmentAssignments;
}
