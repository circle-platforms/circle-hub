// Request evidence is attached only when one original error names one actual request record.
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { RequestBody } from '../../requests/api.ts';
import type { StoredRecord } from '../../records/api.ts';

type RequestEvidence = Pick<StoredRecord<RequestBody>, 'digest' | 'body'>;

/** Copy persisted values, including a deadline fixed by request deduplication, without parsing display text. */
export function requestErrorFields(request: RequestEvidence) {
  const { missing, audience, due, next_action, item } = request.body;
  return { missing, request_id: `rec:${request.digest}`, audience, due, next_action,
    ...(item === undefined ? {} : { items: [item] }) };
}

/** Delay attachment until all producers finish: multiple requests must not masquerade as a unique request. */
export function createRequestErrorBindings() {
  const bindings = new Map<ProtocolError, Map<string, RequestEvidence>>();
  return {
    bind(error: ProtocolError, request: RequestEvidence): void {
      let requests = bindings.get(error);
      if (!requests) { requests = new Map(); bindings.set(error, requests); }
      requests.set(request.digest, request);
    },
    apply(): void {
      for (const [error, requests] of bindings) {
        if (requests.size !== 1) continue;
        const request = requests.values().next().value!;
        if (error.request_id !== undefined && error.request_id !== `rec:${request.digest}`) continue;
        Object.assign(error, requestErrorFields(request));
      }
    },
  };
}
