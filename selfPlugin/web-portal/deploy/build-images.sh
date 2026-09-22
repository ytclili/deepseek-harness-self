#!/bin/sh
# Preparation installs/builds with the configured proxy; the final image construction is offline.
set -eu
umask 077
source=${1:-/mnt/sata4-2/www/code/deepseek-harness-self}
runtime=${PORTAL_RUNTIME_ROOT:-/mnt/sata4-2/www/code/deepseek-harness-runtime/portal}
base=${PORTAL_BASE_IMAGE:-deepseek-harness-runtime:node24}
image=${PORTAL_IMAGE:-deepseek-harness-portal:0.1.7}
[ "$(uname -s)" = Linux ] || exit 1
[ -d "$source/selfPlugin/web-portal/deploy" ] || { echo 'Harness source checkout required' >&2; exit 1; }
docker image inspect "$base" >/dev/null
mkdir -p "$runtime/build"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
context=$runtime/build/context-$stamp
prepared=$runtime/build/prepared-$stamp
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$script_dir/prepare-runtime.sh" "$source" "$prepared"
docker run --rm --network none --user 0:0 --entrypoint node \
  --mount "type=bind,src=$prepared/payload,dst=/app,readonly" --mount "type=bind,src=$runtime/build,dst=/build" \
  "$base" /app/selfPlugin/web-portal/deploy/create-build-context.mjs /app "/build/context-$stamp"
# No network or secret build args. Docker's existing daemon proxy may resolve a missing base only if explicitly provisioned outside this script.
docker build --network none --pull=false --build-arg "BASE_IMAGE=$base" -t "$image" -f "$context/user.Dockerfile" "$context"
printf '%s\n' "$image" > "$runtime/build/image-$stamp.txt"
echo 'Portal image built; no running service was changed.'
