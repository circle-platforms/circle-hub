// knowledge-contribution@1.3.1 as published before the operation lease binding: pack.json and the files it lists, byte
// for byte from packs/workflow/knowledge-contribution at aecc1a9222495d561fd983f53fe985038b2fd0e6 (the parent of the lease
// work). Tests that replay legacy runs copy it from here instead of extracting an earlier commit, which a shallow or
// public clone may not have.
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../../records/digest.ts';
import { manifestDigest } from '../../../runs/api.ts';

export const FROZEN_KNOWLEDGE_CONTRIBUTION = {
  ref: 'knowledge-contribution@1.3.1',
  revision: 'aecc1a9222495d561fd983f53fe985038b2fd0e6',
  /** manifestDigest of the frozen pack.json: the pack_digest an old run of this version carries. */
  digest: '2acb969822443242f3867c37364a9cc076f5a3ed85628beb014b82894030f1f0',
  directory: fileURLToPath(new URL('./knowledge-contribution@1.3.1/', import.meta.url)),
} as const;

/** Copies the frozen pack into `target` after checking the manifest digest and every listed file's size and SHA-256. */
export async function copyFrozenKnowledgeContribution(target: string): Promise<{ id: string; version: string; digest: string }> {
  const source = FROZEN_KNOWLEDGE_CONTRIBUTION.directory;
  const manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8')) as { id: string; version: string; files: { path: string; sha256: string; size: number }[] };
  const digest = manifestDigest(manifest);
  if (digest !== FROZEN_KNOWLEDGE_CONTRIBUTION.digest || `${manifest.id}@${manifest.version}` !== FROZEN_KNOWLEDGE_CONTRIBUTION.ref) {
    throw new Error(`frozen pack manifest changed: ${manifest.id}@${manifest.version} ${digest}`);
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(source, file.path));
    if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) throw new Error(`frozen pack file ${file.path} changed`);
  }
  await cp(source, target, { recursive: true });
  return { id: manifest.id, version: manifest.version, digest };
}
