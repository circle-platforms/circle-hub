import { after, before, it } from 'node:test';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openBed, type Bed } from './testing/bed.ts';
import { proveCategoryGap } from './testing/category-gap.ts';

const skip = (await osIsolationAvailable()) ? false : 'operating-system isolation for pack functions (sandbox-exec) is not available here';

let postgres: TemporaryPostgres;
let bed: Bed;
before(async () => {
  postgres = await startPostgres();
  if (!skip) bed = await openBed(postgres);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

it('removing audit_log leaves exactly that gap', { skip }, async () => {
  await proveCategoryGap(bed, 'audit_log', 14);
});
