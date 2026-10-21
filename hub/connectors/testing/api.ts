// Public surface of the connectors' test toolkit (tests only, never a production entry point): loopback stubs that imitate the
// structures of the real systems with invented content, request recorders, tiny synthetic system packs and a fake PacksPort.
export { extend, json, notFound, startStub, text } from './stub.ts';
export type { RecordedRequest, StubHandler, StubReply, StubServer } from './stub.ts';

export { PAGE_SIZE, agileFixture, mindMap, passwordDigest, startAgileStub } from './agile.ts';
export type { AgileOptions, AgileStub, AgileTreeNode } from './agile.ts';

export { PLM_BUGS, PLM_BUILDS, PLM_PRODUCTS, PLM_STORIES, startPlmStub } from './plm.ts';
export type { PlmOptions, PlmStub } from './plm.ts';

export { BUILDS, buildSiteFiles, commandTree, startBuildSiteStub } from './buildsite.ts';
export type { StaticFile } from './buildsite.ts';

export { DOCUMENTS, startWebDavStub } from './webdav.ts';

export {
  AGILE_FUNCTIONS,
  BUILDSITE_FUNCTIONS,
  DOCSTORE_FUNCTIONS,
  FUNCTIONS_DIR,
  PLM_FUNCTIONS,
  agileSystem,
  buildSiteSystem,
  docStoreSystem,
  fakePacks,
  keyedStoreSystem,
  plmSystem,
  writePack,
} from './packs.ts';
export type { FakePacks, SyntheticPack } from './packs.ts';

export { clock, openConnectorKit } from './kit.ts';
export type { Clock, ConnectorKit } from './kit.ts';
