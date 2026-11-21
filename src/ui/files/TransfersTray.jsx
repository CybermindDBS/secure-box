import { useEffect } from 'react';
import { formatBytes, kindOf } from '../../core/filetypes.js';
import { KIND_ICON, cancelTask, closeTray, files, resumePaused, retryTask, toggleTray } from '../../session/files.js';
import { Icon } from '../common/Icon.jsx';
import { useStore } from '../hooks.js';
import { run } from '../run.js';

const STATUS = { queued: 'Waiting', preparing: 'Preparing…', uploading: 'Encrypting & uploading', done: 'Encrypted & saved', error: 'Failed', cancelled: 'Cancelled', paused: 'Paused — sign-in expired' };

function Row({ t }) {
  const kind = kindOf({ name: t.name, type: t.type });
  const status = t.status === 'uploading' && t.local ? 'Encrypting & saving' : STATUS[t.status];
  return (
    <li className={`transfer is-${t.status}`}>
      <span className={`file-art kind-${kind} art-sm`}>
        <Icon name={KIND_ICON[kind]} size={16} />
      </span>
      <div className="transfer-main">
        <span className="transfer-name">{t.name}</span>
        <span className="transfer-status">{t.error || `${status}${t.status === 'uploading' ? ` · ${Math.round(t.progress * 100)}%` : ''} · ${formatBytes(t.size)}`}</span>
        <span className="transfer-bar">
          <span className="transfer-fill" style={{ '--progress': String(t.progress) }} />
        </span>
      </div>
      {t.status === 'error' || t.status === 'cancelled' ? (
        <button type="button" className="icon-btn" aria-label="Retry" title="Retry" onClick={() => retryTask(t.id)}>
          <Icon name="refresh" size={16} />
        </button>
      ) : t.status === 'done' ? (
        <span className="transfer-done">
          <Icon name="check" size={16} />
        </span>
      ) : (
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel" onClick={() => cancelTask(t.id)}>
          <Icon name="x" size={16} />
        </button>
      )}
    </li>
  );
}

/** Uploads, at the bottom corner: ⌄ only hides the list; ✕ asks first while any is unfinished (#14). */
export function TransfersTray() {
  const transfers = useStore(files.store, (v) => v.transfers);
  const tray = useStore(files.store, (v) => v.tray);
  const counted = transfers.filter((t) => t.status !== 'cancelled');
  const active = transfers.filter((t) => ['queued', 'preparing', 'uploading'].includes(t.status)).length;
  const failed = transfers.filter((t) => t.status === 'error').length;
  const paused = transfers.some((t) => t.status === 'paused');
  const saving = transfers.length > 0 && transfers.every((t) => t.local);
  const stopped = transfers.filter((t) => t.status === 'cancelled').length;
  const bytes = counted.reduce((n, t) => n + t.size, 0);
  const done = counted.reduce((n, t) => n + t.size * (t.status === 'done' ? 1 : t.progress), 0);
  const finished = counted.filter((t) => t.status === 'done').length;
  const share = bytes ? done / bytes : counted.length ? finished / counted.length : 0;
  // The tab's title shows the progress too.
  useEffect(() => {
    document.title = active ? `${Math.floor(share * 100)}% · Secure Box` : 'Secure Box';
  }, [active, share]);
  if (!transfers.length) return null;
  const title = active
    ? `${saving ? 'Saving' : 'Uploading'} ${active} ${active === 1 ? 'file' : 'files'}`
    : paused
      ? 'Uploads paused'
      : failed
        ? `${failed} ${failed === 1 ? 'file' : 'files'} failed`
        : stopped
          ? `${stopped} ${stopped === 1 ? 'upload' : 'uploads'} stopped`
          : saving
            ? 'All saved'
            : 'Uploads complete';
  const collapsed = tray === 'collapsed';
  return (
    <aside className={`transfers${collapsed ? ' is-collapsed' : ''}`} aria-live="polite">
      <header className="transfers-head">
        <strong>{title}</strong>
        {paused ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => run(resumePaused)}>
            Reconnect &amp; resume
          </button>
        ) : null}
        <button type="button" className="icon-btn transfers-toggle" aria-expanded={!collapsed} aria-label={collapsed ? 'Show the files' : 'Hide the files'} title={collapsed ? 'Show files' : 'Hide files'} onClick={toggleTray}>
          <Icon name="chevronDown" />
        </button>
        <button type="button" className="icon-btn" aria-label="Close uploads" title="Close" onClick={() => run(closeTray)}>
          <Icon name="x" />
        </button>
      </header>
      {counted.length >= 2 || active ? (
        <div className="transfers-summary">
          <div className="transfers-summary-text">
            <span>
              {finished} of {counted.length} {counted.length === 1 ? 'file' : 'files'} · {formatBytes(Math.round(done))} of {formatBytes(bytes)}
            </span>
            <strong>{Math.floor(share * 100)}%</strong>
          </div>
          <span className="transfer-bar transfer-bar-total">
            <span className="transfer-fill" style={{ '--progress': String(share) }} />
          </span>
        </div>
      ) : null}
      <ul className="transfer-list">
        {transfers.map((t) => (
          <Row key={t.id} t={t} />
        ))}
      </ul>
    </aside>
  );
}
