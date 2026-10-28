import { readFileSync } from 'node:fs';

export const GENERATED = JSON.parse(readFileSync(new URL('../generated.json', import.meta.url), 'utf8')) as {
  id: string;
  version: string;
  assertion: string;
  provenance_type: string;
  event_schema: string;
  proposal_schema: string;
  operation_kinds: Record<string, string>;
  scanner: string;
};

export const EGRESS = JSON.parse(readFileSync(new URL('../egress.json', import.meta.url), 'utf8')) as {
  max_capture_bytes: number;
  max_manifest_bytes: number;
  max_input_summary_chars: number;
  max_proposals: number;
  http_timeout_ms: number;
};

export const PACK = `${GENERATED.id}@${GENERATED.version}`;
