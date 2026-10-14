# Support and integration acceptance

A usable publication environment needs HTTPS (or isolated loopback), ES modules, BigInt, WebSocket, Web Locks and writable durable browser storage. Missing exclusive lock support or failed journal storage pauses signing. Do not remove saved evidence to bypass that gate.

| Integration | Implemented scope | Acceptance limit |
|---|---|---|
| Syrius | Injected provider, validated account/chain/node, exclusive prompts and explicit cooldown retry | Real extension versions/platforms require clean-profile qualification |
| EVM wallets | EIP-6963 discovery and EIP-1193 requests/events, chain/account ownership | Provider behavior, smart-wallet execution and hardware-wallet prompts require integration testing |
| Zenon networks | Selected validated node identity; routes read from embedded bridge | Build-specific explorers, plasma service and liquidity configuration apply only to the configured chain |
| EVM networks | Registered bridge routes with verified read chain/key/decimals/halt | Unknown networks need an appropriate reader and qualified wallet; bridge discovery alone is insufficient |
| Chromium fixtures | Pinned browser in isolated component/page tests | Local Chromium evidence does not qualify Firefox, WebKit, mobile wallets or a real extension |
| Liquidity | Verified configured pool and conservative approval/postcondition/stake controls | Full DEX/LP bridge/expiry/reward lifecycle and distribution require separate acceptance |
| EVM swaps | Captured router quote, durable approval/send identity and authenticated source receipt | Router calldata trust, supported wallet behavior and actual receiving-chain/economic results require separate acceptance |

EVM smart-contract recipients remain valid address types; this does not prove every contract can use the received asset. Zenon recipients/referrers must be user addresses. Zero, malformed and embedded destinations are refused.

Use [original operation recovery](RECOVERY.md) for lost/late responses or legacy storage. Account addresses, amounts and endpoint details in browser exports are private recovery evidence; do not publish them. A maintainer must identify the recovery contact, supported real-wallet versions, platform matrix and release/incident owner before production acceptance. No such contact is inferred from repository usernames.
