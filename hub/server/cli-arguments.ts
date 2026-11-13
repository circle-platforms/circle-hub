import {knowledgeMessage} from './capacity.ts';
import { parseArgs } from 'node:util';
import { ConnectorError } from '../connectors/api.ts';
import { KnowledgeError } from '../knowledge/api.ts';
import { DocsError } from './docs.ts';
import { RecordsError } from '../records/api.ts';
import { SecretInputError } from './assemble/secret-input.ts';
import { CliError, UsageError } from './errors.ts';

type Flags = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

/** `positionals` arguments, or from `positionals` to `most` when an argument may be left out. */
export function parse<T extends Flags>(args: readonly string[], options: T, positionals: number, most = positionals) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const given = parsed.positionals.length;
  if (given < positionals || given > most) throw new UsageError(`需要 ${most === positionals ? positionals : `${positionals} 至 ${most}`} 个参数，给了 ${given} 个`);
  return parsed;
}

/** A refusal of another package as an operator message with its fix (records' `fix`, the connectors' and knowledge's text). */
export async function decided<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RecordsError) throw new CliError(error.message, error.fix ?? null);
    if (error instanceof DocsError) throw new CliError(error.message, error.hint);
    if(error instanceof KnowledgeError)throw new CliError(knowledgeMessage(error),error.fix);
    if (error instanceof ConnectorError || error instanceof SecretInputError) throw new CliError(error.message);
    throw error;
  }
}

