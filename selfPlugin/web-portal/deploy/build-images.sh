#!/bin/sh
# Preparation installs/builds with the configured proxy; the final image construction is offline.
set -eu
umask 077
source=${1:-/mnt/sata4-2/www/code/deepseek-harness-self}
runtime=${PORTAL_RUNTIME_ROOT:-/mnt/sata4-2/www/code/deepseek-harness-runtime/portal}
base=${PORTAL_BASE_IMAGE:-deepseek-harness-runtime:node24}
platform=${PORTAL_PLATFORM:-linux/amd64}
runtime_image=${PORTAL_RUNTIME_IMAGE:-crpi-hr2qiw4orf9zv9b5.cn-hangzhou.personal.cr.aliyuncs.com/nextbos/deepseek-harness-runtime:0.1.7}
gateway_image=${PORTAL_GATEWAY_IMAGE:-crpi-hr2qiw4orf9zv9b5.cn-hangzhou.personal.cr.aliyuncs.com/nextbos/deepseek-harness-portal:0.1.7}
case "$(uname -s)" in Linux|Darwin) ;; *) exit 1;; esac
[ -d "$source/selfPlugin/web-portal/deploy" ] || { echo 'Harness source checkout required' >&2; exit 1; }
docker image inspect "$base" >/dev/null 2>&1 || docker pull --platform "$platform" "$base"
mkdir -p "$runtime/build"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
context=$runtime/build/context-$stamp
prepared=$runtime/build/prepared-$stamp
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$script_dir/prepare-runtime.sh" "$source" "$prepared"
docker run --rm --platform "$platform" --network none --user 0:0 --entrypoint node \
  --mount "type=bind,src=$prepared/payload,dst=/app,readonly" --mount "type=bind,src=$runtime/build,dst=/build" \
  "$base" /app/selfPlugin/web-portal/deploy/create-build-context.mjs /app "/build/context-$stamp"
# No network or secret build args. Docker's existing daemon proxy may resolve a missing base only if explicitly provisioned outside this script.
docker build --platform "$platform" --network none --pull=false --build-arg "BASE_IMAGE=$base" -t "$runtime_image" -f "$context/user.Dockerfile" "$context"
docker tag "$runtime_image" "$gateway_image"
printf '%s\n%s\n' "$runtime_image" "$gateway_image" > "$runtime/build/image-$stamp.txt"
if [ "${PORTAL_PUSH:-0}" = 1 ]; then
  docker push "$runtime_image"
  docker push "$gateway_image"
fi
echo 'Runtime and gateway images built from one payload; no running service was changed.'
