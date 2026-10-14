import type {Migration} from '../../storage/src/index.ts';
export const flowReceiptMigration:Migration={version:42,name:'Freeze approved original identity projections before provider dispatch',sql:`
ALTER TABLE flow_steps ADD COLUMN receipt_facts jsonb;
`};
