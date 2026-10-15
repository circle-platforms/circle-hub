import type {Migration} from '../../../packages/storage/src/index.ts';
import {registerErrorCodes} from '../../../packages/contracts/src/index.ts';
// Historical failures remain identifiable; this registers no driver or operation.
registerErrorCodes({INVALID_EXECUTION_WORKBOOK:[422,'validation'],COMMAND_VALIDATION_FAILED:[422,'validation'],GATEWAY_REFUSED:[422,'execution']});
export const executionHistoryReadonlyMigration:Migration={version:44,name:'Preserve retired native execution receipts as read only history',sql:`
CREATE FUNCTION hub_legacy_case_receipts_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Native execution receipts are read only history' USING ERRCODE='25006';
END;
$$;
CREATE TRIGGER hub_legacy_case_receipts_readonly BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON case_gateway_receipts FOR EACH STATEMENT EXECUTE FUNCTION hub_legacy_case_receipts_readonly();
`};
