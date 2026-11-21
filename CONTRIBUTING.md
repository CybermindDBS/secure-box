# Contributing

Thanks for your interest in Secure Box!

## Issues and ideas

Bug reports, questions and feature ideas are very welcome: open an issue. For security problems,
follow [SECURITY.md](SECURITY.md) instead.

## Code contributions

Pull requests aren't being accepted for now. Secure Box may also be offered under other license
terms in the future, and keeping all of the code from one author keeps that option open. If you
have a fix, describe it in an issue.

## Working on your own copy

You're free to fork and change Secure Box under the GNU Affero General Public License v3
([LICENSE](LICENSE)). In short: if you let other people use a changed version, for example by
hosting it, you must offer them its source code. The app's ⋯ menu has a **Source code** link;
point it at your fork.

```bash
npm install     # the locked dependencies, with install scripts off
npm run dev     # http://localhost:8080/?demo
npm test
npm run build   # dist/, then the build check
```

The code follows a few rules:

- Few dependencies, each pinned exactly in `package-lock.json`: React, PDF.js and the Vite build tool. Nothing is loaded from another address at run time.
- Encryption and storage live in `src/core/` and the app's logic in `src/session/`, both without React; components in `src/ui/` only show the session and call it.
- The Content-Security-Policy and Trusted Types stay strict, in development too: no inline scripts or styles (no CSS imported from JavaScript), no `eval`, and workers start only through `src/core/trusted.js`.
- Documents are rendered from plain data with React, never as HTML strings; `tests/source.test.mjs` fails on any HTML or code sink in `src/`.
- Every change to the encryption formats comes with tests in `tests/`.
