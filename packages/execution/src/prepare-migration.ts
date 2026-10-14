import type {Migration} from '../../storage/src/index.ts';
export const providerPrepareMigration:Migration={version:43,name:'Bind provider preparations to fenced dispatch evidence',sql:`
ALTER TABLE flow_steps ADD COLUMN prepare_ref jsonb;
`};
