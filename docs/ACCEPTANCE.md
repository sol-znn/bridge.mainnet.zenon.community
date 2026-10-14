# Remaining acceptance evidence

The ten original task IDs below remain separate from source review. Use this
protocol with the exact reviewed commit, source tree and artifact manifest.
A changed candidate requires new source binding. Successful CI, a PR merge,
an HTTP 200 response or a submitted transaction does not close these gates.

## Evidence record

For each task, record its scope, accountable role, date, source/artifact identity,
actual environment, observed result and evidence reference. Use `PASS`, `FAIL`,
`NOT_RUN`, `NOT_ESTABLISHED` or an authorized `NOT_APPLICABLE` decision.
Missing prerequisites are `NOT_RUN`; incomplete provenance is
`NOT_ESTABLISHED`. A not-applicable decision must name the excluded product
scope and supported alternative. A role's acceptance must be recorded explicitly.

Keep raw wallet journals, addresses, recipients, endpoint details, screenshots,
machine paths, account metadata and incident diagnostics private. Public records
contain roles, versions, source/artifact digests, sanitized results and public
evidence links. Do not include personal names or credentials in an acceptance
packet. Preserve the private originals and their exact operation identities.

| Task | Evidence still needed | Responsible role |
| --- | --- | --- |
| 1 | Incident cause/service state, authority for recovery, and disposition of each existing exact request; sustained signing health | Bridge/TSS operators |
| 2 | Explicit new-transfer activation decision for an accepted artifact, halt criteria and rollback responsibilities | Maintainers/operators |
| 3 | One intended Pages publisher, approved candidate deployment, matching served bytes and absence of another writer | Site administrator |
| 16 | Actual proxy service acceptance, or explicit form-only product scope | Frontend/proxy owner |
| 21 | Current-source hosted qualification and enforced required checks | CI/repository administrator |
| 22 | Independent clean-platform real-wallet results for the cases below | Wallet integration reviewer |
| 24 | Canonical origin/base, HTTPS and effective HTTP policy/legacy navigation on the approved deployment | Hosting owner |
| 25 | Canonical economic postconditions for LP/bridge/stake/reward and swap integrations | Protocol/integration reviewer |
| 26 | Independent review, protected workflow/release policy, distribution/incident roles and rollback acceptance | Repository/release owner |
| 28 | Root licensing authority, source/asset provenance, redistribution notices and supported product/support scope | Authorized maintainer |

## Repository and hosting checks: 3, 21, 24, 26

Bind CI to its actual run and attempt. PR workflows can check out a merge revision;
verify its parents and source tree against the candidate rather than renaming it
as the branch commit. Confirm all Node jobs, the native lab and the Pages PR build
ran their required steps without prerequisite-dependent test skips. A deliberately
skipped PR deployment is not deployed-artifact evidence.

The administrator must select the actual target check contexts from the current
PR, including the supported Node matrix, isolated lab and Pages build. Bind the
checks to their intended provider, require current-branch qualification and
independent review, and protect changes to workflow definitions. A workflow file
does not configure branch/ruleset enforcement. Record the applied policy and
verify it separately from the proposal.

After a separately authorized deployment, compare the served release manifest,
HTML and every listed payload hash with the approved artifact. Verify base-path
and custom-domain behavior, HTTP-to-HTTPS policy, certificate validity and the
actual response headers. Check framing policy through `frame-ancestors` in an
HTTP CSP or the accepted HTTP framing header; meta CSP cannot establish it.
Check content-type/referrer policy and legacy/referral navigation with same-origin,
external-origin, userinfo and oversized/invalid inputs. Recheck actual behavior
after a hosting change. Keep rollback to an exact previously accepted artifact.

## Real-wallet cases: 22

Use independently provisioned clean installations and name wallet, browser and OS
versions. Synthetic providers, headless components and a local fork wallet are
separate evidence. Use only a separately authorized integration environment.

| Case | Required observation |
| --- | --- |
| Accept/reject | An accepted request retains its original immutable intent/hash; a rejection requests no replacement signature |
| Delayed original reply | Change the form/account/chain while a request is pending; the original reply belongs only to its original durable operation |
| Disconnect/reload | Nonterminal state survives; exact original-hash reconciliation remains possible without rediscovering a hash by approximate history |
| Concurrent tabs | One original publication owns the operation; another tab cannot replace or duplicate it |
| Persistence failure | Unreadable/unwritable journal state pauses sending and preserves the original state |
| Receipt mismatch/revert | A wrong signer, chain, recipient, calldata/value, hash or reverted receipt cannot establish source success |
| Uncertain outcome | The original operation remains unresolved; no re-sign, automatic replacement or fabricated completion occurs |

Retain private before/after journal evidence and sanitized result references.
An explicit EIP-1193 rejection from the original request can remain a rejected
operation when wrapped by the SDK. Display text alone does not establish that
result. A reported transaction hash takes precedence: preserve the exact report,
hold conflicting reports for independent review, and request no replacement.
Record supported Syrius and injected-wallet integrations separately. Hardware,
smart-contract and other wallet support require their own evidence or an explicit
product decision; absence of testing is not an unsupported-product declaration.

## Economic integration cases: 25

Record actual authorized contracts/programs and canonical transaction/state
references privately. Complete LP creation/approval, LP balance increase, bridge
publication, opposite-side redemption and exact resulting balances. For staking,
establish program availability/reward rules, expiry, cancellation and reward
collection postconditions. Cover empty/halted/unavailable programs, pagination,
reverts and interruptions/reorganizations while preserving the original operation.

For swaps, establish the original approval allowance, source execution and
recipient/asset/quantity/minimum-output postconditions. Cross-chain delivery needs
receiving-chain transaction and balance evidence; a router status or source receipt
alone is insufficient. A local Ethereum fork can exercise source contracts but
cannot establish receiving-chain delivery, distributed TSS or real-wallet support.
Do not reconnect an uncertain operation to a replacement signature.

## Operating service, proxy and ownership: 1, 2, 16, 28

Operators must diagnose and authorize recovery of the existing exact requests.
Frontend deployment cannot resume signing or authorize a ceremony/key change.
Use the private original request/transaction records; never replace them for a
cleaner test result. Record accepted terminal outcomes or explicit unresolved
dispositions before a separate activation decision.

If proxy mode is supported, qualify server-held credentials, restricted upstream
access, validation, abuse/rate/quota controls and timeout/failure behavior. Verify
the browser contains no service credential and does not turn a proxy failure into
transfer success. For a form-only release, an owner can accept that explicit scope;
creating a proxy is not required by the default frontend.

Verify dependency/font notice texts from the exact locked package trees and retain
their terms when distributing. An inventory of package versions, license fields
and file digests is a provenance input, not root licensing authority or permission
to omit attribution. Reconstructed source, assets and support/distribution terms
still require authorized maintainer decisions. Do not invent a repository license.
