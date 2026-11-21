import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { process.stderr.write('REPLAY_NETWORK_BLOCKED\n'); throw new Error('Replay network access is disabled'); };
net.Socket.prototype.connect = denied;
net.connect = denied;
net.createConnection = denied;
net.createServer = denied;
tls.connect = denied;
tls.createServer = denied;
http.request = denied;
http.get = denied;
http.createServer = denied;
https.request = denied;
https.get = denied;
https.createServer = denied;
dgram.createSocket = denied;
globalThis.fetch = denied;
const outside = new Set();
const watch = (original) => {
  const wrapped = function (target, ...rest) {
    try { return original.call(this, target, ...rest); }
    catch (error) {
      if (error?.code === 'ERR_ACCESS_DENIED' && error.permission === 'FileSystemRead')
        outside.add(String(target));
      throw error;
    }
  };
  return Object.assign(wrapped, original);
};
for (const name of ['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'accessSync', 'existsSync', 'opendirSync'])
  fs[name] = watch(fs[name]);
const realpath = watch(fs.realpathSync);
realpath.native = watch(fs.realpathSync.native);
fs.realpathSync = realpath;
syncBuiltinESMExports();
process.on('exit', () => {
  try { fs.writeSync(3, JSON.stringify([...outside].sort())); }
  catch { }
});
