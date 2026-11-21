import { useLayoutEffect, useRef, useState } from 'react';
import { setSection } from '../../session/nav.js';
import { Icon } from '../common/Icon.jsx';
import { useSession } from '../hooks.js';

const VAULT_TABS = [
  { id: 'passwords', label: 'Passwords', icon: 'key' },
  { id: 'files', label: 'Files', icon: 'folder' },
];
const LOCKED_TABS = [{ id: 'vault', label: 'Vault', icon: 'vault' }];
const TOOLS_TAB = { id: 'tools', label: 'Encrypt & decrypt', icon: 'fileLock' };

/** A raised "thumb" under the active tab of a pill, sliding between its tabs. */
function useThumb(pillRef, active) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    if (!pill) return undefined;
    const measure = () => {
      const tab = pill.querySelector('[role="tab"][aria-selected="true"]');
      setBox(tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    return () => observer.disconnect();
  }, [pillRef, active]);
  return box;
}

function Thumb({ box }) {
  return (
    <span
      className={`tab-thumb${box ? ' is-on' : ''}`}
      aria-hidden="true"
      style={box ? { transform: `translateX(${box.left}px)`, width: `${box.width}px` } : undefined}
    />
  );
}

/**
 * The sections, as one row of tabs in two pills: the vault's (Passwords and Files, or Vault while
 * locked), then, after a divider, Encrypt & decrypt. Arrow keys move between them. On phones the
 * same tabs sit in a bar at the bottom of the screen.
 */
export function Tabs({ before = null }) {
  const unlocked = useSession((s) => s.unlocked);
  const section = useSession((s) => s.section);
  const switching = useSession((s) => Boolean(s.switching));
  const vaultPill = useRef(null);
  const toolsPill = useRef(null);
  const vaultTabs = unlocked ? VAULT_TABS : LOCKED_TABS;
  const all = [...vaultTabs, TOOLS_TAB];
  const vaultThumb = useThumb(vaultPill, section);
  const toolsThumb = useThumb(toolsPill, section);

  const onKeyDown = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = all.findIndex((t) => t.id === section);
    const next = Number.isFinite(step) ? (index + step + all.length) % all.length : step < 0 ? 0 : all.length - 1;
    setSection(all[next].id);
    requestAnimationFrame(() => document.getElementById(`tab-${all[next].id}`)?.focus());
  };

  const tab = (t) => (
    <button
      key={t.id}
      id={`tab-${t.id}`}
      type="button"
      role="tab"
      className="tab"
      aria-selected={section === t.id}
      aria-controls="main"
      tabIndex={section === t.id ? 0 : -1}
      disabled={switching && t.id !== 'tools'}
      onClick={() => setSection(t.id)}
    >
      <Icon name={t.icon} size={16} />
      <span className="tab-label">{t.label}</span>
    </button>
  );

  return (
    <nav className={`tabs${unlocked ? '' : ' is-locked'}`} aria-label="Sections">
      {before}
      <div className="tablist" role="tablist" aria-label="Sections" onKeyDown={onKeyDown}>
        <div className={`tab-pill tab-pill-vault${before ? ' has-switcher' : ''}`} ref={vaultPill}>
          <Thumb box={vaultThumb} />
          {vaultTabs.map(tab)}
        </div>
        <span className="tab-divider" aria-hidden="true" />
        <div className="tab-pill tab-pill-tools" ref={toolsPill}>
          <Thumb box={toolsThumb} />
          {tab(TOOLS_TAB)}
        </div>
      </div>
    </nav>
  );
}
