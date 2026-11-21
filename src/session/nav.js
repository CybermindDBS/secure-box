/**
 * Tabs, and the browser's Back and Forward: they move between tabs, folders, the viewer and
 * (on phones) an open item, like pages would.
 */
import { files } from './files.js';
import { setPref } from './prefs.js';
import { publish, state } from './store.js';
import { selectItem } from './passwords.js';
import { runDeferredSignIn } from './vaults.js';
import { closeViewer, viewerIsOpen } from './viewer.js';

const narrow = () => window.matchMedia('(max-width: 760px)').matches;
let restoring = false;
let viewerEntry = false; // the open viewer has a history entry of its own

export function navState() {
  return {
    sb: 1,
    section: state.section,
    folder: state.section === 'files' ? files.folder() : null,
    item: state.section === 'passwords' && narrow() ? state.selectedId : null,
  };
}

export function pushNav() {
  if (restoring) return;
  const next = navState();
  const now = history.state;
  if (now?.sb && !now.viewer && now.section === next.section && now.folder === next.folder && now.item === next.item) return;
  history.pushState(next, '');
}

export const replaceNav = () => history.replaceState(navState(), '');

/** Opens a tab: Passwords, Files or Encrypt & decrypt when unlocked; Vault or Encrypt & decrypt when locked. */
export function setSection(section, { push = true } = {}) {
  const allowed = state.unlocked ? ['passwords', 'files', 'tools'] : ['vault', 'tools'];
  if (!allowed.includes(section) || state.section === section) return;
  state.section = section;
  if (state.unlocked && section !== 'tools') setPref('section', section);
  if (!state.unlocked) setPref('lockedSection', section);
  publish();
  if (push) pushNav();
  if (!state.unlocked && section === 'vault') runDeferredSignIn();
}

/** The viewer tells the history when it opens and closes, so Back closes it (and nothing else). */
export function viewerOpened() {
  if (viewerEntry) return;
  history.pushState({ ...navState(), viewer: true }, '');
  viewerEntry = true;
}

export function viewerClosed() {
  if (!viewerEntry) return;
  viewerEntry = false;
  if (history.state?.viewer) history.back(); // closed in the page: take its entry off again
}

window.addEventListener('popstate', (event) => {
  const target = event.state;
  if (viewerIsOpen() && !target?.viewer) {
    viewerEntry = false; // Back already took the viewer's entry off
    closeViewer({ fromHistory: true });
  }
  if (!target?.sb) return;
  restoring = true;
  try {
    if (target.section !== state.section) setSection(target.section, { push: false });
    if (state.section === 'files' && target.folder !== files.folder()) files.goTo(target.folder ?? null, { push: false });
    if (state.section === 'passwords' && narrow() && target.item !== state.selectedId) {
      selectItem(target.item && state.vault?.items.some((it) => it.id === target.item) ? target.item : null, { push: false });
    }
  } finally {
    restoring = false;
  }
});

