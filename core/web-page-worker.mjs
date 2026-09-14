/** Public text only. No network, private context, model, or browser access. */
import { parentPort, workerData } from 'node:worker_threads';
import { extractReadablePage, WebResearchError } from './web-research.mjs';

try {
  parentPort.postMessage({ page: extractReadablePage(workerData.input, workerData.options) });
} catch (error) {
  const safe = error instanceof WebResearchError ? error
    : new WebResearchError('The web page could not be read.', { code: 'UNREADABLE_RESPONSE', status: 502 });
  parentPort.postMessage({ error: { message: safe.message, status: safe.status, code: safe.code } });
}
