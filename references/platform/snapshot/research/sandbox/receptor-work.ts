import fs from 'node:fs';
const root = process.env.INFOSEC_LAB_ROOT!;
console.log(JSON.stringify({ kind: 'started', pid: process.pid }));
for (let i = 0; i < 8; i++) { console.log(`tick-${i}`); await new Promise(resolve => setTimeout(resolve, 1000)); }
fs.writeFileSync(`${root}/evidence/receptor-remote-effect.json`, JSON.stringify({ pid: process.pid, completedAt: new Date().toISOString() }));
console.log('remote-effect-written');
