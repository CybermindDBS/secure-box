import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { generatePassword, passwordEntropyBits } from '../../core/crypto.js';
import { hostnameOf, safeHref } from '../../core/vault.js';
import { confirmDialog } from '../../session/bridge.js';
import { syncLabel } from '../../session/cloud.js';
import { formatDate, relativeTime } from '../../session/io.js';
import { closeDetail, copyValue, deleteItem, exportCsv, importCsv, saveItem, selectItem, subtitleOf, toggleReveal, visibleItems } from '../../session/passwords.js';
import { pref, setPref } from '../../session/prefs.js';
import { state } from '../../session/store.js';
import { switchTitle } from '../../session/vaults.js';
import { Modal } from '../dialogs/Modal.jsx';
import { Avatar, Icon, Spinner } from '../common/Icon.jsx';
import { Menu, MenuItem } from '../common/Menu.jsx';
import { Segmented } from '../common/Segmented.jsx';
import { useIncremental, useSession, useVersion } from '../hooks.js';
import { run } from '../run.js';

/** What fills Passwords and Files while another vault opens. */
export function SwitchLoader() {
  const switching = useSession((s) => s.switching);
  if (!switching) return null;
  return (
    <div className="vault-loader" role="status">
      <span className="vault-loader-mark" aria-hidden="true">
        <Icon name={switching.provider === 'local' ? 'device' : 'cloud'} size={24} />
      </span>
      <p className="vault-loader-title">{switchTitle(switching.provider)}</p>
      <p key={switching.step} className="vault-loader-step">
        {switching.step}
      </p>
    </div>
  );
}

export function SyncStatus() {
  const sync = useSession((s) => s.sync);
  useSession((s) => s.provider);
  return (
    <span className="sync-status" data-state={sync} role="status">
      {syncLabel(sync)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
/** One entry: drawn again only when it, or whether it's open or busy, changes. */
const ItemRow = memo(function ItemRow({ item, open, busy }) {
  return (
    <li>
      <button
        type="button"
        className={`row${open ? ' is-selected' : ''}${busy ? ' is-pending' : ''}`}
        data-id={item.id}
        aria-current={open ? 'true' : undefined}
        aria-busy={busy ? 'true' : undefined}
        onClick={() => selectItem(item.id)}
      >
        <Avatar item={item} />
        <span className="row-text">
          <span className="row-title">{item.title}</span>
          <span className="row-sub">{busy === 'deleting' ? 'Deleting…' : busy === 'saving' ? 'Saving…' : subtitleOf(item)}</span>
        </span>
        {busy ? <Spinner small /> : null}
      </button>
    </li>
  );
});

function ItemList({ onNew }) {
  const vault = useSession((s) => s.vault);
  const query = useSession((s) => s.query);
  const selectedId = useSession((s) => s.selectedId);
  const pending = useSession((s) => s.pending);
  const switching = useSession((s) => Boolean(s.switching));
  const items = useMemo(() => visibleItems(vault, query), [vault, query]);
  const listRef = useRef(null);
  // Thousands of entries (an import, say): drawn a batch at a time as the list is scrolled.
  const { count, more, sentinel, reveal } = useIncremental(items.length, { key: query, first: 100, step: 200 });
  useEffect(() => {
    if (!selectedId) return;
    const at = items.findIndex((it) => it.id === selectedId);
    if (at >= 0) reveal(at);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [selectedId, items, reveal]);
  if (switching) {
    return (
      <div id="list-empty" className="list-empty">
        <SwitchLoader />
      </div>
    );
  }
  const total = vault?.items.length || 0;
  return (
    <>
      <ul
        id="list"
        className="list"
        ref={listRef}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const index = items.findIndex((it) => it.id === selectedId);
          const at = Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
          const next = items[at];
          if (next) {
            reveal(at);
            selectItem(next.id);
            requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus());
          }
        }}
      >
        {(count < items.length ? items.slice(0, count) : items).map((item) => (
          <ItemRow key={item.id} item={item} open={item.id === selectedId} busy={pending.get(item.id)} />
        ))}
        {more ? <li ref={sentinel} className="list-more" aria-hidden="true" /> : null}
      </ul>
      {!items.length ? (
        <div id="list-empty" className="list-empty">
          {total ? (
            <>
              <p className="empty-title">No matches</p>
              <p>Nothing matches “{query.trim()}”.</p>
            </>
          ) : (
            <>
              <div className="empty-icon">
                <Icon name="key" size={22} />
              </div>
              <p className="empty-title">No passwords yet</p>
              <p>Add a password or a secure note to get started.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
                <Icon name="plus" size={16} />
                <span>New item</span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The open item
// ---------------------------------------------------------------------------
const ToolButton = ({ icon, label, onClick }) => (
  <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>
    <Icon name={icon} />
  </button>
);

function FieldRow({ label, children, tools }) {
  return (
    <div className="field-row">
      <div className="field-main">
        <span className="field-label">{label}</span>
        {children}
      </div>
      <div className="field-tools">{tools}</div>
    </div>
  );
}

function ColorizedPassword({ value }) {
  return (
    <span className="field-value mono password">
      {(value.match(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+/g) || []).map((part, i) =>
        /^[A-Za-z]/.test(part) ? (
          part
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i} className={/^[0-9]/.test(part) ? 'pw-digit' : 'pw-symbol'}>
            {part}
          </span>
        ),
      )}
    </span>
  );
}

function SecretField({ item, field, label }) {
  const key = `${item.id}:${field}`;
  const shown = useSession((s) => s.revealed.has(key));
  const value = item[field];
  const toggle = () => toggleReveal(key);
  return (
    <FieldRow
      label={label}
      tools={
        <>
          <ToolButton icon={shown ? 'eyeOff' : 'eye'} label={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`} onClick={toggle} />
          <ToolButton icon="copy" label={`Copy ${label.toLowerCase()}`} onClick={() => copyValue(value, label, true)} />
        </>
      }
    >
      {field === 'password' ? (
        shown ? (
          <ColorizedPassword value={value} />
        ) : (
          <span className="field-value mono concealed">••••••••••••</span>
        )
      ) : shown ? (
        <div className="field-value note-text">{value}</div>
      ) : (
        <button type="button" className="reveal-note" onClick={toggle}>
          <Icon name="eye" size={16} />
          <span>Hidden — click to reveal</span>
        </button>
      )}
    </FieldRow>
  );
}

/**
 * A secure note's secret as a page to read (#17): large, comfortable text with its own scrolling,
 * hidden until revealed, with Expand for the whole screen.
 */
function NotePage({ item, onExpand }) {
  const key = `${item.id}:notes`;
  const shown = useSession((s) => s.revealed.has(key));
  const [mono, setMono] = useState(pref('textMono'));
  const toggle = () => toggleReveal(key);
  if (!item.notes) return <p className="muted">This note is empty.</p>;
  return (
    <section className={`note-page${shown ? ' is-shown' : ''}`} aria-label="Secret">
      <header className="note-page-bar">
        <span className="field-label">Secret</span>
        <div className="note-page-tools">
          {shown ? (
            <button
              type="button"
              className={`btn btn-ghost btn-sm${mono ? ' is-on' : ''}`}
              aria-pressed={mono}
              title="Fixed-width font"
              onClick={() => {
                setMono(!mono);
                setPref('textMono', !mono);
              }}
            >
              <Icon name="code" size={16} />
              <span>Monospace</span>
            </button>
          ) : null}
          <ToolButton icon={shown ? 'eyeOff' : 'eye'} label={shown ? 'Hide' : 'Show'} onClick={toggle} />
          <ToolButton icon="copy" label="Copy" onClick={() => copyValue(item.notes, 'Secret', true)} />
          <ToolButton icon="expand" label="Read full screen" onClick={() => onExpand(mono)} />
        </div>
      </header>
      {shown ? (
        <div className={`note-page-text${mono ? ' is-mono' : ''}`} tabIndex={0}>
          {item.notes}
        </div>
      ) : (
        <button type="button" className="note-page-hidden" onClick={toggle}>
          <Icon name="eye" size={20} />
          <span>Hidden — click to reveal</span>
          <small>{item.notes.split('\n').length} {item.notes.split('\n').length === 1 ? 'line' : 'lines'} · {item.notes.length.toLocaleString()} characters</small>
        </button>
      )}
    </section>
  );
}

function NoteReader({ item, mono: initialMono, onClose }) {
  const [mono, setMono] = useState(initialMono);
  return (
    <Modal onDismiss={onClose} className="dialog note-reader" labelledBy="note-reader-title">
      <div className="note-reader-bar">
        <Avatar item={item} />
        <h2 id="note-reader-title">{item.title || 'Secure note'}</h2>
        <button
          type="button"
          className={`btn btn-ghost btn-sm${mono ? ' is-on' : ''}`}
          aria-pressed={mono}
          onClick={() => {
            setMono(!mono);
            setPref('textMono', !mono);
          }}
        >
          <Icon name="code" size={16} />
          <span>Monospace</span>
        </button>
        <ToolButton icon="copy" label="Copy" onClick={() => copyValue(item.notes, 'Secret', true)} />
        <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" data-autofocus onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className={`note-reader-text${mono ? ' is-mono' : ''}`} tabIndex={0}>
        {item.notes}
      </div>
    </Modal>
  );
}

function ItemDetail({ onEdit }) {
  const vault = useSession((s) => s.vault);
  const selectedId = useSession((s) => s.selectedId);
  const pending = useSession((s) => s.pending);
  const switching = useSession((s) => Boolean(s.switching));
  const [reader, setReader] = useState(null);
  const item = vault?.items.find((it) => it.id === selectedId) || null;
  if (switching) {
    return (
      <div className="detail-empty">
        <SwitchLoader />
      </div>
    );
  }
  if (!item) {
    return (
      <div className="detail-empty">
        <div className="empty-icon">
          <Icon name="lock" size={22} />
        </div>
        <p className="empty-title">{vault?.items.length ? 'Select an item' : 'Passwords and notes you add show here'}</p>
        <p>Everything is encrypted in this browser before it is saved.</p>
      </div>
    );
  }
  const href = safeHref(item.url);
  const busy = pending.get(item.id);
  return (
    <article key={item.id} className={`detail is-entering${item.type === 'note' ? ' is-note' : ''}${busy ? ' is-pending' : ''}`} aria-busy={busy ? 'true' : undefined}>
      <header className="detail-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back to list" onClick={closeDetail}>
          <Icon name="back" />
        </button>
        <Avatar item={item} size="lg" />
        <div className="detail-heading">
          <h2>{item.title}</h2>
          <p>{busy === 'deleting' ? 'Deleting…' : busy === 'saving' ? 'Saving…' : item.type === 'note' ? 'Secure note' : hostnameOf(item.url) || 'Login'}</p>
        </div>
        <div className="detail-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => onEdit(item)}>
            <Icon name="edit" size={16} />
            <span>Edit</span>
          </button>
          <button type="button" className="icon-btn icon-btn-danger" aria-label="Delete item" title="Delete" disabled={Boolean(busy)} onClick={() => run(deleteItem, item)}>
            {busy === 'deleting' ? <Spinner small /> : <Icon name="trash" />}
          </button>
        </div>
      </header>
      {item.type === 'note' ? (
        <NotePage item={item} onExpand={(mono) => setReader({ mono })} />
      ) : item.username || item.password || item.url || item.notes ? (
        <div className="fields">
          {item.username ? (
            <FieldRow label="Username" tools={<ToolButton icon="copy" label="Copy username" onClick={() => copyValue(item.username, 'Username', false)} />}>
              <span className="field-value">{item.username}</span>
            </FieldRow>
          ) : null}
          {item.password ? <SecretField item={item} field="password" label="Password" /> : null}
          {item.url ? (
            <FieldRow
              label="Website"
              tools={
                <>
                  {href ? (
                    <a className="icon-btn" href={href} target="_blank" rel="noopener noreferrer" aria-label="Open website" title="Open website">
                      <Icon name="external" />
                    </a>
                  ) : null}
                  <ToolButton icon="copy" label="Copy website" onClick={() => copyValue(item.url, 'Website', false)} />
                </>
              }
            >
              {href ? (
                <a className="field-value field-link" href={href} target="_blank" rel="noopener noreferrer">
                  {item.url}
                </a>
              ) : (
                <span className="field-value">{item.url}</span>
              )}
            </FieldRow>
          ) : null}
          {item.notes ? <SecretField item={item} field="notes" label="Notes" /> : null}
        </div>
      ) : (
        <p className="muted">No details saved for this item yet.</p>
      )}
      <p className="meta">
        Edited {relativeTime(item.updated)} · Created {formatDate(item.created)}
      </p>
      {reader ? <NoteReader item={item} mono={reader.mono} onClose={() => setReader(null)} /> : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------
const valuesOf = (item) => ({
  type: item?.type || 'login',
  title: item?.title ?? '',
  username: item?.username ?? '',
  password: item?.password ?? '',
  url: item?.url ?? '',
  notes: item?.notes ?? '',
});

const NO_AUTOFILL = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': true };

/** A textarea that grows with what's typed, up to `max` pixels. */
function GrowingText({ value, onChange, minRows, max = 520, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.style.height = 'auto';
    el.style.height = `${Math.min(max, el.scrollHeight + 2)}px`;
  }, [value, max]);
  return <textarea ref={ref} rows={minRows} value={value} onChange={(e) => onChange(e.target.value)} {...props} />;
}

function ItemEditor({ item, onClose }) {
  const [values, setValues] = useState(() => valuesOf(item));
  const [shown, setShown] = useState(false);
  const [generator, setGenerator] = useState(false);
  const [options, setOptions] = useState(() => pref('generator'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const snapshot = useRef(JSON.stringify(valuesOf(item)));
  const set = (patch) => setValues((v) => ({ ...v, ...patch }));
  const note = values.type === 'note';

  const regenerate = (next = options) => {
    set({ password: generatePassword(next) });
    setShown(true);
    setPref('generator', next);
  };
  const close = async () => {
    if (JSON.stringify(values) !== snapshot.current) {
      const discard = await confirmDialog({ title: 'Discard changes?', message: 'Your unsaved edits to this item will be lost.', confirmLabel: 'Discard', danger: true });
      if (!discard) return;
    }
    onClose();
  };
  const save = async () => {
    setBusy(true);
    setError('');
    const problem = await saveItem(values, item);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };
  const onKeyDown = (event) => {
    if ((event.key === 'Enter' && event.target.matches('input.input')) || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      save();
    }
  };

  return (
    <Modal onDismiss={close} className={`dialog editor${note ? ' is-note' : ''}`} labelledBy="editor-title" busy={busy}>
      <div className="dialog-head">
        <h2 id="editor-title">{item ? 'Edit item' : 'New item'}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="dialog-body" onKeyDown={onKeyDown}>
        <Segmented
          label="Item type"
          value={values.type}
          onChange={(type) => set({ type })}
          options={[
            { id: 'login', label: 'Login', icon: 'key' },
            { id: 'note', label: 'Secure note', icon: 'note' },
          ]}
        />
        <div className="field">
          <label htmlFor="f-title">Title</label>
          <input id="f-title" className="input" type="text" maxLength={200} placeholder={note ? 'e.g. Home Wi-Fi' : 'e.g. GitHub'} value={values.title} onChange={(e) => set({ title: e.target.value })} data-autofocus {...NO_AUTOFILL} />
        </div>
        {!note ? (
          <>
            <div className="field">
              <label htmlFor="f-username">Username or email</label>
              <input id="f-username" className="input" type="text" maxLength={500} value={values.username} onChange={(e) => set({ username: e.target.value })} {...NO_AUTOFILL} />
            </div>
            <div className="field">
              <label htmlFor="f-password">Password</label>
              <div className="input-group">
                <input id="f-password" className="input mono" type={shown ? 'text' : 'password'} maxLength={1000} value={values.password} onChange={(e) => set({ password: e.target.value })} {...NO_AUTOFILL} />
                <div className="input-tools">
                  <ToolButton icon={shown ? 'eyeOff' : 'eye'} label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)} />
                  <ToolButton
                    icon="refresh"
                    label="Generate a strong password"
                    onClick={() => {
                      setGenerator(true);
                      regenerate();
                    }}
                  />
                </div>
              </div>
              {generator ? (
                <div className="generator">
                  <div className="gen-length">
                    <label htmlFor="g-length">Length</label>
                    <input
                      id="g-length"
                      type="range"
                      min="8"
                      max="64"
                      value={options.length}
                      onChange={(e) => {
                        const next = { ...options, length: Number(e.target.value) };
                        setOptions(next);
                        regenerate(next);
                      }}
                    />
                    <output htmlFor="g-length">{options.length}</output>
                  </div>
                  <div className="chips">
                    {[
                      ['upper', 'A–Z'],
                      ['lower', 'a–z'],
                      ['digits', '0–9'],
                      ['symbols', '#$%'],
                    ].map(([name, label]) => (
                      <label key={name} className="chip">
                        <input
                          type="checkbox"
                          checked={options[name]}
                          onChange={(e) => {
                            const next = { ...options, [name]: e.target.checked };
                            if (!['upper', 'lower', 'digits', 'symbols'].some((k) => next[k])) return;
                            setOptions(next);
                            regenerate(next);
                          }}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                    <span className="strength">≈ {passwordEntropyBits(options)} bits</span>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="f-url">Website</label>
              <input id="f-url" className="input" type="text" inputMode="url" maxLength={2048} placeholder="https://" value={values.url} onChange={(e) => set({ url: e.target.value })} {...NO_AUTOFILL} />
            </div>
          </>
        ) : null}
        <div className="field">
          <label htmlFor="f-notes">{note ? 'Secret' : 'Notes'}</label>
          <GrowingText id="f-notes" className={`input textarea${note ? ' note-input' : ''}`} minRows={note ? 12 : 3} max={note ? 560 : 240} spellCheck={false} value={values.notes} onChange={(notes) => set({ notes })} />
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn btn-primary${busy ? ' is-busy' : ''}`} disabled={busy} onClick={save}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Save</span>
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function PasswordsView() {
  useVersion();
  const [editing, setEditing] = useState(null); // null, 'new' or the item
  const selected = Boolean(state.selectedId && state.vault?.items.some((it) => it.id === state.selectedId));
  useEffect(() => {
    const open = () => setEditing('new');
    window.addEventListener('secure-box:new-item', open);
    return () => window.removeEventListener('secure-box:new-item', open);
  }, []);
  if (!state.unlocked) return null;
  return (
    <div id="passwords-view" className={`layout${selected ? ' show-detail' : ''}`}>
      <section className="list-pane" aria-label="Vault items">
        <div className="list-head">
          <span id="count">{state.switching ? '' : state.query ? `${visibleItems().length} of ${state.vault.items.length}` : `${state.vault.items.length} ${state.vault.items.length === 1 ? 'item' : 'items'}`}</span>
          <SyncStatus />
          <div className="list-tools">
            <Menu
              label="Import or export passwords"
              button={(props) => (
                <button {...props} type="button" className="icon-btn" aria-label="Import or export passwords" title="Import or export passwords">
                  <Icon name="more" />
                </button>
              )}
            >
              <MenuItem icon={<Icon name="upload" />} onSelect={() => run(importCsv)}>
                Import passwords (CSV)…
              </MenuItem>
              <MenuItem icon={<Icon name="download" />} onSelect={() => run(exportCsv)}>
                Export passwords (CSV)…
              </MenuItem>
            </Menu>
            <button type="button" className="btn btn-primary btn-sm" title="New item (N)" onClick={() => setEditing('new')}>
              <Icon name="plus" size={16} />
              <span>New</span>
            </button>
          </div>
        </div>
        <ItemList onNew={() => setEditing('new')} />
      </section>
      <section id="detail" className="detail-pane" aria-label="Item details">
        <ItemDetail onEdit={(item) => setEditing(item)} />
      </section>
      {editing ? <ItemEditor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
