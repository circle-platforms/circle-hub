// A replay never reaches a network but loopback: the scratch PostgreSQL listens on 127.0.0.1 and nothing else is wanted. Loaded
// with `node --import` before anything else, this refuses every connection to another address and every datagram socket, so
// that a Hub code path that would call an executor or a business system (a dispatch, a read) fails here instead of reaching it.
// It is a guard inside the process, not an operating-system sandbox: the pack functions run under the Hub's own sandbox.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const refused = [];
const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';

const deny = (what, target) => {
  refused.push(`${what} ${String(target)}`);
  process.stderr.write(`REPLAY_NETWORK_BLOCKED ${what}\n`);
  const error = new Error('Replay network access is limited to loopback');
  error.code = 'REPLAY_NETWORK_BLOCKED';
  throw error;
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect hands the socket its arguments already normalized: one array, [options, callback].
  const given = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const first = given[0];
  // A unix socket path is local.
  if (typeof first === 'string' && !/^[0-9]+$/.test(first)) return originalConnect.apply(this, args);
  if (typeof first === 'object' && first !== null && typeof first.path === 'string') return originalConnect.apply(this, args);
  const host = typeof first === 'object' && first !== null ? first.host : typeof given[1] === 'string' ? given[1] : undefined;
  if (!loopback(host)) deny('connect', host);
  return originalConnect.apply(this, args);
};

const hostOf = (args) => {
  const first = args[0];
  if (typeof first === 'string') return new URL(first).hostname;
  if (first instanceof URL) return first.hostname;
  return first?.hostname ?? first?.host;
};
for (const [module, name] of [[http, 'http'], [https, 'https']]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = (...args) => {
      const host = hostOf(args);
      if (!loopback(host)) deny(name, host);
      return original(...args);
    };
  }
}
tls.connect = (options) => deny('tls', options?.host);
dgram.createSocket = () => deny('dgram', '');
globalThis.fetch = () => deny('fetch', '');
syncBuiltinESMExports();
process.on('exit', () => {
  if (refused.length > 0) process.stderr.write(`REPLAY_NETWORK_REFUSED ${refused.length}: ${refused.slice(0, 5).join('; ')}\n`);
});
