# Security reporting

Do not put credentials, wallet journals, seed phrases, private keys, personal
information, raw diagnostics or an unmitigated exploit in a public issue or PR.
Use public fixture accounts and sanitized evidence for ordinary bug reports.
Never send real funds to reproduce a report.

This repository has not designated a verified confidential reporting contact or
response-time commitment. If **Security > Report a vulnerability** is available,
use that private channel. Its availability must be verified; this document does
not enable it. If unavailable, retain sensitive evidence privately until an
authorized maintainer publishes a verified confidential channel. Do not infer
a contact or recovery authority from an account name.

For a private report, prepare the affected source/artifact identity, prerequisites,
impact, minimal reproduction using disposable fixtures and a proposed mitigation.
Share only necessary evidence through the verified confidential channel. Public
issues may contain non-sensitive symptoms and fixture-only reproduction.

The supported integration limits are in [SUPPORT](docs/SUPPORT.md). CI does not
establish real-wallet support, operating bridge recovery or production activation.
Maintainers must separately accept security ownership, supported versions,
disclosure coordination and release/incident responsibilities under the
[acceptance protocol](docs/ACCEPTANCE.md).
