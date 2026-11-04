// Model 38, R01 R[12] (decision 136 ⑫): the append-only record of every token and invitation issuance, use and revocation.
// Bodies carry identifiers, accounts, times, the label and the client id only: never a token, an invitation code or a hash
// of either, so nothing in a record can be replayed as a credential.
import { z } from 'zod';
import { TokenActionSchema } from '../generated/vocabulary.ts';
import { IsoTime, TokenId, UserId, idOf } from './common.ts';

export const ClientId = idOf('cli');
export const InvitationId = idOf('inv');

const TokenIssue = z.strictObject({
  action: TokenActionSchema.extract(['issue']),
  token: TokenId,
  user: UserId.describe('the account the token acts as'),
  by: UserId.nullable().describe('the issuing account; null only for the token of the bootstrapped first administrator'),
  at: IsoTime,
  label: z.string().max(100),
  client: ClientId.nullable().describe('the registered client the standard authorization issued it to'),
  console_session: z.boolean(),
  expires_at: IsoTime.nullable(),
});
const TokenRevoke = z.strictObject({
  action: TokenActionSchema.extract(['revoke']),
  token: TokenId,
  user: UserId,
  by: UserId.describe('the revoking account; the holder itself when revoked by value (RFC 7009)'),
  at: IsoTime,
  member_deletion: z.uuid().optional().describe('operation_id of the member deletion that revoked the token with the account'),
});
const InvitationIssue = z.strictObject({
  action: TokenActionSchema.extract(['issue']),
  invitation: InvitationId,
  user: UserId,
  by: UserId,
  at: IsoTime,
  expires_at: IsoTime,
});
const InvitationUse = z.strictObject({
  action: TokenActionSchema.extract(['use']),
  invitation: InvitationId,
  user: UserId,
  client: ClientId.describe('the registered client whose authorization request used the invitation'),
  at: IsoTime,
});
export const TokenIssuanceBody = z.union([TokenIssue, TokenRevoke, InvitationIssue, InvitationUse]);
export type TokenIssuanceBody = z.infer<typeof TokenIssuanceBody>;

export const schemas = {
  'token-issuance@1': TokenIssuanceBody,
};
