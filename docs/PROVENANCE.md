# Source provenance and licensing decisions

The [locked dependency notice inventory](DEPENDENCY_LICENSES.json) records installed
package versions, declared license fields and notice-file digests without author or
machine metadata. It is a review input for the [acceptance protocol](ACCEPTANCE.md),
not a bundle composition claim, replacement notice or grant of root licensing
authority. Every production build now preserves exact locked dependency/font notice
texts and their digests in `third-party-notices/`; retain that directory in an
accepted distribution. See [MAINTENANCE.md](MAINTENANCE.md) for scope and validation.

The application contains reconstructed bridge functionality and reused Zenon primitives/ABI/block and wallet adapter code. The existing headers identify origins including `zenon-ptlc/lab/web`, the earlier bridge deployment, `zenon-faucet`, the Syrius adapter, go-zenon consensus code and the HyperCore orchestrator message layouts. Those descriptions are provenance leads, not a grant of authority over missing source or a root license.

`e2e/contracts/Bridge.sol` matches HyperCore-Team/evm-bridge-contracts at `db346b0` apart from provenance comments; its SPDX marker is MIT. It is a lab contract fixture. Matching source does not establish that every deployed contract's bytecode/configuration is identical. OpenZeppelin is an npm dependency pinned by the lockfile. Public fixture mnemonics/accounts are test material and must never be funded on other networks.

Runtime dependency metadata identifies Vue, viem, noble curves/hashes and bech32 as MIT; @lucide/vue as ISC; the local Space Grotesk and JetBrains Mono font packages as OFL-1.1. Preserve each applicable upstream license/notice in distributions. Build tools and vendored fixtures have their own terms. The lockfile, source revision and package trees establish which versions were reviewed.

No repository-wide license is invented by this change. A maintainer must establish ownership of reconstructed code/assets, choose and publish the root license if authorized, and confirm required asset/dependency notices and recovered-source provenance before a public distribution is accepted. Missing source pairing remains unestablished; do not reconstruct it from an attribution comment alone.
