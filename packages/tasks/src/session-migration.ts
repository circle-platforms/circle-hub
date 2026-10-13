import type {Migration} from '../../storage/src/index.ts';
export const sessionMigration:Migration={version:27,name:'Bound development session families and authoritative identity sources',sql:`
ALTER TABLE auth_tokens ADD COLUMN family_id text;
ALTER TABLE auth_tokens ADD COLUMN absolute_expires_at timestamptz;
UPDATE auth_tokens SET family_id=digest,absolute_expires_at=LEAST(expires_at,clock_timestamp()+interval '24 hours') WHERE constraints IS NULL;
CREATE INDEX auth_session_family ON auth_tokens(family_id);
ALTER TABLE policies ADD COLUMN identity_source text NOT NULL DEFAULT 'internal';
UPDATE policies SET identity_source='development' WHERE username IS NOT NULL;
`};
