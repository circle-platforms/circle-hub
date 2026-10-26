// A fake ExternalReaderPort: toy systems whose objects are stored through the records' artifacts like a connector stores what
// it reads (the original by SHA-256, visible to the reader whose credential read it, never shareable). One type always fails.
import type { Artifacts } from '../../../records/api.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort } from '../../../ports.ts';

export interface FakeObject {
  bytes: Uint8Array;
  mediaType: string;
  /** Becomes the `meta` artifact (JSON): what the system pack derived about the object. */
  meta?: Record<string, unknown>;
}

export class FakeExternal implements ExternalReaderPort {
  readonly #artifacts: Artifacts;
  readonly objects = new Map<string, FakeObject>();
  /** Every read, for assertions: the id and whose principal read it. */
  readonly reads: { id: string; principal: string; purpose: string }[] = [];

  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }

  put(id: string, object: FakeObject): void {
    this.objects.set(id, object);
  }

  async accepts(id: string): Promise<boolean> {
    return id.startsWith('toy:');
  }

  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push({ id, principal: context.principal.id, purpose: context.purpose });
    const object = this.objects.get(id);
    if (object === undefined) return { ok: false, id, reason: `synthetic system answered 404 for ${id}` };
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const original = await this.#artifacts.ingest({
      bytes: object.bytes,
      mediaType: object.mediaType,
      origin: { read: { object: `${id}@1` } },
      author: { user: null },
      provenanceType: 'observed',
      visibility,
      name: id,
    });
    const artifacts = [{ name: 'original', artifact: original }];
    if (object.meta !== undefined) {
      const meta = await this.#artifacts.ingest({
        bytes: new TextEncoder().encode(JSON.stringify(object.meta)),
        mediaType: 'application/json',
        origin: { read: { object: `${id}@1` } },
        author: { user: null },
        provenanceType: 'projected',
        visibility,
        name: `${id} meta`,
      });
      artifacts.push({ name: 'meta', artifact: meta });
    }
    return { ok: true, id, revision: '1', artifacts, manifest: 'synthetic' };
  }
}
