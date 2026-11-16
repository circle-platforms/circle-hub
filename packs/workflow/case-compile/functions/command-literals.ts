// A literal of 32 characters or more in a command (a 200-character host name) is not something a model counts reliably. In round 34
// Plumb answered "no" (p(yes) 0.107 and 0.033) for two commands that matched their definitions exactly: the host was 200
// characters long and the definition allows 200. A question to a model therefore carries such a literal as a name and the count
// the program measured, the way the fidelity brief states `literal_lengths`, and the model judges the rest. The rule looks at
// length only: no word, command or product is recognised, the manual's definition is not read, and the text around a literal
// is kept byte for byte.
import { createHash } from 'node:crypto';
import { literalLengths } from './fidelity.ts';

/** What the program measured about one long literal, and the name that stands for it; the literal itself is not kept. */
export interface NamedLiteral {
  /** The name the report uses, such as `«L1»`; in a question the name is followed by the count, as `«L1（200个字符）»`. */
  name: string;
  /** Characters (code points) of the literal. */
  length: number;
  /** Bytes in UTF-8, only when they differ from the characters. */
  bytes?: number;
  /** Characters of each dot-separated label, when the literal has a dot (the figures `literal_lengths` of the fidelity brief states). */
  labels?: number[];
  /** The first 12 hex digits of the SHA-256 of the literal: names it in a report without repeating it. */
  sha256_12: string;
}

/** A named literal and how many times its name stands in the text that was sent. */
export interface CommandLiteral extends NamedLiteral {
  occurrences: number;
}

/** A word split off by white space: quotes around it are not part of the literal, as `literalLengths` reads literals. */
const PIECE = /^(["']*)([^]*?)(["']*)$/u;
/** A name with its count, as this module writes it: already named, however long its figures are. */
const WRITTEN = /^«L\d+（[^»）]*）»$/u;
/** A dotted literal with more labels than this states how many there are and the longest, not every length. */
const LABELS_LISTED = 8;

/** The text before the count: a name in a question starts with it, and nothing else does. */
const stem = (name: string): string => `${name.slice(0, -1)}（`;

function detail(facts: { length: number; bytes?: number; labels?: number[] }): string {
  const count = `${facts.length}个字符${facts.bytes === undefined ? '' : `，${facts.bytes}字节`}`;
  if (!facts.labels) return count;
  const labels = facts.labels.length <= LABELS_LISTED ? `各段${facts.labels.join('、')}` : `${facts.labels.length}段，最长${facts.labels.reduce((longest, n) => (n > longest ? n : longest), 0)}`;
  return `${count}；${labels}`;
}

/**
 * Writes every long literal in `texts` (a run of 32 characters or more between white space, quotes around it ignored: the
 * definition of `literalLengths`) as a name that carries the program's count, `«L1（200个字符；各段63、63、63、8）»`, and gives the
 * same literal the same name wherever it stands. Names follow the order of first appearance across `texts`, so a caller that
 * lists the earlier commands before the current one reads the first literal as `«L1»`. A literal that differs by one character
 * is another literal. Nothing is lost for a reader of the report: the names stand in `literals` with the figures and a digest of
 * the literal, and the texts the caller started from are not changed. A name already written in a text is not reused.
 */
export function nameLongLiterals(texts: readonly string[]): { texts: string[]; literals: NamedLiteral[] } {
  const named = new Map<string, { literal: NamedLiteral; written: string }>();
  const taken = (n: number): boolean => texts.some((text) => text.includes(`«L${n}（`));
  let next = 1;
  const out = texts.map((text) => text.split(/(\s+)/u).map((part) => {
    if (part === '' || /^\s+$/u.test(part)) return part;
    const [, open, core, close] = PIECE.exec(part)!;
    let hit = named.get(core!);
    if (!hit) {
      if (WRITTEN.test(core!)) return part;
      const [facts] = literalLengths([core!]);
      if (!facts) return part;
      while (taken(next)) next += 1;
      const bytes = Buffer.byteLength(core!, 'utf8');
      const literal: NamedLiteral = {
        name: `«L${next}»`,
        length: facts.length,
        ...(bytes !== facts.length ? { bytes } : {}),
        ...(facts.labels ? { labels: facts.labels } : {}),
        sha256_12: createHash('sha256').update(core!).digest('hex').slice(0, 12),
      };
      hit = { literal, written: `${stem(literal.name)}${detail(literal)}）»` };
      named.set(core!, hit);
      next += 1;
    }
    return `${open}${hit.written}${close}`;
  }).join(''));
  return { texts: out, literals: [...named.values()].map((entry) => entry.literal) };
}

/** The named literals whose names stand in `sent` (the text of one question), each with how many times, in the order they were named. */
export function disclose(literals: readonly NamedLiteral[], sent: string): CommandLiteral[] {
  return literals.flatMap((literal) => {
    const occurrences = sent.split(stem(literal.name)).length - 1;
    if (occurrences === 0) return [];
    const { name, length, bytes, labels, sha256_12 } = literal;
    return [{ name, length, ...(bytes === undefined ? {} : { bytes }), ...(labels ? { labels } : {}), occurrences, sha256_12 }];
  });
}
