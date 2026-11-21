import { useEffect, useRef, useState } from 'react';
import { pref, setPref } from '../../session/prefs.js';
import { saveEditing } from '../../session/textedit.js';
import { leaveEditing, setEditingDirty, viewerStore } from '../../session/viewer.js';
import { useStore } from '../hooks.js';

/**
 * A .txt file being edited. Its text only ever lives in this page's memory: Save encrypts it and
 * stores it as the file's new encrypted copy, and nothing is written to disk. Spell-check is off,
 * since some browsers send what's typed to an online spelling service.
 */
export function TextEditor({ file, deleted }) {
  const { editing } = useStore(viewerStore);
  const [text, setText] = useState(() => editing?.original ?? '');
  const [mono, setMono] = useState(() => pref('textMono'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const area = useRef(null);
  const dirty = Boolean(editing) && text !== editing.original;

  useEffect(() => setEditingDirty(dirty), [dirty]);
  useEffect(() => {
    area.current?.focus();
    area.current?.setSelectionRange(0, 0);
  }, []);

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError('');
    try {
      await saveEditing(text);
    } catch (err) {
      setError(`Not saved: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  let status = dirty ? 'Unsaved changes' : 'Editing: changes stay in memory until you save';
  if (deleted) status = 'Deleted elsewhere: saving keeps your text as a new file';
  if (saving) status = 'Encrypting and saving…';

  return (
    <div className="viewer-doc text-edit">
      <div className="doc-toolbar text-edit-bar">
        <span className={`doc-toolbar-note${dirty ? ' is-dirty' : ''}`} role="status">
          {status}
        </span>
        <label className="switch switch-sm" title="Fixed-width font">
          <input
            type="checkbox"
            checked={mono}
            onChange={(e) => {
              setMono(e.target.checked);
              setPref('textMono', e.target.checked);
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-label">Monospace</span>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => leaveEditing()}>
          Done
        </button>
        <button type="button" className={`btn btn-primary btn-sm${saving ? ' is-busy' : ''}`} disabled={!dirty || saving} title="Save (Ctrl+S)" onClick={save}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Save</span>
        </button>
      </div>
      {error ? (
        <p className="form-error text-edit-error" role="alert">
          {error}
        </p>
      ) : null}
      <textarea
        ref={area}
        className={`text-edit-area${mono ? ' is-mono' : ''}`}
        aria-label={`Text of ${file.name}`}
        value={text}
        readOnly={saving}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save();
          }
        }}
      />
    </div>
  );
}
