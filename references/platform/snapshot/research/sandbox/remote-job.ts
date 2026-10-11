import fs from 'node:fs';
import path from 'node:path';
const root = process.env.INFOSEC_LAB_ROOT!;
const id = process.argv[2];
fs.writeFileSync(path.join(root, 'evidence', `${id}-started.json`), JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() }));
setTimeout(() => { fs.writeFileSync(path.join(root, 'evidence', `${id}-effect.json`), JSON.stringify({ id, pid: process.pid, at: new Date().toISOString(), effect: 'synthetic-remote-work-finished' })); }, 3500);
