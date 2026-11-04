// Model 38, R01 R[12] (decision 136 ⑫): every token and invitation issuance, use and revocation appends one token_issuance
// record in the transaction that changes the tokens or invitations row, so a rolled-back change leaves no record and a
// committed one always has its record. The mutable rows stay the working state (hashes, last use); the records are the
// history. Bodies hold ids, accounts, times, the label and the client id; never a token, an invitation code or a hash.
import { TokenIssuanceBody } from '../../contracts/src/tokens.ts';
import { RecordKindSchema } from '../../contracts/src/records.ts';
import { ProvenanceTypeSchema } from '../../contracts/generated/vocabulary.ts';
import type { RecordStore, Transaction } from './api.ts';
import { IntegrityError } from './errors.ts';

export const TOKEN_ISSUANCE_SCHEMA = 'token-issuance@1';
/** Index keys: the account the token or invitation belongs to, and the token or invitation id itself. */
export const TOKEN_ISSUANCE_USER = 'token.issuance.user';
export const TOKEN_ISSUANCE_SUBJECT = 'token.issuance.subject';

/** The unique key of one action on one token or invitation: each happens at most once. */
export function tokenIssuanceKey(subject: string, action: TokenIssuanceBody['action']): string {
  return `${subject}:${action}`;
}

export async function appendTokenIssuance(store: Pick<RecordStore, 'put'>, body: TokenIssuanceBody, tx: Transaction): Promise<string> {
  const parsed = TokenIssuanceBody.parse(body);
  const subject = 'token' in parsed ? parsed.token : parsed.invitation;
  const put = await store.put(
    {
      kind: RecordKindSchema.enum.token_issuance,
      schema: TOKEN_ISSUANCE_SCHEMA,
      provenance: ProvenanceTypeSchema.enum.observed,
      body: parsed,
      created_at: parsed.at,
      unique_key: tokenIssuanceKey(subject, parsed.action),
      index: [{ key: TOKEN_ISSUANCE_USER, value: parsed.user }, { key: TOKEN_ISSUANCE_SUBJECT, value: subject }],
    },
    tx,
  );
  // The row change this record accompanies happens once per subject and action; a second record means a broken invariant.
  if (!put.created) throw new IntegrityError('这个令牌或邀请码的这一操作已经有记录', { detail: { subject, action: parsed.action } });
  return put.digest;
}
