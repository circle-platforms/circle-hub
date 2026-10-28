// A stopped loopback platform is a caller-visible read failure: the missing fact and the next step, with no host.
// Synthetic fixtures only (ORBIT/COMET mind maps, the FAMX product line, lumen-style PLM ids). Addresses stay on the stubs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ProtocolError } from '../../contracts/src/common.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

const HOST = /192\.0\.2|127\.0\.0\.1/;
const NEXT = '稍后用同样参数重新开始；仍失败请管理员核对资源地址与网络';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  for (const pack of ['source-read', 'case-location', 'defect-to-case']) await bed.hub.assignPack(bed.reviewer.principal, pack);
  client = await bed.connect(bed.reviewer, 'session-unreachable-exit');
  await bed.plmStub.close();
});

after(async () => {
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

function unreachable(errors: ProtocolError[]): ProtocolError {
  const error = errors.find(item => item.code === 'SOURCE_RETRYABLE');
  assert.ok(error, JSON.stringify(errors).slice(0, 1500));
  assert.match(error.message, /连不上来源/);
  assert.equal(error.fix, NEXT);
  assert.equal(HOST.test(`${error.message} ${error.fix ?? ''}`), false);
  return error;
}

describe('a stopped loopback source names the missing fact and the next step', () => {
  it('source-read start_run reports the unreachable PLM bug without its address', async () => {
    const res = await client.call('start_run', { pack: 'source-read', inputs: { defect: { external: 'plm:bug:31057' } } });
    assert.equal(res.out.call_result, 'error');
    unreachable(res.out.errors);
    assert.equal(HOST.test(res.text), false);
  });

  it('defect-to-case start_run reports the unreachable defect without its address', async () => {
    const res = await client.call('start_run', {
      pack: 'defect-to-case',
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
      inputs: {
        defects: [{ external: 'plm:bug:31057' }],
        indexed_cases: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure' },
      },
    });
    assert.equal(res.out.call_result, 'error');
    unreachable(res.out.errors);
    assert.equal(HOST.test(res.text), false);
  });

  it('case-location start_run reports the unreachable ORBIT/COMET mind map after the platform stops', async () => {
    const args = { pack: 'case-location', product: 'FAMX', inputs: { documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }] } };
    const warm = await client.call('start_run', args);
    assert.equal(warm.out.call_result, 'ok', warm.text);
    const agile = bed.hub.stubs?.agile;
    assert.ok(agile);
    await agile.close();
    const res = await client.call('start_run', args);
    assert.equal(res.out.call_result, 'error');
    unreachable(res.out.errors);
    assert.equal(HOST.test(res.text), false);
  });
});
