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
npm run dev     # http://localhost:8080/index.html?demo
npm test
```

The code follows a few rules:

- No third-party JavaScript, fonts or images, and no build step: everything in `app/` is served as is.
- The Content-Security-Policy and Trusted Types stay strict: no inline scripts or styles, no `eval`.
- Documents are rendered with DOM calls, never as HTML strings.
- Every change to the encryption formats comes with tests in `tests/`.
