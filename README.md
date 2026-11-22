# Secure Box

An end-to-end encrypted vault for **passwords, secret notes and files**, with built-in viewers and players.

- **Your data stays with you.** Your vault lives encrypted in your own Google Drive or OneDrive, or only on your device. The web host only serves the app's files.
- **One master password for all your vaults.** Keep a vault in each place if you like: they share one master key, and you switch between them without typing your password again.
- **Free to host.** The app is a handful of static files on Firebase Hosting, with no servers or databases.
- **Locked by your master password.** It is never stored or sent anywhere. An offline Emergency Kit lets you reset it if you forget it.
- **Built-in viewers.** Photos, video, audio, PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, Markdown, CSV, plain text and code all open inside Secure Box. Files are decrypted as they stream, and nothing is written to disk.
- **Works on phones and tablets.** The layout adapts to any screen, with a tab bar at the bottom on phones, finger-sized controls and touch gestures in the viewer and the file manager.
- **Encrypt & decrypt, with or without a vault.** A tab of its own turns files into `.sbox` files and text into messages, to keep or to share with a password. Anyone can open what you send them there, no account needed; with your vault open, your master password opens everything you encrypt too.
- **Open source.** The code is public under the GNU AGPL v3, so anyone can check exactly what it does. See [License](#license).

```
 Web host ───static files only──►  your browser  ◄──sign-in──  accounts.google.com
 (Firebase Hosting)                (all encryption           ┌──────────────────────────┐
                                    happens here)  ◄──────►  │ Google Drive / Secure Box │
                                                             │  Key Ring.json  (locked)  │
                                                             │  Vault.json     (cipher)  │
                                                             │  Encrypted files/  blobs  │
                                                             └──────────────────────────┘
```

Try it with sample data that never leaves your browser tab:

```bash
npm install
npm run dev
```

Then open http://localhost:8080/?demo. The demo master password is `secure box demo vault`, and it's filled in for you.

---

## Security model

| What | Stored as | Who can read it |
|---|---|---|
| Master password | Nowhere; only in your head | You |
| Master key (256-bit) | The key ring, **encrypted** twice: with your master password, and with your Emergency Kit's recovery key. Each vault keeps a copy, `Secure Box Key Ring.json` | Someone who can reach a vault **and** knows your master password or has your Emergency Kit |
| Passwords, notes, file names, folders | `Secure Box Vault.json`, encrypted | Same as above |
| Files | `Encrypted files/<random id>`, one opaque blob per file | Same as above |

A vault is the same wherever it lives (Google Drive, OneDrive, or this device): the same three parts, under the same names, in the same format. The vault names each file's encrypted copy itself and never records a Google Drive or OneDrive file id. Each place finds a copy by that name in its own way: Google Drive by a private tag Secure Box puts on the copy, and OneDrive and this device by its name in the `Encrypted files` folder.

**Master password.** It is stretched with PBKDF2-SHA-256 (600,000 rounds) into a key that unlocks the master key, which stays in memory only while unlocked. Changing your password re-locks the master key without re-encrypting anything else.

**Emergency Kit.** It holds a random 256-bit recovery key that can also unlock the master key. If you make a new kit, the old one stops working immediately.

**Key ring.** The key ring is the file that holds your master key, locked twice: once with your master password and once with your Emergency Kit. On its own it opens nothing. All your vaults share one master key, so each keeps a copy of the same key ring.
- Every change (a new master password, a new Emergency Kit) gives the key ring a higher revision number, signed with the master key itself together with the time of the change. An old copy can't be passed off as newer, and two copies changed apart (on two devices while offline) settle on the later change, the same way everywhere.
- A change is always made on top of the newest copy Secure Box can read, and other Secure Box windows are told about it, so a change in one window never undoes one made in another.
- Whenever Secure Box can reach two copies (the open vault, this device's vault, a cloud signed in this session), the newest one replaces the older ones. After a change, the other vaults pick it up the next time you open them here.
- If you unlock a vault that still has an older key ring, your new master password works when this device's vault already has the newer one. Otherwise Secure Box says that this vault still has your previous master password (it remembers when you changed it, nothing secret): enter that once, and the vault takes the new one.

**Vault.** The vault is encrypted with AES-256-GCM. Every save uses a brand-new key derived from the master key with HKDF and a fresh salt. Its size is padded with the Padmé scheme, so the file size gives little away.
- Saves from several devices or windows don't overwrite each other. A save is made on top of the newest vault, and a change carries only what it changes (a name, a folder, the fields you edited), so another device's edits to the rest stay. Google Drive can't refuse a write that comes second, so after each save Secure Box checks Drive's revision history; if another device saved at the same moment, it saves again on top of that.

**Files.** Every file gets its own random 256-bit key, which lives only inside the encrypted vault. Files are encrypted in 1 MiB chunks, using the same streaming scheme as Google's Tink library.
- Each chunk is authenticated, so any tampering, truncation, reordering or swapping of files is detected.
- Sizes are padded (at most about 12% extra).
- Photo and video thumbnails are made on your device and encrypted inside the same blob. Turn off **Thumbnails** (under **View**) to hide them: while it's off, none are fetched or decrypted.
- A `.txt` file edited in Secure Box is saved the same way: the new text is encrypted in memory with a fresh key into a new copy, which replaces the old one, and the old copy is deleted.

**This device.** A vault kept only on your device is encrypted exactly like a cloud vault, with the same key ring. Its vault file is sealed with a key of its own purpose (HKDF), so it can never pass for a cloud vault, or the other way round. Nothing in it is ever uploaded.

**Files encrypted on your device (`.sbox`).** The **Encrypt & decrypt** tab turns files, or a folder, into `.sbox` files without uploading anything. A folder becomes a single `.sbox` with a ZIP inside. It works with no vault and no account at all.
- Each `.sbox` gets its own random 256-bit key and uses the same chunked AES-256-GCM format as your Drive files, so tampering and truncation are detected.
- The file's header keeps that key only in locked copies: one for your account (when a vault is open), locked with a key derived from your master key (HKDF), and one for a password (PBKDF2-SHA-256, 600,000 rounds). Each file gets a salt of its own, even among files encrypted together with one password, so nothing in them shows they belong together. The deliberately slow derivation then runs once per file, when encrypting and when opening. Without a vault, the password is required and is the only way in. Your account's copy keeps working after a password change or an Emergency Kit reset.
- The name, size and date are encrypted inside. With **Hide file names** on, the `.sbox` file itself gets a random name. What shows from outside is the padded size, that it's a Secure Box file, and whether it has a password.
- Opening one: files made with any vault unlocked this session open straight away; others ask for their password. One made with your vault while it's locked offers **Unlock your vault**, which brings you back to the tab with the file ready to open. A key ring backup (**⋯ → Key ring backup**) opens your `.sbox` files on any device, together with your master password or Emergency Kit.

**Encrypted messages.** The same tab's **Text** side turns text into a short block starting with `-----BEGIN SECURE BOX MESSAGE-----`, to paste into a chat or an email (pasting one switches it to **Decrypt** by itself). It uses the same design as `.sbox` files: a random key, kept in a copy for your account and/or one for a password. Everything around the text is authenticated, and its length is padded.

**Streaming without disk.** A service worker (`sw.js`), a small background script your browser runs for Secure Box, decrypts each file chunk by chunk as it streams in, using byte ranges so seeking works: straight from Google Drive or OneDrive, or from the Secure Box page a few MiB at a time for a vault on this device. Decrypted data is marked `no-store`, and nothing is written to the browser's storage. Only an explicit **Download** saves a file.

**What runs where.** Encryption uses the browser's own WebCrypto, which works off the page on a thread of its own: about a gigabyte a second for AES-GCM on a laptop, far faster than any network. Chrome runs all of a page's WebCrypto on that one thread, workers included, so more threads wouldn't make it faster. A small pool of workers (one per spare CPU core, up to four) reads documents for the viewer, makes photo thumbnails, and packs folders and backups into ZIPs, so the page stays responsive. With a cloud, the slow part is waiting on the network, so Secure Box keeps several requests going at once:
- three uploads (two for a vault on this device)
- three copies when moving or copying a vault
- up to four small files fetched ahead while a ZIP downloads

**The page itself.**
- A strict Content-Security-Policy (the same in development and in the build, and checked before every deploy), and Trusted Types that allow exactly Secure Box's own script URLs: the service worker and its workers.
- Built with React and Vite from a locked list of dependencies (React, PDF.js and the Vite build tool), installed with `npm ci --ignore-scripts`. React renders through DOM calls only: a test fails if anything in `src/` could turn text into markup or code.
- No third-party JavaScript, fonts or images are loaded from anywhere else: everything comes from Secure Box's own address.
- It refuses to run inside a frame.
- Every document is rendered with safe DOM calls, never as raw HTML.
- On Firebase Hosting the policy is also sent as HTTP headers, together with HSTS, `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, a cross-origin opener policy and `no-referrer` (see `firebase.json`).

**Sign-in.**
- Google sign-in uses only the `drive.file` scope, so Secure Box can see the files it created and nothing else in your Drive.
- Google's access lasts one hour. After that you click **Reconnect** once, and your vault stays unlocked. One reconnect serves every open Secure Box window.
- OneDrive sign-in uses Microsoft's authorization code flow with PKCE, and asks only for `Files.ReadWrite.AppFolder`: Secure Box sees its own folder (`Apps/Secure Box`) and nothing else. Access is renewed in the background for up to 24 hours, Microsoft's limit for apps in a browser; then you sign in once more.
- Once you've signed in on a browser, Secure Box signs in again by itself when you open it, so only your master password is asked. It remembers only which account you used. To switch, choose **Use a different Google account** (or Microsoft account) on the unlock screen.
- If you close a sign-in pop-up without signing in, Secure Box notices and takes you back to where you were.

**Session.** Secure Box auto-locks after 10 minutes of inactivity, and after 8 hours in any case. Locking reloads the page, which drops every key and secret from memory. Copied passwords are cleared from the clipboard after 30 seconds.
- Uploads, downloads and work on the vault on this device (a move, backup or restore) still running, in any window, hold both automatic locks until they finish. A download that has moved no data for two minutes stops counting, and an upload paused until you reconnect doesn't hold the lock: it stops with it, and the unlock screen says so.
- **Lock** asks first while anything is unfinished (uploads, paused ones included, downloads, or work on the vault on this device), since locking stops it.
- Locks go by the computer's clock. If the clock is set back, Secure Box counts from the new time, so a lock is never put off until the clock catches up.

**Several windows.** The Secure Box windows and tabs of one browser share a single unlocked session:
- A new window opens already unlocked while another one is unlocked, and unlocking one window unlocks the others that are waiting.
- Activity in any window counts, and locking or auto-lock locks every window together.
- The key passes between windows in memory only, over a browser channel that only Secure Box's own pages can use. It is never written to disk.
- Once every window is closed or locked, the next one asks for your master password again.

**What Google or Microsoft can see:** that you store some encrypted blobs, with their approximate sizes and when they change. Neither sees names, folders, contents or keys.

**What the web host (Firebase Hosting) can see:** requests for the static app files. Nothing else.

**Honest caveats**

- **Without your master password *and* your Emergency Kit, your data is gone.** Nobody can recover it, including you. Keep the kit offline, never in Drive or email.
- Use a strong master password and protect your Google or Microsoft account with two-step verification. An attacker needs both.
- Like any web app, Secure Box can't protect you from malware on your device or a malicious browser extension. Your browser's own process memory may also be paged out by the operating system.
- Sign-in uses Google's OpenID Connect *implicit* flow, which needs no Google script in the page. Google still documents this flow but calls it legacy. If they ever retire it, only `src/core/google.js` needs to change.
- Secure Box reaches your cloud through its own Google Cloud project and Microsoft app registration. Google lets it see only the files it made itself, and OneDrive's `Apps/Secure Box` folder belongs to the app. Run under another project or registration, it finds no vault, although yours is still there.
- OneDrive files are read first through Microsoft Graph's `contentStream`, which is still in beta, then through download links (which Microsoft is retiring) or the `/content` redirect. Those download addresses are allowed by name in the Content-Security-Policy, so a new Microsoft download domain needs an update there.
- Secure Box hasn't had an independent security audit yet. To report a problem, see [SECURITY.md](SECURITY.md).

## What it costs

| Service | Monthly cost |
|---|---|
| Firebase Hosting, free Spark plan (about 5 MB of static files, most of it PDF.js, which loads only when a PDF needs it) | $0; includes 10 GB of storage and 360 MB of downloads a day, and needs no billing account |
| Google Drive or OneDrive | Free; uses your normal quota (15 GB on a free Google account, 5 GB on a free Microsoft account) |
| Google Cloud OAuth client and Drive API, Microsoft app registration | Free |

The web host never touches your data, and nothing bills by the hour.

---

## Setup

Secure Box is hosted on **Firebase Hosting**: it's free, serves HTTPS on its own address, and sends the full set of security headers. It only serves the app's files: your data lives in Google Drive, OneDrive or on your device.

**You need:**
- a Google account (and, to offer OneDrive, a Microsoft account);
- Windows PowerShell 5.1 or PowerShell 7;
- [Node.js](https://nodejs.org/) 22 or later, for the build and the Firebase CLI.

### 1. Create a Firebase project

| App address | JavaScript origins for Google |
|---|---|
| `https://<site>.web.app/index.html` | `https://<site>.web.app` and `https://<site>.firebaseapp.com` |

`<site>` is your Firebase Hosting site name. It is usually the project ID, but Firebase sometimes shortens it, so the deploy script looks it up and prints the exact addresses.

In the [Firebase console](https://console.firebase.google.com/), create a project. You can add Firebase to the Google Cloud project that holds (or will hold) your OAuth client, so everything lives in one place. The free Spark plan is enough. Then open **Hosting** and click **Get started** once. You can skip the steps it shows, because the deploy script does them.

### 2. Create a Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project**, or pick the one your Firebase project lives in.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **Google Auth Platform → Get started:** enter an app name (for example "Secure Box") and your email, and choose the **External** audience.
4. **Data access:** add the `.../auth/drive.file` scope. It is non-sensitive, so no verification is needed.
5. **Clients → Create client → Web application:**
   - **Authorized JavaScript origins:** both origins from the table above, plus `http://localhost:8080` for local testing.
   - **Authorized redirect URIs:** each of those origins followed by `/index.html`, plus `http://localhost:8080/index.html`.
6. Copy the **Client ID**.

Keep using the same client once you have vaults: Google lets Secure Box see only the files created through its own Google Cloud project, so a client from another project would find no vault.

**Who can sign in** is set under **Audience**:
- While the app is in *Testing*, only the test users you add there can sign in (up to 100), and Google may ask them to re-approve weekly.
- **Publish** the app to let anyone with a Google account use it. Each person's data still stays in their own Drive.

### 3. Add OneDrive (optional)

Skip this step to offer Google Drive and **This device** only. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open **App registrations → New registration**:

1. **Name:** for example "Secure Box". **Supported account types:** accounts in any organizational directory *and* personal Microsoft accounts.
2. **Redirect URI:** choose the **Single-page application** platform and enter `https://<site>.web.app/index.html`. Then, under **Authentication**, add `https://<site>.firebaseapp.com/index.html` and `http://localhost:8080/index.html` to the same platform. It must be *Single-page application*, not *Web*: Secure Box finishes signing in from the browser.
3. **API permissions → Add a permission → Microsoft Graph → Delegated permissions:** `Files.ReadWrite.AppFolder`. Sign-in also asks for `openid`, `profile`, `email` and `offline_access`, which need no setup.
4. Copy the **Application (client) ID** for the deploy step.

### 4. Deploy

Install the Firebase CLI and sign in once:

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

With OneDrive, add `-MicrosoftClientId <application-id>`.

The script writes `public/assets/config.json`, builds the app (`npm ci`, `npm run build` with its check), then runs `firebase deploy`, which publishes `dist/` with the security headers from `firebase.json`. It remembers its settings in `deploy.settings.json`, so later deploys are just `.\deploy-firebase.ps1`.

If Windows refuses to run scripts, use this form instead. It applies to that one run and doesn't change any settings:

```bash
powershell -ExecutionPolicy Bypass -File .\deploy-firebase.ps1
```

**Keep the same Google project and Microsoft app.** What Secure Box can see in a cloud depends on the app it connects as. Google Drive shows it only the files its own Google Cloud project made, and OneDrive only its app registration's folder. If either changes, every vault already made looks gone to Secure Box, though nothing is deleted. So:
- Keep the Google Cloud project and the Microsoft app registration once people have vaults, and give each a second owner. A new OAuth client in the same Google project is fine: Google deletes OAuth clients that go unused for six months, and a new one there sees everything the old one did.
- If one is deleted by mistake, restore it within 30 days: a Google project or OAuth client from the Cloud console, a Microsoft app registration from **App registrations → Deleted applications**. Vaults then reappear by themselves (Google says a restored client can take a few days to work again).
- The deploy script refuses a client ID from another Google project, or another Microsoft app registration. To switch on purpose, keep the old one working and run it with `-NewCloudApps`. The old one becomes Secure Box's previous connection: when the new one finds no vault, Secure Box offers **Bring it over**, signs in through the old one too, and copies the vault across exactly as stored. Once everyone's vault is across, run it with `-ForgetPreviousCloudApps`.
- If the old one is gone for good, people can still bring their vault back from the cloud's own website (see [Recovery](#recovery)).

### 5. First sign-in

1. Open the app URL. On the **Vault** tab, choose **Google Drive**, **OneDrive** or **This device**.
2. **Create your master password.** Use 12+ characters; a short sentence only you would think of works well. Don't save it in your browser.
3. **Save your Emergency Kit** and keep it offline: download and print it, or copy the recovery key somewhere safe.

---

## Using Secure Box

**Where your vault lives.** The first time, Secure Box asks where to keep your vault:
- **Google Drive** or **OneDrive** (recommended): on all your devices, and safe if you lose one.
- **This device**: no account needed, but nothing syncs, so you back it up yourself.

**A place with no vault yet** asks one question: **Is this your first Secure Box vault?**
- **Yes, it's my first:** create a master password. It opens this vault and any you add later.
- **No, I already have one:** say where one of your vaults is: Google Drive or OneDrive (it signs in, in a pop-up), this device, or a key ring backup file. Then enter that vault's master password. The new vault shares its master password and Emergency Kit.
- If the other cloud can't be reached, or has no vault for that account, Secure Box says so; choose another of the ways instead.

After that, Secure Box opens the vault you used last. The name next to **Passwords** and **Files** says which one is open. Click it to switch to another: a cloud asks you to sign in once, a new place is set up with your current master password, and you never type the password again to switch. Each vault keeps its own passwords and files.
- **A vault with its own key ring** (set up separately, so it has its own master key even if its password is the same) asks for its own master password when you switch to it, without locking. Both stay open until you lock. The vault menu marks such a vault "own master password".
- **Downloads keep going when you switch.** A download started in one vault finishes after you open another. Uploads belong to their vault, so switching asks first and stops them.
- **Nothing leaves you stuck.** Every error screen has **Open another vault**. If a vault is deleted or moved outside Secure Box (its folder deleted, this site's data cleared, the Secure Box folder put in the Google Drive bin), Secure Box says so and offers the way back:
  - **When you open it:** **Try again** once it's restored from the Recycle Bin, **Find the folder…** if you moved it, **Restore a backup…**, or start over without it. A Google Drive vault in the bin is found there: **Restore it** takes it out, as it was.
  - **While it's open:** saving stops, and one dialog offers **Try again** (once it's restored), **Restore it** (from the Google Drive bin), **Save it again** (writes what's open back: passwords, notes and folders, though not its files) or **Lock**. The change you were making is saved as soon as the vault is back.
  - **When you switch to it:** a vault on this device deleted outside Secure Box (its folder deleted, this site's data cleared) says so, and offers **Set up a new vault**, **Restore a backup…** or, for a folder that was moved, **Find the folder…**. The vault you have open stays open.
  - **From an earlier version** of Secure Box, a vault says so ("This vault is from another version"), in Google Drive, OneDrive or on this device, with how to start over.

**Moving or copying a vault.** **⋯ → Move or copy this vault…** takes the open vault to another place: Google Drive, OneDrive, this device (in this browser, or a folder you choose), or another account of the same cloud.
- **How.** A vault is the same in every place, so Secure Box copies it as it's stored, encrypted the whole way: every file's encrypted copy, then the vault and its key ring. Then it reads it all back from there and checks it.
- **Move or copy.** *Move* opens your vault from the new place, and only then clears the old one. *Copy* keeps both: from then on each changes on its own.
- **The old place after a move.** A cloud keeps a short note of where the vault went, and its files go to its bin (Google Drive and OneDrive keep them 30 days). Your other devices that open it there are told **Your vault moved** and can open it in its new place. On this device, the old copy is deleted.
- **A place that already has a vault** is never lost:
  - *An earlier copy of this vault* (one you copied there before) is brought up to date.
  - *A vault with your master password* that has things of its own: **Combine them** keeps everything in both (where both have the same item or file, the version changed last wins; folders with the same name become one; clashing file names get "(2)"), or **Replace it** sends it to the bin first (on this device it's deleted for good).
  - *A vault with its own master password*: **Combine them** once its master password (or Emergency Kit) opens it. Everything goes into that vault, which then opens with its own master password. Or **Replace it**.
  - *Something that can't be read* (another version of Secure Box, or damaged) can only be replaced.
- **Safe to stop.** Nothing at the old place changes until your vault opens from the new one. If it stops (you press **Stop**, the connection drops, the place is full), **Try again** picks up where it stopped; **Close** removes what was copied so far. Secure Box checks there's enough space first, keeps the screen on while it works, and other Secure Box windows with the vault open lock and open it in its new place when unlocked. If a sign-in runs out on a long transfer, it asks you to sign in again and goes on.
- **Where:** folders can be chosen in Chrome and Edge on a computer, and in Chrome on Android. On iPhone and iPad, a vault on this device works only in the Secure Box app on your Home Screen.

Your browser's **Back** and **Forward** buttons move between tabs and folders, close the viewer, and on phones close an open password.

**Passwords**
- Logins and secure notes, with a password generator. **New** is at the top of the list.
- Copy buttons that clear the clipboard after 30 seconds.
- Import and export CSV from Chrome, Firefox, Bitwarden, 1Password, LastPass and others, from the **⋯** button at the top of the list.

**Files**
- **Upload ▾** sends several files at once (**Files…**, or <kbd>U</kbd>) or a whole folder (**A folder…**; browsers allow one folder per pick). To upload several folders, or folders and files together, drag them onto the window. Their folder structure is kept.
- While uploading, the panel shows the whole batch at a glance (files done, data done and one progress bar), and the browser tab's title shows the percentage. Fold the file list away with the arrow.
- Only files uploaded through Secure Box are encrypted. A file you put into the `Secure Box` folder in Google Drive yourself stays as it is, unencrypted. Secure Box can't even see it, because Google only lets it see the files it created. Upload files through Secure Box instead.
- **Organise** with folders, breadcrumbs and search across every folder. **View** holds grid or list, sorting and thumbnails. When the path and the buttons don't fit side by side, the path moves below them.
- **Open** a file or folder with a click (a tap on a phone or tablet). **Select** items with their checkbox, Ctrl/⌘-click or Shift-click (on a phone, long-press one, then tap more), or by dragging a box around them, then Download, Move or Delete them together. The keys work as in Google Drive; press **?** to see them all.
- **Download** a single file as itself. Several items, folders included, download as one **.zip** that keeps their folders, and a folder's ⋯ menu has **Download as .zip**. The ZIP is built and decrypted while it downloads, so it never sits in memory whole, and your browser shows its real size and progress. Small files are fetched a few at a time ahead of the one being written (holding at most 32 MB), so a ZIP of many small files doesn't wait on the network for each in turn.
- **Move** items by dragging them onto a folder or a breadcrumb.
- **Thumbnails** show previews of photos and videos. Secure Box makes them on your device when you upload. Turn **View → Thumbnails** off to hide them.
- Your view is remembered in this browser: the tab you were on, grid or list, sorting, thumbnails, and the password generator's settings.
- **Viewer:** use ← and → to move through a folder, or swipe left and right on a phone or tablet.
  - **Images:** zoom with + and −, Ctrl/⌘ + scroll, or a double-click; press R to rotate. On touch screens, pinch to zoom, double-tap to zoom in or back out, and drag to move around.
  - **Video and audio:** players with seeking.
  - **Documents:** PDFs in the browser's own viewer, or drawn by the built-in PDF.js reader where the browser has none (Android, iPhone and iPad), and reader views for Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, Markdown, CSV and JSON.
  - **Text and code:** text files open as a clean page, like other documents. Switch on **Monospace** for a fixed-width font; code and config files start in monospace, and your choice is remembered. Files without a known extension, such as `README` or `LICENSE`, are checked and shown as plain text when they contain text.
  - **Editing `.txt` files:** **Edit** turns the text into a text box, right in the viewer. **Save** (or <kbd>Ctrl</kbd>+<kbd>S</kbd>) encrypts the new text in your browser and stores it as the file's new encrypted copy: it's never written to disk, and the file keeps its encoding and line breaks. **Done** or <kbd>Esc</kbd> goes back to reading. Unsaved changes are never dropped without asking, and if the file changed or was deleted elsewhere while you were editing, your text is saved beside it instead. Spell-check is off in the text box, since some browsers send what you type to an online spelling service. Files up to 2 MB can be edited.
  - Formats your browser can't play (for example `.heic` in Chrome) say so, and offer **Download**, or **Open in another app** where the browser can hand files over. A video that plays without sound, often an `.mkv`, `.avi` or `.mov` whose sound the browser can't decode, says so too.

**Keyboard** (press <kbd>?</kbd> in Secure Box for the full list)
- <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd>: search
- <kbd>N</kbd>: new item, or a new folder in Files; <kbd>U</kbd>: upload
- In Files: the arrow keys, <kbd>Home</kbd> and <kbd>End</kbd> move, and select with <kbd>Shift</kbd>; <kbd>Space</kbd> selects one, <kbd>Ctrl</kbd>+<kbd>A</kbd> all and <kbd>Esc</kbd> none; <kbd>Enter</kbd> opens, <kbd>F2</kbd> renames, <kbd>Delete</kbd> deletes, <kbd>Backspace</kbd> goes up a folder
- In the viewer: <kbd>←</kbd> <kbd>→</kbd> move through the folder, <kbd>+</kbd> <kbd>−</kbd> zoom, <kbd>0</kbd> fits, <kbd>R</kbd> rotates, <kbd>Esc</kbd> closes

**Menu (⋯)**
- Sync now
- **Move or copy this vault…** (above)
- For a vault on this device: **Back up this vault**, **Restore a backup…**, **Delete this vault…**, and for a folder, **Stop using this folder…**
- **Change master password** (your Emergency Kit keeps working)
- **New Emergency Kit** (the old one stops working)
- **Key ring backup** (below)
- **Keyboard shortcuts**, **Source code** and **Lock**

**A vault on this device**

Passwords and files kept only here: nothing is uploaded. It works like a cloud vault and opens with the same master password.
- **Where it lives.** In Chrome and Edge on a computer, and in Chrome on Android, you choose:
  - **In this browser** (the only choice elsewhere, such as Firefox, Safari and any browser on iPhone and iPad): the browser's private storage for Secure Box.
  - **In a folder you choose**: ordinary encrypted files you can see and copy. It can be a synced folder, such as OneDrive, Dropbox or iCloud Drive, used from one computer at a time: the sync service can't merge changes made on two computers at once, so for several devices use a Google Drive or OneDrive vault. The browser asks once per visit before Secure Box may open it.
- **Keeping it safe in the browser.** The browser deletes this storage if someone clears this site's data, or uninstalls the browser. It may also clear it by itself when space runs low, unless it grants Secure Box *persistent storage*. Browsers decide that themselves, and usually agree for an installed app (see [Install as an app](#install-as-an-app)). The bar above your files shows whether it's protected, and has **Protect** to ask again.
- **On iPhone and iPad** a vault on this device works only in the Secure Box app on your Home Screen. Safari deletes the data of websites you haven't opened for 7 days, and only Home Screen apps are safe from that.
- **Back up** saves the whole vault as one `.zip`, exactly as stored and still encrypted, so you can keep it anywhere. The bar reminds you when it's out of date. If a file's encrypted copy is missing (deleted outside Secure Box), the backup can't hold it and says so.
- **Restore a backup.** On a new phone or computer, choose **This device → Restore a backup…** on the first screen, then unlock with your master password. It also takes a vault's “Secure Box” folder as Google Drive or OneDrive download it from their websites (choose every ZIP file, if there are several): a vault is the same in every place, so that's a whole vault too. In an open vault, **⋯ → Restore a backup…** adds back whatever is missing: passwords, notes, folders and files the vault doesn't have, and encrypted copies deleted outside Secure Box. It never replaces or deletes anything. Only a backup of the same vault (the same master key) can go into an open vault; one of another vault, or one an earlier version of Secure Box made, is refused and says why.
- **Files put in by hand.** If someone copies plain files into a folder vault's `Secure Box` folder, the bar lists them and offers **Encrypt them**. Each one is encrypted into the vault, and then the unencrypted original is deleted.
- **Move it** between this browser and a folder, from one folder to another, or to a cloud, with **⋯ → Move or copy this vault…** (see [Moving or copying a vault](#using-secure-box)). Files someone else put in the old folder stay there, and it won't move into a folder inside its own.
- **Delete this vault.** **⋯ → Delete this vault…** deletes its key ring, its vault and every encrypted file from this device, then locks.
  - Anything else in a chosen folder stays.
  - It can't be undone, except from a backup.
  - A vault you can't open any more can be deleted too: from **Forgot master password? → Delete this vault and start over…**, or from the error screen if it can't be read.

**Encrypt & decrypt**

A tab of its own, there whether or not a vault is open. Everything happens on your computer or phone, and nothing is uploaded.
- **Files:** drop files or a folder in, or choose them. Each file becomes its own `.sbox`, and a folder becomes one `.sbox`. Your originals aren't changed: delete them yourself once you've checked the encrypted copies.
  - In Chrome and Edge on a computer, and in Chrome on Android, you pick a folder to save into, and big files are written a piece at a time.
  - Other browsers save the results as downloads. Each one is put together in memory first, so very large files may not fit, especially on phones.
- **Who can open it.** With a vault open, you can, with your master password, and you can add a **sharing password** for someone else. With no vault open, a password is required. Generate one with a click, and send it separately from the files.
- **Hide file names** is on by default and gives each `.sbox` a random name.
- **Opening `.sbox` files:** drop them in. Files made with a vault that's open come out straight away; others ask for their password. One made with your vault while it's locked offers **Unlock your vault**, which brings you back with it ready. Without your vault, **Use a key ring backup** opens your own files on any device. A folder is unpacked into the folder you choose, or downloaded as a `.zip`.
- **Text:** switch to **Text** to turn a message into a block you can paste anywhere (**Encrypt**), or to read one (**Decrypt**). Pasting a message block switches to **Decrypt** by itself.
- **Anyone can open what you send them** at your Secure Box address, in this tab: no account, no vault, just the password.
- **Key ring backup** (**⋯ → Key ring backup**): saves a copy of your key ring, your master key locked with your master password and Emergency Kit. With it you can open your `.sbox` files and messages on any device, and start a new vault with the same master password (**No, I already have one → A key ring backup** when you create one). Keep it private: it keeps opening with the master password and Emergency Kit you have on the day you export it, even after you change them.

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
| Deleted the Secure Box folder or a file of it in Google Drive | Open your vault: Secure Box finds it in the bin and offers **Restore it**. Or restore it from the bin yourself (Google Drive keeps it 30 days). |
| Deleted it from OneDrive | Restore it from the OneDrive recycle bin, then choose **Try again**. |
| Deleted the vault's folder on this device | Restore it from the Recycle Bin (the Trash on a Mac), then choose **Try again**. If you moved it instead, choose **Find the folder…**. |
| Deleted it while it was open, for good | Choose **Save it again**: your passwords, notes and folders come back from what's open. Its files can come back only from a backup. |
| Deleted some encrypted copies by hand (in the `Encrypted files` folder, or Secure Box's folder in a cloud) | Those files stay in your vault, marked **Encrypted copy missing**. Their entry holds the key that opens a copy put back, so nothing is removed for you. Put the copies back from the bin or Recycle Bin (for a vault on this device, or from a backup with **⋯ → Restore a backup…**), then open the file again. Or open it and choose **Remove from vault**. |
| Secure Box says your vault is with its previous connection | Secure Box now connects to that cloud as a new app. Choose **Bring it over** and approve the sign-in: Secure Box copies your vault across, as it is. The old copy stays until you delete it (on Google Drive, as “Secure Box (old copy)”). |
| Secure Box can't see your vault, as it now connects as a different app | Your vault is still there. On drive.google.com, right-click the “Secure Box” folder and choose **Download** (or, on onedrive.com, download it from **Apps**). Then choose **This device → Restore a backup…**, pick every ZIP file, unlock, and use **⋯ → Move or copy this vault…** to put it back. |
| A cloud says **Your vault moved** | It was moved to another place, from another device or window. Choose **Open your … vault** to open it there, or **Start a new vault here** for a new, empty one in that place. |
| A bad change to the vault | In Drive, right-click `Secure Box Vault.json` → **Manage versions** and download an earlier version. |
| No access to your vault, but you need your `.sbox` files | Open the **Encrypt & decrypt** tab (no sign-in needed), drop the files in, choose **Use a key ring backup**, and enter your master password or Emergency Kit recovery key. |
| The vault on this device is gone (site data cleared, new phone) | Secure Box says so when you open it: choose **Restore a backup…** with your latest backup, then unlock with your master password. |
| Lost both the master password and the Emergency Kit | The data can't be recovered. That's the point of the encryption. For a vault on this device, **Forgot master password? → Delete this vault and start over…** clears it away. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `redirect_uri_mismatch` | The redirect URI must be exactly the app's address, for example `https://<site>.web.app/index.html`. Both addresses (web.app and firebaseapp.com) need their own origin and redirect URI. |
| The Google Cloud console won't save a new origin | If it asks you to add the domain to the authorized domains list, add it under Google Auth Platform → Branding → Authorized domains (for example `<site>.web.app`), then save the client again. |
| Google shows "Access blocked" | Add that Gmail address under Google Auth Platform → Audience → Test users, or publish the app. |
| "Turn on the Google Drive API" | Enable it in the Cloud project and wait a minute. |
| "Reconnect Google Drive" appears | Normal after an hour: one click, and your vault stays unlocked. Allow pop-ups for the site. |
| OneDrive asks you to sign in again | Normal once a day: Microsoft lets apps in a browser renew their access for 24 hours at most. |
| Microsoft sign-in: "Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type" | Move the redirect URIs to the **Single-page application** platform (step 3 of Setup), not *Web*. |
| Microsoft sign-in: "The redirect URI … does not match" | Add the exact address, ending in `/index.html`, for each of web.app, firebaseapp.com and localhost. |
| A video won't play | The browser doesn't support that codec. Download it, or convert it to MP4 (H.264) or WebM. |
| `firebase.ps1 cannot be loaded` | PowerShell is blocking npm's script wrapper. Run `firebase.cmd login` instead; the deploy script already uses `firebase.cmd`. |
| Firebase deploy fails: not signed in, or project not found | Run `firebase login`. Check the project ID under Firebase console → Project settings, and open Hosting → Get started once. |

## Development

```bash
npm install          # the locked dependencies; install scripts are off (.npmrc)
npm run dev          # http://localhost:8080 (add ?demo for the in-memory demo)
npm test             # unit tests
npm run build        # dist/, then the build check
npm run preview      # serves dist/ at http://localhost:8081, under the real CSP
```

- Secure Box is built with **React** and **Vite**. The page keeps its strict Content-Security-Policy in development too: no inline scripts or styles (styles are one linked stylesheet chain, never injected), and the only Trusted Types policy lets through just Secure Box's own scripts.
- `npm run build` writes `dist/` and runs `scripts/check-build.mjs`: the page's CSP must match `firebase.json`'s, nothing may be inline, and every file the page and the service worker load must be there. The deploy script builds with `npm ci --ignore-scripts` and stops if the check fails.
- `npm test` runs 92 unit tests, covering the key ring and its revisions (including changes made in two places, ties, recovery keys typed by hand, files picked in the wrong place and old key ring backups), encryption formats, `.sbox` files, encrypted messages, one vault format for every place, encrypted copies found by name in each place (against stand-ins for Google Drive and OneDrive), backups restored byte for byte (and ones from another version told apart), encrypted copies deleted outside Secure Box found missing (in a cloud and on this device), left out of backups and put back from one, backups packed in a worker, a vault's folder downloaded from a cloud's website restored like a backup (deflated, split into several ZIP files, with pieces missing), a password salt of its own for every `.sbox` file, small files fetched ahead for a ZIP download (in order, within its memory budget), copies made a few at a time when moving a vault (one failing stops the rest), saves that cross on Google Drive, changes made from an out-of-date view applied to things as they are now, the list of copies to delete, Secure Box's own files never taken for files put in by hand, saves on a disk with a coarse clock, moving and copying a vault (what a place holds, copies picked up where a transfer stopped, two vaults combined, the note left where a vault moved away), deleting a vault on this device, and a vault folder moved or deleted outside Secure Box (against a stand-in for a chosen folder), tamper detection, streaming range decryption, ZIP reading and writing (including ZIP64), XML, document readers, text detection, CSV, OneDrive reads, streaming addresses, folders and uploads (against a stand-in for OneDrive), uploads resuming after a lost piece, a cloud vault put in the bin or deleted while open, saving an edited text file in its own encoding and line breaks, and guards on the source itself (no HTML or code sinks, one Trusted Types policy, no injected styles).
- The demo can rehearse failures: add `&faults=` with any of `quota`, `expire`, `trash`, `save`, `race` (uploads and saves going wrong, or crossing with another device's save) or `bin`, `deleted`, `trashed`, `gone` (a vault deleted outside Secure Box), or `moved`, `away` (a vault moved away from another device: while open, or found when opening), or `older` (a vault an earlier version made), or `lost` (a file's encrypted copy deleted outside Secure Box), or `newapp`, `oldgone` (Secure Box connecting as a new app: the vault brought over from its previous connection, or that one gone too), for example http://localhost:8080/?demo&faults=trashed.

```
index.html              the page: Content-Security-Policy, the root element, the stylesheet
vite.config.js          build: serves/emits the service worker's scripts and PDF.js's fonts
public/                 copied as is: sw.js, manifest, icons, assets/config.json (written by deploy)
src/
  main.jsx              frame guard, sign-in pop-up relay, starts the session, renders the app
  core/                 no framework: encryption, formats, clouds, this device, readers
    keyring.js          master password + Emergency Kit (PBKDF2, recovery key), signed revisions
    vault.js            vault envelope, items, folders/files index, CSV, the shared file names
    crypto.js           AES-GCM, HKDF, Padmé padding, password generator
    fileformat.js       chunked AES-256-GCM file format + upload piece writer
    stream-core.js      random-access decryption shared with the service worker
    zip-core.js         streaming ZIP writer (CRC-32, ZIP64) used by the service worker
    stream.js           starts the service worker and builds its file URLs
    trusted.js          the page's one Trusted Types policy (the service worker and workers)
    backend.js          cloud storage: Google Drive and OneDrive (key ring, vault, encrypted files)
    google.js, microsoft.js   sign-in, pop-ups (and noticing when one is closed), REST calls
    retry.js            uploads survive a passing failure: retry, then resume where it got to
    localbox.js         .sbox format: account and password key copies, folder boxes
    localstore.js       the vault on this device: browser storage or a chosen folder, backups
    textbox.js          encrypted text messages
    readers.js          Word/Excel/PowerPoint/OpenDocument/EPUB/RTF/Markdown/CSV/text, as plain data
    textfile.js         editing .txt files: their encoding and line breaks, kept on save
    filetypes.js, thumbs.js, zip.js, xml.js, demo.js
  session/              the app's logic, no React: what's open, unlocking, switching, saving
    vaults.js           the Vault tab's steps, unlock, create, adopt, Emergency Kit, recovery, switching
    cloud.js            saving and syncing, Reconnect, auto-lock, locking every window
    device.js           the vault on this device: making, opening, backups, moving, deleting
    bringover.js        a vault brought over from Secure Box's previous connection to a cloud
    gone.js             a vault deleted or moved outside Secure Box while open: the ways back
    textedit.js         saving a .txt file edited in the viewer, and what if it changed meanwhile
    files.js            folders, choosing, uploads (parallel, batched), downloads, deletes
    tools.js            Encrypt & decrypt: .sbox files and messages, with or without a vault
    passwords.js        items, CSV, master password, Emergency Kit, key ring backup
    windows.js, nav.js, prefs.js, memory.js, places.js, bridge.js, store.js, io.js, viewer.js
  ui/                   React components: shell (tabs, vault switcher, menus), home (the Vault
                        tab), passwords, files, viewer, tools, dialogs, common
  workers/              a small worker pool: document parsing, thumbnails, folder and backup packing
  styles/               the stylesheets, linked once from index.html
firebase.json           Firebase Hosting: publishes dist/ with the security headers
deploy-firebase.ps1     one-command Firebase deploy (builds first)
tests/                  node --test suite
```

## Removing Secure Box

1. Take the app offline: run `firebase hosting:disable --project <project-id>`, or delete the Firebase project.
2. Each person can delete the `Secure Box` folder from their Google Drive, or `Apps/Secure Box` from their OneDrive, and the vault on their device from the ⋯ menu. Export anything they need first.
3. Remove the app's access at myaccount.google.com → Security → Third-party connections, and for OneDrive at account.live.com/consent/Manage. Delete the Microsoft app registration too, if you made one.

## Contributing and security

Bug reports and ideas are welcome as issues; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, as [SECURITY.md](SECURITY.md) explains.

## License

Copyright (C) 2026 [CybermindDBS](https://github.com/CybermindDBS)

Secure Box is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

If you let other people use a changed copy, for example by hosting it, the license asks you to offer them its source code. Point the **Source code** link in the app's ⋯ menu at your version.

For other license terms, open an issue.
