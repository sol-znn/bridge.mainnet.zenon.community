# Contributing

Read [SECURITY](SECURITY.md) before reporting a possible vulnerability. Public
contributions and reports must be in English and exclude private paths, personal
information, credentials, wallet exports and raw logs. Preserve required
attribution in upstream license/notice texts.

## Reproduce and validate

Use a supported Node version from `package.json` and the committed lockfile.
Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:coverage` and
`npm run build`. Use the pinned browser and isolated labs in
[TESTING](docs/TESTING.md) for UI, native and fresh Docker qualification. Keep
prerequisite failures and skipped execution explicit. Synthetic wallet providers
and fixture chains do not establish real-wallet or live economic acceptance.

Bind results to the exact source commit/tree, lockfile, actual command exits,
workflow run/attempt and artifact manifests. Changed source needs new evidence.
The build emits `third-party-notices/` from exact locked installed dependencies;
missing, linked, substituted or mismatched notice inputs fail the build. Retain
that directory when distributing. Do not invent a root project license.

## Scope and review

Keep changes focused. Describe the trigger, resulting behavior, meaningful
validation and remaining limits. Preserve original transaction intent/hash and
unresolved wallet outcomes. Never re-sign, auto-replace or erase recovery evidence
to obtain a passing test. Archive failures privately with honest status.

Dependency PRs must preserve action commit pins and runtime/source identities and
pass applicable qualification. Major updates need compatibility review. No
automatic merge, production deployment or activation approval is configured.
Independent review of signing, receipts, storage, network authority and workflow
permissions remains required. [MAINTENANCE](docs/MAINTENANCE.md) and the
[acceptance protocol](docs/ACCEPTANCE.md) describe administrator decisions.
