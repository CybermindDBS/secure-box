/**
 * Experiments: features kept in the code but left out of the app people use. Production builds
 * (npm run build, and so every deploy) leave them off, and the build drops the code only they
 * reach; an experimental build (npm run dev:experimental, npm run build:experimental) turns them
 * on, to try them out. Node (the tests) knows nothing of the switch, so they're off there too.
 *
 *   browser-vault  a vault on this device kept in the browser's own storage, rather than in a
 *                  folder you choose. That storage belongs to the site's address: moving Secure
 *                  Box to another address would leave such a vault behind.
 */
// Set by vite.config.js: true only in the experimental build.
// eslint-disable-next-line no-undef
const ON = typeof __EXPERIMENTS__ !== 'undefined' && __EXPERIMENTS__;

/** A vault on this device in the browser's own storage. */
export const BROWSER_VAULT = ON;

/** The experiments this build has, by name: shown by its badge, and checked by the build check. */
export const EXPERIMENTS = ON ? ['browser-vault'] : [];
