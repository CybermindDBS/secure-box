import { useEffect, useRef, useState } from 'react';
import { emergencyKitText } from '../../core/keyring.js';
import { answer, dialogs, toast } from '../../session/bridge.js';
import { reconnectNow } from '../../session/cloud.js';
import { BROWSER_VAULT } from '../../experiments.js';
import { FOLDER_HINT } from '../../session/device.js';
import { recoverWith } from '../../session/gone.js';
import { copyText, downloadFile } from '../../session/io.js';
import { changePassword, keyringScope } from '../../session/passwords.js';
import { openOwnKeyring } from '../../session/vaults.js';
import { FormError, PasswordInput, StrengthMeter } from '../common/Fields.jsx';
import { Icon } from '../common/Icon.jsx';
import { useStore } from '../hooks.js';
import { Modal } from './Modal.jsx';
import { MoveVaultDialog } from './MoveVault.jsx';

const EXTRA = new Map(); // kind -> component, for dialogs other parts of the UI add (files, viewer, tools)

/** Lets a part of the UI add a kind of dialog the session can ask for. */
export function registerDialog(kind, component) {
  EXTRA.set(kind, component);
}

// ---------------------------------------------------------------------------
function ConfirmDialog({ id, props, close }) {
  const { title, message, confirmLabel, cancelLabel, danger } = props;
  const titleId = `confirm-${id}`;
  return (
    <Modal onDismiss={() => close(null)} labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId}>{title}</h2>
        {message ? <p className="panel-text">{message}</p> : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" data-autofocus={danger || undefined} onClick={() => close(null)}>
          {cancelLabel}
        </button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/** A question with a few ways on: { title, message, choices: [{ id, label, primary }], cancelLabel }. Resolves with the id chosen, or null. */
function ChooseDialog({ id, props, close }) {
  const titleId = `choose-${id}`;
  return (
    <Modal onDismiss={() => close(null)} className="dialog dialog-choose" labelledBy={titleId}>
      <div className="dialog-body">
        <h2 id={titleId}>{props.title}</h2>
        {props.message ? <p className="panel-text">{props.message}</p> : null}
      </div>
      <div className="dialog-foot is-wrap">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          {props.cancelLabel || 'Not now'}
        </button>
        {props.choices.map((c) => (
          <button key={c.id} type="button" className={`btn ${c.primary ? 'btn-primary' : 'btn-ghost'}`} data-autofocus={c.primary || undefined} onClick={() => close(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function ReconnectDialog({ props, close }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const go = async () => {
    controller.current = new AbortController();
    setBusy(true);
    setStatus(`Finish signing in in the ${props.company} window…`);
    try {
      await reconnectNow(controller.current.signal);
      close(true);
    } catch (err) {
      setBusy(false);
      setStatus(err?.code === 'cancelled' ? '' : err?.code === 'popup-closed' ? `The ${props.company} window was closed before you signed in. Reconnect when you’re ready.` : err.message);
    }
  };
  return (
    <Modal onDismiss={() => close(null)} labelledBy="reconnect-title">
      <div className="dialog-body">
        <h2 id="reconnect-title">{props.title}</h2>
        <p className="panel-text">{props.text}</p>
        {status ? (
          <p className="panel-status" role="status">
            {status}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          Not now
        </button>
        <button type="button" className={`btn btn-primary${busy ? ' is-busy' : ''}`} disabled={busy} onClick={go}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Reconnect</span>
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/** The open vault was deleted or moved outside Secure Box: what happened, and the ways back (gone.js). */
function VaultGoneDialog({ props, close }) {
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const go = async (action) => {
    if (props.actions.find((a) => a.id === action)?.close) return close(action); // the session takes it from here
    setBusy(action);
    setProblem('');
    try {
      await recoverWith(action);
      close('back');
    } catch (err) {
      setBusy('');
      setProblem(err?.message || String(err));
    }
  };
  return (
    <Modal onDismiss={() => close(null)} labelledBy="vault-gone-title" busy={Boolean(busy)}>
      <div className="dialog-body">
        <h2 id="vault-gone-title">{props.title}</h2>
        <p className="panel-text">{props.text}</p>
        {problem ? (
          <p className="form-error" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => close('lock')}>
          Lock
        </button>
        {props.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`btn ${a.primary ? 'btn-primary' : 'btn-ghost'}${busy === a.id ? ' is-busy' : ''}`}
            disabled={Boolean(busy)}
            data-autofocus={a.primary || undefined}
            onClick={() => go(a.id)}
          >
            <span className="btn-spinner" aria-hidden="true" />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function OwnKeyDialog({ props, close }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!secret) return setError('Enter its master password.');
    setBusy(true);
    setError('');
    try {
      close(await openOwnKeyring(props.doc, secret));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal onDismiss={() => close(null)} labelledBy="own-key-title" busy={busy}>
      <div className="dialog-body">
        <h2 id="own-key-title">This vault has its own master password</h2>
        <p className="panel-text">{props.text}</p>
        <PasswordInput id="own-key-password" label="Its master password" value={secret} onChange={setSecret} onEnter={submit} onCaps={setCaps} autoFocus />
        <FormError error={error} code={error ? 'wrong-password' : ''} caps={caps} value={secret} />
        <p className="panel-hint">Its Emergency Kit’s recovery key works too. Both vaults stay open until you lock, so switching back won’t ask again.</p>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn btn-primary${busy ? ' is-busy' : ''}`} disabled={busy} onClick={submit}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Open it</span>
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function DeviceWhereDialog({ props, close }) {
  const { moving, folderOk, folderName } = props;
  const [where, setWhere] = useState(moving === 'browser' ? 'folder' : 'browser');
  return (
    <Modal onDismiss={() => close(null)} labelledBy="device-where-title">
      <div className="dialog-body">
        <h2 id="device-where-title">{moving ? 'Move your vault on this device' : 'Where on this device?'}</h2>
        <p className="panel-text">
          {moving
            ? 'Secure Box copies it there exactly as it is, still encrypted, opens it there, then deletes the old copy.'
            : 'Your vault on this device opens with your current master password. Nothing in it is uploaded.'}
        </p>
        <DeviceWhereChoice where={where} onChange={setWhere} moving={moving} folderOk={folderOk} folderName={folderName} />
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => close(where)} disabled={where === moving && moving === 'browser'}>
          {moving ? 'Move' : 'Continue'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * "In this browser" or "In a folder you choose", for a new vault on this device or a move: a
 * choice only in the experimental build, where the browser's own storage is one (experiments.js).
 */
export function DeviceWhereChoice({ where, onChange, moving = null, folderOk = true, folderName = '' }) {
  return (
    <div className="local-where-choice" role="radiogroup" aria-label="Where to keep it">
      {BROWSER_VAULT ? (
        <label className="local-option">
          <input type="radio" name="device-where" value="browser" checked={where === 'browser'} disabled={moving === 'browser'} onChange={() => onChange('browser')} />
          <span>
            <strong>In this browser</strong>
            <small>Nothing to set up. Clearing this site’s data in the browser deletes it.</small>
            {moving === 'browser' ? <em className="local-now">Where it is now</em> : null}
          </span>
        </label>
      ) : null}
      <label className="local-option">
        <input type="radio" name="device-where" value="folder" checked={where === 'folder'} disabled={!folderOk} onChange={() => onChange('folder')} />
        <span>
          <strong>{moving === 'folder' ? 'In another folder' : 'In a folder you choose'}</strong>
          <small>Ordinary encrypted files you can see, copy and back up. A synced folder (OneDrive, Dropbox, iCloud Drive) works too.</small>
          {moving === 'folder' && folderName ? <em className="local-now">Now in “{folderName}”</em> : null}
          {where === 'folder' ? <small className="local-folder-hint">{FOLDER_HINT}</small> : null}
        </span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ChangePasswordDialog({ close }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    const problem = await changePassword({ current, next, confirm });
    setBusy(false);
    if (problem) setError(problem);
    else close(true);
  };
  const wrong = error === 'Your current master password is not correct.';
  return (
    <Modal onDismiss={() => close(null)} labelledBy="pw-title" busy={busy}>
      <div className="dialog-body">
        <h2 id="pw-title">Change master password</h2>
        <p className="panel-text">{keyringScope()}</p>
        <PasswordInput id="pw-current" label="Current master password" value={current} onChange={setCurrent} onCaps={setCaps} autoFocus />
        <PasswordInput id="pw-new" label="New master password" value={next} onChange={setNext} />
        <StrengthMeter password={next} />
        <PasswordInput id="pw-confirm" label="Repeat new password" value={confirm} onChange={setConfirm} onEnter={save} />
        <p className="panel-hint">Your Emergency Kit keeps working after the change.</p>
        <FormError error={error} code={wrong ? 'wrong-password' : ''} caps={caps} value={current} />
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-ghost" onClick={() => close(null)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn btn-primary${busy ? ' is-busy' : ''}`} disabled={busy} onClick={save}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Change password</span>
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/**
 * Saving an Emergency Kit, more than one way (#19): download it, copy the recovery key, or show
 * it to write down. Used on the Vault tab after creating a master password and for a new kit.
 */
export function KitSaver({ recovery, email, onSaved }) {
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState({ download: false, copy: false });
  const mark = (what) => {
    setDone((d) => ({ ...d, [what]: true }));
    onSaved?.();
  };
  return (
    <div className="kit-saver">
      <ul className="facts">
        <li>
          <Icon name="download" size={16} />
          Print it or keep it on a USB stick
        </li>
        <li>
          <Icon name="alert" size={16} />
          Never store it in your cloud drive or email
        </li>
        <li>
          <Icon name="refresh" size={16} />
          Make a new one any time from the ⋯ menu
        </li>
      </ul>
      <div className="kit-actions">
        <button
          type="button"
          className={`btn btn-ghost btn-block${done.download ? ' is-done' : ''}`}
          onClick={() => {
            downloadFile(`Secure Box Emergency Kit (${recovery.id}).txt`, emergencyKitText({ email, recovery }), 'text/plain;charset=utf-8');
            mark('download');
          }}
        >
          <Icon name={done.download ? 'check' : 'download'} />
          <span>Download Emergency Kit</span>
        </button>
        <div className="kit-row">
          <button
            type="button"
            className={`btn btn-ghost btn-sm${done.copy ? ' is-done' : ''}`}
            onClick={async () => {
              try {
                await copyText(recovery.text, { sensitive: true });
                toast('Recovery key copied · cleared from the clipboard in 30 s');
                mark('copy');
              } catch {
                toast('The browser blocked clipboard access.', 'error');
              }
            }}
          >
            <Icon name={done.copy ? 'check' : 'copy'} size={16} />
            <span>Copy recovery key</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setShown(!shown);
              if (!shown) onSaved?.();
            }}
          >
            <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
            <span>{shown ? 'Hide it' : 'Show it to write down'}</span>
          </button>
        </div>
        {shown ? (
          <p className="kit-key mono" aria-label="Recovery key">
            {recovery.text}
          </p>
        ) : null}
      </div>
      <p className="panel-foot">
        Recovery key ID: <span className="mono">{recovery.id}</span>
      </p>
    </div>
  );
}

function KitDialog({ props, close }) {
  const [saved, setSaved] = useState(false);
  const [sure, setSure] = useState(false);
  return (
    <Modal onDismiss={() => (saved ? close(true) : null)} labelledBy="kit-title">
      <div className="dialog-body">
        <h2 id="kit-title">Save your new Emergency Kit</h2>
        <p className="panel-text">Your old kit no longer works. If you ever forget your master password, this kit’s recovery key is the only way back in.</p>
        <KitSaver recovery={props.recovery} email={props.email} onSaved={() => setSaved(true)} />
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>I’ve saved my Emergency Kit somewhere safe</span>
        </label>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn btn-primary" disabled={!sure} onClick={() => close(true)}>
          Done
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
const KINDS = {
  confirm: ConfirmDialog,
  choose: ChooseDialog,
  reconnect: ReconnectDialog,
  ownKey: OwnKeyDialog,
  vaultGone: VaultGoneDialog,
  ...(BROWSER_VAULT ? { deviceWhere: DeviceWhereDialog } : {}),
  changePassword: ChangePasswordDialog,
  kit: KitDialog,
  moveVault: MoveVaultDialog,
};

export function DialogHost() {
  const list = useStore(dialogs);
  return list.map((entry) => {
    const Kind = KINDS[entry.kind] || EXTRA.get(entry.kind);
    if (!Kind) return null;
    return <Kind key={entry.id} id={entry.id} props={entry.props} close={(value) => answer(entry.id, value)} />;
  });
}
