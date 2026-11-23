import { useState } from 'react';
import { localSupport } from '../../core/localstore.js';
import { BROWSER_VAULT } from '../../experiments.js';
import { FOLDER_HINT, allowDeviceFolder, createDeviceVault, deleteDeviceAtGate, forgetDeviceFolderAtGate, forgetGoneDevice, openDeviceVault, relocateDevice, restoreDeviceFromGate, startOverDevice } from '../../session/device.js';
import { formatDate, pickFile } from '../../session/io.js';
import { deviceChoice } from '../../session/memory.js';
import { setSection } from '../../session/nav.js';
import { bringOver } from '../../session/bringover.js';
import { companyName, currentProvider, placeDetail, placeRows, providerName } from '../../session/places.js';
import { DEMO, state } from '../../session/store.js';
import {
  adoptChange,
  adoptFrom,
  adoptKeyring,
  adoptKeyringFile,
  adoptStop,
  createAccount,
  finishKit,
  openPlace,
  problemAction,
  recover,
  recoverKitFile,
  restoreFromBin,
  retry,
  showAdopt,
  showCreate,
  showRecover,
  showStart,
  showUnlock,
  showWelcome,
  signIn,
  startNewVault,
  startOverInCloud,
  unlock,
} from '../../session/vaults.js';
import { DeviceWhereChoice, KitSaver } from '../dialogs/DialogHost.jsx';
import { FormError, PasswordInput, StrengthMeter, TextInput } from '../common/Fields.jsx';
import { Icon, Spinner } from '../common/Icon.jsx';
import { useAction, useSession } from '../hooks.js';
import { run } from '../run.js';

const placeIcon = (provider) => (provider === 'local' ? 'device' : 'cloud');

/** A button that shows it's working while its action runs. */
function Go({ action, children, kind = 'primary', block = true, disabled = false }) {
  const [go, busy] = useAction(action);
  return (
    <button type="button" className={`btn btn-${kind}${block ? ' btn-block' : ''}${busy ? ' is-busy' : ''}`} disabled={busy || disabled} onClick={() => go()}>
      <span className="btn-spinner" aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}

const Link = ({ onClick, children, danger = false }) => (
  <button type="button" className={`link-btn${danger ? ' link-danger' : ''}`} onClick={() => run(onClick)}>
    {children}
  </button>
);

/** Where this card is about, with the way back to every place (#3). */
function PlaceChip() {
  useSession((s) => s.provider);
  useSession((s) => s.identity);
  useSession((s) => s.backend);
  const provider = currentProvider();
  // The demo's cloud is its sample data; a vault on this device is one there too (moved or copied there).
  const demoCloud = DEMO && provider !== 'local';
  const name = demoCloud ? 'Demo vault' : providerName(provider);
  const detail = demoCloud ? 'Sample data' : placeDetail(provider);
  return (
    <div className="place-chip">
      <span className="place-chip-icon" aria-hidden="true">
        <Icon name={placeIcon(provider)} size={16} />
      </span>
      <span className="place-chip-text">
        <strong>{name}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      {!DEMO ? (
        <button type="button" className="link-btn place-chip-change" onClick={() => run(showWelcome)}>
          Change
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The places
// ---------------------------------------------------------------------------
export function PlaceRow({ icon, name, sub, onClick, last = false, disabled = false, busy = false }) {
  return (
    <button type="button" className={`place-row${last ? ' is-last-used' : ''}`} onClick={onClick} disabled={disabled || busy}>
      <span className="place-row-icon" aria-hidden="true">
        {busy ? <Spinner small /> : <Icon name={icon} size={20} />}
      </span>
      <span className="place-row-text">
        <strong>{name}</strong>
        <small>{sub}</small>
      </span>
      <Icon name="chevronRight" size={18} className="place-row-go" />
    </button>
  );
}

function Places({ gate }) {
  const rows = placeRows();
  const known = rows.some((r) => r.last);
  return (
    <>
      <h2 className="home-title">{DEMO ? 'Try Secure Box' : known ? 'Open your vault' : 'Where should your vault live?'}</h2>
      <p className="home-lead">Passwords, secrets and files, encrypted in this browser before they’re stored.</p>
      {gate.message ? (
        <p className={`home-message${gate.tone === 'error' ? ' is-error' : ''}`} role={gate.tone === 'error' ? 'alert' : 'status'}>
          {gate.message}
        </p>
      ) : null}
      <div className="place-list">
        {rows.map((row) => (
          <PlaceRow key={row.provider} icon={row.icon} name={row.name} sub={row.sub} last={row.last} disabled={row.disabled} onClick={() => run(openPlace, row.provider)} />
        ))}
      </div>
      {!DEMO && !known ? <p className="home-note">New here? Pick where your vault should live. You can add the others later, with the same master password.</p> : null}
      <div className="home-tools-hint">
        <Icon name="fileLock" size={18} />
        <span>
          Got a <span className="mono">.sbox</span> file or an encrypted message?
        </span>
        <button type="button" className="link-btn" onClick={() => setSection('tools')}>
          Open it in Encrypt &amp; decrypt →
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------
function Unlock({ gate }) {
  const [password, setPassword] = useState(gate.demoPassword || '');
  const [caps, setCaps] = useState(false);
  const [go, busy] = useAction(() => unlock(password));
  const provider = currentProvider();
  return (
    <>
      <h2 className="home-title">Welcome back</h2>
      {gate.status ? (
        <p className="home-message" role="status">
          {gate.status}
        </p>
      ) : null}
      <PasswordInput id="unlock-password" label="Master password" value={password} onChange={setPassword} onEnter={go} onCaps={setCaps} autoFocus disabled={busy} invalid={Boolean(gate.error)} />
      {gate.demoPassword ? (
        <p className="panel-hint">
          Demo master password: <span className="mono">{gate.demoPassword}</span>
        </p>
      ) : null}
      <FormError error={gate.error} code={gate.errorCode} caps={caps} value={password} />
      <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => go()}>
        <span className="btn-spinner" aria-hidden="true" />
        <span>Unlock</span>
      </button>
      <div className="home-links">
        <Link onClick={showRecover}>Forgot master password?</Link>
        {!DEMO && provider !== 'local' ? <Link onClick={() => signIn('select_account', provider)}>Use a different {companyName(provider)} account</Link> : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// A place with no vault yet: the first vault, or one more for the master password you have?
// ---------------------------------------------------------------------------
function Start({ gate }) {
  return (
    <>
      <h2 className="home-title">{gate.title}</h2>
      <p className="panel-text">Is this your first Secure Box vault?</p>
      <div className="choice-list">
        <button type="button" className="choice" onClick={() => run(showCreate)}>
          <span className="choice-icon">
            <Icon name="plus" size={20} />
          </span>
          <span className="choice-text">
            <strong>Yes, it’s my first</strong>
            <small>Create a master password. It will open this vault and any you add later.</small>
          </span>
        </button>
        <button type="button" className={`choice${gate.suggested ? ' is-suggested' : ''}`} onClick={() => run(showAdopt)}>
          <span className="choice-icon">
            <Icon name="key" size={20} />
          </span>
          <span className="choice-text">
            <strong>No, I already have one</strong>
            <small>Keep the master password and Emergency Kit you have. All your vaults share them.</small>
          </span>
        </button>
      </div>
      {gate.hint ? <p className="panel-hint start-hint">{gate.hint}</p> : null}
    </>
  );
}

function Create({ gate }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [go, busy] = useAction(() => createAccount(password, confirm));
  return (
    <>
      <h2 className="home-title">Create your master password</h2>
      <p className="panel-text">It encrypts the key to everything in your vault. It’s never stored or sent anywhere, so Secure Box can’t reset it for you.</p>
      <PasswordInput id="create-password" label="Master password" value={password} onChange={setPassword} autoFocus disabled={busy} />
      <StrengthMeter password={password} />
      <PasswordInput id="create-confirm" label="Repeat it" value={confirm} onChange={setConfirm} onEnter={go} disabled={busy} reveal={false} />
      <p className="panel-hint">Use 12+ characters: a short sentence only you would think of works well. Don’t save it in your browser or online account.</p>
      <FormError error={gate.error} />
      <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => go()}>
        <span className="btn-spinner" aria-hidden="true" />
        <span>Create vault</span>
      </button>
      <div className="home-links">
        <Link onClick={showStart}>Back</Link>
      </div>
    </>
  );
}

function Adopt({ gate }) {
  const [secret, setSecret] = useState('');
  const [caps, setCaps] = useState(false);
  const [go, busy] = useAction(() => adoptKeyring(secret));
  const waiting = Boolean(gate.waiting);
  return (
    <>
      <h2 className="home-title">Use the master password you have</h2>
      <p className="panel-text">{gate.intro}</p>
      {gate.step === 'source' ? (
        <>
          <p className="choice-label">Where is one of your vaults?</p>
          <div className="choice-list">
            {gate.sources.map((from) => (
              <button key={from} type="button" className="choice" disabled={waiting} onClick={() => run(adoptFrom, from)}>
                <span className="choice-icon">
                  <Icon name="cloud" size={20} />
                </span>
                <span className="choice-text">
                  <strong>{providerName(from)}</strong>
                  <small>Sign in to fetch its key ring</small>
                </span>
              </button>
            ))}
            {gate.local ? (
              <button type="button" className="choice" disabled={waiting} onClick={() => run(adoptFrom, 'local')}>
                <span className="choice-icon">
                  <Icon name="device" size={20} />
                </span>
                <span className="choice-text">
                  <strong>This device</strong>
                  <small>{gate.local}</small>
                </span>
              </button>
            ) : null}
            <button type="button" className="choice" disabled={waiting} onClick={() => run(async () => adoptKeyringFile(await pickFile('.json,application/json')))}>
              <span className="choice-icon">
                <Icon name="archive" size={20} />
              </span>
              <span className="choice-text">
                <strong>A key ring backup</strong>
                <small>The .json file saved with ⋯ → Key ring backup</small>
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="choice-found" role="status">
            <span className="choice-found-icon">
              <Icon name="check" size={16} />
            </span>
            <span className="choice-found-text">{gate.found}</span>
            <button type="button" className="link-btn" onClick={() => run(adoptChange)}>
              Change
            </button>
          </div>
          <PasswordInput id="adopt-password" label="Master password" value={secret} onChange={setSecret} onEnter={go} onCaps={setCaps} autoFocus disabled={busy} />
          <p className="panel-hint">The master password of that vault. Its Emergency Kit’s recovery key works too.</p>
        </>
      )}
      {waiting ? (
        <p className="panel-status adopt-waiting" role="status">
          <Spinner small />
          <span>{gate.waiting}</span>
          {gate.cancellable ? (
            <button type="button" className="link-btn" onClick={adoptStop}>
              Cancel
            </button>
          ) : null}
        </p>
      ) : null}
      <FormError error={gate.error} code={gate.errorCode} caps={caps} value={secret} />
      {gate.step === 'unlock' ? (
        <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => go()}>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Open my new vault</span>
        </button>
      ) : null}
      <div className="home-links">
        <Link onClick={showStart}>Back</Link>
      </div>
    </>
  );
}

function Kit() {
  const [sure, setSure] = useState(false);
  const recovery = state.pendingKit;
  if (!recovery) return null;
  return (
    <>
      <h2 className="home-title">Save your Emergency Kit</h2>
      <p className="panel-text">If you ever forget your master password, this kit’s recovery key is the only way back in.</p>
      <KitSaver recovery={recovery} email={state.identity?.email} />
      <label className="check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>I’ve saved my Emergency Kit somewhere safe</span>
      </label>
      <button type="button" className="btn btn-primary btn-block" disabled={!sure} onClick={() => run(finishKit)}>
        Open my vault
      </button>
    </>
  );
}

function Recover({ gate }) {
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [go, busy] = useAction(() => recover({ key, password, confirm }));
  return (
    <>
      <h2 className="home-title">Reset your master password</h2>
      <p className="panel-text">Load your Emergency Kit, then choose a new master password.</p>
      <button type="button" className="btn btn-ghost btn-block" onClick={() => run(async () => recoverKitFile(await pickFile('.txt,text/plain')))}>
        <Icon name="upload" />
        <span>Load Emergency Kit file…</span>
      </button>
      {gate.fileName ? (
        <p className="panel-status" role="status">
          Using {gate.fileName}
        </p>
      ) : null}
      <TextInput id="recover-key" label="…or type the recovery key" value={key} onChange={setKey} mono placeholder="XXXX-XXXX-…" />
      <PasswordInput id="recover-password" label="New master password" value={password} onChange={setPassword} disabled={busy} />
      <StrengthMeter password={password} />
      <PasswordInput id="recover-confirm" label="Repeat it" value={confirm} onChange={setConfirm} onEnter={go} reveal={false} disabled={busy} />
      <FormError error={gate.error} />
      <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => go()}>
        <span className="btn-spinner" aria-hidden="true" />
        <span>Reset &amp; unlock</span>
      </button>
      <div className="home-links">
        <Link onClick={() => showUnlock()}>Back</Link>
      </div>
      {gate.deletable ? (
        <p className="panel-foot recover-delete">
          No Emergency Kit either?{' '}
          <Link danger onClick={deleteDeviceAtGate}>
            Delete this vault and start over…
          </Link>
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// This device
// ---------------------------------------------------------------------------
function DeviceNew({ gate }) {
  const [where, setWhere] = useState(BROWSER_VAULT && gate.browserOk ? 'browser' : 'folder');
  const [go, busy] = useAction(() => createDeviceVault(where));
  return (
    <>
      <h2 className="home-title">A vault on this device</h2>
      <p className="panel-text">Passwords and files kept here only. Nothing is uploaded, so nothing syncs: back it up now and then, and keep the backup somewhere else.</p>
      {BROWSER_VAULT && gate.browserOk && gate.folderOk ? (
        <DeviceWhereChoice where={where} onChange={setWhere} />
      ) : gate.folderOk ? (
        <p className="panel-hint">It’s kept in a folder you choose, as ordinary encrypted files you can see, copy and back up. {FOLDER_HINT}</p>
      ) : BROWSER_VAULT ? (
        <p className="panel-hint">It’s kept in this browser’s private storage. Clearing this site’s data in the browser deletes it.</p>
      ) : null}
      <FormError error={gate.error} />
      <button type="button" className={`btn btn-primary btn-block${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => go()}>
        <span className="btn-spinner" aria-hidden="true" />
        <span>Continue</span>
      </button>
      <button type="button" className="btn btn-ghost btn-block device-restore" onClick={() => run(restoreDeviceFromGate)}>
        <Icon name="upload" />
        <span>Restore a backup…</span>
      </button>
    </>
  );
}

function DeviceAllow({ gate }) {
  return (
    <>
      <h2 className="home-title">Open your vault</h2>
      <p className="panel-text">
        Your vault on this device is in the folder <strong>“{gate.name}” › Secure Box</strong>. Your browser asks once per visit before Secure Box may open it.
      </p>
      <FormError error={gate.error} />
      <Go action={allowDeviceFolder}>Open the folder</Go>
      <div className="home-links">
        <Link onClick={forgetDeviceFolderAtGate}>Forget this folder</Link>
      </div>
    </>
  );
}

function DeviceIos() {
  return (
    <>
      <h2 className="home-title">Use the Home Screen app</h2>
      <p className="panel-text">On iPhone and iPad, keep a vault on this device only in the Secure Box app on your Home Screen. Safari deletes the data of websites you haven’t opened for 7 days, and only Home Screen apps are safe from that.</p>
      <ol className="local-steps">
        <li>In Safari, tap Share, then Add to Home Screen.</li>
        <li>Open Secure Box from your Home Screen.</li>
      </ol>
    </>
  );
}

// ---------------------------------------------------------------------------
// Problems: what happened, the one thing to do, and always a way on
// ---------------------------------------------------------------------------
function Problem({ gate }) {
  return (
    <>
      <div className="problem-head">
        <span className="problem-icon" aria-hidden="true">
          <Icon name="alert" size={20} />
        </span>
        <h2 className="home-title">{gate.title}</h2>
      </div>
      <p className="panel-text">{gate.message}</p>
      <Go action={() => problemAction(gate.action)}>{gate.actionLabel}</Go>
      <div className="home-links">
        {gate.forgettable ? <Link onClick={forgetGoneDevice}>Forget it</Link> : null}
        {gate.deletable ? (
          <Link danger onClick={deleteDeviceAtGate}>
            Delete this vault…
          </Link>
        ) : null}
        <Link onClick={showWelcome}>Open another vault</Link>
      </div>
    </>
  );
}

function MissingKeyring() {
  const provider = currentProvider();
  return (
    <>
      <div className="problem-head">
        <span className="problem-icon" aria-hidden="true">
          <Icon name="alert" size={20} />
        </span>
        <h2 className="home-title">Key ring not found</h2>
      </div>
      <p className="panel-text">
        Your vault is in {providerName(provider)}, but its key ring file (<span className="mono">Secure Box Key Ring.json</span>) is missing. Restore it from the trash (recycle bin) in {providerName(provider)}, then try again.
      </p>
      <Go action={retry}>Try again</Go>
      <div className="home-links">
        {provider !== 'local' ? <Link onClick={() => signIn('select_account', provider)}>Use a different {companyName(provider)} account</Link> : null}
        <Link onClick={showWelcome}>Open another vault</Link>
      </div>
    </>
  );
}

function MissingVault() {
  const provider = currentProvider();
  return (
    <>
      <div className="problem-head">
        <span className="problem-icon" aria-hidden="true">
          <Icon name="alert" size={20} />
        </span>
        <h2 className="home-title">Vault file not found</h2>
      </div>
      <p className="panel-text">
        Your key ring is fine, but <span className="mono">Secure Box Vault.json</span> is missing from {provider === 'local' ? 'this device' : `your ${providerName(provider)}`}. Restore it from the trash (recycle bin) there and try again — or start over with an empty vault.
      </p>
      <div className="btn-stack">
        <Go action={retry}>Try again</Go>
        <Go action={startNewVault} kind="ghost">
          Start a new, empty vault
        </Go>
      </div>
      <div className="home-links">
        <Link onClick={showWelcome}>Open another vault</Link>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// A vault deleted or moved outside Secure Box: what happened, and the ways on
// ---------------------------------------------------------------------------
/** The vault moved away from this place (session/migrate.js): where it went, and the way there. */
function VaultMoved({ gate }) {
  const provider = currentProvider();
  const there = gate.to !== provider && gate.to !== 'local';
  const otherAccount = gate.to === provider && provider !== 'local';
  const here = gate.to === 'local' && Boolean(deviceChoice()); // this device has a vault: it may well be the one
  return (
    <>
      <div className="problem-head">
        <span className="problem-icon is-info" aria-hidden="true">
          <Icon name="move" size={20} />
        </span>
        <h2 className="home-title">Your vault moved</h2>
      </div>
      <p className="panel-text">
        It was {gate.text}.{' '}
        {there
          ? 'Open it there: everything that was here went with it.'
          : otherAccount
            ? 'Sign in with that account to open it.'
            : 'Open it on that device, under This device: everything that was here went with it.'}
      </p>
      <div className="btn-stack">
        {there ? <Go action={() => openPlace(gate.to)}>Open your {providerName(gate.to)} vault</Go> : null}
        {otherAccount ? <Go action={() => signIn('select_account', provider)}>Use another {companyName(provider)} account</Go> : null}
        {here ? <Go action={openDeviceVault}>Open your vault on this device</Go> : null}
        <Go action={startOverInCloud} kind={there || otherAccount || here ? 'ghost' : 'primary'}>
          Start a new vault here
        </Go>
      </div>
      <div className="home-links">
        <Link onClick={showWelcome}>Open another vault</Link>
      </div>
    </>
  );
}

function VaultMissing({ gate }) {
  const provider = currentProvider();
  const head = (title) => (
    <div className="problem-head">
      <span className="problem-icon" aria-hidden="true">
        <Icon name="alert" size={20} />
      </span>
      <h2 className="home-title">{title}</h2>
    </div>
  );
  const otherAccount = provider !== 'local' ? <Link onClick={() => signIn('select_account', provider)}>Use a different {companyName(provider)} account</Link> : null;
  const elsewhere = <Link onClick={showWelcome}>Open another vault</Link>;

  if (gate.kind === 'bin') {
    return (
      <>
        {head('Your vault is in the bin')}
        <p className="panel-text">The Secure Box folder in your Google Drive was moved to the bin. Take it out to open your vault: everything in it comes back as it was.</p>
        <Go action={restoreFromBin}>Restore it</Go>
        <div className="home-links">
          {otherAccount}
          {elsewhere}
        </div>
      </>
    );
  }
  // Secure Box now connects to this cloud as a new app, which can't see what the old one made.
  const name = providerName(provider);
  const onedrive = provider === 'microsoft';
  const sees = `${name} shows an app only ${onedrive ? 'its own folder' : 'the files it made itself'}`;
  if (gate.kind === 'previous') {
    return (
      <>
        {head(gate.had ? 'Your vault is with Secure Box’s previous connection' : 'Had a vault here before?')}
        <p className="panel-text">
          Secure Box now connects to {name} as a new app, and {sees}.{' '}
          {gate.had
            ? `Your vault is still in your ${name}. Bring it over: Secure Box signs in through its previous connection too, and copies your vault across exactly as it is.`
            : `If you had a vault in this ${companyName(provider)} account, bring it over: Secure Box signs in through its previous connection too, and copies it across exactly as it is.`}
        </p>
        <div className="btn-stack">
          <Go action={bringOver}>Bring it over</Go>
          <Go action={startOverInCloud} kind="ghost">
            Start a new vault here
          </Go>
        </div>
        <div className="home-links">
          {otherAccount}
          {elsewhere}
        </div>
      </>
    );
  }
  if (gate.kind === 'app') {
    return (
      <>
        {head(`Secure Box can’t see your vault in ${name}`)}
        {gate.failed ? (
          <p className="panel-text">
            Secure Box couldn’t sign in through its previous connection: {gate.failed} If {companyName(provider)} said that app was deleted or blocked, it’s gone for good.
          </p>
        ) : null}
        <p className="panel-text">
          Your vault is still in your {name}
          {onedrive ? ', in Apps › Secure Box' : ', in its “Secure Box” folder'}. But Secure Box now connects to {name} as a different app, and {sees}. To bring your vault back:
        </p>
        <ol className="local-steps">
          <li>
            {onedrive
              ? 'On onedrive.com, open Apps, select the “Secure Box” folder with your vault, and choose Download.'
              : 'On drive.google.com, right-click the “Secure Box” folder and choose Download. Google may split it into several ZIP files.'}
          </li>
          <li>Choose Restore from the download below, and pick {onedrive ? 'the ZIP file' : 'all the ZIP files'}.</li>
          <li>Unlock your vault, then use ⋯ → Move or copy this vault… to put it back in your {name}.</li>
        </ol>
        <div className="btn-stack">
          <Go action={restoreDeviceFromGate}>Restore from the download…</Go>
          {gate.failed ? (
            <Go action={bringOver} kind="ghost">
              Try the previous connection again
            </Go>
          ) : null}
          <Go action={startOverInCloud} kind="ghost">
            Start a new vault here
          </Go>
        </div>
        <div className="home-links">
          {otherAccount}
          {elsewhere}
        </div>
      </>
    );
  }
  if (gate.kind === 'cloud') {
    return (
      <>
        {head(`Your vault isn’t in your ${providerName(provider)} any more`)}
        <p className="panel-text">
          {onedrive
            ? 'Secure Box can’t find its folder (Apps › Secure Box) in your OneDrive. If it was deleted by mistake, restore it from the OneDrive recycle bin, then try again. If it’s gone for good, start a new vault here.'
            : 'Secure Box can’t find its folder in your Google Drive, not even in the bin, so it was deleted for good. If your vault is in another Google account, use that one. Otherwise, start a new vault here.'}
        </p>
        <div className="btn-stack">
          {onedrive ? <Go action={retry}>Try again</Go> : null}
          <Go action={startOverInCloud} kind={onedrive ? 'ghost' : 'primary'}>
            Start a new vault
          </Go>
        </div>
        <div className="home-links">
          {otherAccount}
          {elsewhere}
        </div>
      </>
    );
  }
  if (BROWSER_VAULT && gate.kind === 'browser') {
    return (
      <>
        {head('Your vault in this browser is gone')}
        <p className="panel-text">
          {gate.message} {gate.backupAt ? `Your last backup of it is from ${formatDate(gate.backupAt)}: restore it to have your vault back as it was then.` : 'If you have a backup of it, restore it to have your vault back.'}
        </p>
        <div className="btn-stack">
          <Go action={restoreDeviceFromGate}>Restore a backup…</Go>
          <Go action={startOverDevice} kind="ghost">
            Start a new vault
          </Go>
        </div>
        <div className="home-links">{elsewhere}</div>
      </>
    );
  }
  return (
    <>
      {head('Your vault on this device is missing')}
      <p className="panel-text">{gate.message} If it was deleted by mistake, restore it from the Recycle Bin (the Trash on a Mac), then try again. If you moved or renamed it, find it.</p>
      <div className="btn-stack">
        <Go action={retry}>Try again</Go>
        <Go action={relocateDevice} kind="ghost">
          Find the folder…
        </Go>
        <Go action={restoreDeviceFromGate} kind="ghost">
          Restore a backup…
        </Go>
      </div>
      <div className="home-links">
        <Link onClick={startOverDevice}>Start over without it</Link>
        {elsewhere}
      </div>
    </>
  );
}

function Setup() {
  return (
    <>
      <h2 className="home-title">Finish setting up</h2>
      <p className="panel-text">This copy of Secure Box isn’t connected to a Google sign-in client yet. Deploy it with your Google OAuth client ID:</p>
      <div className="code-row">
        <code>.\deploy-firebase.ps1 -Project &lt;id&gt; -GoogleClientId &lt;id&gt;</code>
      </div>
      <p className="panel-foot">The README walks you through the whole setup.</p>
      <a className="btn btn-ghost btn-block" href="?demo">
        Preview with demo data
      </a>
    </>
  );
}

function Working({ gate }) {
  return (
    <div className="working" role="status">
      <Spinner />
      <span>{gate.text}</span>
    </div>
  );
}

const PANELS = {
  places: Places,
  working: Working,
  unlock: Unlock,
  start: Start,
  create: Create,
  adopt: Adopt,
  kit: Kit,
  recover: Recover,
  'device-new': DeviceNew,
  'device-allow': DeviceAllow,
  ...(BROWSER_VAULT ? { 'device-ios': DeviceIos } : {}),
  problem: Problem,
  'missing-keyring': MissingKeyring,
  'missing-vault': MissingVault,
  'vault-missing': VaultMissing,
  'vault-moved': VaultMoved,
  setup: Setup,
};

// Panels that are about one place show it on top, with the way back to the others.
const ABOUT_A_PLACE = new Set(['working', 'unlock', 'start', 'create', 'adopt', 'kit', 'recover', 'device-new', 'device-allow', 'device-ios', 'problem', 'missing-keyring', 'missing-vault', 'vault-missing', 'vault-moved']);

function TrustFooter() {
  return (
    <footer className="home-foot">
      <span>
        <Icon name="lock" size={14} />
        Encrypted in your browser
      </span>
      <span>
        <Icon name={localSupport().browser ? 'cloud' : 'device'} size={14} />
        Kept in your own cloud or on your device
      </span>
      <span>
        <Icon name="key" size={14} />
        Your master password never leaves you
      </span>
      <a href="privacy.html" target="_blank" rel="noopener">
        Privacy
      </a>
    </footer>
  );
}

/** The Vault tab while locked: one card, with every step in it. */
export function VaultHome() {
  const gate = useSession((s) => s.gate);
  const Panel = PANELS[gate.panel];
  const showChip = ABOUT_A_PLACE.has(gate.panel) && !(gate.panel === 'problem' && gate.action === 'show-welcome');
  return (
    <div className="home">
      <div className="home-inner">
        <section className="home-card" key={gate.panel} aria-live="polite">
          {gate.panel === 'loading' ? (
            <div className="working" role="status">
              <Spinner />
              <span>Loading…</span>
            </div>
          ) : (
            <>
              {showChip ? <PlaceChip /> : null}
              {Panel ? <Panel gate={gate} /> : null}
            </>
          )}
        </section>
        <TrustFooter />
      </div>
    </div>
  );
}
