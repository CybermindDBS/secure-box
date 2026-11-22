import { useEffect, useRef, useState } from 'react';
import { bytesText, clearAgain, contentsOf, describeContents, destinations, dropCopies, lookThere, openTheirs, placeOfOpen, reconnect, transfer } from '../../session/migrate.js';
import { companyName, providerName } from '../../session/places.js';
import { DEMO, state } from '../../session/store.js';
import { switchVault } from '../../session/vaults.js';
import { FormError, PasswordInput } from '../common/Fields.jsx';
import { Icon, Spinner } from '../common/Icon.jsx';
import { Modal } from './Modal.jsx';

/** Where deleted things go at a place, in words: "the Google Drive bin", or null on this device (deleted for good). */
const binOf = (provider) => (provider === 'microsoft' ? 'the OneDrive recycle bin' : provider === 'google' ? (DEMO ? 'the demo’s bin' : 'the Google Drive bin') : null);
const nameOf = (provider) => (DEMO && provider === 'google' ? 'the demo vault' : providerName(provider)); // in a sentence
const titleOf = (provider) => (provider === 'local' ? 'This device' : DEMO ? 'Demo vault' : providerName(provider)); // on its own

/** The place a vault is going to, in a few words: "OneDrive", "this browser", "“Vaults” › Secure Box". */
function shortPlace(dest) {
  if (dest.provider !== 'local') return nameOf(dest.provider);
  return dest.backend.where === 'folder' ? `“${dest.backend.name}”` : 'this browser';
}

/** Where the open vault is when the dialog opens (a move then opens it elsewhere, behind the dialog). */
function originNow() {
  const provider = state.provider;
  const local = provider === 'local';
  return {
    provider,
    label: placeOfOpen(),
    name: titleOf(provider),
    detail: local ? (state.backend.where === 'folder' ? 'A folder on this device' : 'In this browser') : DEMO ? 'Sample data' : state.identity?.email,
    icon: local ? 'device' : 'cloud',
    bin: binOf(provider),
  };
}

function PlaceCard({ icon, label, name, detail, tone }) {
  return (
    <div className={`move-place${tone ? ` is-${tone}` : ''}`}>
      <span className="move-place-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="move-place-text">
        <small>{label}</small>
        <strong>{name}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
    </div>
  );
}

/** From where to where: the open vault's place, an arrow, the place it's going. */
function Route({ origin, dest }) {
  const toDetail = dest.provider === 'local' ? (dest.backend.where === 'folder' ? 'A folder on this device' : 'In this browser') : DEMO ? 'Sample data' : dest.auth?.identity.email;
  return (
    <div className="move-route">
      <PlaceCard icon={origin.icon} label="From" name={origin.name} detail={origin.detail} />
      <span className="move-route-arrow" aria-hidden="true">
        <Icon name="chevronRight" size={18} />
      </span>
      <PlaceCard icon={dest.provider === 'local' ? 'device' : 'cloud'} label="To" name={titleOf(dest.provider)} detail={toDetail} tone="to" />
    </div>
  );
}

/** "3 passwords and notes and 2 files": what a vault there has that this one doesn't. */
function ownThings(compare) {
  const only = compare.onlyThere;
  const parts = [];
  if (only.items) parts.push(`${only.items} ${only.items === 1 ? 'password or note' : 'passwords and notes'}`);
  if (only.files) parts.push(`${only.files} ${only.files === 1 ? 'file' : 'files'}`);
  if (only.folders && !only.files) parts.push(`${only.folders} ${only.folders === 1 ? 'folder' : 'folders'}`);
  const newer = compare.newerThere.items + compare.newerThere.files;
  return { own: parts.join(' and '), newer };
}

/** What's at the place, and (if there's a vault) whether to combine with it or replace it. */
function ThereNow({ plan, keep, setKeep, secret, setSecret, secretError, setSecretError, busy }) {
  const { look, dest } = plan;
  const bin = binOf(dest.provider);
  const where = shortPlace(dest);
  const has = plan.there ? `, with its ${describeContents(contentsOf(plan.there))}` : '';
  const replaceText = bin ? `It goes to ${bin} first${has}. You can still restore it from there.` : `It’s deleted from this device for good first${has}.`;
  if (look.kind === 'empty') {
    return (
      <div className="move-there" role="note">
        <Icon name="info" size={16} />
        <p>
          {dest.lost ? `Your earlier vault on this device is gone (${dest.lost}). ` : ''}
          {look.note ? `Your vault was moved away from ${where} before. It comes back there now.` : `Nothing is in ${where} yet: your vault goes in as it is.`}
          {look.inBin ? ` There’s an older vault in ${bin}: it stays there.` : ''}
        </p>
      </div>
    );
  }
  if (look.kind === 'same' && plan.compare?.earlierCopy) {
    return (
      <div className="move-there" role="note">
        <Icon name="refresh" size={16} />
        <p>An earlier copy of this vault is in {where}. It’s brought up to date: nothing in it is lost.</p>
      </div>
    );
  }
  if (look.kind === 'unreadable') {
    return (
      <div className="move-there is-warn" role="alert">
        <Icon name="alert" size={16} />
        <p>
          Something is in {where} that Secure Box can’t open: {look.reason.replace(/\.$/, '')}. To {where === 'this browser' ? 'keep your vault here' : 'go on'}, it has to be replaced. {replaceText}
        </p>
      </div>
    );
  }
  const other = look.kind === 'other';
  const { own, newer } = plan.compare ? ownThings(plan.compare) : { own: '', newer: 0 };
  const intro = other
    ? `Another vault is in ${where}, with a master password of its own.`
    : `A vault with your master password is in ${where}${own ? `, with ${own} this one doesn’t have` : ''}${newer ? `${own ? ', and' : ', with'} ${newer} ${newer === 1 ? 'thing' : 'things'} changed there more recently` : ''}.`;
  return (
    <>
      <div className="move-there" role="note">
        <Icon name="vault" size={16} />
        <p>{intro}</p>
      </div>
      <p className="move-group" id="move-keep-label">
        The vault already there
      </p>
      <div className="local-where-choice move-options" role="radiogroup" aria-labelledby="move-keep-label">
        <label className="local-option">
          <input type="radio" name="move-keep" value="combine" checked={keep === 'combine'} disabled={busy} onChange={() => setKeep('combine')} />
          <span>
            <strong>Combine them</strong>
            <small>
              {other
                ? 'Everything in both is kept, in that vault, which then opens with its own master password and Emergency Kit.'
                : 'Everything in both is kept. Where both have the same thing, the latest version wins.'}
            </small>
          </span>
        </label>
        {other && keep === 'combine' && !plan.their ? (
          <div className="move-secret">
            <PasswordInput
              id="move-their-password"
              label="Its master password"
              value={secret}
              onChange={(value) => {
                setSecret(value);
                setSecretError('');
              }}
              autoFocus
            />
            <FormError error={secretError} code={secretError ? 'wrong-password' : ''} value={secret} />
            <small className="move-secret-hint">Its Emergency Kit’s recovery key works too.</small>
          </div>
        ) : null}
        <label className="local-option is-danger">
          <input type="radio" name="move-keep" value="replace" checked={keep === 'replace'} disabled={busy} onChange={() => setKeep('replace')} />
          <span>
            <strong>Replace it</strong>
            <small>{replaceText}</small>
          </span>
        </label>
      </div>
    </>
  );
}

/** Move or copy, and what each means here. */
function ModeChoice({ origin, mode, setMode, plan, busy, labelled }) {
  const from = origin.label;
  const to = shortPlace(plan.dest);
  const From = `${from[0].toUpperCase()}${from.slice(1)}`;
  const moveText =
    origin.provider === 'local'
      ? `Your vault opens from ${to}, and is deleted from ${from}.`
      : `Your vault opens from ${to}. ${From} keeps only a note of where it went, and its files go to ${origin.bin}.`;
  return (
    <>
      {labelled ? (
        <p className="move-group" id="move-mode-label">
          This vault
        </p>
      ) : null}
      <div className="local-where-choice move-options" role="radiogroup" aria-labelledby={labelled ? 'move-mode-label' : undefined} aria-label={labelled ? undefined : 'Move or copy'}>
        <label className="local-option">
          <input type="radio" name="move-mode" value="move" checked={mode === 'move'} disabled={busy} onChange={() => setMode('move')} />
          <span>
            <strong>Move it</strong>
            <small>{moveText}</small>
          </span>
        </label>
        <label className="local-option">
          <input type="radio" name="move-mode" value="copy" checked={mode === 'copy'} disabled={busy} onChange={() => setMode('copy')} />
          <span>
            <strong>Copy it</strong>
            <small>Your vault stays in {from} too. From then on, each changes on its own.</small>
          </span>
        </label>
      </div>
    </>
  );
}

/** How much goes, and whether it fits. */
function SizeLine({ plan }) {
  const c = contentsOf(state.vault);
  const short = plan.free != null && plan.need > plan.free;
  return (
    <p className={`move-size${short ? ' is-short' : ''}`}>
      <span>
        {describeContents(c)}
        {plan.need ? ` · ${bytesText(plan.need)} to copy` : c.files ? ' · already there' : ''}
      </span>
      {plan.free != null ? <span>{short ? `Not enough space: ${bytesText(plan.free)} free in ${shortPlace(plan.dest)}` : `${bytesText(plan.free)} free`}</span> : null}
    </p>
  );
}

const STEPS = [
  { id: 'copy', label: 'Copying the encrypted files' },
  { id: 'write', label: 'Saving the vault and key ring' },
  { id: 'check', label: 'Checking the copy' },
  { id: 'open', label: 'Opening it from its new place', move: true },
  { id: 'tidy', label: 'Clearing the old place', move: true },
];

/** The transfer's steps, ticked off, with the files' progress under the first. */
function Progress({ phase, progress, mode }) {
  const steps = STEPS.filter((s) => mode === 'move' || !s.move);
  const order = ['prepare', 'clear', ...steps.map((s) => s.id)];
  const now = Math.max(0, order.indexOf(phase));
  const fraction = phase !== 'copy' && phase !== 'prepare' && phase !== 'clear' ? 1 : progress.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <ol className="move-steps">
      {steps.map((s) => {
        const at = order.indexOf(s.id);
        const status = at < now ? 'done' : at === now ? 'now' : 'later';
        return (
          <li key={s.id} className={`is-${status}`} aria-current={status === 'now' ? 'step' : undefined}>
            <span className="move-step-mark" aria-hidden="true">
              {status === 'done' ? <Icon name="check" size={14} /> : status === 'now' ? <Spinner small /> : null}
            </span>
            <span className="move-step-text">
              <span>{s.label}</span>
              {s.id === 'copy' && (status === 'now' || status === 'done') ? (
                <>
                  <span className="transfer-bar move-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-label="Copying the encrypted files">
                    <span className="transfer-fill" style={{ '--progress': fraction }} />
                  </span>
                  <small className="move-step-detail">
                    {status === 'done'
                      ? progress.total
                        ? `${bytesText(progress.total)} copied`
                        : 'All there already'
                      : progress.total
                        ? `${bytesText(progress.done)} of ${bytesText(progress.total)}`
                        : 'Getting ready…'}
                  </small>
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The dialog behind ⋯ → Move or copy this vault (session/migrate.js). */
export function MoveVaultDialog({ close }) {
  const [origin] = useState(originNow);
  const [step, setStep] = useState('choose'); // choose, looking, ready, working, done, stopped, failed
  const [rows] = useState(() => destinations());
  const [picked, setPicked] = useState(null);
  const [plan, setPlan] = useState(null);
  const [mode, setMode] = useState('move');
  const [keep, setKeep] = useState('combine');
  const [secret, setSecret] = useState('');
  const [secretError, setSecretError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [phase, setPhase] = useState('prepare');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const controller = useRef(null);
  const heading = useRef(null);
  const latest = useRef(null);
  const timer = useRef(0);
  const working = step === 'looking' || step === 'working';

  // Each step announces itself: focus moves to its heading (the Modal focused the first one).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => () => controller.current?.abort(), []);

  const look = async (row) => {
    setPicked(row);
    setProblem(null);
    setStep('looking');
    controller.current = new AbortController();
    try {
      const found = await lookThere(row, { signal: controller.current.signal });
      if (!found) return setStep('choose');
      setPlan(found);
      setKeep(found.look.kind === 'unreadable' ? 'replace' : 'combine');
      setSecret('');
      setSecretError('');
      setStep('ready');
    } catch (err) {
      if (err?.code === 'cancelled' || err?.name === 'AbortError') return setStep('choose');
      setProblem({ at: 'look', err });
      setStep('failed');
    }
  };

  const go = async (current = plan) => {
    let ready = current;
    if (ready.look.kind === 'other' && keep === 'combine' && !ready.their) {
      if (!secret) return setSecretError('Enter its master password.');
      setUnlocking(true);
      try {
        ready = await openTheirs(ready, secret);
        setPlan(ready);
      } catch (err) {
        setUnlocking(false);
        return setSecretError(err.message);
      }
      setUnlocking(false);
    }
    setProblem(null);
    setPhase('prepare');
    setProgress({ done: 0, total: 0 });
    setStep('working');
    controller.current = new AbortController();
    try {
      const done = await transfer(ready, {
        mode,
        replace: keep === 'replace',
        signal: controller.current.signal,
        onStep: setPhase,
        onProgress: (p) => {
          latest.current = p;
          timer.current ||= setTimeout(() => {
            timer.current = 0;
            setProgress(latest.current);
          }, 100);
        },
      });
      clearTimeout(timer.current);
      timer.current = 0;
      setResult(done);
      setStep('done');
    } catch (err) {
      clearTimeout(timer.current);
      timer.current = 0;
      if (err?.name === 'AbortError' || controller.current.signal.aborted) return setStep('stopped');
      console.error(err);
      setProblem({ at: 'transfer', err });
      setStep('failed');
    }
  };

  const signInAgain = async () => {
    setRetrying(true);
    try {
      await reconnect(plan, problem.err.side);
      setRetrying(false);
      go();
    } catch (err) {
      setRetrying(false);
      if (err?.code !== 'popup-closed') setProblem({ ...problem, err });
    }
  };

  const tidyAgain = async () => {
    setRetrying(true);
    try {
      await clearAgain(result.leftover);
      setResult({ ...result, leftover: null });
    } catch (err) {
      setResult({
        ...result,
        leftover: { ...result.leftover, message: err.message },
      });
    }
    setRetrying(false);
  };

  // Stopped or failed, and not tried again: the copies made so far go (they're no vault's).
  const giveUp = () => {
    if (plan) dropCopies(plan);
    close(null);
  };
  // With "Replace it", what was there went first: say so, rather than "nothing changed".
  const clearedNote = plan?.dest.cleared
    ? ` The vault that was in ${shortPlace(plan.dest)} is gone already, as you chose${binOf(plan.dest.provider) ? `: it’s in ${binOf(plan.dest.provider)}` : ''}.`
    : '';
  const from = origin.label;
  const to = plan ? shortPlace(plan.dest) : picked ? (picked.provider === 'local' ? 'this device' : nameOf(picked.provider)) : '';
  const short = plan && plan.free != null && plan.need > plan.free;
  const replacing = plan && keep === 'replace' && plan.look.kind !== 'empty' && !(plan.look.kind === 'same' && plan.compare?.earlierCopy);
  const verb = mode === 'move' ? 'Move' : 'Copy';

  let title;
  let body;
  let foot;
  switch (step) {
    case 'choose':
      title = 'Move or copy your vault';
      body = (
        <>
          <p className="panel-text">Choose where it goes. It travels as it’s stored, encrypted the whole way, and nothing in {from} changes until it’s safely there.</p>
          <div className="place-list move-dest-list">
            {rows.map((row) => (
              <button key={row.id} type="button" className="place-row" disabled={row.disabled} onClick={() => look(row)}>
                <span className="place-row-icon" aria-hidden="true">
                  <Icon name={row.icon} size={20} />
                </span>
                <span className="place-row-text">
                  <strong>{row.name}</strong>
                  <small>{row.disabled ? row.why : row.detail}</small>
                </span>
                <Icon name="chevronRight" size={16} className="place-row-go" />
              </button>
            ))}
          </div>
        </>
      );
      foot = (
        <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
          Cancel
        </button>
      );
      break;
    case 'looking':
      title = `Looking at ${to}…`;
      body = (
        <div className="move-wait" role="status">
          <Spinner />
          <p>
            {picked?.provider === 'local' || DEMO
              ? 'Checking what’s there.'
              : `If a ${companyName(picked?.provider)} window opened, sign in there${picked?.other ? ' with the account to take your vault to' : ''}. Then Secure Box checks what’s in ${to}.`}
          </p>
        </div>
      );
      foot = (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            controller.current?.abort();
            setStep('choose');
          }}
        >
          Back
        </button>
      );
      break;
    case 'ready':
      title = `${verb} your vault to ${to}`;
      body = (
        <>
          <Route origin={origin} dest={plan.dest} />
          <ThereNow plan={plan} keep={keep} setKeep={setKeep} secret={secret} setSecret={setSecret} secretError={secretError} setSecretError={setSecretError} busy={unlocking} />
          <ModeChoice origin={origin} mode={mode} setMode={setMode} plan={plan} busy={unlocking} labelled={['same', 'other'].includes(plan.look.kind) && !plan.compare?.earlierCopy} />
          <SizeLine plan={plan} />
        </>
      );
      foot = (
        <>
          <button type="button" className="btn btn-ghost" disabled={unlocking} onClick={() => setStep('choose')}>
            Back
          </button>
          <button type="button" className={`btn ${replacing ? 'btn-danger' : 'btn-primary'}${unlocking ? ' is-busy' : ''}`} disabled={unlocking || short} onClick={() => go()}>
            <span className="btn-spinner" aria-hidden="true" />
            <span>{replacing ? `Replace it and ${verb.toLowerCase()}` : `${verb} to ${to}`}</span>
          </button>
        </>
      );
      break;
    case 'working':
      title = `${mode === 'move' ? 'Moving' : 'Copying'} to ${to}`;
      body = (
        <>
          <Route origin={origin} dest={plan.dest} />
          <Progress phase={phase} progress={progress} mode={mode} />
          <p className="panel-hint move-keep-open">
            Keep this tab open until it’s done
            {'wakeLock' in navigator ? ': the screen stays on meanwhile' : ''}. Nothing in {from} changes until your vault is safely there.
          </p>
        </>
      );
      foot = (
        <button type="button" className="btn btn-ghost" disabled={['open', 'tidy'].includes(phase)} onClick={() => controller.current?.abort()}>
          Stop
        </button>
      );
      break;
    case 'done': {
      const what = describeContents(result.contents);
      title = mode === 'move' ? `Moved to ${result.label}` : `Copied to ${result.label}`;
      body = (
        <>
          <div className="tool-done move-done">
            <span className="tool-done-icon">
              <Icon name="check" size={18} />
            </span>
            <div>
              <strong>{mode === 'move' ? `Your vault now opens from ${to}.` : `Your vault is still in ${from}, and ${to} has a copy.`}</strong>
              <small>
                {result.combined
                  ? `Combined with the vault that was there: ${what} in all.`
                  : result.updated
                    ? `The earlier copy there is up to date: ${what}.`
                    : `${what[0].toUpperCase()}${what.slice(1)}.`}{' '}
                {mode === 'copy'
                  ? 'Each now changes on its own.'
                  : result.leftover
                    ? ''
                    : origin.provider === 'local'
                      ? `It’s no longer in ${from}.`
                      : `${from[0].toUpperCase()}${from.slice(1)} keeps a note for your other devices of where it went, and its old files are in ${origin.bin}.`}
              </small>
            </div>
          </div>
          {result.ownKey ? (
            <div className="move-there" role="note">
              <Icon name="key" size={16} />
              <p>{mode === 'move' ? 'From now on, your vault' : 'The vault there'} opens with that vault’s own master password and Emergency Kit.</p>
            </div>
          ) : null}
          {result.missing.length ? (
            <div className="move-there is-warn" role="note">
              <Icon name="alert" size={16} />
              <p>
                {result.missing.length === 1
                  ? `“${result.missing[0]}” didn’t come along: its encrypted copy was already missing`
                  : `${result.missing.length} files didn’t come along: their encrypted copies were already missing`}{' '}
                in {result.from}. {result.missing.length === 1 ? 'It’s still listed, but it won’t open.' : 'They’re still listed, but won’t open.'}
              </p>
            </div>
          ) : null}
          {result.leftover ? (
            <div className="move-there is-warn" role="alert">
              <Icon name="alert" size={16} />
              <p>
                The old copy in {result.from} couldn’t be cleared: {result.leftover.message.replace(/\.$/, '')}. Your vault is safe in {to}.
              </p>
            </div>
          ) : null}
        </>
      );
      foot = (
        <>
          {result.leftover ? (
            <button type="button" className={`btn btn-ghost${retrying ? ' is-busy' : ''}`} disabled={retrying} onClick={tidyAgain}>
              <span className="btn-spinner" aria-hidden="true" />
              <span>Clear it again</span>
            </button>
          ) : null}
          {mode === 'copy' && plan.dest.provider !== origin.provider ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                close(true);
                switchVault(plan.dest.provider);
              }}
            >
              Open the copy
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => close(true)}>
            Done
          </button>
        </>
      );
      break;
    }
    case 'stopped':
      title = 'Stopped';
      body = (
        <>
          <p className="panel-text">
            Nothing was {mode === 'move' ? 'moved' : 'copied'}: your vault is in {from}, as it was.{clearedNote}
          </p>
          <p className="panel-hint">Try again to pick up where it stopped. Close removes what was copied to {to} so far.</p>
        </>
      );
      foot = (
        <>
          <button type="button" className="btn btn-ghost" onClick={giveUp}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={() => go()}>
            Try again
          </button>
        </>
      );
      break;
    default: {
      const err = problem?.err;
      const expired = err?.code === 'expired';
      const side = err?.side === 'from' ? origin.provider : plan?.dest.provider || picked?.provider;
      title = problem?.at === 'look' ? `Couldn’t open ${to}` : `The ${mode === 'move' ? 'move' : 'copy'} stopped`;
      body = (
        <>
          <p className="panel-text">
            {expired
              ? `The ${companyName(side)} sign-in ran out. Sign in again to go on.`
              : err?.code === 'quota'
                ? `${to[0].toUpperCase()}${to.slice(1)} is full.`
                : err?.code === 'popup-blocked'
                  ? err.message
                  : err?.message || 'Something went wrong.'}
          </p>
          {problem?.at === 'transfer' ? (
            <p className="panel-hint">
              Nothing in {from} changed.{clearedNote} Try again to pick up where it stopped. Close removes what was copied to {to} so far.
            </p>
          ) : null}
        </>
      );
      foot = (
        <>
          <button type="button" className="btn btn-ghost" onClick={problem?.at === 'transfer' ? giveUp : () => close(null)}>
            Close
          </button>
          {problem?.at === 'look' ? (
            <button type="button" className="btn btn-primary" onClick={() => look(picked)}>
              Try again
            </button>
          ) : expired ? (
            <button type="button" className={`btn btn-primary${retrying ? ' is-busy' : ''}`} disabled={retrying} onClick={signInAgain}>
              <span className="btn-spinner" aria-hidden="true" />
              <span>Sign in again</span>
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => go()}>
              Try again
            </button>
          )}
        </>
      );
    }
  }

  return (
    <Modal onDismiss={() => (working ? null : close(step === 'done' ? true : null))} className="dialog move-dialog" labelledBy="move-title" busy={working}>
      <div className="dialog-body">
        <h2 id="move-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <div className="move-body" aria-live="polite">
          {body}
        </div>
      </div>
      <div className="dialog-foot">{foot}</div>
    </Modal>
  );
}
