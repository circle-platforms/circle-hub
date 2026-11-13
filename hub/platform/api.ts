// Public surface of the platform package. Other packages import only from here.
export {
  assertHubEnvironment,
  assertKnownHubVariables,
  HUB_CONFIG_VARIABLES,
  PLATFORM_ONLY_VARIABLES,
  PLATFORM_VARIABLES,
  RETIRED_VARIABLES,
  retiredEnvironmentKeys,
  unknownHubVariables,
} from './environment.ts';
export { messageOf, PlatformError } from './errors.ts';
export { DATA_ROOT_VARIABLE, defaultDataRoot, ensureLayout, layoutAt, reportsDirectory, resolveLayout, type Layout } from './layout.ts';
export {
  APPLICATION_ROLE,
  DATABASE_NAME,
  DATABASE_PORT,
  DEFAULT_KEY_ACCOUNT,
  DEFAULT_KEY_SERVICE,
  DEFAULT_PORT,
  OPERATOR_TOKEN_ACCOUNT,
  readSettings,
  readSettingsFile,
  resolveDatabaseNames,
  resolveSettings,
  SERVICE_LABEL,
  SETTINGS_SCHEMA,
  type DatabaseNames,
  type PlatformSettings,
} from './settings.ts';
export { createContext, identityOf, postgresFor, settingsOf, type PlatformContext } from './context.ts';
export {
  createPostgres,
  ensureDatabaseRunning,
  resolveBinaries,
  type DatabaseTarget,
  type PostgresControl,
  type PostgresStatus,
} from './postgres.ts';
export { BACKUP_SCHEMA, MANIFEST_FILE, backupPath, createBackup, listBackups, pruneBackups, verifyBackup, type BackupManifest } from './backup.ts';
export { TABLE_DIGEST } from './sql.ts';
export { restoreBackup, setAside, type RestoreReport } from './restore.ts';
export { launchAgent, renderPlist, serviceDefinition, serviceEnvironment, type ServiceDefinition, type ServiceStatus } from './launchd.ts';
export { readCurrentRelease, RELEASE_FILE, type ReleaseRef, type ReleaseSource } from './release.ts';
export {
  deploy,
  MIGRATE_ARGUMENTS,
  readProgress,
  rollback,
  runDeploy,
  runRollback,
  type DeployHost,
  type DeployReport,
  type OperationProgress,
} from './deploy.ts';
export { checkHealth, HEALTH_PATH, waitForHealth, type HealthResult } from './health.ts';
export { rehearse, type RehearsalReport } from './rehearse.ts';
export { verifyPostgres, type VerifyResult } from './verify.ts';
export { isPlatformCommand, main, platformCommands, PLATFORM_COMMAND_METADATA, PLATFORM_COMMANDS, runPlatformCommand, type PlatformCommand, type PlatformCommandMetadata, type PlatformIo } from './cli.ts';
export { fdIsKeyPipe, liveKeyPipe, readKeyStdin, type KeyPipe } from './key-transfer.ts';
export { deploymentKeyNames, ensureHubDatabase, hubKeyProvider } from './service.ts';
export {
  fileKeyProvider,
  fileKeyStore,
  KEY_BYTES,
  keyDirectory,
  OPERATOR_TOKEN_ITEM,
  VAULT_KEY_ITEM,
  type DeploymentKeyNames,
  type FileKeyOptions,
  type KeyItem,
  type KeyItemName,
  type KeyProvider,
  type KeyStore,
} from './file-key.ts';
export { RENEW_WITHIN_DAYS, daysLeft, readServerTls, tlsPaths, type ServerTls, type TlsPaths } from './tls.ts';
export { runCommand, type CommandResult, type CommandRunner } from './process.ts';


export { nativeResetBackup, type ResetBackup } from './reset/backup.ts';
export { CODE_ROOT, agentFor, platformLockPath } from './context.ts';
export { exists, listFiles, sha256File, withLock, writeFileAtomic } from './files.ts';
export { guardSignals } from './deploy.ts';
export { portOccupied } from './health.ts';
export { quoteIdentifier, withSession, type SqlSession } from './sql.ts';
export { toolEnvironment, type CommandOptions } from './process.ts';
export { newSettingsFile, writeSettingsFile } from './settings.ts';

export { archiveResetDatabase, createResetDatabase, type ResetDatabaseControl, type CreateResetDatabaseOptions } from './reset/database.ts';
