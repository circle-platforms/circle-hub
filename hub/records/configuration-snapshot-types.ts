// Protected current-schema state. These payloads must never be rendered in logs or ordinary export output.
import type { PackManifest } from '../../contracts/src/pack.ts';
import type { RecordKind } from '../../contracts/generated/protocol.ts';
import type { ProvenanceType } from '../../contracts/generated/vocabulary.ts';
import type { RecordsConfig } from './api.ts';
import type { RecordMigrationReceipt } from './schema-compatibility.ts';

export type ConfigurationScalar = string | number | boolean | null;
export type ConfigurationValue = ConfigurationScalar | ConfigurationValue[] | {[key:string]:ConfigurationValue};
export type ConfigurationRow = {[key:string]:ConfigurationValue};

export interface ConfigurationAuthentication {
  users:ConfigurationRow[];
  user_history:ConfigurationRow[];
  oauth_clients:ConfigurationRow[];
  tokens:ConfigurationRow[];
  invitations:ConfigurationRow[];
}
export interface ConfigurationRecord {
  seq:string;
  id:string;
  digest:string;
  kind:RecordKind;
  schema:string;
  provenance:ProvenanceType;
  created_at:string;
  body:string;
  size:number;
}
export interface ConfigurationIndex { key:string; value:string; digest:string; record_seq:string }
export interface ConfigurationKey { kind:RecordKind; key:string; digest:string }
export interface ConfigurationObject {
  sha256:string;
  size:number;
  media_type:string;
  created_at:string;
  bytes_base64:string;
  public:boolean;
}
export interface ConfigurationPackage {
  record:string;
  pack:string;
  version:string;
  digest:string;
  manifest:PackManifest;
}
export interface ConfigurationPersonalStorage {
  personal_spaces:ConfigurationRow[];
  personal_payloads:ConfigurationRow[];
  personal_record_bindings:ConfigurationRow[];
  personal_objects:ConfigurationRow[];
  personal_purges:ConfigurationRow[];
}
export interface ConfigurationClosure {
  records:ConfigurationRecord[];
  indexes:ConfigurationIndex[];
  keys:ConfigurationKey[];
  objects:ConfigurationObject[];
  packages:ConfigurationPackage[];
  teams:ConfigurationRow[];
  team_members:ConfigurationRow[];
  pointers:ConfigurationRow[];
  lease_registrations:ConfigurationRow[];
  object_holds:ConfigurationRow[];
  personal:ConfigurationPersonalStorage;
}
export interface ConfigurationSnapshot extends ConfigurationClosure {
  format:'circle-hub-configuration-snapshot@1';
  migrations:RecordMigrationReceipt[];
  captured_at:string;
  authentication:ConfigurationAuthentication;
}

export type ExportConfigurationSnapshot = (config:RecordsConfig)=>Promise<ConfigurationSnapshot>;
export type ValidateConfigurationSnapshot = (input:unknown)=>ConfigurationSnapshot;
export type RestoreConfigurationSnapshot = (config:RecordsConfig,snapshot:ConfigurationSnapshot)=>Promise<void>;
