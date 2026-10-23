# Deployment and acceptance

The reviewed source, local qualification, hosted CI, published artifact and operating bridge service are separate acceptance steps. A successful build or deployment cannot resume TSS signing or prove a threshold ceremony.

## One Pages publisher

A repository administrator must set **Settings > Pages > Source > GitHub Actions**, remove the competing legacy branch/Jekyll publisher, require reviewed changes and qualification checks, configure the `github-pages` environment, and enable **Enforce HTTPS** after the domain certificate is ready. Workflow edits alone do not change those settings. Confirm that only one approved publisher runs for the accepted commit.

The workflow tests and builds pull requests without publishing. Only the deployment job on `main` has Pages and OIDC write permissions. Actions are pinned to commit hashes. `public/CNAME` declares `bridge.zenon.foo`; a fork or project-site deployment must explicitly choose its own domain and `VITE_BASE` before activation. No automatic production activation is implied by a development branch.

Download the accepted `dist` artifact and verify `release-manifest.json`: source commit/tree, dirty flag, source-input hash, lockfile hash, runtime and canonical unpacked file hashes. Reject a dirty production source. Then compare the hosted HTML and referenced asset hashes with that same artifact. A ZIP checksum alone does not establish an identical unpacked tree. Check HTTP redirects, HTTPS delivery and the site's headers after deployment.

## Public build configuration

| Variable | Behavior |
|---|---|
| `VITE_NETWORK` | `mainnet` by default; `devnet` selects isolated fixture endpoints |
| `VITE_ZNN_NODE` | Comma-separated WS/WSS nodes; selected node identity is validated |
| `VITE_EVM_RPCS` | JSON map of chain IDs to public read RPC URLs |
| `VITE_PLASMA_BOT_URL` | A tokenless proxy endpoint; its server holds any upstream credential |
| `VITE_PLASMA_BOT_TOKEN` | Optional owner-approved browser-public plasma token for direct mode |
| `VITE_BASE` | `/` by default; set `/<repository>/` for a project site |

All `VITE_*` values are public once built. The owner deliberately supports a browser-public plasma token with the service's `plasma-bot` ability. The Pages workflow passes that optional secret only to non-PR builds; never use a private or broadly privileged credential for this purpose. No token value belongs in source, reports or review text. With no token or proxy, the plasma action opens the service's own form. A configured proxy receives only the recipient address and no Authorization header, with a ten-second request deadline. Direct mode retains the same deadline and sends its configured browser-public token to the service. The proxy operator must validate user addresses, apply abuse limits, protect its upstream credential, and qualify quota/error behavior; the repository does not deploy that service.

## Browser policy and hosting headers

The HTML declares a CSP that allows local scripts/fonts, local or data/HTTPS images, secure RPC connections and explicitly listed loopback lab endpoints. Objects and form submission are disabled; referrer disclosure is disabled. Theme initialization and the legacy affiliate redirect use external local scripts. Legacy redirects accept only this deployment's origin and URLs without userinfo.

`frame-ancestors` cannot be enforced by a meta CSP. A hosting owner must supply and test an HTTP framing policy, content-type protection and the selected transport policy through a hosting layer that supports headers. GitHub Pages does not supply arbitrary response-header configuration through repository HTML. The `.foo` domain's HSTS preload must be considered when evaluating HTTP behavior. Verify actual post-deployment behavior rather than claiming that a meta tag or DNS change installed server headers.

## Production release gates

1. Independent review of transaction identity, unknown-outcome recovery, wallet handling and conservative send/stake policies.
2. Hosted qualification of the exact accepted source, including the isolated lab; target fork-approval states with zero jobs are pending, never passing.
3. Clean-platform testing with named real extension/provider/browser versions, rejection, account/node changes, late responses and restart recovery.
4. Operator incident explanation, verified threshold-service/ceremony state, and progress of existing exact requests under an accepted recovery procedure.
5. Pool/LP bridge, stake expiry/cancel/collect and distribution qualification in a suitable isolated environment; the one-key lab is not TSS or live-chain evidence.
6. Administrator verification of one Pages publisher, canonical HTTPS delivery, security headers, review rules and matching source/artifact/hosted bytes.
7. Maintainer decisions on licensing, ownership, supported integrations and the production activation decision.

Record an owner role and dated evidence for each gate. If the authorized owner or coordination channel is unavailable, the gate remains open; do not infer acceptance from silence.

These gates have distinct scopes. Frontend review and fixture qualification can proceed while Zenon bridge transfers remain paused. Operator incident recovery and a new-transfer activation decision concern the operating Zenon bridge; deploying frontend files cannot satisfy those gates. EVM swaps use independent third-party routers and require their own wallet, quote-service and destination-outcome acceptance. A source receipt or router status is insufficient evidence of destination delivery.

The plasma proxy gate is conditional. An administrator must record whether the accepted deployment uses direct browser-public-token mode, proxy mode or the service's form, and qualify that selected scope. Restoring configuration support does not inspect a deployed token or establish service authorization. No proxy deployment is required when proxy mode is not selected. Source defaults do not establish deployed repository-variable or secret values.

## What is not deployed

No server, no analytics, no remote scripts. Everything the page needs is in
`dist/`; the workflow fails the build if `dist/` references a CDN.

The page does call third-party APIs at run time: the Zenon and EVM nodes,
zenonhub's plasma bot, and three swap routers, `aggregator-api.kyberswap.com`,
`app.across.to` and `li.quest` (LI.FI, also the source of dollar prices). The
routers need no key. Unkeyed, LI.FI allows 75 quotes per two hours.
