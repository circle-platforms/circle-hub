// One behavior registration for every generated record kind; no second personal-kind set.
import type { RecordKind } from '../../contracts/generated/protocol.ts';
type Visibility = 'admin' | 'run' | 'source' | 'dedicated';
type PersonalOwner = 'space' | 'capture' | 'memory_action' | 'run' | null;
export interface RecordAccess { readonly visibility:Visibility; readonly personal:PersonalOwner; readonly personalPack:boolean }
const access=(visibility:Visibility,personal:PersonalOwner,personalPack:boolean):RecordAccess=>({visibility,personal,personalPack});
export const RECORD_ACCESS = {
  claim: access('admin', null, false),
  source_artifact: access('source', 'capture', false),
  authorization: access('admin', null, false),
  action: access('run', 'memory_action', false),
  effect: access('admin', null, false),
  request: access('run', null, false),
  call_log: access('admin', null, false),
  run: access('run', 'run', false),
  submission: access('run', null, false),
  validation_result: access('run', null, false),
  pack_version: access('admin', null, false),
  tree_node: access('admin', null, false),
  tree_root: access('admin', null, false),
  root_pointer: access('admin', null, false),
  knowledge_space_version: access('dedicated', 'space', false),
  knowledge_space_entry: access('dedicated', 'space', false),
  knowledge_space_grant: access('dedicated', 'space', false),
  knowledge_space_source: access('dedicated', 'space', false),
  knowledge_space_quota: access('dedicated', null, false),
  knowledge_share: access('dedicated', null, false),
  personal_pack_version: access('dedicated', 'space', true),
  personal_pack_grant: access('dedicated', 'space', true),
  personal_pack_retirement: access('dedicated', 'space', true),
  personal_pack_transfer: access('dedicated', 'space', true),
  memory_document: access('dedicated', 'space', false),
  memory_version: access('dedicated', 'space', false),
  memory_grant: access('dedicated', 'space', false),
  memory_share: access('dedicated', null, false),
  knowledge_source_attribution: access('dedicated', 'space', false),
  member_deletion: access('dedicated', null, false),
  knowledge_team_source_attribution: access('dedicated', null, false),
  token_issuance: access('admin', null, false),
  result_summary: access('admin', null, false),
} as const satisfies Record<RecordKind,RecordAccess>;
