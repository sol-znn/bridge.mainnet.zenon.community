#!/usr/bin/env bash
# Isolated Docker lab. GO_ZENON_DIR must match pins.json; wipe deletes only
# this lab's named volumes and generated assets. Native mode uses native.mjs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="$here/.build"
assets="$here/assets"
export LAB_BRIDGE_ADMIN="z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d"
export LAB_ANVIL_IMAGE
LAB_ANVIL_IMAGE="$(node -p "require(process.argv[1]).anvilImage" "$here/pins.json")"
compose() {
  LAB_ZNND_TAG="$(cat "$build/revision")" docker compose -f "$here/docker-compose.yml" "$@"
}
case "${1:-}" in
  build) node "$here/build.mjs" docker ;;
  up)
    [ -f "$build/manifest.json" ] || node "$here/build.mjs" docker
    node "$here/verify-build.mjs" docker
    expected="$(node -p "require(process.argv[1]).imageId" "$build/manifest.json")"
    actual="$(docker image inspect --format '{{.Id}}' "bridge-lab-znnd:$(cat "$build/revision")")"
    [ "$actual" = "$expected" ] || { echo 'Lab image differs from its manifest; rebuild.' >&2; exit 1; }
    key="$(node -p "require(process.argv[1]).key" "$build/manifest.json")"
    if [ -f "$assets/genesis.json" ]; then
      [ -f "$assets/identity" ] && [ "$(cat "$assets/identity")" = "$key" ] || { echo 'Existing genesis uses different inputs; archive or wipe this lab first.' >&2; exit 1; }
    else
      node "$here/make-assets.mjs" "$build/src/docker/devnet" "$assets"
      printf '%s' "$key" > "$assets/identity"
    fi
    compose up -d
    node "$here/docker-manifest.mjs"
    node "$here/frontier.mjs" 180 --wait 120 --docker
    ;;
  status) compose ps -a; node "$here/frontier.mjs" 30 ;;
  down) compose down ;;
  wipe) compose down -v; rm -rf "$assets" ;;
  *) echo 'usage: lab.sh build|up|status|down|wipe' >&2; exit 2 ;;
esac
