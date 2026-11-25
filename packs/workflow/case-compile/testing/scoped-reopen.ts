import { AUTOID } from '../functions/test-support.ts';

export const SCOPED_REOPEN = {
  scope: { words: '本次只编译前两条', cases: [AUTOID, '990000000000000032'] },
  exclude: ['990000000000000032'],
};
