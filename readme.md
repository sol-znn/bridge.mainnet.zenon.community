# Zenon bridge

The front end for the Network of Momentum multichain bridge: move ZNN, QSR and
LP tokens between Zenon and Ethereum or BNB Chain, redeem them, stake LP in the
liquidity program, and see whether the orchestrators are signing.

Live at <https://bridge.zenon.foo>. A static site: no backend,
everything is read from a Zenon node and the EVM chains.

## What it does

| View | |
|---|---|
| Bridge | Wrap (Zenon to EVM) through Syrius, unwrap (EVM to Zenon) through any EVM wallet, and swap between EVM assets on Ethereum and BNB Chain without the bridge. Fee, minimum, receive amount, time estimate, recipient plasma check |
| Activity | Every transfer for the connected or tracked addresses, live status and countdown, one-click redeem on either side |
| Liquidity | Add to the wZNN/ETH Uniswap V2 pool, bridge the LP token, stake it for 1 to 12 months, revoke, collect rewards |
| Stats | Orchestrator status derived on chain, waiting requests, pillars seen signing, networks, pairs, fees held, configuration |
| Affiliate | Make a referral link; an active referral shows on every page with a Clear button |

A red banner on every page says when the bridge is down: halted, generating a
key, or not signing (the oldest wrap past finality has waited six hours or
more). As of 2026-10-12 mainnet is in that last state, with requests waiting
34 days.

Swaps (ETH, BNB and the bridge's own EVM tokens, on one chain or across the
two) do not go through the orchestrators. A router quotes one transaction and
the wallet sends it: KyberSwap on one chain, Across between the two, LI.FI
when neither has a route. A swap settles in seconds, needs an EVM wallet only,
and keeps working while the bridge is down. Amounts carry a dollar estimate.
A Bridge or Swap toggle above the form picks the mode; Bridge is the default.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), Swaps and Prices.

What the original app did, flow by flow, is in
[docs/FUNCTIONALITY.md](docs/FUNCTIONALITY.md). Current safety and qualification boundaries are in [docs/QUALIFICATION.md](docs/QUALIFICATION.md); original-operation recovery is in [docs/RECOVERY.md](docs/RECOVERY.md).

## Wallets

- **Zenon:** the Syrius browser extension (`window.zenon`, v0.3.4 and later;
  the older postMessage protocol too; real versions require [integration qualification](docs/SUPPORT.md)). The page tries its configured primary and fallback nodes. "Use Syrius node" in the wallet menu
  switches to the wallet's node after the user confirms its network (Mainnet,
  Testnet or a devnet, from the node's chain identifier). Bridge details are read from the selected node, but new transfers require a verified matching EVM route and fresh safety data. A node switch does not establish support for an arbitrary network.
- **EVM:** any wallet that announces itself by EIP-6963 (MetaMask, Rabby,
  Phantom, Coinbase and others), or `window.ethereum`. Reads go through the
  wallet's own RPC when it is on the right chain.

WalletConnect is not supported: it needs a project id and a remote relay.

## Run it

```sh
npm ci
npm run dev          # http://localhost:5190, mainnet
npm test             # unit tests
npm run build        # dist/, what Pages serves
```

`VITE_NETWORK=devnet` points the app at the e2e devnet. Other settings are in
[docs/DEPLOY.md](docs/DEPLOY.md).

## Layout

```
src/znn/      Zenon primitives, ABI, block template, JSON-RPC client, typed calls
src/evm/      EVM bridge, ERC-20 and Uniswap ABIs, viem clients
src/wallet/   Syrius and EIP-6963 adapters
src/core/     pure logic: fees, status, referral, orchestrator health, plasma bot
src/state/    reactive stores: node, wallets, bridge, activity, referral
src/views/    Bridge, Activity, Liquidity, Stats, Affiliate
tests/unit/   vitest, with mainnet fixtures
e2e/          devnet + anvil harness: both bridge contracts and a test orchestrator
docs/         FUNCTIONALITY, ARCHITECTURE, TESTING, DEPLOY
```

## Docs

- [docs/FUNCTIONALITY.md](docs/FUNCTIONALITY.md): what the original did
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how this one is built, and why
- [docs/TESTING.md](docs/TESTING.md): unit tests and the end-to-end devnet
- [docs/DEPLOY.md](docs/DEPLOY.md): GitHub Pages, acceptance and the tokenless plasma proxy
- [docs/RECOVERY.md](docs/RECOVERY.md): original transaction evidence and unknown outcomes
- [docs/SUPPORT.md](docs/SUPPORT.md): supported capabilities and integration acceptance limits
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md): validation, contribution privacy and confidential reporting boundaries
- [docs/MAINTENANCE.md](docs/MAINTENANCE.md): dependency update policy, distribution notices and owner decisions

## Dropped from the original

Google Tag Manager and the Twitter pixel (remote scripts), WalletConnect, and
the unused "Supernova" network settings.

Local checks and a one-key lab do not qualify production signing or real-wallet distributions. Review [deployment gates](docs/DEPLOY.md) and [source provenance](docs/PROVENANCE.md) before activation.
