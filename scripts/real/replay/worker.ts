import { parentPort, workerData } from 'node:worker_threads';
import { inspectBundle, safeFile } from './bundle.ts';
import { play } from './player.ts';
import { ReplayError, requireFact, sha } from './types.ts';
if (parentPort) {
  try {
    const b = inspectBundle(workerData.bundle);
    requireFact(sha(safeFile(workerData.bundle, 'source.json')) === workerData.sourceSha256, '工作线程来源包摘要变化');
    const result = await play(b, workerData.app, workerData.options);
    parentPort.postMessage(result);
  }
  catch (error) {
    const e = error instanceof ReplayError ? error : new ReplayError('回放工作线程失败', 1, { errorSha256: sha(error instanceof Error ? error.message : String(error)) });
    parentPort.postMessage({ status: e.exit === 2 ? 'unavailable' : 'different', exit: e.exit, firstDifference: { fact: e.message, ...e.detail } });
  }
}
