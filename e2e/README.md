# Isolated bridge qualification

All keys here are committed public fixtures. Never fund them outside the isolated lab. Endpoints must be loopback and the suite refuses writes unless both chain IDs are Zenon 322 and EVM 31337. This is a one-key orchestrator fixture, not distributed TSS or production activation evidence.

## Pinned source

Clone `https://github.com/sol-znn/go-zenon`, check out `616f0a61ebc8562846965822f94976e531e0937c`, and set `GO_ZENON_DIR` to that checkout. Working-tree edits are excluded: the build exports that exact commit and checks its tree against `lab/pins.json`. Review the fork and the explicit devnet bridge overlay; this is not an official-mainnet qualification.

## Native lab

Install Go 1.27.1 and Anvil 1.8.5. Verify the appropriate official archive SHA256 from `lab/pins.json`, set `LAB_GO_BIN` if Go is not on PATH, and set `ANVIL_BIN` to the extracted executable. Install the pinned Chrome for Testing headless shell with the lockfile's `node_modules/.bin/browsers install chrome-headless-shell@155.0.8059.39 --path <tools-directory>` and set `CHROME_PATH` to it.

```sh
npm ci
npm run lab:build:native
npm run lab:native          # foreground supervisor; Ctrl-C stops its children
# In a second terminal:
node e2e/lab/frontier.mjs 60 --wait 120 --native
npm run test:e2e
```

Readiness must succeed before the tests. It checks production and agreement across five nodes. The supervisor binds loopback only, fails when a child exits, and records the source/build, binary, Anvil, genesis and config identities. An existing native chain with different inputs is refused; archive its generated `.build/native` evidence and create a fresh isolated chain. Do not reuse unknown fixture publications with a different lab state. Short reorg failures are retained, not re-signed away.

On a convergence timeout, the failure report additionally records bounded
read-only peer counts, numeric sync state/heights and each node's height-two
momentum hash. Missing or malformed diagnostic data remains unavailable.

Native qualification runs three independent fresh cold-start cases: two with
the original error-only RPC logging and one with RPC info logging. Each case
has its own runner, chain and artifact; every failure stays failed. There is no
warm restart or successful-case substitution. The 600-second, minimum-height,
depth and exact five-node convergence requirements are unchanged.

The `error-b` case keeps the original Go startup without a profiling listener.
Only after an actual readiness refusal and its read-only peer/hash snapshot,
the source-bound supervisor may signal the exact owned node with the lowest
valid frontier for a postmortem. A private per-start challenge, exact source/build/node-role identity,
one-shot request and verified child exit bind the capture. It stops this
already-failed isolated fixture; the original failure remains fatal. This
separates startup profiling from the unprofiled failure being investigated.
The `error-a` and `info` cases retain a loopback-only profiling listener for
comparison on the RPC node. Every case also owns private, one-shot postmortem
controls for all five fixture nodes. A lagging producer uses its own unprofiled
postmortem even when the RPC has a loopback profiler. No case signals a PID
supplied by a request. Equal minimum heights use a fixed producer-first role
order; incomplete or foreign frontier records do not select a node.

After preserving a native readiness failure, the report compares all five
hashes at the lowest observed frontier, in addition to height two. It also
collects a bounded loopback profile or owned-child postmortem from the selected
isolated node and fixed log categories. The public report identifies the selected
fixture role, port and observed height. This prevents a healthy RPC profile from
standing in for a stalled producer. Only public Go function names, wait classes,
counts and numeric heights leave the parser. Raw profiles/logs, goroutine IDs,
pointer arguments, peer data and paths are excluded. Missing ownership or
incomplete diagnostic data stays unavailable. Private control files and raw
stderr are excluded from uploaded evidence. Successful readiness performs
no profile reads, postmortem requests/signals or diagnostic-log reads. These diagnostics do not fix or establish
the historical sync-lag cause by themselves.
Peer identities, addresses, names and raw RPC errors are excluded. These
failure-only reads do not extend the qualification window, restart nodes or
permit fixture writes.

## Docker lab

```sh
npm run lab:up
npm run test:e2e
npm run lab:down
```

Docker pins the Go/runtime/Anvil images by digest. `lab.sh` verifies the built image and overlay identities before reuse. `npm run lab:wipe` explicitly deletes only this lab's generated assets and named volumes. Archive evidence first. The Docker path needs independent qualification on a host with a running Docker daemon; a native pass does not prove Docker passed.

`lab:up` waits for the same readiness barrier as native mode: minimum height 20,
depth three and three consecutive five-node agreements on recent momentum hashes.
The extra node RPC ports 47100-47103 bind only to loopback. Docker build/runtime
image pairing and readiness are recorded in `.build/manifest.json` and
`.build/docker/{run-manifest,readiness-report}.json`. Qualification has a separate
Docker job that starts with no chain assets or fixture publication, then runs all
three E2E files. Its result remains separate from the native job.

The compiled-browser suite requires a fresh WebSocket upgrade and validated
chain-322 frontier for the initial load, four cold starts and a controlled
normal socket disconnect/reconnect. Reconnection must issue a new frontier
read; a new socket cannot inherit the old socket's chain or freshness evidence.
Console errors, unexpected endpoints and CSP violations remain fatal. Bounded
transport reports exclude raw NetLog, headers, cookies and RPC payloads. A
passing reconnect control does not establish the cause of an earlier unexpected
transport failure.

The suite establishes the idempotent committed loopback bridge fixture itself
before starting its read-only browser checks. It can therefore run first or
after either other E2E file. Vitest orders uncached files by size and cached
files by failure/duration; no filename or previous suite may supply this setup
implicitly. Fixture writes retain the chain-322/Anvil-31337 identity guard.

The compiled-browser report also records the browser revision and a bounded
network-service inventory before navigation. Only a WebSocket error triggers
another inventory; there is no idle polling. Reports retain service counts and
whether the observed service set changed, excluding process identifiers,
command lines and raw query errors. Missing, malformed or timed-out evidence
leaves the comparison unknown. An empty browser error has its own fixed category.
A deliberately terminated network utility can produce the same empty error
signature while the browser remains usable, even with NetLog enabled; a missing
NetLog connection graph therefore remains incomplete evidence. A matching
injected signature alone does not establish the cause of a historical failure.

A failed target run on the tested merge `b8af7c02` observed a replaced network
service after successful five-node readiness; the browser's empty WebSocket
error still fails the suite. The reason for that replacement remains unknown.
The report now passively inspects at most 64 KiB of the owned browser's stderr
after launch and before teardown. It retains only a fixed count of the pinned
Chromium [network-service recreation message](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/network_service_instance_impl.cc#L652),
byte/truncation facts and the owned main browser's exit state. Raw lines,
identifiers and paths are never included. Missing or incomplete capture stays
explicit; a zero counter does not prove the service never exited. The message
itself does not distinguish a crash from termination or establish its cause.
Reporting snapshots precede the fixture's intentional browser shutdown.

When a browser socket error occurs, a single pre-teardown snapshot also records
deltas of the pinned Chromium utility-process crash, kill and disconnected-alive
counters. The baseline is taken before navigation; there is no idle polling.
The [pinned process-type enum](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/public/common/process_type.h#L18)
and [termination histogram sites](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/browser_child_process_host_impl.cc#L468)
define the categories. An actual owned-browser SIGKILL calibration increased only
the utility-kill counter while replacing the network service. It calibrates the
metric, not the natural Linux failure. These counters cover **all utility
processes** and do not alone identify a network-service termination or its cause.
Unknown browser revisions, schemas, deadlines and non-monotone samples remain
unavailable. Identifiers, paths, arbitrary histogram names and raw query errors
are excluded. Unexpected socket/console errors remain fatal.

The pinned Linux implementation can send `SIGKILL` itself when querying a
[disconnected child's known-dead status](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/base/process/kill_posix.cc#L82).
A killed-counter delta therefore does not prove an external actor or OOM.
Every native and Docker CI case calibrates a separate owned kernel signal observer
using one deliberate `SIGTERM` to its own disposable Python child. It then
observes each compiled/probe browser's initial network-service threads in a fresh,
recipient-filtered tracefs instance. Only fixed signal, sender-role and
generation-result categories enter the report. No raw trace, process/thread ID,
command, executable or path is uploaded. Buffer loss, bounds, identity or
permission failures remain explicit. The observer stops before intentional
browser teardown and removes only its own tracing instance. It neither signals
the natural browser nor changes its sandbox or RPC policy. Signal generation
is positive evidence; it does not establish why an earlier IPC pipe closed.

Actual-Go transport probes reuse the already accepted compiled fixture origin
`http://127.0.0.1:5195` after that fixture closes. A random web port is not in
the native lab's existing Origin allowlist and can be refused before an RPC
reply. That setup error is distinct from a validated socket dropping while
the network service is replaced. The allowlist is never widened for a probe.

The `info` case additionally makes 24 fresh production-bundle starts. It reuses
the already built and hash-checked compiled scripts on their accepted origin,
with the existing Go lab and no injected wallet. Its process/signal baseline
precedes the first application navigation, matching the failing startup scope.
The application itself sends its startup RPCs. Paired chain-322 frontier replies,
an open first socket and the Anvil banner are required. A first socket error
remains fatal even if the application subsequently reconnects. Console, CSP,
outbound, process-replacement and diagnostic bounds remain enforced; the loop
stops on its first failure and never retries a failed start. Its separate report
does not replace the original compiled suite or the staged RPC probe.
Script admission includes the committed standalone `/theme-init.js` initializer
as well as hashed `/assets/*.js` entries. Both use relative paths inside the
same compiled build and retain exact byte/size checks; other root scripts,
traversal, encoded paths and URL/query forms are refused.

Signal reports also retain the helper's actual exit/signal and output
completeness. A missing or nonzero helper outcome cannot produce a complete
observation. An owned zygote or other browser descendant has its own sender
category; it is not classified as an external actor merely because its process
group differs from the main browser's.

Native stack reports can distinguish fixed downloader wait sites only for the
exact reviewed Go commit and built downloader file SHA-256. The EOF handoff and the hash reply/timeout select are
separate categories, as are the first-worker and remaining-worker joins.
Unknown source pins or source locations have no inferred wait-site category.
Only those fixed categories are emitted; raw paths, offsets and arguments stay
private. A matching stack shape alone is not a causal reproduction.

A known pre-publication validation rejection archives the matching signed fixture
under `e2e/.state/rejected/` and releases its pending slot. The startup cache error
must name that block's exact acknowledged momentum. Network/timeouts, malformed
responses, internal and unclassified RPC errors keep `publication.json` and its
original hash. There is no automatic resend, replacement signature or cleanup of
old lab state.

The genesis generator backs every declared QSR fusion while preserving total supply; index 1 has 10,000 ZNN and 70,000 spendable QSR plus its fused QSR. Setup deploys/configures the lab bridge/token, and the suites exercise wrap, delayed two-step EVM redemption, unwrap/referral, Zenon redemption and UI behavior. See [qualification boundaries](../docs/QUALIFICATION.md) and [release gates](../docs/DEPLOY.md).

## Downloader phase isolation

A failed synchronization could leave an EOF flag in the downloader's shared
`processCh`. The next block-fetch worker could consume that old flag before new
hashes arrived and exit successfully. The new hash worker then queued two hashes
and blocked sending its EOF to a full channel with no block worker left. The
outer sync joined the blocked worker indefinitely. This is independent of a
particular height: the actual package regression freezes at height 5, while a
natural Linux CI producer froze at height 2.

The pinned package passed its nine existing tests. A control using two complete
actual synchronizations, the real queue/peer/delivery functions and descending
protocol hash replies reproduced height 5, two pending hashes and active sync.
It did not seed `processCh` directly. Resetting that channel for each new sync
made all ten package tests and ten repeated controlled interleavings pass. The
[natural failure on the unpatched source](https://github.com/edgepillar/bridge.mainnet.zenon.community/actions/runs/40545587535/attempts/1)
independently captured `HASH_COMPLETION_HANDOFF` and
`SYNC_JOIN_AFTER_FIRST_SUCCESS`, with no block-fetch worker. Its exact Go source
and downloader-file hash matched the control. The older RPC-5 run lacks this
stack evidence; no exact retrospective attribution is claimed for that run.

Both native and Docker lab builds now apply only this two-line synchronization
patch to the exported Go source. `downloader-phase-reset.mjs` refuses any source
or result whose SHA-256 differs from the qualified preimage/result. The Go base
commit/tree remain pinned and its checkout is never edited. Build manifests
record the original/patched identities, actual downloader hash and all overlay
hashes. The runtime is therefore explicitly a patched lab build. Consensus rules,
genesis, peer requirements and convergence/timeout assertions are unchanged.
This does not install a fix on an operating bridge or accept a production node
upgrade; those remain operator/owner decisions.

The native `error-b` CI job also qualifies the package control before starting
its fresh chains. It exports the exact unmodified Git archive, passes the nine
baseline tests, requires the original height-5 regression to fail, then applies
the exact patch and requires ten package tests plus ten repeated controls to
pass with zero skips. Go stays offline using the module cache already populated
by the pinned native build. Only fixed outcomes, counters, source/runtime pins
and stream SHA-256/byte/completeness facts enter `downloader-control-report.json`.
Raw command output and stack data stay outside uploaded artifacts. A failure
remains fatal. Current-source Linux/native/Docker evidence is required separately
from the completed Darwin package control and any earlier successful cold case.
## Browser utility-exit investigation

The `browser-transport` CI job uses the same pinned sandboxed Chromium for 48
fresh browser starts. It varies complete messages, empty final continuations,
separately scheduled final continuations and direct network blocking. Complete
messages are serialized on the synthetic loopback server. Each start must receive
all 13 valid JSON replies and keep its socket open during the observation window.
Socket or console errors, unexpected service replacement and incomplete controls
fail the job. It sends no injected signals and uses no wallet or chain.

The report binds source/tree/file/lock/runtime identities and retains fixed
utility-termination, stderr and inherited cgroup-memory facts. Raw lines,
identifiers, profiles and paths are excluded. The cgroup counters cover the whole
process's cgroup hierarchy; utility counters cover all utilities. Neither alone identifies a
particular process or establishes why it exited. Current compiled native/Docker
checks also capture memory facts after a transport error, before browser teardown.

This bounded experiment investigates the preserved natural network-service
replacement. A passing probe or injected calibration does not establish its cause
or dispose of historical failures. The browser pin, fatal transport assertions,
sandbox and five-node readiness requirements are unchanged.

An actual source-bound production-bundle failure at the thirteenth fresh start
captured a browser `mojo-message-error` digest of
`69c060217c0aaa981ed6d74af3d0d36dd720a2bc952df8dae6cced7c8b0f57fa`
over 57 bytes. That digest exactly matches the public pinned Chromium rejection
for a duplicate active DevTools request ID, including its standard Mojo prefix.
The [interceptor](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/devtools/devtools_url_loader_interceptor.cc#L814)
reports that collision as a bad message. The
[browser error handler](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/content/browser/browser_child_process_host_impl.cc#L754)
synchronously retains the selected error and terminates the network service.
The same natural event independently recorded an owned-browser SIGKILL. This
identifies the immediate disconnection mechanism; the internal origin of the
colliding renderer request IDs and uninstrumented production behavior are separate.

Qualification therefore uses the pinned renderer's `Network.setBlockedURLs`
allow rules before a default block, plus an exact loopback `connect-src` header
on the owned fixture server. It never enables Fetch interception. Component RPC
replies and isolated landing pages are served by the bounded loopback fixture
middleware instead of intercepted requests. Outbound observations, CSP errors,
socket errors and service replacement remain fatal. The additional fixture header
does not establish production hosting/header acceptance or change the product CSP.

Before chains start, a separate owned control proves allowed HTTP and WebSocket
traffic succeeds, a denied HTTP image is blocked by the inspector without reaching
its server, and a denied WebSocket is blocked by the fixture's connect policy
without an upgrade. Both denied targets are other owned loopback endpoints;
no public endpoint is contacted. Its source/lock/browser identities, actual
counts and network-service continuity are retained in `network-policy-control.json`.
Failure is fatal and never falls back to Fetch interception. Full current-source
native/Docker and compiled-startup qualification remains required separately.

Each native/Docker job also runs 12 fresh browsers before its owned lab stops.
These use the actual qualified Go RPC codec: one validated chain-322 frontier
response releases twelve concurrent `ledger.getMomentumsByPage(0, 30)` reads.
This reproduces the application's staged startup pattern instead of substituting
a Node WebSocket writer. Source/build/runtime identities must match the current
lab manifests. Only bounded ledger reads are sent; no wallet, subscription,
signature, transfer or chain write is involved. The separate sanitized report
does not establish an unobserved historical cause or production acceptance.

# Offline browser IPC diagnostics

The compiled-startup experiment alone enables the pinned headless reporter with
`CHROME_HEADLESS=1`, which disables uploads through Chromium's unattended policy.
It uses a new private dump directory under the experiment's owned CI scratch and
first calibrates an intentionally crashed, unconnected `about:blank` renderer.
That injected renderer crash is reported separately from natural failures.
The production bundle still fails on its first socket error or network-service
replacement; failed starts are never retried.

The standalone browser job first runs that same calibration before any chain
job may start. Both callers await the installed Puppeteer's asynchronous
`defaultArgs()` result before checking reporter flags or launching a browser.
The regression uses that real API without starting a browser.
A failed control leaves chain execution explicitly not run; it
cannot qualify a candidate. The control commits a fresh blank document and
requires an empty pre-crash baseline, one owned request, one new renderer
SIGTRAP dump and the actual complete reader exit while the main browser stays
alive. Optional CDP crash events are retained separately; a target-close outcome
alone cannot qualify the control. It retains fixed phase/refusal categories, helper
exit facts and reader outcomes even on failure. Target identifiers and raw errors
are excluded. Its small artifact allows setup failures to be diagnosed without
repeating completed native tests.

The pinned Linux headless-shell package omits `chrome_crashpad_handler`. The
`browser-transport` and `info` jobs install only that member from the official
full Chrome package at the same version, using a pinned 924,320-byte HTTP range, archive identity, compressed
and uncompressed SHA-256 values, exact sizes and ELF architecture. It refuses a
full-archive response or an unknown existing helper. The pinned headless browser
must retain its exact executable digest. Neither a second browser nor a raw dump
is published. The manifest records the actual component input and reuse status.

### Updating the offline reporter pin

`lab/browser-reporter.pin.json` describes one member of the official Linux
Chrome ZIP. It is not a reusable offset table: every browser version needs a
fresh archive identity, ZIP layout and executable digest. Update it in the same
reviewed change as the browser version in the workflows, lab pins and reporter
validator. Search for the previous version throughout the repository; do not
relax `verifyReporterPin()` to accept arbitrary versions.

1. Select the exact Chrome for Testing version and the official `linux64`
   `chrome-linux64.zip` URL. Record the archive's total byte length and ETag.
   Use bounded, identity-encoded range requests under the artifact cache's
   ownership, quota and lease rules. Reject redirects, a full-archive response,
   changed identities and incomplete output. The ETag is an HTTP identity
   validator, not a substitute for either SHA-256 digest below.
2. Read the ZIP end-of-central-directory record and its central directory with
   explicit bounds. Require one exact
   `chrome-linux64/chrome_crashpad_handler` entry, unencrypted raw DEFLATE
   (method 8). Record its CRC-32, compressed size, uncompressed size and local
   header offset. Refuse unsupported ZIP64 or multi-disk layouts rather than
   guessing offsets. A bounded tail request is enough only when it contains the
   complete directory; never treat a partial directory as a complete listing.
3. Read and validate the local header and exact member name. If its offset is
   `offset`, the payload begins at
   `offset + 30 + fileNameLength + extraFieldLength`; the variable lengths come
   from that header, not from assumptions about earlier versions. Set
   `rangeStart` to that position and
   `rangeEnd = rangeStart + compressedBytes - 1`. Check that the entire member
   fits before the central directory and within `archiveBytes`.
4. Fetch only that compressed range, using `If-Match` with the recorded ETag.
   Require HTTP 206, the exact `Content-Range`, `Content-Length`, ETag and no
   content encoding, as `readPinnedReporterRange()` does. Calculate
   `compressedSha256` over the raw compressed bytes. Inflate with an explicit
   output bound, verify the central-directory size and CRC-32, then calculate
   `sha256` over the complete inflated member. Check the existing 64-bit,
   little-endian x86-64 ELF requirements in `decodeReporterComponent()`.
   Current limits are 512 MiB per archive, 4 MiB compressed and 8 MiB inflated
   per reporter; exceeding them requires a separately reviewed policy change.
5. Obtain the **headless-shell executable** for the same version/platform
   through the pinned browser installer and record its exact SHA-256 as
   `browserSha256`. Do not hash the full Chrome executable instead, replace the
   headless executable or copy a digest from another platform. Keep the
   existing scope value and populate every pin field from these measured
   inputs. Retain source/version, HTTP identities, lengths, digests and actual
   transport outcomes in the private qualification record.
6. Review the pin and matching version guards together. Run the reporter
   component unit tests and Python parser controls, then require fresh Linux
   `browser-transport`, native and Docker qualification for the changed source.
   The standalone job must pass the owned renderer crash calibration, direct
   network allow/deny control and all 48 fresh transport starts. Check the
   reporter manifest against the reviewed pin and confirm that the browser
   digest is unchanged by installation. Unit tests alone do not qualify a new
   browser or reporter, and a successful old-version run does not qualify it.

Keep one protected object per digest and omit raw dumps from every upload.
Regeneration is a maintainer operation; routine CI only consumes the reviewed
pin and must fail on a different archive, member, executable or existing helper.

A failed E2E suite remains fatal while subsequent read-only diagnostic probes
may still run against the same owned lab and an already validated bundle. Each
stage's actual wrapper exit is retained. An 18-minute E2E process-group bound
leaves time for evidence upload within the job's existing 35-minute deadline;
timeout exits leave the child's final outcome unknown. Test, readiness and socket
assertions are unchanged. The reader separately records its real process exit,
signal and output completeness; a complete empty report cannot establish a cause.

The reader follows only bounded Crashpad annotation structures. It skips report
and client identifiers, memory, stacks, environment, paths and unrelated annotation
values. It emits allowlisted Mojo validation/interface/method categories and a
digest of the selected `mojo-message-error` value; unknown strings are never
published. Raw minidumps remain in owned runner scratch and are excluded from
every artifact upload. Missing or refused diagnostics never establish a cause.

The policy and layout follow the pinned Chromium sources for the
[headless reporter](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/headless/lib/headless_crash_reporter_client.cc),
[upload policy](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/components/crash/core/app/crashpad.cc), and
[Crashpad format](https://github.com/chromium/chromium/blob/3ff7ac5a9224be9156d7f8703a06e22890aafd34/third_party/crashpad/crashpad/minidump/minidump_extensions.h).
