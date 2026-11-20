# Secure Box

An end-to-end encrypted vault for **passwords, secret notes and files**, with built-in viewers and players.

- **Your data stays with you.** Your vault lives encrypted in your own Google Drive or OneDrive, or only on your device. The web host only serves the app's files.
- **One master password for all your vaults.** Keep a vault in each place if you like: they share one master key, and you switch between them without typing your password again.
- **Free to host.** The app is a handful of static files on Firebase Hosting (recommended) or Amazon S3, with no servers or databases.
- **Locked by your master password.** It is never stored or sent anywhere. An offline Emergency Kit lets you reset it if you forget it.
- **Built-in viewers.** Photos, video, audio, PDF, Word, Excel, PowerPoint, OpenDocument, Markdown, CSV, plain text and code all open inside Secure Box. Files are decrypted as they stream, and nothing is written to disk.
- **Works on phones and tablets.** The layout adapts to any screen, with finger-sized controls and touch gestures in the viewer.
- **Tools too.** Encrypt files into `.sbox` files and text into messages, to keep or to share.
- **Open source.** The code is public under the GNU AGPL v3, so anyone can check exactly what it does. See [License](#license).

```
 Web host ───static files only──►  your browser  ◄──sign-in──  accounts.google.com
 (Firebase or S3)                  (all encryption           ┌──────────────────────────┐
                                    happens here)  ◄──────►  │ Google Drive / Secure Box │
                                                             │  Key Ring.json  (locked)  │
                                                             │  Vault.json     (cipher)  │
                                                             │  Encrypted files/  blobs  │
                                                             └──────────────────────────┘
```

Try it with sample data that never leaves your browser tab:

```bash
npm run dev
```

Then open http://localhost:8080/index.html?demo. The demo master password is `secure box demo vault`, and it's filled in for you.

---

## Security model

| What | Stored as | Who can read it |
|---|---|---|
| Master password | Nowhere; only in your head | You |
| Master key (256-bit) | The key ring, **encrypted** twice: with your master password, and with your Emergency Kit's recovery key. Each vault keeps a copy (`Secure Box Key Ring.json` in a cloud, `keyring.json` on a device) | Someone who can reach a vault **and** knows your master password or has your Emergency Kit |
| Passwords, notes, file names, folders | `Secure Box Vault.json` in a cloud (`index.json` on a device), encrypted | Same as above |
| Files | `Encrypted files/<random id>` in a cloud (`files/<id>` on a device), one opaque blob per file | Same as above |

**Master password.** It is stretched with PBKDF2-SHA-256 (600,000 rounds) into a key that unlocks the master key, which stays in memory only while unlocked. Changing your password re-locks the master key without re-encrypting anything else.

**Emergency Kit.** It holds a random 256-bit recovery key that can also unlock the master key. If you make a new kit, the old one stops working immediately.

**Key ring.** The key ring is the file that holds your master key, locked twice: once with your master password and once with your Emergency Kit. On its own it opens nothing. All your vaults share one master key, so each keeps a copy of the same key ring.
- Every change (a new master password, a new Emergency Kit) gives the key ring a higher revision number, signed with the master key itself. An old copy can't be passed off as newer.
- Whenever Secure Box can reach two copies (the open vault, this device's vault, a cloud signed in this session), the newest one replaces the older ones. After a change, the other vaults pick it up the next time you open them here.
- If you unlock a vault that still has an older key ring, your new master password works when this device's vault already has the newer one.

**Vault.** The vault is encrypted with AES-256-GCM. Every save uses a brand-new key derived from the master key with HKDF and a fresh salt. Its size is padded with the Padmé scheme, so the file size gives little away.

**Files.** Every file gets its own random 256-bit key, which lives only inside the encrypted vault. Files are encrypted in 1 MiB chunks, using the same streaming scheme as Google's Tink library.
- Each chunk is authenticated, so any tampering, truncation, reordering or swapping of files is detected.
- Sizes are padded (at most about 12% extra).
- Photo and video thumbnails are made on your device and encrypted inside the same blob. They stay hidden unless you turn on the **Thumbnails** switch; until then, none are fetched or decrypted.

**This device.** A vault kept only on your device is encrypted exactly like a cloud vault, with the same key ring. Its vault file is sealed with a key of its own purpose (HKDF), so it can never pass for a cloud vault, or the other way round. Nothing in it is ever uploaded.

**Files encrypted on your device (`.sbox`).** **⋯ → Encrypt files to .sbox** turns files, or a folder, into `.sbox` files without uploading anything. A folder becomes a single `.sbox` with a ZIP inside.
- Each `.sbox` gets its own random 256-bit key and uses the same chunked AES-256-GCM format as your Drive files, so tampering and truncation are detected.
- The file's header keeps that key only in locked copies: one for your account, locked with a key derived from your master key (HKDF), and optionally one for a sharing password (PBKDF2-SHA-256, 600,000 rounds). Your account's copy keeps working after a password change or an Emergency Kit reset.
- The name, size and date are encrypted inside. With **Hide file names** on, the `.sbox` file itself gets a random name. What shows from outside is the padded size, that it's a Secure Box file, and whether it has a sharing password.
- A key ring backup (**⋯ → Key ring backup**) opens your `.sbox` files on any device, together with your master password or Emergency Kit.

**Encrypted messages.** **⋯ → Encrypt or decrypt text** turns text into a short block starting with `-----BEGIN SECURE BOX MESSAGE-----`, to paste into a chat or an email. It uses the same design as `.sbox` files: a random key, kept in a copy for your account and optionally one for a sharing password. Everything around the text is authenticated, and its length is padded.

**Streaming without disk.** A service worker (`sw.js`), a small background script your browser runs for Secure Box, decrypts each file chunk by chunk as it streams in, using byte ranges so seeking works: straight from Google Drive or OneDrive, or from the Secure Box page a few MiB at a time for a vault on this device. Decrypted data is marked `no-store`, and nothing is written to the browser's storage. Only an explicit **Download** saves a file.

**The page itself.**
- A strict Content-Security-Policy, and Trusted Types that allow exactly one script URL: the service worker.
- No third-party JavaScript, fonts or images.
- It refuses to run inside a frame.
- Every document is rendered with safe DOM calls, never as raw HTML.
- On Firebase Hosting the policy is also sent as HTTP headers, together with HSTS, `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, a cross-origin opener policy and `no-referrer` (see `firebase.json`). S3 can't send these headers, so there the page relies on its built-in policy.

**Sign-in.**
- Google sign-in uses only the `drive.file` scope, so Secure Box can see the files it created and nothing else in your Drive.
- Google's access lasts one hour. After that you click **Reconnect** once, and your vault stays unlocked. One reconnect serves every open Secure Box window.
- Once you've signed in on a browser, Secure Box reconnects to Google by itself when you open it, so only your master password is asked. It remembers only which Google account you used. To switch, choose **Use a different Google account** on the unlock screen.

**Session.** Secure Box auto-locks after 10 minutes of inactivity. Locking reloads the page, which drops every key and secret from memory. Copied passwords are cleared from the clipboard after 30 seconds.

**Several windows.** The Secure Box windows and tabs of one browser share a single unlocked session:
- A new window opens already unlocked while another one is unlocked, and unlocking one window unlocks the others that are waiting.
- Activity in any window counts, and locking or auto-lock locks every window together.
- The key passes between windows in memory only, over a browser channel that only Secure Box's own pages can use. It is never written to disk.
- Once every window is closed or locked, the next one asks for your master password again.

**What Google can see:** that you store some encrypted blobs, with their approximate sizes and when they change. Google never sees names, folders, contents or keys.

**What the web host (Firebase or AWS) can see:** requests for the static app files. Nothing else.

**Honest caveats**

- **Without your master password *and* your Emergency Kit, your data is gone.** Nobody can recover it, including you. Keep the kit offline, never in Drive or email.
- Use a strong master password and protect your Google account with 2-Step Verification. An attacker needs both.
- Like any web app, Secure Box can't protect you from malware on your device or a malicious browser extension. Your browser's own process memory may also be paged out by the operating system.
- Sign-in uses Google's OpenID Connect *implicit* flow, which needs no Google script in the page. Google still documents this flow but calls it legacy. If they ever retire it, only `app/assets/google.js` needs to change.
- Secure Box hasn't had an independent security audit yet. To report a problem, see [SECURITY.md](SECURITY.md).

## What it costs

| Service | Monthly cost |
|---|---|
| Firebase Hosting, free Spark plan (≈ 300 KB of static files) | $0; includes 10 GB of storage and 360 MB of downloads a day, and needs no billing account |
| *or* Amazon S3 (the same files, a few requests per visit) | ≈ $0.00 (within the free tier) |
| Google Drive | Free; uses your normal Drive quota (15 GB on a free account) |
| Google Cloud OAuth client and Drive API | Free |

The web host never touches your data, and nothing bills by the hour.

---

## Setup

Pick a host. **Firebase Hosting** is recommended: it's free, serves HTTPS on its own address, and sends the full set of security headers. **Amazon S3** works too. Your data is the same either way, because it lives in Google Drive.

**You need:**
- a Google account;
- Windows PowerShell 5.1 or PowerShell 7;
- for Firebase: [Node.js](https://nodejs.org/) 20 or later, for the Firebase CLI;
- for S3: an AWS account, with the [AWS CLI v2](https://aws.amazon.com/cli/) signed in to it.

### 1. Choose where the app lives

| Host | App address | JavaScript origin(s) for Google |
|---|---|---|
| Firebase | `https://<site>.web.app/index.html` | `https://<site>.web.app` and `https://<site>.firebaseapp.com` |
| S3 | `https://<bucket>.s3.<region>.amazonaws.com/index.html` | `https://<bucket>.s3.<region>.amazonaws.com` |

`<site>` is your Firebase Hosting site name. It is usually the project ID, but Firebase sometimes shortens it, so the deploy script looks it up and prints the exact addresses.

**Firebase.** In the [Firebase console](https://console.firebase.google.com/), create a project. You can add Firebase to the Google Cloud project that holds (or will hold) your OAuth client, so everything lives in one place. The free Spark plan is enough. Then open **Hosting** and click **Get started** once. You can skip the steps it shows, because the deploy script does them.

**S3.** Create a bucket in the S3 console, or let the deploy script create one. Names in the console's *account regional namespace* work well, for example `securebox-123456789012-ap-southeast-1-an`. Use no dots in the name, so HTTPS works. S3's "static website hosting" endpoints are HTTP-only, and browsers only allow encryption and Google sign-in over HTTPS. That's why Secure Box uses the bucket's HTTPS endpoint, and you don't need CloudFront.

### 2. Create a Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project**, or pick the one your Firebase project lives in.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **Google Auth Platform → Get started:** enter an app name (for example "Secure Box") and your email, and choose the **External** audience.
4. **Data access:** add the `.../auth/drive.file` scope. It is non-sensitive, so no verification is needed.
5. **Clients → Create client → Web application:**
   - **Authorized JavaScript origins:** the origin(s) from the table above, plus `http://localhost:8080` for local testing.
   - **Authorized redirect URIs:** each of those origins followed by `/index.html`, plus `http://localhost:8080/index.html`.
6. Copy the **Client ID**.

**Who can sign in** is set under **Audience**:
- While the app is in *Testing*, only the test users you add there can sign in (up to 100), and Google may ask them to re-approve weekly.
- **Publish** the app to let anyone with a Google account use it. Each person's data still stays in their own Drive.

### 3. Deploy

**Firebase Hosting.** Install the Firebase CLI and sign in once:

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

Then deploy:

```bash
.\deploy-firebase.ps1 -Project <project-id> -GoogleClientId <client-id>
```

The script writes `app/assets/config.json`, then runs `firebase deploy` with the security headers from `firebase.json`.

**Amazon S3.**

```bash
aws login
```

```bash
.\deploy.ps1 -Bucket <bucket> -GoogleClientId <client-id>
```

The S3 script:
- creates or adopts the bucket;
- allows public reading of `index.html`, `sw.js` and `assets/*` only;
- writes `app/assets/config.json` and uploads the app.

Both scripts remember their settings in `deploy.settings.json`, so later deploys are just `.\deploy-firebase.ps1` or `.\deploy.ps1`.

If Windows refuses to run scripts, use this form instead. It applies to that one run and doesn't change any settings:

```bash
powershell -ExecutionPolicy Bypass -File .\deploy-firebase.ps1
```

### 4. First sign-in

1. Open the app URL → **Continue with Google**.
2. **Create your master password.** Use 12+ characters; a short sentence only you would think of works well. Don't save it in your browser.
3. **Download your Emergency Kit** and keep it offline: print it, or put it on a USB stick.

### Moving from S3 to Firebase

Your vault, files and Emergency Kit live in Google Drive, so nothing needs copying.

1. Do the Firebase parts of steps 1 and 3. `deploy-firebase.ps1` reuses the client ID that `deploy.ps1` remembered, so `.\deploy-firebase.ps1 -Project <project-id>` is enough.
2. Add the Firebase origins and redirect URIs to your **existing** OAuth client (step 2, item 5). Keep using that client: Google lets Secure Box see only the files created through its own Google Cloud project, so a client from another project would find no vault.
3. Open `https://<site>.web.app/`, sign in, and unlock with your usual master password.
4. Preferences such as grid or list view and the Thumbnails switch are remembered per address, so set them again once.
5. When you're happy, retire the S3 copy: remove the S3 address from the OAuth client, empty the bucket, delete the CloudFormation stack, then delete the bucket if it's still there.

---

## Using Secure Box

**Where your vault lives.** The first time, Secure Box asks where to keep your vault:
- **Google Drive** or **OneDrive** (recommended): on all your devices, and safe if you lose one.
- **Only on this device**: no account needed, but nothing syncs, so you back it up yourself.

After that, Secure Box opens the vault you used last. The name next to **Passwords** and **Files** says which one is open. Click it to switch to another: a cloud asks you to sign in once, a new place is set up with your current master password, and you never type the password again to switch. Each vault keeps its own passwords and files.

Your browser's **Back** and **Forward** buttons move between tabs and folders, close the viewer, and on phones close an open password.

**Passwords**
- Logins and secure notes, with a password generator. **New** is at the top of the list.
- Copy buttons that clear the clipboard after 30 seconds.
- Import and export CSV from Chrome, Firefox, Bitwarden, 1Password, LastPass and others, from the **⋯** button at the top of the list.

**Files**
- **Upload** several files at once with the Upload button, or a whole folder with **Upload folder** (browsers allow one folder per pick). To upload several folders, or folders and files together, drag them onto the window. Their folder structure is kept.
- While uploading, the panel shows the whole batch at a glance (files done, data done and one progress bar), and the browser tab's title shows the percentage. Fold the file list away with the arrow.
- Only files uploaded through Secure Box are encrypted. A file you put into the `Secure Box` folder in Google Drive yourself stays as it is, unencrypted. Secure Box can't even see it, because Google only lets it see the files it created. Upload files through Secure Box instead.
- **Organise** with folders, breadcrumbs, grid or list view, sorting, and search across every folder.
- **Select** several items with Ctrl/⌘-click or Shift-click, then Download, Move or Delete them together.
- **Download** a single file as itself. Several items, folders included, download as one **.zip** that keeps their folders, and a folder's ⋯ menu has **Download as .zip**. The ZIP is built and decrypted while it downloads, so it never sits in memory, and your browser shows its real size and progress.
- **Move** items by dragging them onto a folder or a breadcrumb.
- **Thumbnails** are off by default. Turn on the **Thumbnails** switch above your files to see previews of photos and videos. Secure Box makes them on your device when you upload, so they're ready whenever you switch them on.
- **Viewer:** use ← and → to move through a folder, or swipe left and right on a phone or tablet.
  - **Images:** zoom with + and −, Ctrl/⌘ + scroll, or a double-click; press R to rotate. On touch screens, pinch to zoom, double-tap to zoom in or back out, and drag to move around.
  - **Video and audio:** players with seeking.
  - **Documents:** an inline PDF viewer, and reader views for Word, Excel, PowerPoint, OpenDocument, RTF, Markdown, CSV and JSON. Chrome on Android can't show a PDF inside a page, so there PDFs offer **Open** (in a new tab) and **Download** instead.
  - **Text and code:** text files open as a clean page, like other documents. Switch on **Monospace** for a fixed-width font; code and config files start in monospace, and your choice is remembered. Files without a known extension, such as `README` or `LICENSE`, are checked and shown as plain text when they contain text.
  - Formats your browser can't play natively (for example `.mkv` or `.heic` in Chrome) offer a download instead.

**Keyboard**
- <kbd>/</kbd>: search
- <kbd>N</kbd>: new item, or new folder in Files
- <kbd>U</kbd>: upload
- <kbd>Backspace</kbd>: go up a folder
- <kbd>Delete</kbd>: delete the selection
- <kbd>Ctrl</kbd>+<kbd>A</kbd>: select all

**Menu (⋯)**
- Sync now
- For a vault on this device: **Back up this vault**, **Restore a backup…**, and for a folder, **Stop using this folder…**
- **Change master password** (your Emergency Kit keeps working)
- **New Emergency Kit** (the old one stops working)
- **Key ring backup** (below)
- **Tools:** encrypt files to `.sbox`, decrypt `.sbox` files, encrypt or decrypt text (below)

**A vault on this device**

Passwords and files kept only here: nothing is uploaded. It works like a cloud vault and opens with the same master password.
- **Where it lives.** In Chrome and Edge on a computer, and in Chrome on Android, you choose:
  - **In this browser** (the only choice elsewhere, such as Firefox, Safari and any browser on iPhone and iPad): the browser's private storage for Secure Box.
  - **In a folder you choose**: ordinary encrypted files you can see and copy. It can be a synced folder, such as OneDrive, Dropbox or iCloud Drive. The browser asks once per visit before Secure Box may open it.
- **Keeping it safe in the browser.** The browser deletes this storage if someone clears this site's data, or uninstalls the browser. It may also clear it by itself when space runs low, unless it grants Secure Box *persistent storage*. Browsers decide that themselves, and usually agree for an installed app (see [Install as an app](#install-as-an-app)). The bar above your files shows whether it's protected, and has **Protect** to ask again.
- **On iPhone and iPad** a vault on this device works only in the Secure Box app on your Home Screen. Safari deletes the data of websites you haven't opened for 7 days, and only Home Screen apps are safe from that.
- **Back up** saves the whole vault as one `.zip`, exactly as stored and still encrypted, so you can keep it anywhere. The bar reminds you when it's out of date.
- **Restore a backup.** On a new phone or computer, choose **Keep it only on this device → Restore a backup…** on the first screen, then unlock with your master password. In an open vault, **⋯ → Restore a backup…** adds back whatever is missing.
- **Files put in by hand.** If someone copies plain files into a folder vault's `Secure Box` folder, the bar lists them and offers **Encrypt them**. Each one is encrypted into the vault, and then the unencrypted original is deleted.

**Tools (⋯ menu)**

These work on your computer or phone and upload nothing.
- **Encrypt files:** choose files or a folder. Each file becomes its own `.sbox`, and a folder becomes one `.sbox`. Your originals aren't changed: delete them yourself once you've checked the encrypted copies.
  - In Chrome and Edge on a computer, and in Chrome on Android, you pick a folder to save into, and big files are written a piece at a time.
  - Other browsers save the results as downloads. Each one is put together in memory first, so very large files may not fit, especially on phones.
- **Hide file names** is on by default and gives each `.sbox` a random name.
- **Add a sharing password** lets someone without your account open the files: they go to Secure Box, choose **Open a .sbox file** on the sign-in screen, and enter the password. Send the password separately from the files. Your own account can always open them too.
- **Decrypt .sbox files:** files made with your account open straight away. Others ask for their sharing password, or for the key ring backup of the account that made them. A folder is unpacked into the folder you choose, or downloaded as a `.zip`.
- **Encrypt text:** type or paste text and press **Encrypt** to get a message block to paste anywhere. Paste a message block instead, and the button turns into **Decrypt**. Add a sharing password, and someone without an account can read it with **Read a message** on the sign-in screen.
- **Key ring backup:** saves a copy of your key ring: your master key, locked with your master password and Emergency Kit. With it you can open your `.sbox` files and messages on any device, and start a new vault with the same master password (**Already have a Secure Box vault? Use the same master password** when you create one). Keep it private: it keeps opening with the master password and Emergency Kit you have on the day you export it, even after you change them.

### Install as an app

Secure Box can be installed like an app. It opens in its own window, and browsers are more willing to keep a vault on this device safe.
- **Chrome or Edge on a computer:** the install icon in the address bar, or the browser menu → **Install Secure Box**.
- **Android:** the Chrome menu → **Add to Home screen** or **Install app**.
- **iPhone and iPad:** in Safari, **Share → Add to Home Screen**.

## Recovery

| Problem | Fix |
|---|---|
| Forgot the master password | On the unlock screen, choose **Forgot master password?**, load your Emergency Kit, then set a new password. |
| Lost the Emergency Kit | While unlocked, use **⋯ → New Emergency Kit**. |
| Deleted a Secure Box file in Drive | Restore it from Google Drive's trash (kept for 30 days). |
| A bad change to the vault | In Drive, right-click `Secure Box Vault.json` → **Manage versions** and download an earlier version. |
| No access to Google Drive, but you need your `.sbox` files | On the sign-in screen, choose **Open a .sbox file**, load your key ring backup, and enter your master password or Emergency Kit recovery key. |
| The vault on this device is gone (site data cleared, new phone) | On the first screen, choose **Keep it only on this device → Restore a backup…** with your latest backup, then unlock with your master password. |
| Lost both the master password and the Emergency Kit | The data can't be recovered. That's the point of the encryption. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `redirect_uri_mismatch` | The redirect URI must be exactly the app's address, for example `https://<site>.web.app/index.html`. Every address you use (web.app, firebaseapp.com, S3) needs its own origin and redirect URI. |
| The Google Cloud console won't save a new origin | If it asks you to add the domain to the authorized domains list, add it under Google Auth Platform → Branding → Authorized domains (for example `<site>.web.app`), then save the client again. |
| Google shows "Access blocked" | Add that Gmail address under Google Auth Platform → Audience → Test users, or publish the app. |
| "Turn on the Google Drive API" | Enable it in the Cloud project and wait a minute. |
| "Reconnect Google Drive" appears | Normal after an hour: one click, and your vault stays unlocked. Allow pop-ups for the site. |
| A video won't play | The browser doesn't support that codec. Download it, or convert it to MP4 (H.264) or WebM. |
| `firebase.ps1 cannot be loaded` | PowerShell is blocking npm's script wrapper. Run `firebase.cmd login` instead; the deploy script already uses `firebase.cmd`. |
| Firebase deploy fails: not signed in, or project not found | Run `firebase login`. Check the project ID under Firebase console → Project settings, and open Hosting → Get started once. |
| S3 deploy fails: account blocks public bucket policies | Under S3 → *Block Public Access settings for this account*, turn off the two "bucket policies" options. Only the app files become public. |

## Development

```bash
npm run dev
```

```bash
npm test
```

- `npm run dev` serves `app/` at http://localhost:8080. Add `?demo` to the URL for the in-memory demo.
- `npm test` runs 43 unit tests, covering the key ring and its revisions, encryption formats, `.sbox` files, encrypted messages, the local vault's index key and backups, tamper detection, streaming range decryption, ZIP reading and writing (including ZIP64), XML, document readers, text detection, CSV, and OneDrive reads, streaming addresses, folders and uploads (against a stand-in for OneDrive).

```
app/
  index.html            markup + Content-Security-Policy
  sw.js                 service worker: streaming decryption, Range requests, no caching
  assets/
    app.js              controller: unlock, master password, sections, saving, auto-lock
    keyring.js          master password + Emergency Kit (PBKDF2, recovery key)
    vault.js            vault envelope, items, folders/files index, CSV
    crypto.js           AES-GCM, HKDF, Padmé padding, password generator
    fileformat.js       chunked AES-256-GCM file format + upload piece writer
    stream-core.js      random-access decryption shared with the service worker
    zip-core.js         streaming ZIP writer (CRC-32, ZIP64) used by the service worker
    stream.js           starts the service worker and builds its file URLs
    backend.js          cloud storage: Google Drive and OneDrive (key ring, vault, encrypted files)
    google.js           sign-in, reconnect pop-up, Drive REST calls
    files-view.js       file manager: grid/list, thumbnails, uploads, move, rename, delete
    localbox.js         .sbox format: account and sharing-password key copies, folder boxes
    localstore.js       the vault on this device: browser storage or a chosen folder, backups, files put in by hand
    textbox.js          encrypted text messages
    local-tools.js      tools: .sbox files and messages
    microsoft.js        Microsoft sign-in and OneDrive calls
    filetypes.js        file types and which viewer opens what
    viewer.js           full-screen viewer and players
    readers.js          Word/Excel/PowerPoint/OpenDocument/RTF/Markdown/CSV/text readers
    zip.js, xml.js      dependency-free ZIP and XML parsing
    thumbs.js           local thumbnail generation
    ui.js               icons, toasts, dialogs, clipboard
    demo.js             in-memory backend for ?demo
firebase.json           Firebase Hosting: files to publish + security headers
deploy-firebase.ps1     one-command Firebase deploy
infra/template.yaml     CloudFormation: the bucket and its policy
deploy.ps1              one-command S3 deploy
tests/                  node --test suite
```

## Removing Secure Box

1. Take the app offline. **Firebase:** run `firebase hosting:disable --project <project-id>`, or delete the Firebase project. **S3:** empty the bucket, delete the CloudFormation stack, then delete the bucket if it's still there.
2. Each person can delete the `Secure Box` folder from their Drive. Export anything they need first.
3. Remove the app's access at myaccount.google.com → Security → Third-party connections.

## Contributing and security

Bug reports and ideas are welcome as issues; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, as [SECURITY.md](SECURITY.md) explains.

## License

Copyright (C) 2026 [CybermindDBS](https://github.com/CybermindDBS)

Secure Box is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

If you let other people use a changed copy, for example by hosting it, the license asks you to offer them its source code. Point the **Source code** link in the app's ⋯ menu at your version.

For other license terms, open an issue.
