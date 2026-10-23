# Repository maintenance

## Dependency updates

`.github/dependabot.yml` proposes weekly npm and GitHub Actions version checks.
Compatible runtime and development updates use separate groups. The npm queue
is bounded to three open version-update PRs and the Actions queue to two. Major
npm updates remain separate. Security updates remain distinct from regular
version updates. No auto-merge, reviewer identity or privileged token is configured.
Forks may require an administrator to enable version updates; the configuration
file does not establish that the repository setting is enabled.

Require applicable Node, coverage, build, browser, native and fresh Docker checks.
Preserve workflow commit pins and verify paired tool/runtime and artifact
identities. Changed Go, Anvil, browser or compiler pins need fresh matching lab
evidence. Changes to this repository configuration do not modify user-owned
local automations.

## Distribution notices

Every Vite production build emits `third-party-notices/`, including programmatic
qualification builds. The generator validates installed non-development package
names, versions and license fields against the lockfile, rejects linked or missing
notice inputs and copies complete recognized notice bytes without redacting
required upstream attribution. Its manifest contains relative paths and SHA-256
digests without package-author or host metadata. The release manifest includes
every notice output file. The conservative set may include dependencies absent
from the final bundle.

This mechanism does not grant ownership of reconstructed source/assets or select
their root license. An authorized maintainer must still accept provenance,
applicable terms and the final distribution under task 28. Retain the notice
directory with the accepted artifact.

## Decisions reserved to maintainers

An authorized administrator must select actual code owners and required reviewers,
protect the intended branch and workflows, enforce current required check
contexts, verify the confidential reporting channel and assign release, support,
incident and rollback responsibilities. A CODEOWNERS file cannot contain invented
handles or unapproved personal identities. None are assigned here.

Root licensing, reporting contacts, response commitments and real-wallet/product
support remain explicit owner decisions. A checklist does not configure GitHub
settings. Review/merge authorization, deployment, served-artifact verification
and operating bridge activation remain separate gates.
