import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { formatBytes, kindOf } from '../../core/filetypes.js';
import { KIND_ICON, cancelTask, closeTray, files, resumePaused, retryFailed, retryTask, toggleTray } from '../../session/files.js';
import { pref, setPref } from '../../session/prefs.js';
import { Icon } from '../common/Icon.jsx';
import { useIncremental, useStore } from '../hooks.js';
import { run } from '../run.js';

const STATUS = { queued: 'Waiting', preparing: 'Preparing…', uploading: 'Encrypting & uploading', saving: 'Saving to your vault…', done: 'Encrypted & saved', error: 'Failed', cancelled: 'Cancelled', paused: 'Paused — sign-in expired' };

/** One upload: drawn again only when it changes (session/files.js makes a new row only then). */
const Row = memo(function Row({ t }) {
  const kind = kindOf({ name: t.name, type: t.type });
  const status = t.status === 'uploading' && t.local ? 'Encrypting & saving' : t.status === 'done' && t.savedAs ? `${STATUS.done} as “${t.savedAs}”` : STATUS[t.status];
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
      ) : t.status === 'saving' ? (
        <span className="transfer-done" aria-hidden="true" />
      ) : (
        <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel" onClick={() => cancelTask(t.id)}>
          <Icon name="x" size={16} />
        </button>
      )}
    </li>
  );
});

// The box can be moved out of the way of what's behind it: dragged by its top, up and to the left
// from its corner (CSS: bottom right, above the tabs on phones), staying inside the screen and below
// the top bar. Double-clicking its top puts it back. Where it was left is remembered (prefs).
const EDGE = 8;

/** How far the box may go from its corner: up to maxY, and left to maxX. */
function room(tray) {
  const moved = tray.style.translate;
  tray.style.translate = '';
  const home = tray.getBoundingClientRect();
  tray.style.translate = moved;
  const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + EDGE;
  return { maxX: Math.max(0, Math.floor(home.left - EDGE)), maxY: Math.max(0, Math.floor(home.top - top)) };
}

const within = ({ x, y }, { maxX, maxY }) => ({ x: Math.round(Math.min(Math.max(0, x), maxX)), y: Math.round(Math.min(Math.max(0, y), maxY)) });

function place(tray, { x, y }) {
  tray.style.translate = x || y ? `${-x}px ${-y}px` : '';
}

/** Dragging the box by its top (mouse, finger or pen); a press that doesn't move is just a press. */
function startMoving(event, tray) {
  if (event.button !== 0 || event.target.closest('button, a, input')) return;
  const head = event.currentTarget;
  const limits = room(tray);
  const from = within(pref('trayOffset'), limits);
  const start = { x: event.clientX, y: event.clientY };
  let now = from;
  let moving = false;
  head.setPointerCapture(event.pointerId);
  const move = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moving && Math.hypot(dx, dy) < 4) return;
    moving = true;
    tray.classList.add('is-moving');
    now = within({ x: from.x - dx, y: from.y - dy }, limits);
    place(tray, now);
  };
  const end = () => {
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', end);
    head.removeEventListener('pointercancel', end);
    tray.classList.remove('is-moving');
    if (moving) setPref('trayOffset', now);
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

/** Uploads, at the bottom corner: ⌄ only hides the list; ✕ asks first while any is unfinished (#14). */
export function TransfersTray() {
  const transfers = useStore(files.store, (v) => v.transfers);
  const sum = useStore(files.store, (v) => v.summary);
  const tray = useStore(files.store, (v) => v.tray);
  const box = useRef(null);
  const shown = Boolean(transfers.length && sum);
  // Where it was left, kept inside the screen as the screen turns or the box grows.
  useLayoutEffect(() => {
    const el = box.current;
    if (!shown || !el) return undefined;
    const fit = () => place(el, within(pref('trayOffset'), room(el)));
    fit();
    window.addEventListener('resize', fit);
    const resized = new ResizeObserver(fit);
    resized.observe(el);
    return () => {
      window.removeEventListener('resize', fit);
      resized.disconnect();
    };
  }, [shown]);
  // Thousands of uploads: the list is drawn a batch at a time as it's scrolled.
  const { count, more, sentinel } = useIncremental(transfers.length, { key: 'uploads', first: 60, step: 120 });
  const active = sum?.active || 0;
  const share = !sum ? 0 : sum.bytes ? sum.sent / sum.bytes : sum.files ? sum.finished / sum.files : 0;
  // The tab's title shows the progress too.
  useEffect(() => {
    document.title = active ? `${Math.floor(share * 100)}% · Secure Box` : 'Secure Box';
  }, [active, share]);
  if (!transfers.length || !sum) return null;
  const saving = sum.local;
  const title = active
    ? `${saving ? 'Saving' : 'Uploading'} ${active} ${active === 1 ? 'file' : 'files'}`
    : sum.paused
      ? 'Uploads paused'
      : sum.failed
        ? `${sum.failed} ${sum.failed === 1 ? 'file' : 'files'} failed`
        : sum.stopped
          ? `${sum.stopped} ${sum.stopped === 1 ? 'upload' : 'uploads'} stopped`
          : saving
            ? 'All saved'
            : 'Uploads complete';
  const collapsed = tray === 'collapsed';
  return (
    <aside ref={box} className={`transfers${collapsed ? ' is-collapsed' : ''}`} aria-live="polite">
      <header
        className="transfers-head"
        title="Drag to move it out of the way. Double-click to put it back."
        onPointerDown={(event) => startMoving(event, box.current)}
        onDoubleClick={(event) => {
          if (event.target.closest('button')) return;
          setPref('trayOffset', { x: 0, y: 0 });
          place(box.current, { x: 0, y: 0 });
        }}
      >
        <strong>{title}</strong>
        {sum.paused ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => run(resumePaused)}>
            Reconnect &amp; resume
          </button>
        ) : sum.failed > 1 && !active ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryFailed}>
            Retry all
          </button>
        ) : null}
        <button type="button" className="icon-btn transfers-toggle" aria-expanded={!collapsed} aria-label={collapsed ? 'Show the files' : 'Hide the files'} title={collapsed ? 'Show files' : 'Hide files'} onClick={toggleTray}>
          <Icon name="chevronDown" />
        </button>
        <button type="button" className="icon-btn" aria-label="Close uploads" title="Close" onClick={() => run(closeTray)}>
          <Icon name="x" />
        </button>
      </header>
      {sum.files >= 2 || active ? (
        <div className="transfers-summary">
          <div className="transfers-summary-text">
            <span>
              {sum.finished} of {sum.files} {sum.files === 1 ? 'file' : 'files'}
              {sum.reading ? ' so far' : ''} · {formatBytes(Math.round(sum.sent))} of {formatBytes(sum.bytes)}
            </span>
            <strong>{Math.floor(share * 100)}%</strong>
          </div>
          <span className="transfer-bar transfer-bar-total">
            <span className="transfer-fill" style={{ '--progress': String(share) }} />
          </span>
        </div>
      ) : null}
      <ul className="transfer-list">
        {(count < transfers.length ? transfers.slice(0, count) : transfers).map((t) => (
          <Row key={t.id} t={t} />
        ))}
        {more ? <li ref={sentinel} className="transfer-more" aria-hidden="true" /> : null}
      </ul>
    </aside>
  );
}
