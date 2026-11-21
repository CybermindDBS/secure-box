import { toast } from '../session/bridge.js';

/** Runs an action from a click; whatever goes wrong shows as a toast (never an unhandled error). */
export function run(action, ...args) {
  return Promise.resolve()
    .then(() => action(...args))
    .catch((err) => {
      console.error(err);
      if (err?.code !== 'cancelled') toast(err?.message || 'Something went wrong.', 'error');
    });
}
