// The products the product reader port lets one account read, decided once per request (decision 82). Inside a request's
// permission snapshot the first answer for an account is reused by every later check of that account in the same request
// and is dropped with the snapshot when the request ends; another account, another request, a background job after its
// request ended and a read outside any request (CLI, tests without a snapshot) ask the port again. A failed answer is
// never kept (records' requestRead).
import type { PacksPort } from '../ports.ts';
import { requestRead, type Principal } from '../records/api.ts';

/** One key per product port, so two knowledge services in one process never share an answer. */
const ports = new WeakMap<object, string>();
let portCount = 0;

/** Weight of an answer for the request cache's byte budget: the product ids in UTF-16, plus a fixed overhead. */
const weight = (products: ReadonlySet<string>): number => 64 + [...products].reduce((sum, id) => sum + 2 * id.length, 0);

export function readableProducts(packs: Pick<PacksPort, 'readableProducts'>, account: Principal): Promise<ReadonlySet<string>> {
  let port = ports.get(packs);
  if (port === undefined) { port = `knowledge.readable-products:${++portCount}`; ports.set(packs, port); }
  return requestRead(account.id, port, () => packs.readableProducts(account), weight);
}
