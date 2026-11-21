import { useEffect, useMemo, useRef, useState } from 'react';
import { ROOT_NAME } from '../../session/files.js';
import { state } from '../../session/store.js';
import { registerDialog } from '../dialogs/DialogHost.jsx';
import { Modal } from '../dialogs/Modal.jsx';
import { Icon } from '../common/Icon.jsx';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** A name: new folder, rename. Resolves with the trimmed text, or null. */
function PromptDialog({ id, props, close }) {
  const { title, label, value = '', confirmLabel = 'Save', selectStem = false } = props;
  const [text, setText] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    const input = ref.current;
    const dot = value.lastIndexOf('.');
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(0, selectStem && dot > 0 ? dot : value.length);
    });
  }, [value, selectStem]);
  const ok = () => close(text.trim() || null);
  return (
    <Modal onDismiss={() => close(null)} labelledBy={`prompt-${id}`}>
      <div className="dialog-body">
        <h2 id={`prompt-${id}`}>{title}</h2>
        <div className="field">
          <label htmlFor={`prompt-input-${id}`}>{label}</label>
          <input
            ref={ref}
            id={`prompt-input-${id}`}
            className="input"
            type="text"
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                ok();
              }
            }}
          />
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={ok} disabled={!text.trim()}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Where to move things: a tree of folders. Resolves with { folder } (null: All files), or null. */
function MoveDialog({ id, props, close }) {
  const exclude = useMemo(() => new Set(props.exclude || []), [props.exclude]);
  const [choice, setChoice] = useState(props.from ?? null);
  const rows = useMemo(() => {
    const out = [];
    const add = (folder, depth) => {
      const fid = folder ? folder.id : null;
      const blocked = Boolean(folder && exclude.has(folder.id));
      out.push({ id: fid, name: folder ? folder.name : ROOT_NAME, depth, blocked });
      if (blocked) return;
      for (const child of state.vault.folders.filter((f) => f.parent === fid).sort((a, b) => collator.compare(a.name, b.name))) add(child, depth + 1);
    };
    add(null, 0);
    return out;
  }, [exclude]);
  return (
    <Modal onDismiss={() => close(null)} labelledBy={`move-${id}`}>
      <div className="dialog-body">
        <h2 id={`move-${id}`}>{props.title}</h2>
        <div className="tree" role="listbox" aria-label="Folders">
          {rows.map((row) => (
            <button
              key={row.id ?? 'root'}
              type="button"
              role="option"
              aria-selected={row.id === choice}
              className={`tree-row${row.id === choice ? ' is-selected' : ''}`}
              disabled={row.blocked}
              style={{ '--depth': String(row.depth) }}
              onClick={() => setChoice(row.id)}
              onDoubleClick={() => !row.blocked && close({ folder: row.id })}
            >
              <Icon name={row.id ? 'folder' : 'home'} size={16} />
              <span>{row.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => close({ folder: choice })}>
          Move here
        </button>
      </div>
    </Modal>
  );
}

const SHORTCUTS = [
  ['Everywhere', [
    ['/', 'Search'],
    ['Ctrl K', 'Search'],
    ['?', 'These shortcuts'],
    ['← →', 'Move between tabs (when a tab is focused)'],
  ]],
  ['Passwords', [
    ['N', 'New item'],
    ['↑ ↓', 'Previous or next item'],
    ['Esc', 'Close the item'],
  ]],
  ['Files', [
    ['U', 'Upload files'],
    ['N', 'New folder'],
    ['Arrows', 'Move around (grid-aware)'],
    ['Shift + arrows', 'Choose more'],
    ['Home / End', 'First / last'],
    ['Shift + Home / End', 'Choose up to the first / last'],
    ['Ctrl A', 'Choose everything'],
    ['Space', 'Choose or unchoose'],
    ['Enter', 'Open'],
    ['F2', 'Rename'],
    ['Delete', 'Delete what’s chosen'],
    ['Backspace', 'Up one folder'],
    ['Esc', 'Choose nothing'],
  ]],
  ['Viewer', [
    ['← →', 'Previous or next file'],
    ['+ / −', 'Zoom in or out'],
    ['0', 'Fit / actual size'],
    ['R', 'Rotate'],
    ['Esc', 'Close'],
  ]],
];

/** "?" — every keyboard shortcut (#12). */
function ShortcutsDialog({ close }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (k) => (mac ? k.replace(/^Ctrl /, '⌘ ') : k);
  return (
    <Modal onDismiss={() => close(null)} className="dialog shortcuts" labelledBy="shortcuts-title">
      <div className="dialog-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => close(null)} data-autofocus>
          <Icon name="x" />
        </button>
      </div>
      <div className="dialog-body shortcuts-body">
        {SHORTCUTS.map(([group, list]) => (
          <section key={group} className="shortcut-group">
            <h3>{group}</h3>
            <dl>
              {list.map(([key, what]) => (
                <div key={`${group}-${key}-${what}`} className="shortcut">
                  <dt>
                    <kbd>{keys(key)}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

registerDialog('prompt', PromptDialog);
registerDialog('moveTo', MoveDialog);
registerDialog('shortcuts', ShortcutsDialog);
