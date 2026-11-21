import { useState } from 'react';
import { BOX_EXTENSION } from '../../core/localbox.js';
import { toast } from '../../session/bridge.js';
import { copyText, pickFile, pickFiles } from '../../session/io.js';
import { vaultLabel } from '../../session/places.js';
import { pref } from '../../session/prefs.js';
import {
  addFiles,
  addFolder,
  boxStatus,
  canPickFolder,
  chooseBackup,
  clearFiles,
  copyTextOut,
  dismissDone,
  dropBackup,
  encryptJobs,
  formatBytes,
  messageStatus,
  newSharingPassword,
  openBoxes,
  removeBox,
  removeJob,
  runText,
  setText,
  setTextMode,
  setToolsMode,
  shareTextOut,
  startOverText,
  stopTools,
  toolsStore,
  unlockForTools,
} from '../../session/tools.js';
import { Check, FormError, PasswordInput, StrengthMeter } from '../common/Fields.jsx';
import { Icon, Spinner } from '../common/Icon.jsx';
import { Segmented } from '../common/Segmented.jsx';
import { useSession, useStore, useVersion } from '../hooks.js';
import { run } from '../run.js';

// ---------------------------------------------------------------------------
// Choosing files and folders (a picker, or a drop)
// ---------------------------------------------------------------------------
/** Reads a drop: files as they are, each dropped folder as one folder (with its files' paths). */
async function readDrop(dataTransfer) {
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return { files: [...dataTransfer.files], folders: [] };
  const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  const files = [];
  const folders = [];
  for (const entry of entries) {
    if (entry.isFile) files.push(await fileOf(entry));
    else if (entry.isDirectory) {
      const found = [];
      const walk = async (dir, path) => {
        const reader = dir.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) {
            if (child.isFile) found.push({ file: await fileOf(child), path: `${path}/${child.name}` });
            else if (child.isDirectory) await walk(child, `${path}/${child.name}`);
          }
        }
      };
      await walk(entry, entry.name);
      folders.push({ name: entry.name, files: found.map((f) => f.file), paths: found.map((f) => f.path) });
    }
  }
  return { files, folders };
}

async function take({ files, folders }) {
  for (const folder of folders) {
    if (folder.files.length) addFolder(folder.name, folder.files, folder.paths);
    else toast(`“${folder.name}” is empty.`);
  }
  if (files.length) await addFiles(files);
}

/** Every chosen folder's files come with paths relative to its parent ("Photos/2024/a.jpg"). */
async function chooseFolder() {
  const files = await pickFiles({ folder: true });
  if (!files.length) return;
  const top = files[0].webkitRelativePath.split('/')[0] || 'Folder';
  addFolder(top, files, files.map((f) => f.webkitRelativePath || `${top}/${f.name}`));
}

function DropZone({ compact }) {
  const [over, setOver] = useState(false);
  const busy = useStore(toolsStore, (s) => Boolean(s.busy));
  return (
    <div
      className={`drop-zone${compact ? ' is-compact' : ''}${over ? ' is-over' : ''}`}
      onDragOver={(event) => {
        if (busy || ![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOver(false);
      }}
      onDrop={(event) => {
        if (busy || ![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setOver(false);
        run(async () => take(await readDrop(event.dataTransfer)));
      }}
    >
      <span className="drop-zone-icon" aria-hidden="true">
        <Icon name="upload" size={compact ? 18 : 26} />
      </span>
      <div className="drop-zone-text">
        <strong>{compact ? 'Add more: drop them here' : 'Drop files or a folder here'}</strong>
        {!compact ? (
          <small>
            <span className="mono">{BOX_EXTENSION}</span> files open; anything else gets encrypted
          </small>
        ) : null}
      </div>
      <div className="drop-zone-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => addFiles(await pickFiles()))}>
          <Icon name="file" size={16} />
          <span>Choose files</span>
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(chooseFolder)}>
          <Icon name="folder" size={16} />
          <span>Choose a folder</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who can open what you encrypt
// ---------------------------------------------------------------------------
function SharingPassword({ password, setPassword, confirm, setConfirm, onEnter, idPrefix }) {
  const generate = () => {
    const value = newSharingPassword();
    setPassword(value);
    setConfirm(value);
    toast('Strong password generated. Copy it now to share it.');
  };
  return (
    <div className="sharing-password">
      <PasswordInput id={`${idPrefix}-password`} label="Password" value={password} onChange={setPassword} mono />
      <div className="sharing-tools">
        <button type="button" className="btn btn-ghost btn-sm" onClick={generate}>
          <Icon name="refresh" size={16} />
          <span>Generate a strong one</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!password}
          onClick={() => run(async () => {
            await copyText(password, { sensitive: true });
            toast('Password copied · cleared from the clipboard in 30 s');
          })}
        >
          <Icon name="copy" size={16} />
          <span>Copy</span>
        </button>
      </div>
      {password ? <StrengthMeter password={password} /> : null}
      <PasswordInput id={`${idPrefix}-confirm`} label="Repeat it" value={confirm} onChange={setConfirm} onEnter={onEnter} mono reveal={false} />
    </div>
  );
}

/**
 * Logged out: a password is the way in (required). Unlocked: you (your master password) always,
 * and others with a password if you want.
 */
function WhoCanOpen({ what, share, setShare, password, setPassword, confirm, setConfirm, onEnter, idPrefix }) {
  const unlocked = useSession((s) => s.unlocked);
  useSession((s) => s.provider);
  const fields = <SharingPassword password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} onEnter={onEnter} idPrefix={idPrefix} />;
  if (!unlocked) {
    return (
      <div className="who">
        <p className="tool-label">Protect {what} with a password</p>
        {fields}
        <p className="tool-hint">
          Anyone with this password can open {what}, and it can’t be recovered: keep it safe. Send it separately, for example by phone or another app.{' '}
          <button type="button" className="link-inline" onClick={() => run(unlockForTools)}>
            Unlock your vault
          </button>{' '}
          to also open {what} with your master password.
        </p>
      </div>
    );
  }
  return (
    <div className="who">
      <p className="tool-label">Who can open {what}</p>
      <div className="who-row">
        <span className="who-icon">
          <Icon name="key" size={16} />
        </span>
        <span className="who-text">
          <strong>You, with your master password</strong>
          <small>{vaultLabel()}</small>
        </span>
        <Icon name="check" size={16} className="who-check" />
      </div>
      <Check checked={share} onChange={setShare} hint="Send it separately, for example by phone or another app.">
        Others too, with a password
      </Check>
      {share ? fields : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function EncryptSection() {
  const jobs = useStore(toolsStore, (s) => s.jobs);
  const busy = useStore(toolsStore, (s) => s.busy);
  const error = useStore(toolsStore, (s) => s.error);
  const unlocked = useSession((s) => s.unlocked);
  const [share, setShare] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hideNames, setHideNames] = useState(pref('hideNames'));
  const size = jobs.reduce((n, j) => n + j.size, 0);
  const folders = jobs.some((j) => j.kind === 'folder');
  const count = jobs.length;
  const what = count === 1 ? 'it' : 'them';
  const go = () => run(() => encryptJobs({ password, confirm, share, hideNames }));
  return (
    <section className="tool-section" aria-label="Encrypt">
      <header className="tool-section-head">
        <span className="tool-section-icon is-encrypt">
          <Icon name="lock" size={16} />
        </span>
        <h3>
          Encrypt {count} {folders ? (count === 1 ? 'item' : 'items') : count === 1 ? 'file' : 'files'} <span className="tool-section-meta">· {formatBytes(size)}</span>
        </h3>
      </header>
      <ul className="tool-list">
        {jobs.map((job) => (
          <li key={job.id} className="tool-item">
            <Icon name={job.kind === 'folder' ? 'folder' : 'file'} size={16} />
            <span className="tool-item-name">{job.name}</span>
            <span className="tool-item-meta">{job.kind === 'folder' ? `${job.count} ${job.count === 1 ? 'file' : 'files'} · ${formatBytes(job.size)}` : formatBytes(job.size)}</span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${job.name}`} title="Remove" disabled={Boolean(busy)} onClick={() => removeJob(job.id)}>
              <Icon name="x" size={16} />
            </button>
          </li>
        ))}
      </ul>
      <WhoCanOpen what={what} share={share} setShare={setShare} password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} onEnter={go} idPrefix="box" />
      <Check checked={hideNames} onChange={setHideNames} hint="The .sbox files get random names. The real names are stored inside, encrypted.">
        Hide file names
      </Check>
      <p className="tool-note">
        {canPickFolder() ? 'You’ll choose a folder to save the encrypted .sbox files in.' : 'The encrypted .sbox files are saved to your downloads.'} The originals stay as they are.
        {!unlocked ? '' : ' Your master password always opens them.'}
      </p>
      <FormError error={error} />
      <button type="button" className={`btn btn-primary btn-block${busy === 'encrypt' ? ' is-busy' : ''}`} disabled={Boolean(busy)} onClick={go}>
        <span className="btn-spinner" aria-hidden="true" />
        <Icon name="lock" size={16} />
        <span>
          Encrypt {count === 1 ? `“${jobs[0].name}”` : `${count} ${folders ? 'items' : 'files'}`}
        </span>
      </button>
    </section>
  );
}

function OpenSection() {
  const boxes = useStore(toolsStore, (s) => s.boxes);
  const backup = useStore(toolsStore, (s) => s.backup);
  const busy = useStore(toolsStore, (s) => s.busy);
  const error = useStore(toolsStore, (s) => s.error);
  const unlocked = useSession((s) => s.unlocked);
  useVersion(); // key rings unlocked this session open more files
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const statuses = boxes.map((b) => boxStatus(b, backup));
  const needsPassword = statuses.some((s) => s.needs === 'password');
  const needsVault = statuses.some((s) => s.needs === 'vault');
  const ready = boxes.filter((b) => b.box).length;
  // Nothing here can open yet (every file needs a vault that isn't open): the button waits.
  const blocked = !backup && statuses.every((st) => st.needs === 'vault' || (st.tone === 'error' && st.needs !== 'password'));
  const go = () => run(() => openBoxes({ password, backupSecret: secret }));
  return (
    <section className="tool-section" aria-label="Open">
      <header className="tool-section-head">
        <span className="tool-section-icon is-open">
          <Icon name="unlock" size={16} />
        </span>
        <h3>
          Open {boxes.length} {BOX_EXTENSION} {boxes.length === 1 ? 'file' : 'files'}
        </h3>
      </header>
      <ul className="tool-list">
        {boxes.map((entry, i) => (
          <li key={entry.id} className="tool-item">
            <Icon name="file" size={16} />
            <span className="tool-item-name">{entry.file.name}</span>
            <span className={`tool-item-state is-${statuses[i].tone}`}>
              {statuses[i].tone === 'ok' ? <Icon name="check" size={14} /> : null}
              {statuses[i].text}
            </span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${entry.file.name}`} title="Remove" disabled={Boolean(busy)} onClick={() => removeBox(entry.id)}>
              <Icon name="x" size={16} />
            </button>
          </li>
        ))}
      </ul>
      {needsPassword ? <PasswordInput id="box-open-password" label="The file’s password" value={password} onChange={setPassword} onEnter={go} mono /> : null}
      {needsVault && !backup ? (
        <div className="tool-callout">
          <Icon name="vault" size={18} />
          <div>
            <strong>{unlocked ? 'Made with another of your vaults?' : 'Made with your Secure Box vault?'}</strong>
            <p>
              {unlocked
                ? 'Open that vault from the vault menu, or use its key ring backup.'
                : 'Unlock it and they open with your master password. Or use the vault’s key ring backup.'}
            </p>
            <div className="tool-callout-actions">
              {!unlocked ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => run(unlockForTools)}>
                  <Icon name="unlock" size={16} />
                  <span>Unlock your vault</span>
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(async () => chooseBackup(await pickFile('.json,application/json')))}>
                <Icon name="archive" size={16} />
                <span>Use a key ring backup</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {backup ? (
        <div className="tool-backup">
          <div className="choice-found">
            <span className="choice-found-icon">
              <Icon name="check" size={16} />
            </span>
            <span className="choice-found-text">Key ring backup “{backup.name}”</span>
            <button type="button" className="link-btn" onClick={dropBackup}>
              Remove
            </button>
          </div>
          <PasswordInput id="box-master" label="Its master password or recovery key" value={secret} onChange={setSecret} onEnter={go} />
        </div>
      ) : null}
      <p className="tool-note">{canPickFolder() ? 'You’ll choose a folder to save the decrypted files in.' : 'Decrypted files are saved to your downloads; a folder comes out as a .zip.'}</p>
      <FormError error={error} />
      <button type="button" className={`btn btn-primary btn-block${busy === 'open' ? ' is-busy' : ''}`} disabled={Boolean(busy) || !ready || blocked} onClick={go}>
        <span className="btn-spinner" aria-hidden="true" />
        <Icon name="unlock" size={16} />
        <span>Decrypt {ready === 1 ? 'it' : `${ready} files`}</span>
      </button>
    </section>
  );
}

function FileTool() {
  const jobs = useStore(toolsStore, (s) => s.jobs.length);
  const boxes = useStore(toolsStore, (s) => s.boxes.length);
  const busy = useStore(toolsStore, (s) => s.busy);
  const status = useStore(toolsStore, (s) => s.status);
  const done = useStore(toolsStore, (s) => s.done);
  const error = useStore(toolsStore, (s) => s.error);
  const chosen = jobs + boxes > 0;
  return (
    <div className="tool">
      {done ? (
        <div className="tool-done" role="status">
          <span className="tool-done-icon">
            <Icon name="check" size={18} />
          </span>
          <div>
            <strong>{done.text}</strong>
            <small>
              {done.kind === 'encrypt'
                ? done.password
                  ? `Send the password separately from the files${done.account ? '. Your master password opens them too' : ''}.`
                  : 'Your master password opens them, on any device with your vault.'
                : 'The originals stay as they are.'}
            </small>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={dismissDone}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ) : null}
      <DropZone compact={chosen} />
      {busy && busy !== 'text' ? (
        <div className="tool-progress" role="status">
          <Spinner small />
          <span>{status}</span>
          <button type="button" className="link-btn" onClick={stopTools}>
            Stop
          </button>
        </div>
      ) : null}
      {jobs ? <EncryptSection /> : null}
      {boxes ? <OpenSection /> : null}
      {!jobs && !boxes && error ? <FormError error={error} /> : null}
      {chosen && !busy ? (
        <button type="button" className="link-btn tool-clear" onClick={clearFiles}>
          Clear the list
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
function TextTool() {
  const text = useStore(toolsStore, (s) => s.text);
  const textMode = useStore(toolsStore, (s) => s.textMode);
  const out = useStore(toolsStore, (s) => s.textOut);
  const secret = useStore(toolsStore, (s) => s.textOutSecret);
  const error = useStore(toolsStore, (s) => s.textError);
  const errorCode = useStore(toolsStore, (s) => s.textErrorCode);
  const busy = useStore(toolsStore, (s) => s.busy === 'text');
  const unlocked = useSession((s) => s.unlocked);
  useVersion(); // key rings unlocked this session open more files
  const [share, setShare] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [openPassword, setOpenPassword] = useState('');
  const encrypt = textMode === 'encrypt';
  const status = !encrypt ? messageStatus(text) : null;
  const go = () => run(() => runText(encrypt ? { password, confirm, share } : { password: openPassword }));
  return (
    <div className="tool">
      <Segmented
        className="text-modes"
        label="Encrypt or decrypt"
        value={textMode}
        onChange={setTextMode}
        options={[
          { id: 'encrypt', label: 'Encrypt', icon: 'lock' },
          { id: 'decrypt', label: 'Decrypt', icon: 'unlock' },
        ]}
      />
      <section className="tool-section">
        <textarea
          className={`input textarea text-area${encrypt ? '' : ' mono'}`}
          rows={encrypt ? 6 : 7}
          maxLength={1_000_000}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label={encrypt ? 'Text to encrypt' : 'Message to decrypt'}
          placeholder={encrypt ? 'Type or paste the text to encrypt' : 'Paste a Secure Box message. It starts with -----BEGIN SECURE BOX MESSAGE-----'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              go();
            }
          }}
        />
        {encrypt ? (
          <WhoCanOpen what="it" share={share} setShare={setShare} password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} onEnter={go} idPrefix="text" />
        ) : status ? (
          status.ok ? (
            status.mine ? (
              <p className="message-status is-ok">
                <Icon name="check" size={16} />
                Opens with your vault
              </p>
            ) : status.password ? (
              <>
                <p className="message-status">
                  <Icon name="key" size={16} />
                  Opens with its password
                </p>
                <PasswordInput id="text-open-password" label="The message’s password" value={openPassword} onChange={setOpenPassword} onEnter={go} mono />
              </>
            ) : (
              <div className="tool-callout">
                <Icon name="vault" size={18} />
                <div>
                  <strong>{unlocked ? 'Made with another Secure Box vault' : 'Made with a Secure Box vault'}</strong>
                  <p>{unlocked ? 'Open that vault from the vault menu, then come back here.' : 'It opens with the master password of the vault that made it.'}</p>
                  {!unlocked ? (
                    <div className="tool-callout-actions">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => run(unlockForTools)}>
                        <Icon name="unlock" size={16} />
                        <span>Unlock your vault</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            )
          ) : (
            <p className="message-status is-error">
              <Icon name="alert" size={16} />
              {status.error}
            </p>
          )
        ) : null}
        <FormError error={error} code={errorCode} />
        <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={go}>
          <span className="btn-spinner" aria-hidden="true" />
          <Icon name={encrypt ? 'lock' : 'unlock'} size={16} />
          <span>{encrypt ? 'Encrypt' : 'Decrypt'}</span>
        </button>
      </section>
      {out ? (
        <section className="tool-section text-result" aria-label="Result">
          <header className="tool-section-head">
            <span className={`tool-section-icon ${secret ? 'is-open' : 'is-encrypt'}`}>
              <Icon name={secret ? 'unlock' : 'lock'} size={16} />
            </span>
            <h3>{secret ? 'Decrypted' : 'Encrypted message'}</h3>
            <div className="tool-section-tools">
              {!secret && typeof navigator.share === 'function' ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(shareTextOut)}>
                  <Icon name="share" size={16} />
                  <span>Share</span>
                </button>
              ) : null}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => run(copyTextOut)}>
                <Icon name="copy" size={16} />
                <span>Copy</span>
              </button>
            </div>
          </header>
          <textarea className={`input textarea text-area${secret ? '' : ' mono'}`} rows={secret ? 6 : 8} readOnly spellCheck={false} aria-label="Result" value={out} />
          <p className="tool-note">
            {secret ? 'Copies are cleared from the clipboard after 30 seconds.' : password && (share || !unlocked) ? 'Send the password separately from the message.' : 'Your master password opens it, on any device with your vault.'}
          </p>
          <button type="button" className="link-btn tool-clear" onClick={startOverText}>
            Start over
          </button>
        </section>
      ) : null}
    </div>
  );
}

/** The Encrypt & decrypt tab: the same with or without a vault. */
export function ToolsView() {
  const mode = useStore(toolsStore, (s) => s.mode);
  const unlocked = useSession((s) => s.unlocked);
  return (
    <div className="tools">
      <div className="tools-inner">
        <header className="tools-head">
          <div>
            <h1 className="tools-title">Encrypt &amp; decrypt</h1>
            <p className="tools-lead">
              Lock files and messages with a password to share them, or open ones you received. Everything happens on this device
              {unlocked ? ', and your master password always opens what you encrypt here.' : '. No vault or account needed.'}
            </p>
          </div>
          <Segmented
            className="tools-modes"
            label="Files or text"
            value={mode}
            onChange={setToolsMode}
            options={[
              { id: 'files', label: 'Files', icon: 'file' },
              { id: 'text', label: 'Text', icon: 'note' },
            ]}
          />
        </header>
        {mode === 'files' ? <FileTool /> : <TextTool />}
      </div>
    </div>
  );
}
