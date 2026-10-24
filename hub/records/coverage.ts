// Operation-scoped coverage. Only this module retains exact matches; none are serialized, logged or returned.
import type {
  ArtifactOrigin, Authorizations, CredentialScan, DerivedCoverage, DerivedCoverageInput, DerivedScanAcceptance,
  EffectiveScanAcceptance, ObjectStore, RecordStore, ScanAcceptance, SourceArtifact, SourceArtifactBody, StoredRecord,
} from './api.ts';
import type { ReadTier } from '../../contracts/generated/vocabulary.ts';
import { digestOf, isSha256 } from './digest.ts';
import { scanAcceptanceKey } from './constants.ts';
import { hubArtifact, sourceLinks, type SourceLinks } from './lineage.ts';
import { CREDENTIAL_SCANNER, scanDigest, scanWithMatches,scanAllCredentials } from './scan.ts';

type Evidence = DerivedScanAcceptance['sources'][number];
type Scan = ReturnType<typeof scanWithMatches>;
interface IO { store: RecordStore; objects: ObjectStore; authorizations: Authorizations; scan(bytes: Uint8Array): Scan }
const originKey = (origin: ArtifactOrigin) => digestOf(origin);
const version = (scan: CredentialScan) => Number(/@([0-9]+)$/.exec(scan.scanner)?.[1] ?? 0);
const decisions = (e: ScanAcceptance[]) => [...new Set(e.map(a => a.authorization))].sort().join(',');

/** Immutable graph records are fetched by frontier, never by source or by entry. */
export class CoverageContext {
  readonly #io: IO;
  readonly records = new Map<string,StoredRecord>();
  readonly bySha = new Map<string,SourceArtifact[]>();
  readonly #missing = new Set<string>();
  readonly #loadedSha = new Set<string>();
  readonly #links = new Map<string,SourceLinks | null>();
  readonly #lineage = new Map<string,boolean>();
  readonly #originHub = new Map<string,boolean>();
  readonly #effective = new Map<string,EffectiveScanAcceptance | null>();
  readonly #fullScans=new Map<string,Scan>();
  readonly #fullFacts=new Map<string,CredentialScan>();
  readonly #facts = new Map<string,CredentialScan | null>();
  #config = new Map<string, import('./api.ts').AuthorizationRecord>();

  constructor(io: IO) { this.#io = io; }

  async #fetch(digests: Iterable<string>): Promise<void> {
    const needed = [...new Set(digests)].filter(d => isSha256(d) && !this.records.has(d) && !this.#missing.has(d));
    if (!needed.length) return;
    const found = await this.#io.store.getMany(needed);
    for (const digest of needed) { const record = found.get(digest); if (record) this.records.set(digest,record); else this.#missing.add(digest); }
  }

  async #loadSha(shas: Iterable<string>, force = false): Promise<void> {
    const needed = [...new Set(shas)].filter(s => isSha256(s) && (force || !this.#loadedSha.has(s)));
    if (!needed.length) return;
    const rows = await this.#io.store.findMany<SourceArtifactBody>({key:'artifact.sha256',values:needed,kind:'source_artifact'});
    for (const sha of needed) { this.#loadedSha.add(sha); this.bySha.set(sha,[]); }
    for (const row of rows) {
      this.records.set(row.digest,row);
      this.bySha.get(row.body.sha256)?.push(row);
    }
    this.#facts.clear(); this.#effective.clear();
  }

  async load(origins: readonly ArtifactOrigin[], seeds: readonly SourceArtifact[] = []): Promise<void> {
    for (const row of seeds) { this.records.set(row.digest,row); const list = this.bySha.get(row.body.sha256) ?? []; list.push(row); this.bySha.set(row.body.sha256,list); this.#loadedSha.add(row.body.sha256); }
    let pending = [...origins];
    for (let depth = 0; pending.length && depth <= 32; depth++) {
      const batch = [...new Map(pending.filter(o => !this.#links.has(originKey(o))).map(o => [originKey(o),o])).values()];
      pending = [];
      if (!batch.length) break;
      const refs = batch.flatMap(o => 'generated' in o ? o.generated.inputs.flatMap(i => /^rec:([a-f0-9]{64})$/.exec(i)?.slice(1) ?? []) : []);
      await this.#fetch(refs);
      const parts: string[] = [];
      for (const ref of refs) {
        const record = this.records.get(ref);
        if (record?.kind === 'tree_root' && record.schema === 'tree_root@1') {
          const body = record.body as {parts?:{sources?:Array<{record:string}>}};
          parts.push(...(body.parts?.sources ?? []).map(p => p.record));
        }
      }
      await this.#fetch(parts);
      const links: SourceLinks[] = [];
      for (const origin of batch) {
        const value = 'generated' in origin ? await sourceLinks({get:async <B>(d: string) => (this.records.get(d) as StoredRecord<B> | undefined) ?? null},origin) : null;
        this.#links.set(originKey(origin),value);
        if (value) links.push(value);
      }
      const shas = new Set<string>(), pins = new Set<string>();
      for (const link of links) for (const [sha,records] of link) { shas.add(sha); for (const pin of records) if (pin !== null) pins.add(pin); }
      await Promise.all([this.#fetch(pins),this.#loadSha(shas)]);
      for (const link of links) for (const [sha,pins] of link) {
        for (const row of this.bySha.get(sha) ?? []) if ((pins.has(null) || pins.has(row.digest)) && hubArtifact(row)) pending.push(row.body.origin);
        for (const pin of pins) {
          const row = pin === null ? undefined : this.records.get(pin) as SourceArtifact | undefined;
          if (row?.kind === 'source_artifact' && row.body.sha256 === sha && hubArtifact(row)) pending.push(row.body.origin);
        }
      }
    }
    await this.refresh();
  }

  /** Refresh only credential-bearing dependencies, in bulk. Immutable ancestry is not walked or scanned again. */
  async refresh(reload = false): Promise<void> {
    const shas = [...this.bySha].filter(([,rows]) => rows.some(r => r.body.scan.findings.length > 0)).map(([sha]) => sha);
    if (reload) await this.#loadSha(shas,true);
    this.#config = await this.#io.authorizations.resourceConfigs(shas.map(scanAcceptanceKey));
    this.#fullFacts.clear();this.#facts.clear();
    for(const sha of shas){
      if(!this.#config.has(scanAcceptanceKey(sha))||!(this.bySha.get(sha)??[]).some(row=>row.body.scan.truncated))continue;
      const bytes=await this.#io.objects.get(sha);if(!bytes)continue;
      const full=this.#fullScans.get(sha)??this.#io.scan(bytes);this.#fullScans.set(sha,full);
      if(full.complete&&!full.scan.truncated&&full.scan.inspected)this.#fullFacts.set(sha,full.scan);
    }
    this.#effective.clear();
  }

  links(origin: ArtifactOrigin): SourceLinks | null { return this.#links.get(originKey(origin)) ?? null; }

  hubOrigin(origin: ArtifactOrigin, path = new Set<string>()): boolean {
    if ('read' in origin) return true;
    if (!('generated' in origin)) return false;
    const key = originKey(origin);
    const cached = this.#originHub.get(key); if (cached !== undefined) return cached;
    const links = this.links(origin);
    if (links === null) return false;
    for (const [sha,pins] of links) for (const pin of pins) {
      const rows = pin === null ? this.bySha.get(sha) ?? [] : [this.records.get(pin) as SourceArtifact].filter(Boolean);
      if (!rows.some(row => row.body.sha256 === sha && this.hub(row,path))) { this.#originHub.set(key,false); return false; }
    }
    this.#originHub.set(key,true); return true;
  }

  hub(row: SourceArtifact, path = new Set<string>()): boolean {
    if (!hubArtifact(row) || path.has(row.digest) || path.size >= 32) return false;
    const cached = this.#lineage.get(row.digest); if (cached !== undefined) return cached;
    const next = new Set(path); next.add(row.digest);
    const valid = this.hubOrigin(row.body.origin,next);
    this.#lineage.set(row.digest,valid); return valid;
  }

  /** Stored scan facts only: no byte reads and no credential scan on a read. */
  facts(sha: string): CredentialScan | null {
    if(this.#fullFacts.has(sha))return this.#fullFacts.get(sha)!;
    if (this.#facts.has(sha)) return this.#facts.get(sha)!;
    const rows = this.bySha.get(sha) ?? [];
    const newest = Math.max(...rows.map(r => version(r.body.scan)));
    const hits = rows.filter(r => version(r.body.scan) === newest && r.body.scan.findings.length > 0).map(r => r.body.scan);
    const first = hits[0];
    const result = !first || first.scanner !== CREDENTIAL_SCANNER || !first.inspected || first.truncated || hits.some(s => s.scanner !== CREDENTIAL_SCANNER || !s.inspected || s.truncated || scanDigest(s) !== scanDigest(first)) ? null : first;
    this.#facts.set(sha,result); return result;
  }

  acceptance(row: SourceArtifact, path = new Set<string>()): EffectiveScanAcceptance | null {
    if (!this.hub(row) || path.has(row.digest) || path.size >= 32) return null;
    if (this.#effective.has(row.digest)) return this.#effective.get(row.digest)!;
    const finish = (v: EffectiveScanAcceptance | null) => { this.#effective.set(row.digest,v); return v; };
    const scan = this.facts(row.body.sha256);
    if (!scan) return finish(null);
    const direct = this.#config.get(scanAcceptanceKey(row.body.sha256));
    if (direct?.body.bound === scanDigest(scan)) return finish({kind:'direct',acceptance:{by:direct.body.decided_by,at:direct.body.decided_at,authorization:direct.digest}});
    const prior = row.body.scan.derived;
    if (!prior?.sources.length || prior.scanner !== undefined && prior.scanner !== CREDENTIAL_SCANNER || prior.scan_digest !== undefined && prior.scan_digest !== scanDigest(scan)) return finish(null);
    const next = new Set(path); next.add(row.digest);
    if (!this.validProof(prior,row.body.origin,next)) return finish(null);
    return finish({kind:'derived',acceptance:prior});
  }

  validProof(proof: DerivedScanAcceptance, origin: ArtifactOrigin, path = new Set<string>()): boolean {
    const links = this.links(origin);
    if (!links || !this.hubOrigin(origin)) return false;
    for (const source of proof.sources) {
      const pins = links.get(source.sha256), row = this.records.get(source.record) as SourceArtifact | undefined;
      if (!pins || !pins.has(null) && !pins.has(source.record) || !row || row.kind !== 'source_artifact' || row.body.sha256 !== source.sha256) return false;
      const accepted = this.acceptance(row,path);
      if (!accepted || this.tier(row,accepted) === 'retain_only') return false;
      const evidence = accepted.kind === 'direct' ? [accepted.acceptance] : accepted.acceptance.sources.flatMap(s => s.acceptances);
      if (decisions(evidence) !== decisions(source.acceptances)) return false;
    }
    return proof.sources.length > 0;
  }

  tier(row: SourceArtifact, acceptance: EffectiveScanAcceptance | null): ReadTier {
    if (!acceptance) return row.body.read_tier;
    // Compatibility policy, not reconstruction of the historical request: a newly
    // accepted legacy scan hold uses the default tier. Stored acceptance on an
    // already-retained legacy record proves an explicit retention request.
    return row.body.requested_read_tier ?? (row.body.read_tier === 'retain_only' && !row.body.scan.accepted && !row.body.scan.derived ? 'model_readable' : row.body.read_tier);
  }

  async prepare(input: DerivedCoverageInput): Promise<{handle:DerivedCoverage;valid:boolean}> {
    const values = new Map<string,Evidence>();
    const valid = input.author.user === null && 'generated' in input.origin && this.hubOrigin(input.origin);
    if (valid) {
      const links = this.links(input.origin)!;
      for (const sha of new Set(input.derivedSources)) {
        const pins = links.get(sha); if (!pins) { values.clear(); return this.#matcher(values,false); }
        for (const row of [...(this.bySha.get(sha) ?? [])].reverse()) {
          if (!pins.has(null) && !pins.has(row.digest)) continue;
          const accepted = this.acceptance(row);
          if (!accepted || this.tier(row,accepted) === 'retain_only') continue;
          const bytes = await this.#io.objects.get(sha); if (!bytes) continue;
          const source = this.#fullScans.get(sha)??this.#io.scan(bytes), recorded = this.facts(sha);
          if (!recorded || !source.scan.inspected || source.scan.truncated || !source.complete || scanDigest(source.scan) !== scanDigest(recorded)) continue;
          const evidence = accepted.kind === 'direct' ? [accepted.acceptance] : accepted.acceptance.sources.flatMap(s => s.acceptances);
          const acceptances = [...new Map(evidence.map(a => [a.authorization,a])).values()].sort((a,b) => a.authorization < b.authorization ? -1 : a.authorization > b.authorization ? 1 : 0);
          const receipt = {sha256:sha,record:row.digest,acceptances};
          for (const value of source.matches) if (!values.has(value)) values.set(value,receipt);
          break;
        }
      }
    }
    return this.#matcher(values,valid);
  }

  #matcher(values: Map<string,Evidence>, valid: boolean): {handle:DerivedCoverage;valid:boolean} {
    const handle: DerivedCoverage = {assess:(bytes) => {
      const found = this.#io.scan(bytes);
      if (!valid || !found.scan.inspected || found.scan.truncated || !found.complete || !found.matches.length) return {scan:found.scan,derived:null};
      const sources = new Map<string,Evidence>();
      for (const value of found.matches) {
        const source = values.get(value); if (!source) return {scan:found.scan,derived:null};
        sources.set(source.record,source);
      }
      return {scan:found.scan,derived:{scanner:CREDENTIAL_SCANNER,scan_digest:scanDigest(found.scan),sources:[...sources.values()].map(source => ({...source,acceptances:source.acceptances.map(a => ({...a}))}))}};
    }};
    return {handle,valid};
  }
}
