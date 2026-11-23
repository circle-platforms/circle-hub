import { readFileSync } from 'node:fs';
import { PackManifest } from '../../contracts/src/pack.ts';
import type { PackSummary } from '../../contracts/src/run.ts';
import { canonicalBytes, sha256Hex, type CallLogLine } from '../records/api.ts';
import type { TraceNode } from '../telemetry/api.ts';

const skillDirectory = new URL('../../packs/skill/hub-observability/', import.meta.url);
const manifest = PackManifest.parse(JSON.parse(readFileSync(new URL('pack.json', skillDirectory), 'utf8')));
const files = new Map(manifest.files.map(({ path, sha256, size }) => {
  const bytes = readFileSync(new URL(path, skillDirectory));
  if (bytes.length !== size || sha256Hex(bytes) !== sha256) throw new Error(`Bundled skill file failed verification: ${path}`);
  return [path, { path, sha256, text: bytes.toString('utf8') }];
}));

export const observabilitySkill: PackSummary = {
  id: manifest.id, pack: `${manifest.id}@${manifest.version}`, version: manifest.version,
  kind: manifest.kind, title: manifest.title, description: manifest.description,
  digest: sha256Hex(canonicalBytes(manifest)),
  products: [], inputs: [], parameters: [], requirements: [],
};

export function observabilitySkillFile(path = 'SKILL.md') {
  const file = files.get(path);
  return file ? { pack: observabilitySkill.pack, ...file } : null;
}

export function observedCall(line: CallLogLine) {
  const { at, user, session, tool, run, trace_id, span_id, call_result, error_code, acceptance, duration_ms } = line;
  return { at, user, session, tool, run, trace_id, span_id, call_result, error_code, acceptance, duration_ms };
}

export function observedStep(node: TraceNode): ObservedStep {
  return { ...stepFields(node), children: node.children.map(observedStep) };
}

type ObservedStep = ReturnType<typeof stepFields> & { children: ObservedStep[] };

function stepFields(node: TraceNode) {
  const { span_id, parent_span_id, is_root, name, type, started_at, ended_at, duration_ms, level, user_id, session_id, run_id,
    client_name, client_version, client_platform, release, environment, usage } = node;
  return { span_id, parent_span_id, is_root, name, type, started_at, ended_at, duration_ms, level, user_id, session_id, run_id,
    client_name, client_version, client_platform, release, environment, usage };
}
