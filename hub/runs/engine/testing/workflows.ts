// A fake WorkflowStore for the engine's tests: packs loaded from directories written by packs.ts and validated against the
// pack file formats, assignments by user, the exact version by digest. The real registry is hub/runs/packs.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChecksFile, LedgerFile, KnowledgeFile, PackManifest, RequirementsFile, SlotsFile, WorkflowFile } from '../../../../contracts/src/pack.ts';
import type { PackSummary } from '../../../../contracts/src/run.ts';
import { digestOf, type Principal } from '../../../records/api.ts';
import type { LoadedWorkflow, WorkflowStore } from '../../../ports.ts';
import { requirementSummary } from '../start.ts';

export class FakeWorkflowStore implements WorkflowStore {
  owner: string | null;
  constructor(owner: string | null = null) { this.owner = owner; }
  async ownerOf(_digest: string): Promise<string | null> { return this.owner; }
  readonly #byDigest = new Map<string, LoadedWorkflow>();
  readonly #versions = new Map<string, LoadedWorkflow[]>();
  readonly #assigned = new Map<string, Set<string>>();
  readonly #withdrawn = new Set<string>();

  /** Loads and validates a pack directory; returns the loaded workflow. */
  async add(dir: string): Promise<LoadedWorkflow> {
    const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(dir, path), 'utf8'));
    const manifest = PackManifest.parse(await json('pack.json'));
    const listed = new Set(manifest.files.map((f) => f.path));
    const instructions = await readFile(join(dir, 'SKILL.md'));
    const loaded: LoadedWorkflow = {
      ...(this.owner ? { owner: this.owner } : {}),
      pack: { id: manifest.id, version: manifest.version, digest: digestOf(manifest), kind: manifest.kind, directory: dir },
      manifest,
      workflow: WorkflowFile.parse(await json('workflow.json')),
      requirements: RequirementsFile.parse(await json('requirements.json')).requirements,
      checks: ChecksFile.parse(await json('checks.json')).checks,
      slots: SlotsFile.parse(await json('slots.schema.json')),
      ledger: listed.has('ledger.json') ? LedgerFile.parse(await json('ledger.json')) : null,
      knowledge: listed.has('knowledge.json') ? KnowledgeFile.parse(await json('knowledge.json')) : null,
      instructions: instructions.toString('utf8'),
      instructionsDigest: createHash('sha256').update(instructions).digest('hex'),
      readJson(path: string): unknown {
        if (!listed.has(path)) throw new Error(`${path} is not a file of pack ${manifest.id}@${manifest.version}`);
        return JSON.parse(readFileSync(join(dir, path), 'utf8'));
      },
    };
    this.#byDigest.set(loaded.pack.digest, loaded);
    this.#versions.set(manifest.id, [...(this.#versions.get(manifest.id) ?? []), loaded]);
    return loaded;
  }

  assign(user: string, pack: string): void {
    const set = this.#assigned.get(user) ?? new Set<string>();
    set.add(pack);
    this.#assigned.set(user, set);
  }

  unassign(user: string, pack: string): void {
    this.#assigned.get(user)?.delete(pack);
  }

  withdraw(pack: string): void {
    this.#withdrawn.add(pack);
  }

  async forUser(user: Principal, ref: string): Promise<LoadedWorkflow | null> {
    const at = ref.indexOf('@');
    const id = at < 0 ? ref : ref.slice(0, at);
    const version = at < 0 ? null : ref.slice(at + 1);
    if (this.#withdrawn.has(id)) return null;
    if (user.role !== 'admin' && !this.#assigned.get(user.id)?.has(id)) return null;
    const versions = this.#versions.get(id) ?? [];
    return (version === null ? versions[versions.length - 1] : versions.find((v) => v.pack.version === version)) ?? null;
  }

  async byDigest(digest: string): Promise<LoadedWorkflow | null> {
    return this.#byDigest.get(digest) ?? null;
  }

  async summaries(user: Principal): Promise<PackSummary[]> {
    const out: PackSummary[] = [];
    for (const [id, versions] of this.#versions) {
      const latest = await this.forUser(user, id);
      if (latest === null || versions.length === 0) continue;
      out.push({
        pack: `${latest.pack.id}@${latest.pack.version}`,
        id: latest.pack.id,
        version: latest.pack.version,
        kind: latest.pack.kind,
        title: latest.manifest.title,
        description: latest.manifest.description,
        products: [],
        inputs: latest.workflow.inputs,
        parameters: latest.workflow.parameters.map((p) => ({ name: p.name, description: p.description, required: p.required, ...(p.schema !== undefined ? { schema: p.schema } : {}) })),
        requirements: latest.requirements.map(t=>requirementSummary(t,latest.ledger,latest.checks,`${latest.pack.id}@${latest.pack.version}`)),
      });
    }
    return out;
  }
}
