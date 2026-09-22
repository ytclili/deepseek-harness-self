#!/bin/sh
# Networked Linux build/test preparation happens in a disposable source copy, not the live checkout.
set -eu
umask 077
if [ "${1:-}" = --inside ]; then
  cd /app
  export LEFTHOOK=0
  export CI=1
  export NODE_USE_ENV_PROXY=1
  export http_proxy=${http_proxy:-${HTTP_PROXY:-}}
  export https_proxy=${https_proxy:-${HTTPS_PROXY:-}}
  if ! command -v make >/dev/null || ! command -v g++ >/dev/null || ! command -v python3 >/dev/null || ! command -v git >/dev/null; then
    command -v apt-get >/dev/null || { echo 'Base image needs make, g++, python3 and git for Linux builds' >&2; exit 1; }
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3 pkg-config ca-certificates git
  fi
  git config --global --add safe.directory /app
  pnpm install --frozen-lockfile --store-dir /cache/pnpm
  pnpm run build
  for plugin in enterprise-auth enterprise-tools web-portal; do
    node "selfPlugin/$plugin/scripts/link-harness.mjs" /app
    if [ "$plugin" = web-portal ]; then npm --prefix selfPlugin/web-portal/client ci --cache /cache/npm --no-audit --no-fund; fi
    npm --prefix "selfPlugin/$plugin" run check
    npm --prefix "selfPlugin/$plugin" test
  done
  exit 0
fi
[ "$(uname -s)" = Linux ] || exit 1
source=${1:-/mnt/sata4-2/www/code/deepseek-harness-self}
[ -d "$source/.git" ] && [ ! -L "$source/.git" ] || { echo 'A checkout with a real .git directory is required for the plugin compatibility gate' >&2; exit 1; }
runtime=${PORTAL_RUNTIME_ROOT:-/mnt/sata4-2/www/code/deepseek-harness-runtime/portal}
base=${PORTAL_BASE_IMAGE:-deepseek-harness-runtime:node24}
target=${2:?A new preparation directory is required}
case "$target" in "$runtime"/build/prepared-*) ;; *) echo 'Preparation target must be a new portal/build/prepared-* directory' >&2; exit 2;; esac
mkdir -p "$runtime/build/cache"
name=${target##*/}
docker run --rm --network none --user 0:0 --entrypoint node \
  --mount "type=bind,src=$source,dst=/app,readonly" --mount "type=bind,src=$runtime/build,dst=/build" \
  "$base" /app/selfPlugin/web-portal/deploy/create-build-context.mjs /app "/build/$name" --prepare --host-source "$source"
set --
proxy_file=${PORTAL_PROXY_ENV_FILE:-/mnt/sata4-2/www/code/deepseek-harness-runtime/deploy/proxy.env}
if [ -f "$proxy_file" ]; then
  [ ! -L "$proxy_file" ] || exit 1
  docker run --rm --network none --user 0:0 --read-only --entrypoint node \
    --mount "type=bind,src=$proxy_file,dst=/proxy.env,readonly" "$base" --input-type=module -e '
import {readFileSync} from "node:fs";const text=readFileSync("/proxy.env","utf8");if(text.length>65536)throw Error("Proxy settings too large");for(const line of text.split(/\r?\n/)){if(!line||line.startsWith("#"))continue;if(!/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)=[^\r\n\0]*$/.test(line))throw Error("Unexpected proxy environment field");}
'
  set -- --env-file "$proxy_file"
fi
# Host networking reuses a host-loopback proxy. Only this trusted build phase receives proxy variables.
docker run --rm --network host --user 0:0 --entrypoint sh "$@" \
  --mount "type=bind,src=$target/payload,dst=/app" --mount "type=bind,src=$runtime/build/cache,dst=/cache" \
  --mount "type=bind,src=$source/.git,dst=/app/.git,readonly" \
  "$base" /app/selfPlugin/web-portal/deploy/prepare-runtime.sh --inside
echo 'Prepared and tested Linux Harness and portal artifacts; live checkout was not changed.'
