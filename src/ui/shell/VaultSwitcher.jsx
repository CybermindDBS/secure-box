import { companyName, microsoftReady, placeName, PROVIDERS } from '../../session/places.js';
import { DEMO } from '../../session/store.js';
import { switchTitle, switchVault } from '../../session/vaults.js';
import { Icon, Spinner } from '../common/Icon.jsx';
import { Menu } from '../common/Menu.jsx';
import { useVersion } from '../hooks.js';
import { state } from '../../session/store.js';

/** What each place says in the switcher: open, signed in, or how you'd open it. */
function optionText(p, s) {
  const opening = s.switching?.provider || null;
  const current = s.unlocked && p === s.provider;
  const available = p !== 'microsoft' || microsoftReady();
  if (p === opening) return 'Opening…';
  if (current) return p === 'local' ? (s.backend?.where === 'folder' ? `“${s.backend.name}” › Secure Box` : 'In this browser') : s.identity?.email || '';
  if (!available) return 'Not set up on this copy of Secure Box';
  let sub = p === 'local' ? 'Only on this device, not synced' : DEMO ? 'Sample data, only in this tab' : s.auths[p] ? `Signed in · ${s.auths[p].identity.email}` : `Sign in with ${companyName(p)}`;
  // A vault known to have its own key ring says so: switching to it asks for its master password.
  if (s.master && s.kids[p] && s.kids[p] !== s.master.kid) sub += ' · own master password';
  return sub;
}

/**
 * The vault the Passwords and Files tabs show, at the start of their pill: a menu to open the
 * others without locking. While one opens, it names that one, with a spinner for its icon.
 */
export function VaultSwitcher() {
  useVersion();
  const s = state;
  const opening = s.switching?.provider || null;
  const shown = opening || s.provider;
  const name = placeName(shown);
  return (
    <Menu
      align="left"
      className="source-menu"
      label="Your vaults"
      button={(props) => (
        <button
          {...props}
          type="button"
          className={`place-pill${opening ? ' is-opening' : ''}`}
          title={opening ? `${switchTitle(opening)}…` : shown === 'local' ? 'Passwords and Files are kept on this device only' : `Passwords and Files are stored in your ${name}`}
          aria-label={opening ? switchTitle(opening) : `${name}: where Passwords and Files are kept. Open another vault.`}
        >
          {opening ? <Spinner small /> : <Icon name={shown === 'local' ? 'device' : 'cloud'} size={16} />}
          <span className="place-pill-name">{name}</span>
          <Icon name="chevronDown" size={14} className="place-pill-chevron" />
        </button>
      )}
    >
      <div className="menu-head">
        <span className="menu-label">Your vaults</span>
      </div>
      {PROVIDERS.filter((p) => !DEMO || p !== 'microsoft').map((p) => {
        const current = s.unlocked && p === s.provider;
        const available = p !== 'microsoft' || microsoftReady();
        return (
          <button
            key={p}
            type="button"
            role="menuitem"
            className={`source-option${current ? ' is-current' : ''}${available ? '' : ' is-soon'}`}
            disabled={current || !available || Boolean(opening)}
            onClick={() => switchVault(p)}
          >
            <Icon name={p === 'local' ? 'device' : 'cloud'} size={18} />
            <span className="source-option-text">
              <strong>{placeName(p)}</strong>
              <small>{optionText(p, s)}</small>
            </span>
            <Icon name="check" size={16} className="source-check" />
          </button>
        );
      })}
      <p className="source-foot">Each keeps its own passwords and files. The clouds sync across your devices; This device keeps them here only.</p>
    </Menu>
  );
}
