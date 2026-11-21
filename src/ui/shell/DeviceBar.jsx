import { backupDevice, backupState, encryptStrays, protectDevice } from '../../session/device.js';
import { relativeTime } from '../../session/io.js';
import { isDevice } from '../../session/places.js';
import { state } from '../../session/store.js';
import { Icon, Spinner } from '../common/Icon.jsx';
import { useVersion } from '../hooks.js';
import { run } from '../run.js';

/**
 * The bar under the tabs for the vault on this device: where it's kept (as precisely as a
 * browser allows, #11), whether the browser protects it, backups, files put in by hand.
 */
export function DeviceBar() {
  useVersion();
  if (!state.unlocked || !isDevice() || state.switching) return null;
  const { backend, device } = state;
  const backup = backupState();
  const strays = device.strays;
  return (
    <div className="local-status vault-status">
      <div className="local-status-row">
        <span className="local-where">
          <Icon name={backend.where === 'folder' ? 'folder' : 'device'} size={16} />
          {backend.where === 'folder' ? (
            <span>
              Kept in <strong>“{backend.name}”</strong> › Secure Box
              <span className="local-where-why" title="Browsers never tell websites where a folder is on your disk, only its name.">
                <Icon name="info" size={14} label="Browsers never tell websites where a folder is on your disk, only its name." />
              </span>
            </span>
          ) : (
            <span>Kept in this browser</span>
          )}
        </span>
        {device.protection === 'protected' ? <span className="local-pill is-ok">Won’t be cleared automatically</span> : null}
        {device.protection === 'unprotected' ? (
          <>
            <span className="local-pill is-warn">The browser may clear it when space runs low</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(protectDevice)}>
              <Icon name="shield" size={16} />
              <span>Protect</span>
            </button>
          </>
        ) : null}
        {device.busy ? (
          <span className="local-busy" role="status">
            <Spinner small />
            <span>{device.busy}</span>
          </span>
        ) : backup && !backup.empty ? (
          <>
            <span className={`local-pill${backup.stale ? ' is-warn' : ''}`}>{backup.at ? `Backed up ${relativeTime(backup.at)}` : 'Not backed up yet'}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(backupDevice)}>
              <Icon name="download" size={16} />
              <span>Back up</span>
            </button>
          </>
        ) : null}
      </div>
      {strays.length ? (
        <div className="local-status-row local-strays">
          <Icon name="alert" size={16} />
          <span>
            {strays.length === 1 ? 'An unencrypted file is' : `${strays.length} unencrypted files are`} in this vault’s folder:{' '}
            {strays.slice(0, 3).map((s) => s.name).join(', ')}
            {strays.length > 3 ? ` and ${strays.length - 3} more` : ''}
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => run(encryptStrays)}>
            <Icon name="lock" size={16} />
            <span>Encrypt them</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
