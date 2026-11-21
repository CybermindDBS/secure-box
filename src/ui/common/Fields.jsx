import { useState } from 'react';
import { passwordStrength } from '../../core/keyring.js';
import { Icon } from './Icon.jsx';

// Password managers shouldn't offer to save (or fill) the master password and secrets typed here.
const NO_AUTOFILL = { autoComplete: 'off', autoCapitalize: 'off', spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': true };

/**
 * A password field with a Show button, and a subtle "Caps Lock is on" while it is (#18).
 * `onCaps` tells the form, so an error about a wrong password can mention it too.
 */
export function PasswordInput({ id, label, value, onChange, onEnter, autoFocus = false, mono = false, reveal = true, placeholder, hint, onCaps, disabled = false, invalid = false }) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const check = (event) => {
    const on = Boolean(event.getModifierState?.('CapsLock'));
    if (on !== caps) {
      setCaps(on);
      onCaps?.(on);
    }
  };
  return (
    <div className="field">
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className="input-group">
        <input
          id={id}
          className={`input${mono ? ' mono' : ''}`}
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          data-autofocus={autoFocus || undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            check(event);
            if (event.key === 'Enter' && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
          onKeyUp={check}
          onMouseDown={check}
          onBlur={() => {
            setCaps(false);
            onCaps?.(false);
          }}
          {...NO_AUTOFILL}
        />
        {reveal ? (
          <div className="input-tools">
            <button type="button" className="icon-btn" aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)} disabled={disabled}>
              <Icon name={shown ? 'eyeOff' : 'eye'} />
            </button>
          </div>
        ) : null}
      </div>
      {caps ? (
        <p className="caps-hint" role="status">
          <Icon name="capsLock" size={14} />
          Caps Lock is on
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

/** A plain text field with the same look. */
export function TextInput({ id, label, value, onChange, onEnter, autoFocus = false, mono = false, placeholder, type = 'text', inputMode, maxLength, disabled = false }) {
  return (
    <div className="field">
      {label ? <label htmlFor={id}>{label}</label> : null}
      <input
        id={id}
        className={`input${mono ? ' mono' : ''}`}
        type={type}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        disabled={disabled}
        data-autofocus={autoFocus || undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        {...NO_AUTOFILL}
      />
    </div>
  );
}

export function StrengthMeter({ password }) {
  const { score, label } = passwordStrength(password);
  return (
    <div className="meter" data-score={String(score)}>
      <span className="meter-bar">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="meter-label">{label}</span>
    </div>
  );
}

/**
 * What went wrong, under a form. After a wrong master password it also says when Caps Lock is on,
 * or when the password starts or ends with a space (#18).
 */
export function FormError({ error, code = '', caps = false, value = '' }) {
  if (!error) return null;
  const wrong = code === 'wrong-password';
  const notes = [];
  if (wrong && caps) notes.push('Caps Lock is on.');
  if (wrong && /^\s|\s$/.test(value)) notes.push('It starts or ends with a space — is that right?');
  return (
    <p className="form-error" role="alert">
      {error}
      {notes.length ? <span className="form-error-note"> {notes.join(' ')}</span> : null}
    </p>
  );
}

export function Check({ checked, onChange, children, hint, disabled = false }) {
  return (
    <label className="check box-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {children}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
