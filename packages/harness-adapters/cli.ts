// Minimal CLI around the adapter library, for local inspection only.
// It maps a real directory to the virtual file table and back; it does not
// touch the hub, a network, or the environment.
//
//   node packages/harness-adapters/cli.ts import <dir> --from <harness>
//   node packages/harness-adapters/cli.ts export <manifests.json> --to <harness> [--dir <dir>]

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HarnessId, VirtualFiles } from './neutral.ts';
import { HARNESS_IDS, exportTo, importFrom } from './index.ts';

const USAGE = `usage:
  import <dir> --from <harness>      read a directory into neutral manifests
  export <manifests.json> --to <harness> [--dir <dir>]
                                     export manifests; --dir provides the original file table
harness: ${HARNESS_IDS.join(' | ')}`;

async function readDirectory(root: string): Promise<VirtualFiles> {
  const files: VirtualFiles = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(full);
      const key = relative(root, full).split(sep).join('/');
      try {
        files[key] = decoder.decode(bytes);
      } catch {
        files[key] = new Uint8Array(bytes);
      }
    }
  }
  await walk(root);
  return files;
}

function encodeFiles(files: VirtualFiles): Record<string, string | { base64: string }> {
  const out: Record<string, string | { base64: string }> = {};
  for (const [path, value] of Object.entries(files)) {
    out[path] = typeof value === 'string' ? value : { base64: Buffer.from(value).toString('base64') };
  }
  return out;
}

function parseHarness(flag: string, value: string | undefined): HarnessId {
  if (value !== undefined && (HARNESS_IDS as readonly string[]).includes(value)) return value as HarnessId;
  throw new Error(`--${flag} must be one of: ${HARNESS_IDS.join(', ')}`);
}

export async function runCli(argv: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const [command, ...rest] = argv;
  try {
    if (command === 'import') {
      const dir = rest[0];
      const harness = parseHarness('from', rest[rest.indexOf('--from') + 1]);
      if (dir === undefined || dir.startsWith('--') || !rest.includes('--from')) throw new Error(USAGE);
      const result = importFrom(harness, await readDirectory(dir));
      return { status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
    }
    if (command === 'export') {
      const manifestsFile = rest[0];
      const harness = parseHarness('to', rest[rest.indexOf('--to') + 1]);
      if (manifestsFile === undefined || manifestsFile.startsWith('--') || !rest.includes('--to')) throw new Error(USAGE);
      const dirIndex = rest.indexOf('--dir');
      const sourceDir = dirIndex === -1 ? undefined : rest[dirIndex + 1];
      const manifests = JSON.parse(await readFile(manifestsFile, 'utf8')) as Parameters<typeof exportTo>[1];
      const source = sourceDir === undefined ? {} : await readDirectory(sourceDir);
      const result = exportTo(harness, manifests, source);
      return { status: 0, stdout: `${JSON.stringify({ files: encodeFiles(result.files), warnings: result.warnings }, null, 2)}\n`, stderr: '' };
    }
    throw new Error(USAGE);
  } catch (error) {
    return { status: 1, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout !== '') process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = status;
}
