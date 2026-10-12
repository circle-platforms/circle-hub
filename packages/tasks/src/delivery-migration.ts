import type { Migration } from '../../storage/src/index.ts';
export const deliveryMigration: Migration = { version: 2, name: 'Pinned capability and durable delivery receipts', sql: `
ALTER TABLE tasks ADD COLUMN capability_pack_id text;
ALTER TABLE tasks ADD COLUMN pack_version text;
ALTER TABLE tasks ADD COLUMN result_status text;
ALTER TABLE tasks ADD COLUMN result jsonb;
` };
