// The network guard of a replay process: loopback and unix sockets work, every other address is refused before a connection
// is tried. Loopback only; nothing leaves this machine, the refused address is a documentation address (192.0.2.0/24).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('./submissions-net-guard.mjs', import.meta.url));

const script = (body: string) => spawnSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', body], { encoding: 'utf8', timeout: 20000 });

describe('the network guard', () => {
  test('refuses a connection to another address, a request to another host and a fetch, and says so on exit', () => {
    const result = script(`
      import net from 'node:net'; import http from 'node:http';
      const outcomes = [];
      try { net.connect(80, '192.0.2.1'); outcomes.push('connected'); } catch (e) { outcomes.push(e.code); }
      try { http.get('http://192.0.2.1/'); outcomes.push('requested'); } catch (e) { outcomes.push(e.code); }
      try { await fetch('http://192.0.2.1/'); outcomes.push('fetched'); } catch (e) { outcomes.push(e.code); }
      console.log(JSON.stringify(outcomes));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['REPLAY_NETWORK_BLOCKED', 'REPLAY_NETWORK_BLOCKED', 'REPLAY_NETWORK_BLOCKED']);
    assert.match(result.stderr, /REPLAY_NETWORK_REFUSED 3/);
  });

  test('lets a loopback connection through', () => {
    const result = script(`
      import net from 'node:net';
      const server = net.createServer((socket) => socket.end('ok')).listen(0, '127.0.0.1', () => {
        const client = net.connect(server.address().port, '127.0.0.1');
        client.on('data', (data) => { console.log(String(data)); client.destroy(); server.close(); });
      });
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
    assert.doesNotMatch(result.stderr, /REPLAY_NETWORK/);
  });
});
