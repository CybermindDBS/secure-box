/**
 * A few workers, one per spare CPU core (up to four), for the tasks in tasks.js (#21). They start
 * only through the page's Trusted Types policy, and nothing secret is needed for these tasks: a
 * worker gets decrypted document bytes or a file you chose, never a key.
 */
import { allowScript, trustedScriptUrl } from '../core/trusted.js';
import workerUrl from './tasks.worker.js?worker&url';

allowScript(workerUrl);

const SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const slots = []; // { worker, busy }
const jobs = new Map(); // id -> { resolve, reject, onProgress, slot }
let nextId = 0;
let broken = typeof Worker !== 'function';

function spawn() {
  try {
    const worker = new Worker(trustedScriptUrl(workerUrl), { type: 'module', name: 'secure-box-tasks' });
    const slot = { worker, busy: 0 };
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      if (!job) return;
      if ('progress' in data) return job.onProgress?.(data.progress);
      jobs.delete(data.id);
      slot.busy--;
      if (data.error) job.reject(Object.assign(new Error(data.error.message), { code: data.error.code, name: data.error.name }));
      else job.resolve(data.result);
    };
    worker.onerror = (event) => {
      // A worker that can't run (a browser without module workers): the page does the work.
      event.preventDefault?.();
      broken = true;
      for (const [id, job] of jobs) {
        if (job.slot !== slot) continue;
        jobs.delete(id);
        job.fallback();
      }
    };
    slots.push(slot);
    return slot;
  } catch {
    broken = true;
    return null;
  }
}

const pick = () => {
  const idle = slots.find((s) => !s.busy);
  if (idle) return idle;
  if (slots.length < SIZE) return spawn();
  return slots.reduce((a, b) => (b.busy < a.busy ? b : a));
};

async function runHere(task, args, onProgress) {
  const { TASKS } = await import('./tasks.js');
  return TASKS[task](args, onProgress);
}

/** Runs `task` with `args` in a worker (or on the page). `transfer`: buffers handed over, not copied. */
export function runTask(task, args, { transfer = [], onProgress } = {}) {
  if (broken) return runHere(task, args, onProgress);
  const slot = pick();
  if (!slot) return runHere(task, args, onProgress);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    slot.busy++;
    jobs.set(id, { resolve, reject, onProgress, slot, fallback: () => runHere(task, args, onProgress).then(resolve, reject) });
    slot.worker.postMessage({ id, task, args }, transfer);
  });
}
