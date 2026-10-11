import type {Migration} from '../../storage/src/index.ts';
export const checklistMigration:Migration={version:8,name:'Required current revision delivery predicates',sql:`
ALTER TABLE checklist_items ADD COLUMN required boolean NOT NULL DEFAULT true;
ALTER TABLE checklist_items ADD COLUMN predicate text NOT NULL DEFAULT 'assessment-completed';
`};
