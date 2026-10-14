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

## Docker lab

```sh
npm run lab:up
npm run test:e2e
npm run lab:down
```

Docker pins the Go/runtime/Anvil images by digest. `lab.sh` verifies the built image and overlay identities before reuse. `npm run lab:wipe` explicitly deletes only this lab's generated assets and named volumes. Archive evidence first. The Docker path needs independent qualification on a host with a running Docker daemon; a native pass does not prove Docker passed.

The genesis generator backs every declared QSR fusion while preserving total supply; index 1 has 10,000 ZNN and 70,000 spendable QSR plus its fused QSR. Setup deploys/configures the lab bridge/token, and the suites exercise wrap, delayed two-step EVM redemption, unwrap/referral, Zenon redemption and UI behavior. See [qualification boundaries](../docs/QUALIFICATION.md) and [release gates](../docs/DEPLOY.md).
