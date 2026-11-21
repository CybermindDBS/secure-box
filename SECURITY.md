# Security policy

Secure Box holds passwords, notes and files, so security reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately instead: open
this repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply as soon as possible. Fixes are published with credit to you, unless you'd rather stay
anonymous.

## Scope

In scope:

- Anything that could expose decrypted data, keys or the master password: the key ring, vault and
  file formats, the streaming service worker, the page's script and Content-Security-Policy setup,
  and how windows share an unlocked session.
- Ways around auto-lock, or around locking every window together.
- Cross-site scripting, clickjacking, or anything that lets another site act inside Secure Box.

Out of scope:

- Attacks that need malware on the device, a malicious browser extension, or someone holding both
  the Google account *and* the master password or Emergency Kit.
- Copies hosted with a changed configuration or changed code.
- Copies hosted somewhere that can't send the security headers in `firebase.json`; the page's
  built-in policy covers most of them, but only Firebase Hosting is supported.

## Status

Secure Box has **not had an independent security audit**. Its design is explained in the README
under "Security model". Please read it before trusting Secure Box with important data.

## Supported versions

Fixes go into the latest version on the default branch only.
