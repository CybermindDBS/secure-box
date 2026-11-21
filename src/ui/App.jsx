import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { ask, setTransitionRunner } from '../session/bridge.js';
import { files } from '../session/files.js';
import { closeDetail, moveSelection } from '../session/passwords.js';
import { state } from '../session/store.js';
import { DialogHost } from './dialogs/DialogHost.jsx';
import { Toasts } from './common/Toasts.jsx';
import { useKeydown, useSession } from './hooks.js';
import { VaultHome } from './home/VaultHome.jsx';
import './files/FilesDialogs.jsx';
import { FilesView } from './files/FilesView.jsx';
import { TransfersTray } from './files/TransfersTray.jsx';
import { Viewer } from './viewer/Viewer.jsx';
import { PasswordsView } from './passwords/PasswordsView.jsx';
import { DeviceBar } from './shell/DeviceBar.jsx';
import { TopBar } from './shell/TopBar.jsx';
import { ToolsView } from './tools/ToolsView.jsx';

// Cross-fades: a View Transition around a synchronous render of the new state.
setTransitionRunner((update) => {
  const transition = document.startViewTransition(() => flushSync(update));
  transition.ready.catch(() => {}); // a newer transition skips this one, which is fine
  transition.finished.catch(() => {});
  return transition.updateCallbackDone;
});

const typingIn = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

/** Shortcuts for the whole page (Files adds its own). `?` lists them all. */
function useShortcuts() {
  useKeydown((event) => {
    if (!state.unlocked || state.switching || document.querySelector('dialog[open]')) return;
    const typing = typingIn(event.target);
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const searchable = state.section === 'passwords' || state.section === 'files';
    if (searchable && ((event.key === '/' && !typing && plain) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault();
      window.dispatchEvent(new Event('secure-box:search'));
    } else if (event.key === '?' && !typing) {
      event.preventDefault();
      ask('shortcuts');
    } else if (state.section === 'passwords' && !typing && plain) {
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        window.dispatchEvent(new Event('secure-box:new-item'));
      } else if (event.key === 'Escape' && state.selectedId) closeDetail();
    } else if (state.section === 'files') files.key?.(event, { typing, plain });
  }, []);
  // Arrow keys in the search field move through the password list.
  useEffect(() => {
    const onKey = ({ detail: event }) => {
      if (state.section !== 'passwords') return files.searchKey?.(event);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      }
      return undefined;
    };
    window.addEventListener('secure-box:search-key', onKey);
    return () => window.removeEventListener('secure-box:search-key', onKey);
  }, []);
}

export default function App() {
  const unlocked = useSession((s) => s.unlocked);
  const section = useSession((s) => s.section);
  const switching = useSession((s) => Boolean(s.switching));
  const arriving = useSession((s) => Boolean(s.arriving));
  useShortcuts();
  return (
    <>
      <div className={`shell ${unlocked ? 'app is-unlocked' : 'is-locked'}${switching ? ' is-switching' : ''}${arriving ? ' is-arriving' : ''}`} data-section={section}>
        <TopBar />
        {unlocked && section !== 'tools' ? <DeviceBar /> : null}
        <main id="main" className="view" role="tabpanel" aria-labelledby={`tab-${section}`}>
          {!unlocked ? (
            <div className="view-panel" hidden={section !== 'vault'}>
              <VaultHome />
            </div>
          ) : (
            <>
              <div className="view-panel" hidden={section !== 'passwords'}>
                <PasswordsView />
              </div>
              <div className="view-panel" hidden={section !== 'files'}>
                <FilesView />
              </div>
            </>
          )}
          <div className="view-panel" hidden={section !== 'tools'}>
            <ToolsView />
          </div>
        </main>
      </div>
      {unlocked ? <TransfersTray /> : null}
      {unlocked ? <Viewer /> : null}
      <DialogHost />
      <Toasts />
    </>
  );
}
