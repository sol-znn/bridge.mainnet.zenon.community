# Testing

Install the committed dependency graph with `npm ci`. Use a supported Node release from `package.json`; CI targets Node 22, 24 and 26. Local qualification and hosted results are separate.

```sh
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=low
npm run build
CHROME_PATH=<pinned-headless-shell> npm run test:browser
```

## Deterministic source checks

`tests/unit` covers recorded ABI/signature vectors, exact fees/amounts, recipient/referral eligibility, complete bounded history, schema/RPC failure handling, retired node/account responses, fail-closed route/health authority, journal persistence and original-outcome recovery, EVM receipt identity, compiler-cache inputs and retry-safe lab publications. Fixtures contain public test accounts; no wallet or production write is used.

Coverage thresholds apply to the selected safety modules listed in `vite.config.ts`, not the whole application. State ownership, orchestration and browser focus have additional targeted tests. A percentage is not a security proof.

The journal retention regression creates and rejects 205 entries through the durable APIs. It has a twenty-second test budget because coverage instrumentation on shared CI runners can exceed the default five seconds. Its record-count and unresolved-operation assertions remain required.

## Offline browser qualification

`tests/browser` mounts the actual Vue components and uses isolated providers. Outbound network requests are refused; the disconnected-wallet fallback is served by a loopback fixture. It checks all five views at 320/375/768/1024/1440 pixels in light/dark themes with connected/disconnected wallets, modal keyboard/focus behavior, reduced motion, strict amount/recipient checks, late original results, queued economic changes, reverted receipts, same-origin redirects and real cross-tab Web Locks.

Liquidity cases cover unavailable/substituted pools, reverted approvals, LP completion postconditions, zero/halted/unavailable programs, source changes before a queued stake, complete paginated stake history, expiry cancellation and submitted-only collection. These fixtures do not establish DEX contract behavior, real LP minting, stake economics or a production reward cycle. Results and screenshots are written to ignored `.browser-results`.

Browser launch keeps Chromium's default sandbox. On Ubuntu 24.04, the qualification workflow loads a root-owned AppArmor profile granting user namespaces to the exact pinned headless-shell executable and retains that profile with its evidence artifact. A browser launch failure fails qualification. Local Linux environments may need the corresponding [Chromium namespace configuration](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Isolated protocol and page checks

Follow the [pinned lab setup](../e2e/README.md), require successful readiness, then run:

```sh
npm run test:e2e
```

The suites run sequentially because administrator/orchestrator/user fixture sends share one account. They exercise wrap, two delayed EVM redeems, unwrap/referral, Zenon redemption and exact balances, then the actual page with its node/contract reads and injected wallet adapters. `built.e2e.test.ts` also builds the devnet production bundle, serves its actual HTML/CSP and checks routes, absence of development stores and external requests, and mobile layout with disconnected wallets. It records loaded initial JavaScript sizes and hashes separately from later route loads. The lab asserts loopback endpoints and chain IDs before writes. No mainnet funds are used.

Protocol delay tests disable interval mining and control EVM blocks explicitly; UI receipt waits restore interval mining. Zenon publication acknowledges a momentum with depth three and waits until a receive source is included before signing. Unknown publications retain the exact signed block and stop replacements. Preserve a failed run before creating a fresh isolated chain.

The one-key orchestrator does not exercise distributed TSS. Native and Docker evidence are separate; a native pass cannot qualify Docker. Real wallet/platform tests, a full pool-to-LP-to-stake lifecycle, independent review, hosted CI and deployment/operator acceptance remain [external gates](QUALIFICATION.md).

### Swaps on a mainnet fork (`e2e/swap.fork.mjs`)

Swaps cannot run on the lab: the routers quote mainnet. This script drives the
page in headless Chrome with a mock EIP-6963 wallet that forwards to an anvil
fork of Ethereum, so the quoted transactions really execute:

```
docker run -d --rm --name swap-fork -p 127.0.0.1:46599:8545 --entrypoint anvil \
  ghcr.io/foundry-rs/foundry:v1.8.5@sha256:32c8ea9ef052a440cb1620175987a3f49eff8b068a0c6a3d09ebf7f5f9a0e043 --host 0.0.0.0 --chain-id 1 \
  --accounts 0 --block-time 1 --no-storage-caching \
  --allow-origin http://127.0.0.1:5231 --fork-url https://ethereum-rpc.publicnode.com
SWAP_FORK=http://127.0.0.1:46599 CHROME_PATH=<pinned-fixture-browser> npm run test:swap
docker rm -f swap-fork
```

It checks the Bridge and Swap modes (what each picker offers, the bridge
banner hidden in Swap), the dollar estimates, the unfiltered pickers, a wallet refusal
reading "Declined in wallet", no terms prompt, ETH to wZNN and back through
KyberSwap with an approve and a custom recipient, and the sending half of ETH
to BNB through Across. It calls the live router APIs, so it is not part of
`npm test`, and arrival on the other chain is beyond what a fork can show.
Start a fresh fork for each run: the routers quote live prices, and an old
fork drifts from them.
Keep mining enabled so receipt checks can observe their required confirmations.
The fixture waits for the exact original hash to be confirmed in the journal
before starting another publication. It stops on an unresolved original operation.


The fork script is inherited upstream integration tooling. It was not run as part of the offline or two-chain devnet qualification. Use a fresh isolated fork, the pinned browser and public fixture accounts; never connect a real funded wallet. Router API success or a local fork receipt does not prove destination-chain delivery.

The fixture refuses a nonliteral-loopback endpoint, credentials/routing data,
redirects, the wrong Anvil version or chain, and missing fork metadata before
fixture writes. It also requires the pinned browser. The mock wallet forwards to
the same bounded Node RPC adapter; responses are paired to their request and capped
at 256 KiB with an eight-second deadline. Browser and Vite cleanup are both attempted
on failure. Use only a fresh fork owned by this qualification run; endpoint/client
identity alone does not establish ownership of an existing local service.

The preflight follows the pinned Anvil schema: execution identity is in
`anvil_nodeInfo.environment.chainId`; `anvil_metadata.forkedNetwork` must identify
Ethereum chain 1, the same fork block number and a valid block hash. A local
`--chain-id 1` override does not establish the fork source's chain. See the
[v1.8.5 RPC handlers](https://github.com/foundry-rs/foundry/blob/v1.8.5/crates/anvil/src/eth/api.rs).

Set `BROWSER_PROFILE_DIR` and `QUALIFICATION_CACHE_DIR` to the owned task's private
locations. Preserve an interrupted journal/profile and actual exit evidence. A
missing fork, tool or browser is `NOT_RUN`, not a skipped successful integration.
Browser fixture servers and compiled fixture builds do not load local dotenv
files. Supply fixture overrides explicitly through the process environment.

The offline swap component case uses router and wallet stand-ins, delays the original wallet reply, changes the selected account, and verifies that the durable record retains the original payload, amount, account and hash. Parser regressions reject expired/malformed replies, unsafe amounts and malformed calldata. `readiness.test.ts` rejects a node returning the same genesis hash when a recent height was requested, as well as missing, wrong-chain and divergent responses.

The browser runner accepts `BROWSER_RESULTS_DIR`, `BROWSER_PROFILE_DIR` and `QUALIFICATION_CACHE_DIR` for private owned qualification locations. Reports and screenshots remain private until explicitly reviewed for export. Qualification storage and fixture caches must not overwrite historical evidence.

Router replies are streamed with a 256 KiB body limit, integer amounts must fit uint256, and calldata is bounded to leave room for durable quote metadata. The private operation payload retains the chosen assets, recipient, amount, minimum output and expiry after reload; these are intended quote values, not authenticated destination results.

Qualification retains each Node matrix job's mainnet `dist` as a separate artifact. Compare their source/lock identities and canonical asset-tree hashes; runtime-specific release manifests are expected to differ. Artifact upload grants no Pages deployment rights. A fork lacking the Pages workflow on its default branch cannot dispatch that workflow; do not move or publish a default branch to bypass this refusal.
