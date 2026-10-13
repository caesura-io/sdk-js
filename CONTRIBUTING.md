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

## Live persistence check

With a test account API key, opt into a check that creates a conversation and performs real analyses:

```sh
CAESURA_LIVE_TEST=1 pnpm --filter @caesura-io/openai exec vitest run src/persistence.live.test.ts
```

Provider calls are mocked. This check consumes CaesuraO credits and writes test conversation data.

## This release and examples

Use `pnpm changeset status` to check the versions planned by pending changesets.
Keep versions and changelogs unchanged in the implementation commit. After its PR
passes validation and merges, Changesets opens the version PR. Review its three
versions and workspace dependency updates, pass validation, then merge to publish.
Confirm all three exact versions and provenance on npm before updating examples.

The [examples repository](https://github.com/caesura-io/examples-sdk-js) includes a
guarded `node scripts/use-published-sdk.mjs` transition. After publication it pins
the released versions and regenerates both npm lockfiles. Run its standalone CI
checks, then commit the examples separately. Never commit sibling dependencies as
the release-ready configuration. Repository settings must allow Changesets PRs;
all three npm trusted publishers must target this repository's `release.yml`.
Local dry runs do not verify these remote permissions or OIDC configuration.
