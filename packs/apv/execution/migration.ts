import type {Migration} from '../../../packages/storage/src/index.ts';
export const caseExecutionMigration:Migration={version:20,name:'Bound gateway submission intents receipts and independent observations',sql:`
CREATE TABLE case_gateway_receipts (operation_id text PRIMARY KEY REFERENCES operations,
 input_revision_id text NOT NULL,workbook_sha256 text NOT NULL,submit_intent boolean NOT NULL DEFAULT false,
 validation_fence bigint,verified_tree_sha256 text,verified_report_sha256 text,
 gateway_task_id text,receipt jsonb,observed_state text,updated_at timestamptz NOT NULL DEFAULT now());
`};
