// Inspect executable headers without executing them. OS execution remains a separate smoke check.
import { openSync, closeSync, readSync } from 'node:fs';
import type { Target } from './integrity.ts';

export function verifyExecutableTarget(path: string, target: Target): void {
  const fd = openSync(path, 'r'), header = Buffer.alloc(64);
  let length: number;
  try { length = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  let actual: Target | undefined;
  if (length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1) {
    const machine = header.readUInt16LE(18);
    if (machine === 62) actual = 'linux-x64';
    if (machine === 183) actual = 'linux-arm64';
  } else if (length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    if (cpu === 0x01000007) actual = 'darwin-x64';
    if (cpu === 0x0100000c) actual = 'darwin-arm64';
  }
  if (actual !== target) throw new Error('可执行文件格式或目标架构不一致');
}
