import type {Migration} from '../../storage/src/index.ts';

export const knowledgePageMigration:Migration={version:17,name:'Index explicitly shared personal source pagination',sql:`
CREATE INDEX knowledge_shared_pages ON knowledge_records(tenant_id,scope_id,owner_id,created_at,record_id)
 WHERE kind='SourceRevision' AND knowledge_category='consolidated' AND source_type='shared-session'
 AND payload->'sharing'->>'allowed'='true';
`};
