// These unit checks exercise safety infrastructure only; they do not establish real Hub migration.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VmCleanup, pipeSyntheticKey, requireSyntheticVm} from './testing/linux-real-vm.ts';

test('VM gate refuses when the explicit synthetic-only opt-in is missing', async () => {
  const saved = process.env.CIRCLE_HUB_TEST_REAL_VM;
  delete process.env.CIRCLE_HUB_TEST_REAL_VM;
  try {await assert.rejects(requireSyntheticVm());}
  finally {
    if (saved === undefined) delete process.env.CIRCLE_HUB_TEST_REAL_VM;
    else process.env.CIRCLE_HUB_TEST_REAL_VM = saved;
  }
});

test('cleanup attempts every owned resource in reverse order and exposes failures', async () => {
  const scope = new VmCleanup(), order:string[] = [];
  scope.register('root', async () => {order.push('root');});
  scope.register('unit', async () => {order.push('unit'); throw new Error('private output');});
  scope.register('process', async () => {order.push('process');});
  await assert.rejects(scope.run(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].message, '清理失败：unit');
    assert.equal(JSON.stringify(error).includes('private output'), false);
    return true;
  });
  assert.deepEqual(order, ['process','unit','root']);
  await scope.run();
});

const command = (program:string) => ({node:process.execPath, args:['--input-type=module','-e',program], cwd:process.cwd(), env:{}});

test('process pipe checks synthetic bytes inside the receiving child without capture', async () => {
  await pipeSyntheticKey(
    command("import {randomBytes} from 'node:crypto';process.stdout.write(randomBytes(32));"),
    command('let n=0;for await(const b of process.stdin)n+=b.length;process.exitCode=n===32?0:3;'),
  );
});

test('process pipe reports either child failure without exposing child diagnostics', async () => {
  await assert.rejects(pipeSyntheticKey(
    command("process.stderr.write('synthetic-private-diagnostic');process.exit(7);"),
    command('for await(const b of process.stdin){}'),
  ), {message:'合成主密钥管道失败（不披露子进程输出）'});
});

test('process pipe terminates both children at its deadline', async () => {
  await assert.rejects(pipeSyntheticKey(
    command('setInterval(()=>{},1000);'),
    command('setInterval(()=>{},1000);'), 50,
  ), {message:'合成主密钥管道失败（不披露子进程输出）'});
});
