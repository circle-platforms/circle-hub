// Reading the feeding layer beside seedlings (the kb-feeding-views task, docs/hub-r4-tasks/kb-feeding.md): five object
// kinds, version bindings, usages, the frozen offset and retractions are append-only records the Hub-side store
// (kb-feeding-hub) owns. This module is the read shape the views consume: a cut of the layer at a frozen sequence
// (only records up to that offset), bindings grouped per object with undeclared and conflict counted apart, and
// contradictions counted apart. Nothing here decides identity, binding or association by keywords: every join is a
// digest equality, and inheritance is expanded only by the product pack's declared rule.
import type { FedCase, KnowledgeStructure, VersionBinding, FeedingUsage, FeedingRetraction } from '../../contracts/src/feeding.ts';
import type { FeedingCut, FeedingReader, KnowledgeStructureObject } from './feeding-types.ts';

export type { FeedingCut, FeedingReader, KnowledgeStructureObject } from './feeding-types.ts';
export { FEEDING_INDEX } from './feeding-types.ts';
export { RecordFeedingReader } from './feeding-reader.ts';
export { boundLines } from './feeding-reader.ts';
void (null as unknown as FedCase | KnowledgeStructure | VersionBinding | FeedingUsage | FeedingRetraction | FeedingReader | FeedingCut);
