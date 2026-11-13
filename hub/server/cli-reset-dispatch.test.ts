import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from './cli.ts';

for (const [args, code] of [[['--help'], 0], [['--scope=runs'], 2]] as const) {
  test(`early reset ${args.join(' ')} needs neither a database nor normal assembly`, async () => {
    const output: string[] = [];
    let assemblies = 0;
    const result = await main(['reset', ...args], {
      io: { env: {}, cwd: '.', stdout: line => output.push(line), stderr: line => output.push(line) },
      assembly: async () => { assemblies++; throw new Error('must not open ordinary command assembly'); },
    });
    assert.equal(result, code);
    assert.equal(assemblies, 0);
    assert.ok(output.some(line => line.includes('circle-hub reset')));
  });
}
