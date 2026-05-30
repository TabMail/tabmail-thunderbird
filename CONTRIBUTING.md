# Contributing to the TabMail Thunderbird Add-on

Thank you for your interest in contributing!

This project is licensed under the **Mozilla Public License 2.0 (MPL-2.0)**.
Contributions are accepted under the same license.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. The DCO is a lightweight way for you to certify that you wrote
the contribution, or otherwise have the right to submit it under the project's
license.

To sign off on a commit, add the `-s` flag:

```bash
git commit -s -m "your message"
```

This appends a `Signed-off-by:` line using your `git config user.name` and
`user.email`, certifying that you agree to the DCO (reproduced below). Every
commit in a pull request must be signed off.

If you forget, you can amend the most recent commit with:

```bash
git commit --amend -s
```

## Development setup

- Load temporarily: Thunderbird → Tools → Developer Tools → Debug Add-ons →
  "Load Temporary Add-on" → select `manifest.json`.
- Run tests: `npm install && npm test` (Vitest, ESM).
- New MPL-licensed source files should carry the standard MPL 2.0 header (see any
  existing `.js` file for the format).

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Trademarks

The MPL-2.0 license covers the code, not the "TabMail" name or logo. See
[TRADEMARKS.md](./TRADEMARKS.md) — forks must rebrand.

---

## Developer Certificate of Origin 1.1

```
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
