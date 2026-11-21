/** A worker of the pool (pool.js): runs one task at a time and posts back its result. */
import { TASKS } from './tasks.js';

self.onmessage = async ({ data }) => {
  const { id, task, args } = data;
  try {
    const result = await TASKS[task](args, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: { message: err?.message || String(err), code: err?.code || '', name: err?.name || 'Error' } });
  }
};
