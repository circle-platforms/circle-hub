// Public surface of the connectors package (D01 D02 D03-read D07-resources, B02 provenance, B05 read actions, R02). Other
// packages import only this file. The server wires createConnectors and hands `reader` (ExternalReaderPort) to runs and
// knowledge and `catalog` (ResourceCatalogPort) to the console; `admin` backs the resource commands.
export { createConnectors, createExternalReader, createResourceCatalog, osIsolationAvailable } from './connectors.ts';
export type { Connectors, ConnectorsOptions, ResourceAdmin } from './connectors.ts';

export type { PackFunctionRunner, ReadArgs, ReadOutcome } from './read.ts';
export { COMPONENT, parseExternal } from './read.ts';

export type { AddResourceInput, CredentialDescription, ResourceDescription, UpdateResourceInput } from './resources.ts';
export { credentialEntry, sessionEntry, storedCredential } from './resources.ts';

export type { LoginStatus } from './login.ts';

export { HttpSource, atPointer, decodeText } from './http.ts';
export type { ConnectorLog, ConnectorLogEvent, FetchLike, HttpExchange, HttpReply, HttpRequest, HttpSourceOptions, LoginHooks } from './http.ts';

export { CONNECTOR_ERRORS, ConnectorError, isConnectorErrorCode } from './errors.ts';
export type { ConnectorErrorCode, ErrorLayer } from './errors.ts';

export { matchRoute, compileRoutes } from './routes.ts';
export { shapeProblem } from './shape.ts';
export { readProfile } from './profiles.ts';

export { Redactor } from './redact.ts';
