// Subject builders of the checks (checks.json `subject`), from the inputs the Hub gives them (contracts/src/pack.ts):
// - structureSubject (RunSubjectInput): the cases of the run as the structure@1 tables and the tag check judge them,
//   { subjects } (subject.ts);
// - commandSubject (ItemSubjectInput): the commands the findings of one item cite, split as the catalog@1 tables read them:
//   `claims` are the statements that a command exists (present true) or does not (present false); `phrases` are the
//   command lines the findings cite from the case (present left out) that the case really writes (lines.ts), whose arguments
//   are checked against the signatures; `unquoted` are the other cited lines, the model's statements, which no catalog table
//   reads (findings_sources sends them back). A negative case without a cited line falls back to the case's own lines;
//   negative_commands reports an advisory source defect when none resolves at a catalog head;
// - scanSubject (ItemSubjectInput): the optional scan of the case's own text lines for command phrases (tables/catalog.json,
//   advisory, listed by no requirement of this pack: off).
import { guarded, isRecord } from './common.ts';
import { caseLines, quotableLines, quotedFromCase } from './lines.ts';
import { toCatalogSubject, toStructureSubjects } from './subject.ts';

export { caseLines };

export function structureSubject(input: unknown): unknown {
  return guarded(() => {
    const items = isRecord(input) && Array.isArray(input.items) ? input.items : [];
    return { subjects: toStructureSubjects(items) };
  });
}

type Cited = { claims: Array<{ command: string; present: boolean }>; phrases: string[] };

/** The commands every finding of a slot record cites, by kind. */
export function citedCommands(slots: unknown): Cited {
  const out: Cited = { claims: [], phrases: [] };
  const findings = isRecord(slots) && Array.isArray(slots.findings) ? slots.findings : [];
  for (const finding of findings) {
    const commands = isRecord(finding) && Array.isArray(finding.commands) ? finding.commands : [];
    for (const command of commands) {
      if (!isRecord(command) || typeof command.command !== 'string') continue;
      if (typeof command.present === 'boolean') out.claims.push({ command: command.command, present: command.present });
      else out.phrases.push(command.command);
    }
  }
  return out;
}

export function commandSubject(input: unknown): unknown {
  return guarded(() => {
    const record = isRecord(input) ? input : {};
    const item = isRecord(record.item) ? record.item : {};
    const fields = isRecord(item.fields) ? item.fields : {};
    const negative = fields.negative === true;
    const cited = citedCommands(record.slots);
    const lines = quotableLines(item, record.evidence);
    const phrases = cited.phrases.filter((phrase) => quotedFromCase(phrase, lines));
    const unquoted = cited.phrases.filter((phrase) => !quotedFromCase(phrase, lines));
    return {
      item: typeof item.id === 'string' ? item.id : '',
      location: typeof item.location === 'string' ? item.location : null,
      negative,
      claims: cited.claims,
      phrases: negative && phrases.length === 0 ? [...new Set(lines)] : phrases,
      unquoted,
    };
  });
}

export function scanSubject(input: unknown): unknown {
  return guarded(() => {
    const record = isRecord(input) ? input : {};
    const item = isRecord(record.item) ? record.item : {};
    const fields = isRecord(item.fields) ? item.fields : {};
    return toCatalogSubject(item, caseLines(fields));
  });
}

/** Without a named export: the run subject of the structure tables, or the item subject of the cited-command tables. */
export default function (input: unknown): unknown {
  return isRecord(input) && input.applies === 'item' ? commandSubject(input) : structureSubject(input);
}
