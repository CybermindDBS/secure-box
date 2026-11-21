import { useEffect, useRef, useState } from 'react';
import { lockWhenAsked } from '../../session/cloud.js';
import { files } from '../../session/files.js';
import { setQuery } from '../../session/passwords.js';
import { DEMO } from '../../session/store.js';
import { Icon } from '../common/Icon.jsx';
import { useSession, useStore } from '../hooks.js';
import { run } from '../run.js';
import { AppMenu } from './AppMenu.jsx';
import { Tabs } from './Tabs.jsx';
import { VaultSwitcher } from './VaultSwitcher.jsx';

/** The search field of Passwords and Files. On phones it takes over the top bar while open. */
function Search({ open, setOpen }) {
  const section = useSession((s) => s.section);
  const query = useSession((s) => s.query);
  const filesQuery = useStore(files.store, (v) => v.query);
  const switching = useSession((s) => Boolean(s.switching));
  const ref = useRef(null);
  const inFiles = section === 'files';
  const value = inFiles ? filesQuery : query;
  const set = (next) => (inFiles ? files.setQuery(next) : setQuery(next));
  useEffect(() => {
    const focus = () => {
      setOpen(true);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.select();
      });
    };
    window.addEventListener('secure-box:search', focus);
    return () => window.removeEventListener('secure-box:search', focus);
  }, [setOpen]);
  return (
    <label className="search">
      <Icon name="search" />
      <input
        ref={ref}
        id="search"
        type="search"
        placeholder={inFiles ? 'Search files' : 'Search passwords'}
        autoComplete="off"
        spellCheck={false}
        aria-label={inFiles ? 'Search files' : 'Search passwords'}
        value={value}
        disabled={switching}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (value) {
              event.preventDefault();
              set('');
            } else setOpen(false);
          } else window.dispatchEvent(new CustomEvent('secure-box:search-key', { detail: event }));
        }}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
      />
      <kbd aria-hidden="true">/</kbd>
    </label>
  );
}

export function TopBar() {
  const unlocked = useSession((s) => s.unlocked);
  const section = useSession((s) => s.section);
  const switching = useSession((s) => Boolean(s.switching));
  const [searching, setSearching] = useState(false);
  const searchable = unlocked && (section === 'passwords' || section === 'files');
  return (
    <header className={`topbar${searching && searchable ? ' is-searching' : ''}`}>
      <div className="brand">
        <img className="mark-sm" src="assets/favicon.svg" alt="" width="28" height="28" />
        <span className="brand-name">Secure Box</span>
        {DEMO ? <span className="badge">Demo</span> : null}
      </div>
      <Tabs before={unlocked ? <VaultSwitcher /> : null} />
      {searchable ? <Search open={searching} setOpen={setSearching} /> : null}
      <div className="top-actions">
        {unlocked ? (
          <>
            {searchable ? (
              <button
                type="button"
                className="icon-btn search-open"
                aria-label="Search"
                title="Search"
                onClick={() => window.dispatchEvent(new Event('secure-box:search'))}
              >
                <Icon name="search" />
              </button>
            ) : null}
            {searching && searchable ? (
              <button type="button" className="icon-btn search-close" aria-label="Close search" title="Close search" onClick={() => setSearching(false)}>
                <Icon name="x" />
              </button>
            ) : null}
            <AppMenu />
            <button type="button" className="icon-btn" aria-label="Lock" title="Lock" disabled={switching} onClick={() => run(lockWhenAsked)}>
              <Icon name="lock" />
            </button>
          </>
        ) : (
          <a className="top-link" href="https://github.com/CybermindDBS/secure-box" target="_blank" rel="noopener noreferrer">
            <Icon name="code" size={16} />
            <span>Source code</span>
          </a>
        )}
      </div>
    </header>
  );
}
