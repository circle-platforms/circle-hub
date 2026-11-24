import { execFileSync } from 'node:child_process';

export function trackedSourcePaths(root: string, pattern = '.'): string[] {
  return execFileSync('git', [
    'ls-files', '-z', '--', pattern,
    ':(exclude,top)foundation/circle/**', ':(exclude,top)references/**',
  ], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
}
