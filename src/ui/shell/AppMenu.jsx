import { ask } from '../../session/bridge.js';
import { lockWhenAsked, syncNow } from '../../session/cloud.js';
import { backupDevice, deleteDevice, forgetDeviceFolder, restoreDevice } from '../../session/device.js';
import { openMoveVault } from '../../session/migrate.js';
import { exportKeyring, newEmergencyKit } from '../../session/passwords.js';
import { isDevice, vaultLabel } from '../../session/places.js';
import { Icon } from '../common/Icon.jsx';
import { Menu, MenuItem, MenuSeparator } from '../common/Menu.jsx';
import { useSession } from '../hooks.js';
import { run } from '../run.js';

/** The ⋯ menu: the open vault, the key ring (master password, Emergency Kit, backup), lock. */
export function AppMenu() {
  useSession((s) => s.provider);
  useSession((s) => s.backend);
  const switching = useSession((s) => Boolean(s.switching));
  const device = isDevice();
  const where = useSession((s) => s.backend?.where);
  return (
    <Menu
      label="More"
      button={(props) => (
        <button {...props} type="button" className="icon-btn" aria-label="More" title="More" disabled={switching}>
          <Icon name="more" />
        </button>
      )}
    >
      <div className="menu-head">
        <span className="menu-label">Open vault</span>
        <span className="menu-email">{vaultLabel()}</span>
      </div>
      <MenuItem icon={<Icon name="refresh" />} onSelect={() => run(() => syncNow())}>
        Sync now
      </MenuItem>
      <MenuItem icon={<Icon name="move" />} onSelect={() => run(openMoveVault)}>
        Move or copy this vault…
      </MenuItem>
      {device ? (
        <>
          {where === 'browser' ? (
            <MenuItem icon={<Icon name="download" />} onSelect={() => run(backupDevice)}>
              Back up this vault
            </MenuItem>
          ) : null}
          <MenuItem icon={<Icon name="upload" />} onSelect={() => run(restoreDevice)}>
            Restore a backup…
          </MenuItem>
          {where === 'folder' ? (
            <MenuItem icon={<Icon name="folder" />} onSelect={() => run(forgetDeviceFolder)}>
              Stop using this folder…
            </MenuItem>
          ) : null}
          <MenuItem icon={<Icon name="trash" />} danger onSelect={() => run(deleteDevice)}>
            Delete this vault…
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={<Icon name="key" />} onSelect={() => run(() => ask('changePassword'))}>
        Change master password…
      </MenuItem>
      <MenuItem icon={<Icon name="shield" />} onSelect={() => run(newEmergencyKit)}>
        New Emergency Kit…
      </MenuItem>
      <MenuItem icon={<Icon name="archive" />} onSelect={() => run(exportKeyring)}>
        Key ring backup…
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Icon name="keyboard" />} onSelect={() => run(() => ask('shortcuts'))}>
        Keyboard shortcuts
      </MenuItem>
      <MenuItem icon={<Icon name="code" />} href="https://github.com/CybermindDBS/secure-box">
        Source code (AGPL-3.0)
      </MenuItem>
      <MenuItem icon={<Icon name="lock" />} onSelect={() => run(lockWhenAsked)}>
        Lock
      </MenuItem>
    </Menu>
  );
}
