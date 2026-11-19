/**
 * Tools menu: encrypt files and folders on this device into .sbox boxes (localbox.js), and
 * decrypt them again. Nothing is uploaded.
 *
 * Where the browser allows it (Chrome and Edge on computers), results are written straight into
 * a folder you pick, a piece at a time. Elsewhere they are saved as downloads, which means each
 * result is assembled in memory first.
 */
import { generatePassword } from './crypto.js';
import { formatBytes } from './filetypes.js';
import { KeyringError, parseKeyring, passwordProblem, unlockWithPassword, unlockWithRecovery } from './keyring.js';
import { BOX_EXTENSION, boxAccess, openContent, readBox, unlockBox, writeBox, zipEntries, zipEntryData, zipFolder } from './localbox.js';
import { looksLikeMessage, messageAccess, openMessage, readMessage, sealText } from './textbox.js';
import { $, copyText, downloadFile, h, icon, toast } from './ui.js';

const canPickFolder = () => typeof window.showDirectoryPicker === 'function';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percent = (p) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;

/** A file or folder name that's valid on Windows, macOS and Linux. */
function safeName(name, fallback = 'file') {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

const randomName = () => `${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}${BOX_EXTENSION}`;

/** A name not yet used in `dir`: "name", then "name (2).ext", "name (3).ext"… */
async function freeName(dir, name, kind = 'file') {
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    try {
      await (kind === 'file' ? dir.getFileHandle(candidate) : dir.getDirectoryHandle(candidate));
    } catch (err) {
      if (err.name === 'NotFoundError') return candidate;
      if (err.name !== 'TypeMismatchError') throw err; // a folder with that name, or the other way round
    }
  }
}

/** Writes one file into a picked folder; a failed write leaves nothing half-written behind. */
async function writeToFolder(dir, name, produce) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await produce((bytes) => writable.write(bytes));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw err;
  }
}

async function collect(produce) {
  const parts = [];
  await produce((bytes) => {
    parts.push(bytes);
  });
  return new Blob(parts);
}

/** Opens the browser's file picker. */
function pickFiles({ folder = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, hidden: true });
    if (folder) input.webkitdirectory = true;
    const finish = () => {
      resolve([...(input.files || [])]);
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    document.body.append(input);
    input.click();
  });
}

/** A key ring backup opens with its master password, or with its Emergency Kit's recovery key. */
async function unlockBackup(doc, secret) {
  try {
    return await unlockWithPassword(doc, secret);
  } catch (err) {
    if (!(err instanceof KeyringError)) throw err;
  }
  try {
    return await unlockWithRecovery(doc, secret);
  } catch {
    throw new Error('That master password or recovery key doesn’t open this key ring backup.');
  }
}

/**
 * `master()` returns the unlocked account's master key, or null on the sign-in screen
 * ("Open a .sbox file" works without an account, using a sharing password or a key ring backup).
 */
export function createLocalTools({ master }) {
  let busy = false;
  let controller = null;
  let selection = null; // what to encrypt
  let boxes = []; // what to decrypt: { file, box } or { file, error }
  let backup = null; // a key ring backup: { doc, name }

  function setBusy(dialog, on) {
    busy = on;
    const go = dialog.querySelector('.dialog-foot .btn-primary');
    go.disabled = on;
    go.classList.toggle('is-busy', on);
    for (const el of dialog.querySelectorAll('.dialog-body button, .dialog-body input, .dialog-body textarea')) el.disabled = on;
    controller = on ? new AbortController() : null;
  }

  function setStatus(id, text) {
    const el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
  }

  // Closing a dialog while it works cancels the work.
  for (const id of ['#box-encrypt', '#box-decrypt', '#text-dialog']) {
    $(id).addEventListener('cancel', () => controller?.abort());
    $(id).addEventListener('close', () => controller?.abort());
  }
  // Text typed or decrypted here doesn't stay in the page once the dialog closes.
  $('#text-dialog').addEventListener('close', () => {
    for (const id of ['#text-input', '#text-output', '#text-password', '#text-confirm', '#text-open-password']) $(id).value = '';
  });

  // -------------------------------------------------------------------------
  // Text: encrypt a message, or read one
  // -------------------------------------------------------------------------
  let resultIsSecret = false;

  const textMode = () => (looksLikeMessage($('#text-input').value) ? 'decrypt' : 'encrypt');

  function updateTextMode() {
    const mode = textMode();
    const key = master();
    let needPassword = false;
    if (mode === 'decrypt') {
      try {
        const access = messageAccess(readMessage($('#text-input').value), key);
        needPassword = !access.mine && access.password;
      } catch {
        /* the error shows when they press Decrypt */
      }
    }
    $('#text-go-label').textContent = mode === 'decrypt' ? 'Decrypt' : 'Encrypt';
    $('#text-encrypt-options').hidden = mode !== 'encrypt' || !key;
    $('#text-password-field').hidden = !needPassword;
    setStatus('#text-note', mode === 'encrypt' && !key ? 'Unlock Secure Box to encrypt text. A message with a sharing password can be read without unlocking.' : '');
    $('#text-result').hidden = true;
    setStatus('#text-error', '');
  }

  function openText() {
    for (const id of ['#text-input', '#text-output', '#text-password', '#text-confirm', '#text-open-password']) $(id).value = '';
    for (const id of ['#text-password', '#text-confirm']) $(id).type = 'password';
    $('#text-share').checked = false;
    $('#text-share-fields').hidden = true;
    $('#text-title').textContent = master() ? 'Encrypt or decrypt text' : 'Read a message';
    updateTextMode();
    $('#text-dialog').showModal();
    $('#text-input').focus();
  }

  function showResult(label, value, encrypted) {
    resultIsSecret = !encrypted;
    $('#text-result-label').textContent = label;
    $('#text-output').value = value;
    $('#text-output').classList.toggle('mono', encrypted);
    $('#text-share-out').hidden = !encrypted || typeof navigator.share !== 'function';
    $('#text-result').hidden = false;
  }

  async function runText() {
    const dialog = $('#text-dialog');
    setStatus('#text-error', '');
    const value = $('#text-input').value;
    const key = master();
    if (textMode() === 'decrypt') {
      let message;
      try {
        message = readMessage(value);
      } catch (err) {
        return setStatus('#text-error', err.message);
      }
      const access = messageAccess(message, key);
      const password = $('#text-open-password').value;
      const accountOnly = key ? 'This message was encrypted with a different Secure Box account.' : 'This message opens only in the Secure Box account that made it.';
      if (!access.mine && !password) return setStatus('#text-error', access.password ? 'Enter the sharing password.' : accountOnly);
      setBusy(dialog, true);
      try {
        showResult('Decrypted text', await openMessage(message, { master: access.mine ? key : null, password }), false);
      } catch (err) {
        setStatus('#text-error', err.code === 'other-account' ? accountOnly : err.message);
      } finally {
        setBusy(dialog, false);
      }
      return;
    }
    if (!key) return setStatus('#text-error', 'Unlock Secure Box to encrypt text.');
    if (!value.trim()) return setStatus('#text-error', 'Type or paste the text to encrypt.');
    let password = '';
    if ($('#text-share').checked) {
      password = $('#text-password').value;
      const problem = passwordProblem(password, $('#text-confirm').value);
      if (problem) return setStatus('#text-error', problem);
    }
    setBusy(dialog, true);
    try {
      const armored = await sealText({ text: value, master: key, password });
      showResult(password ? 'Encrypted: opens with your account or the sharing password' : 'Encrypted: opens only with your account', armored, true);
    } catch (err) {
      setStatus('#text-error', err.message);
    } finally {
      setBusy(dialog, false);
    }
  }

  // -------------------------------------------------------------------------
  // Encrypt
  // -------------------------------------------------------------------------
  function openEncrypt() {
    if (!master()) throw new Error('Unlock Secure Box first.');
    selection = null;
    setStatus('#box-selection', '');
    setStatus('#box-encrypt-status', '');
    setStatus('#box-encrypt-error', '');
    $('#box-hide-names').checked = true;
    $('#box-share').checked = false;
    $('#box-share-fields').hidden = true;
    for (const id of ['#box-password', '#box-confirm']) {
      $(id).value = '';
      $(id).type = 'password';
    }
    $('#box-encrypt-note').textContent = canPickFolder()
      ? 'You’ll choose a folder to save the encrypted .sbox files in. The originals stay as they are: delete them yourself once you’ve checked the encrypted copies.'
      : 'The encrypted .sbox files are saved to your downloads. The originals stay as they are: delete them yourself once you’ve checked the encrypted copies.';
    $('#box-encrypt').showModal();
  }

  async function chooseForEncrypt(folder) {
    const files = await pickFiles({ folder });
    if (!files.length) return;
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (folder) {
      const top = safeName(files[0].webkitRelativePath.split('/')[0], 'Folder');
      // Names that some systems can't store (a ":" from a Mac, say) are tidied so they unpack anywhere.
      const paths = files.map((f) => (f.webkitRelativePath || `${top}/${f.name}`).split('/').map((part) => safeName(part)).join('/'));
      const dirs = new Set();
      for (const path of paths) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
      }
      const items = [...[...dirs].sort().map((path) => ({ path, dir: true })), ...files.map((file, i) => ({ path: paths[i], file })).sort((a, b) => (a.path < b.path ? -1 : 1))];
      selection = { kind: 'folder', name: top, items, count: files.length };
      setStatus('#box-selection', `Folder “${top}” · ${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`);
    } else {
      selection = { kind: 'files', files };
      setStatus('#box-selection', files.length === 1 ? `${files[0].name} · ${formatBytes(bytes)}` : `${files.length} files · ${formatBytes(bytes)}`);
    }
    setStatus('#box-encrypt-error', '');
  }

  async function runEncrypt() {
    const dialog = $('#box-encrypt');
    const key = master();
    if (!key) throw new Error('Unlock Secure Box first.');
    setStatus('#box-encrypt-error', '');
    if (!selection) return setStatus('#box-encrypt-error', 'Choose files or a folder first.');
    let password = '';
    if ($('#box-share').checked) {
      password = $('#box-password').value;
      const problem = passwordProblem(password, $('#box-confirm').value);
      if (problem) return setStatus('#box-encrypt-error', problem);
    }
    const hide = $('#box-hide-names').checked;
    let target = null;
    if (canPickFolder()) {
      try {
        target = await window.showDirectoryPicker({ id: 'secure-box-encrypted', mode: 'readwrite' });
      } catch (err) {
        if (err.name === 'AbortError') return;
        target = null; // not allowed here: fall back to downloads
      }
    }
    const jobs = selection.kind === 'folder' ? [{ ...selection }] : selection.files.map((file) => ({ kind: 'file', name: file.name, file }));
    setBusy(dialog, true);
    const { signal } = controller;
    let done = 0;
    try {
      for (const job of jobs) {
        const step = jobs.length > 1 ? `${done + 1} of ${jobs.length} · ` : '';
        let source = job.file;
        let meta = { kind: 'file', name: job.name, type: job.file?.type || '', mtime: job.file?.lastModified };
        if (job.kind === 'folder') {
          source = await zipFolder(job.items, { signal, onProgress: (p) => setStatus('#box-encrypt-status', `Reading “${job.name}”… ${percent(p)}`) });
          meta = { kind: 'folder', name: job.name, type: 'application/zip', mtime: Date.now(), files: job.count };
        }
        const name = hide ? randomName() : `${safeName(job.name)}${BOX_EXTENSION}`;
        const produce = (write) =>
          writeBox({ source, meta, master: key, password, write, signal, onProgress: (p) => setStatus('#box-encrypt-status', `${step}Encrypting “${job.name}”… ${percent(p)}`) });
        if (target) await writeToFolder(target, await freeName(target, name), produce);
        else {
          downloadFile(name, await collect(produce), 'application/octet-stream');
          await pause(400); // let the browser start each download
        }
        done++;
      }
      setBusy(dialog, false);
      dialog.close();
      const what = selection.kind === 'folder' || done === 1 ? `“${jobs[0].name}”` : `${done} files`;
      toast(`Encrypted ${what}${target ? ` into “${target.name}”` : ''}${password ? ', with a sharing password' : ''}`);
    } catch (err) {
      setBusy(dialog, false);
      setStatus('#box-encrypt-status', '');
      const finished = done ? ` (${done} of ${jobs.length} finished)` : '';
      setStatus('#box-encrypt-error', err?.name === 'AbortError' ? `Stopped${finished}.` : `${err.message || err}${finished}`);
    }
  }

  // -------------------------------------------------------------------------
  // Decrypt
  // -------------------------------------------------------------------------
  function openDecrypt() {
    boxes = [];
    backup = null;
    $('#box-list').replaceChildren();
    $('#box-list').hidden = true;
    $('#box-password-field').hidden = true;
    $('#box-keyring').hidden = true;
    $('#box-open-password').value = '';
    $('#box-master').value = '';
    setStatus('#box-keyring-name', '');
    setStatus('#box-decrypt-status', '');
    setStatus('#box-decrypt-error', '');
    $('#box-decrypt-title').textContent = master() ? 'Decrypt .sbox files' : 'Open .sbox files';
    $('#box-decrypt-note').textContent = canPickFolder()
      ? 'You’ll choose a folder to save the decrypted files in.'
      : 'Decrypted files are saved to your downloads; a folder comes out as a .zip.';
    $('#box-decrypt').showModal();
  }

  const needsBackupText = () => (master() ? 'Made with another Secure Box account: load its key ring backup' : 'Needs the key ring backup of the account that made it');

  /** Why a box didn't open, in the words of its row. */
  function failureText(err) {
    if (err?.code === 'other-account') return needsBackupText();
    if (err?.code === 'needs-password') return 'Needs its sharing password';
    return err?.message || String(err);
  }

  /** How each chosen file will open (or why it didn't), and which extra fields that needs. */
  function renderBoxes() {
    const key = master();
    let needPassword = false;
    let needBackup = false;
    $('#box-list').replaceChildren(
      ...boxes.map(({ file, box, error, failure }) => {
        let text = error;
        let tone = 'error';
        if (box) {
          const access = boxAccess(box, key);
          if (access.mine) [text, tone] = ['Opens with your account', 'ok'];
          else if (backup && boxAccess(box, { kid: backup.doc.kid }).mine) [text, tone] = ['Opens with your key ring backup', 'ok'];
          else if (access.password) {
            [text, tone] = ['Needs its sharing password', 'info'];
            needPassword = true;
          } else {
            [text, tone] = [needsBackupText(), 'info'];
            needBackup = true;
          }
          if (failure) [text, tone] = [failure, 'error'];
        }
        return h('li', { class: 'box-item' }, icon('file', 16), h('span', { class: 'box-item-name', text: file.name }), h('span', { class: `box-item-state is-${tone}`, text }));
      }),
    );
    $('#box-list').hidden = !boxes.length;
    $('#box-password-field').hidden = !needPassword;
    $('#box-keyring').hidden = !needBackup && !backup;
  }

  async function chooseBoxes() {
    const files = await pickFiles();
    if (!files.length) return;
    boxes = [];
    for (const file of files) {
      try {
        boxes.push({ file, box: await readBox(file) });
      } catch (err) {
        boxes.push({ file, error: err.message });
      }
    }
    setStatus('#box-decrypt-error', '');
    renderBoxes();
  }

  async function chooseBackup() {
    const [file] = await pickFiles();
    if (!file) return;
    for (const entry of boxes) entry.failure = '';
    try {
      backup = { doc: parseKeyring(await file.text()), name: file.name };
      setStatus('#box-keyring-name', `Using ${file.name}`);
      setStatus('#box-decrypt-error', '');
    } catch (err) {
      backup = null;
      setStatus('#box-keyring-name', '');
      setStatus('#box-decrypt-error', `That isn’t a Secure Box key ring backup (${err.message})`);
    }
    renderBoxes();
  }

  /** Unpacks a folder box into `target`. If anything fails, what was unpacked so far is removed. */
  async function extractFolder(content, target, onProgress) {
    const entries = await zipEntries(content);
    const total = entries.reduce((n, e) => n + e.size, 0) || 1;
    let done = 0;
    const created = []; // what this run added to `target` itself
    const dirs = new Map([['', target]]);
    const dirFor = async (path) => {
      if (dirs.has(path)) return dirs.get(path);
      const cut = path.lastIndexOf('/');
      const parentPath = cut < 0 ? '' : path.slice(0, cut);
      const parent = await dirFor(parentPath);
      let name = safeName(path.slice(cut + 1), 'Folder');
      if (!parentPath) {
        name = await freeName(parent, name, 'dir'); // never merge into an existing folder
        created.push(name);
      }
      const handle = await parent.getDirectoryHandle(name, { create: true });
      dirs.set(path, handle);
      return handle;
    };
    try {
      for (const entry of entries) {
        const path = entry.path.replace(/\/$/, '');
        if (entry.dir) {
          await dirFor(path);
          continue;
        }
        const cut = path.lastIndexOf('/');
        const dir = await dirFor(cut < 0 ? '' : path.slice(0, cut));
        const name = await freeName(dir, safeName(path.slice(cut + 1)));
        if (dir === target) created.push(name);
        await writeToFolder(dir, name, async (write) => {
          for await (const bytes of zipEntryData(content, entry)) {
            await write(bytes);
            done += bytes.length;
            onProgress(done / total);
          }
        });
      }
    } catch (err) {
      for (const name of created) await target.removeEntry(name, { recursive: true }).catch(() => {});
      throw err;
    }
  }

  async function runDecrypt() {
    const dialog = $('#box-decrypt');
    setStatus('#box-decrypt-error', '');
    const ready = boxes.filter((b) => b.box);
    if (!ready.length) return setStatus('#box-decrypt-error', 'Choose .sbox files first.');
    const key = master();
    const password = $('#box-open-password').value;
    const secret = $('#box-master').value;
    let backupKey = null;
    if (backup) {
      if (!secret) return setStatus('#box-decrypt-error', 'Enter the master password or recovery key for the key ring backup.');
      try {
        backupKey = await unlockBackup(backup.doc, secret);
      } catch (err) {
        return setStatus('#box-decrypt-error', err.message);
      }
    }

    // Nothing to open with: say what's missing instead of failing every file.
    const opensWith = ({ box }) => (key && boxAccess(box, key).mine) || (backupKey && boxAccess(box, backupKey).mine) || (password && boxAccess(box, null).password);
    if (!ready.some(opensWith)) {
      const wantsPassword = ready.some(({ box }) => boxAccess(box, null).password);
      return setStatus('#box-decrypt-error', wantsPassword && !password ? 'Enter the sharing password.' : 'Load the key ring backup of the account that made these files.');
    }

    let target = null;
    if (canPickFolder()) {
      try {
        target = await window.showDirectoryPicker({ id: 'secure-box-decrypted', mode: 'readwrite' });
      } catch (err) {
        if (err.name === 'AbortError') return;
        target = null;
      }
    }
    for (const entry of boxes) entry.failure = '';
    setBusy(dialog, true);
    const { signal } = controller;
    let failed = 0;
    let done = 0;
    let stopped = false;
    let lastName = '';
    for (const [i, entry] of ready.entries()) {
      const { file, box } = entry;
      const step = ready.length > 1 ? `${i + 1} of ${ready.length} · ` : '';
      const progress = (p) => setStatus('#box-decrypt-status', `${step}Decrypting ${file.name}… ${percent(p)}`);
      try {
        const account = key && boxAccess(box, key).mine ? key : backupKey && boxAccess(box, backupKey).mine ? backupKey : null;
        const unlocked = await unlockBox(box, { master: account, password });
        const content = await openContent(file, box, unlocked);
        const { meta } = unlocked;
        const produce = async (write) => {
          for await (const bytes of content.stream({ signal, onProgress: progress })) await write(bytes);
        };
        if (meta.kind === 'folder') {
          if (target) await extractFolder(content, target, progress);
          else downloadFile(`${safeName(meta.name, 'Folder')}.zip`, await collect(produce), 'application/zip');
        } else {
          const name = safeName(meta.name);
          if (target) await writeToFolder(target, await freeName(target, name), produce);
          else downloadFile(name, await collect(produce), meta.type || 'application/octet-stream');
        }
        if (!target) await pause(400);
        entry.done = true;
        lastName = meta.name;
        done++;
      } catch (err) {
        if (err?.name === 'AbortError') {
          stopped = true;
          break;
        }
        entry.failure = failureText(err);
        failed++;
      }
    }
    // What's left in the list is what still needs doing.
    boxes = boxes.filter((b) => !b.done);
    setBusy(dialog, false);
    setStatus('#box-decrypt-status', '');
    renderBoxes();
    if (failed || stopped) {
      const parts = [];
      if (done) parts.push(`${done} decrypted.`);
      if (failed) parts.push(failed === 1 ? 'One file didn’t open: see the list.' : `${failed} files didn’t open: see the list.`);
      if (stopped) parts.push('Stopped.');
      setStatus('#box-decrypt-error', parts.join(' '));
      return;
    }
    dialog.close();
    toast(`Decrypted ${done === 1 ? `“${lastName}”` : `${done} files`}${target ? ` into “${target.name}”` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  $('#box-share').addEventListener('change', (event) => {
    $('#box-share-fields').hidden = !event.target.checked;
    if (event.target.checked) $('#box-password').focus();
  });
  $('#text-share').addEventListener('change', (event) => {
    $('#text-share-fields').hidden = !event.target.checked;
    if (event.target.checked) $('#text-password').focus();
  });
  $('#text-input').addEventListener('input', () => updateTextMode());
  $('#text-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runText();
    }
  });
  for (const id of ['#text-confirm', '#text-open-password']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runText();
      }
    });
  }

  const generateInto = (ids) => {
    const value = generatePassword({ length: 24 });
    for (const id of ids) {
      $(id).value = value;
      $(id).type = 'text';
    }
    $(ids[0]).select();
    toast('Strong password generated. Copy it now to share it.');
  };
  // A new password is a new try: drop the old "didn't open" marks.
  for (const id of ['#box-open-password', '#box-master']) {
    $(id).addEventListener('input', () => {
      if (!boxes.some((b) => b.failure)) return;
      for (const entry of boxes) entry.failure = '';
      renderBoxes();
    });
  }

  return {
    busy: () => busy,
    actions: {
      'box-encrypt-open': () => openEncrypt(),
      'box-decrypt-open': () => openDecrypt(),
      'box-pick-files': () => chooseForEncrypt(false),
      'box-pick-folder': () => chooseForEncrypt(true),
      'box-generate': () => generateInto(['#box-password', '#box-confirm']),
      'text-generate': () => generateInto(['#text-password', '#text-confirm']),
      'text-open': () => openText(),
      'text-go': () => runText(),
      'text-close': () => (busy ? controller?.abort() : $('#text-dialog').close()),
      'text-copy': async () => {
        await copyText($('#text-output').value, { sensitive: resultIsSecret });
        toast(resultIsSecret ? 'Copied. It’s cleared from the clipboard in 30 seconds.' : 'Copied');
      },
      'text-share-out': () => navigator.share({ text: $('#text-output').value }).catch((err) => err.name === 'AbortError' || toast(err.message, 'error')),
      'box-encrypt-go': () => runEncrypt(),
      'box-encrypt-cancel': () => (busy ? controller?.abort() : $('#box-encrypt').close()),
      'box-pick-boxes': () => chooseBoxes(),
      'box-pick-keyring': () => chooseBackup(),
      'box-decrypt-go': () => runDecrypt(),
      'box-decrypt-cancel': () => (busy ? controller?.abort() : $('#box-decrypt').close()),
    },
  };
}
