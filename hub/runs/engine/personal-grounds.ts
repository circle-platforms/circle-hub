// Temporary phase-2 admission guard. Phase 3 replaces this with the complete actual-reader visibility rule.
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { SourceBinding } from '../../../contracts/src/run.ts';
import { parseReference } from '../../refs/api.ts';
import type { Principal } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';

export async function personalGroundProblem(ctx: EngineContext, by: Principal, value: unknown, bindings: readonly SourceBinding[] = []): Promise<ProtocolError | null> {
  // Engines built without the knowledge port (some package tests) have no personal spaces to guard.
  const spaces = ctx.deps.knowledge?.spaces;
  if (!spaces) return null;
  const pins = new Map<string, string>();
  for (const binding of bindings) {
    const ref = parseReference(binding.reference);
    if (ref.scheme === 'src' && binding.artifact) pins.set(ref.sha256, binding.artifact);
  }
  const seen = new Set<object>();
  const references = new Set<string>(bindings.map(binding => binding.reference));
  const work = [value];
  while (work.length) {
    const row = work.pop();
    if (typeof row === 'string' && (row.startsWith('src:') || row.startsWith('tree:'))) references.add(row);
    else if (row && typeof row === 'object' && !seen.has(row)) {
      seen.add(row);
      work.push(...Object.values(row));
    }
  }
  // Classification depends on the capture and directory, not each parser selector or entry in the same directory.
  const checked = new Set<string>();
  for (const reference of references) {
    let pin: string | undefined, key = reference;
    try {
      const ref = parseReference(reference);
      if (ref.scheme === 'src') {
        pin = pins.get(ref.sha256);
        key = ref.sha256 + '/' + (pin ?? '');
      } else if (ref.scheme === 'tree') key = ref.root + ref.path;
    } catch { /* Malformed references remain the ordinary exact-value validator's responsibility. */ }
    if (checked.has(key)) continue;
    checked.add(key);
    if (await spaces.personalGround(by, reference, pin)) return {
      code: 'SPACE_RESULT_GROUNDS_PRIVATE',
      message: PROTOCOL_CODES.SPACE_RESULT_GROUNDS_PRIVATE.when,
      fix: PROTOCOL_CODES.SPACE_RESULT_GROUNDS_PRIVATE.fix,
    };
  }
  return null;
}
