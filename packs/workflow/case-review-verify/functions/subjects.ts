// Subject builder of the verification's catalog check (checks.json command_claims, ItemSubjectInput): the statements of the
// verifier's slot record that a command exists (present true) or does not (present false), as tables/command-claims.json
// reads them. The verifier who says an existing command does not exist (or the reverse) has made the error, so the check
// judges the artifact under verification and the verification requirement sends it back for repair. Commands without
// `present` are not judged here: this pack holds no fact about the target's own command lines (the draft's catalog
// requirement does).
import { isRecord } from './common.ts';

const SLOT = 'verification';

export function claimSubject(input: unknown): unknown {
  try {
    const record = isRecord(input) ? input : {};
    const item = isRecord(record.item) ? record.item : {};
    const slots = isRecord(record.slots) ? record.slots : {};
    const claims: Array<{ command: string; present: boolean }> = [];
    for (const statement of Array.isArray(slots[SLOT]) ? slots[SLOT] : []) {
      const commands = isRecord(statement) && Array.isArray(statement.commands) ? statement.commands : [];
      for (const command of commands) {
        if (isRecord(command) && typeof command.command === 'string' && typeof command.present === 'boolean') claims.push({ command: command.command, present: command.present });
      }
    }
    return { item: typeof item.id === 'string' ? item.id : '', location: typeof item.location === 'string' ? item.location : null, claims };
  } catch {
    return { item: '', location: null, claims: [] };
  }
}

export default function (input: unknown): unknown {
  return claimSubject(input);
}
