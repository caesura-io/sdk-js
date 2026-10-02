# Contributing

Thanks for your interest in CaesuraO!

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Making changes

1. Create a branch.
2. Make your change with tests.
3. Run `pnpm changeset` and describe your change (this drives versioning).
4. Open a PR against `main`.

CI runs lint, typecheck, tests, and build on every PR.

## Release validation

PR CI and release both call `.github/workflows/validate.yml` at the triggering
commit. Publishing depends on all validation jobs. Validation builds packages,
runs lint/types/regressions, and installs tarballs into isolated consumer projects.
OpenAI runs against 4.87.3 plus the first and newest supported 5/6/7 releases and
the newest 4.x; AI SDK runs against 5/6/7 through actual `wrapLanguageModel` calls.
The consumer checks ESM/CommonJS imports and declarations, both OpenAI APIs,
streaming, and foreground/background operation without credentials or live calls.

Validation and release use the same npm version pinned in
`.github/actions/setup-publishing/action.yml`. Do not replace it with `npm@latest`:
pnpm 9 forwards `--no-git-checks` to npm, which npm 12 rejects. After building,
`pnpm test:publish` exercises that publish handoff for all three packages with
`--dry-run` and a loopback registry. It never uploads or verifies OIDC credentials.

After `pnpm build`, run `pnpm test:packages 4.87.3 5` (or other matrix versions).
This downloads public dependencies into a temporary directory with install scripts
disabled and removes it afterward. Exact resolved versions appear in its output.

Include the regression tests and fixtures when committing this release. Add
Changesets entries for behavior/API changes; pre-1.0 breaking changes use a minor
bump. Do not edit versions or changelogs manually. Changesets prepares the version
PR, and its merge is validated again before publishing.
