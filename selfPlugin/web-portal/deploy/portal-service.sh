#!/bin/sh
# iStoreOS/BusyBox entry: init, start, stop, update, status. No public proxy/DNS changes.
set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime=${PORTAL_RUNTIME_ROOT:-/mnt/sata4-2/www/code/deepseek-harness-runtime/portal}
image=${PORTAL_IMAGE:-deepseek-harness-portal:0.1.7}
container=deepseek-harness-portal-gateway
label=io.dsh.portal.gateway
port=23080
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo 'Linux Docker host root required' >&2; exit 1; }
case "$runtime" in /*) ;; *) exit 2;; esac
mkdir -p "$runtime/gateway" "$runtime/users" "$runtime/backups"
[ ! -L "$runtime" ] && [ ! -L "$runtime/gateway" ] || exit 1
chmod 700 "$runtime" "$runtime/gateway" "$runtime/backups"
owned() { [ "$(docker inspect -f '{{index .Config.Labels "io.dsh.portal.gateway"}}' "$container" 2>/dev/null || :)" = web-portal ]; }
stop_gateway() {
  if docker inspect "$container" >/dev/null 2>&1; then
    owned || { echo 'Gateway container name is owned by another service' >&2; exit 1; }
    docker stop --time 30 "$container" >/dev/null
    docker rm "$container" >/dev/null
  fi
}
backup() {
  backup_dir=$(mktemp -d "$runtime/backups/config.XXXXXX")
  for file in config.json model.key; do
    if [ -f "$runtime/gateway/$file" ]; then [ ! -L "$runtime/gateway/$file" ] || exit 1; cp -p "$runtime/gateway/$file" "$backup_dir/$file"; fi
  done
  chmod 700 "$backup_dir"
}
start_gateway() {
  [ -f "$runtime/gateway/config.json" ] && [ -s "$runtime/gateway/model.key" ] || { echo 'Create private gateway/config.json and gateway/model.key first; existing files are never overwritten.' >&2; exit 1; }
  [ ! -L "$runtime/gateway/config.json" ] && [ ! -L "$runtime/gateway/model.key" ] || exit 1
  chmod 600 "$runtime/gateway/config.json" "$runtime/gateway/model.key"
  docker image inspect "$image" >/dev/null
  # Validate fixed mount/port settings before stopping anything or installing rules.
  docker run --rm --network none --user 0:0 --read-only --entrypoint node \
    --mount "type=bind,src=$runtime/gateway/config.json,dst=/config.json,readonly" "$image" --input-type=module -e '
import {readFileSync} from "node:fs";const c=JSON.parse(readFileSync("/config.json","utf8"));
if(c.docker.hostDataRoot!==process.argv[1]||c.docker.dataRoot!=="/srv/portal"||c.docker.image!==process.argv[2]||c.model.runtimeBaseUrl!=="http://host.docker.internal:23080/portal/model/v1"||c.model.apiKeyFile!=="/srv/portal/gateway/model.key"||c.networkPolicyFile!=="/run/dsh-portal/network-policy.json")throw Error("Deployment paths, policy, image or port mismatch");
' "$runtime" "$image"
  set --
  proxy_file=${PORTAL_PROXY_ENV_FILE:-/mnt/sata4-2/www/code/deepseek-harness-runtime/deploy/proxy.env}
  if [ -f "$proxy_file" ]; then
    [ ! -L "$proxy_file" ] || exit 1
    docker run --rm --network none --user 0:0 --read-only --entrypoint node \
      --mount "type=bind,src=$proxy_file,dst=/proxy.env,readonly" "$image" --input-type=module -e '
import {readFileSync} from "node:fs";const value=readFileSync("/proxy.env","utf8");
if(value.length>65536)throw Error("Proxy settings too large");
for(const line of value.split(/\r?\n/)){if(!line||line.startsWith("#"))continue;if(!/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)=[^\r\n\0]*$/.test(line))throw Error("Unexpected proxy environment field");}
'
    set -- --env-file "$proxy_file"
  fi
  stop_gateway
  sh "$script_dir/install-network-policy.sh" install "$port" "$image"
  docker run -d --name "$container" --label "$label=web-portal" --restart no \
    --network host --user 0:0 --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges:true --memory 1g --cpus 1 --pids-limit 256 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=134217728,mode=1777 \
    --mount "type=bind,src=$runtime,dst=/srv/portal" \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount type=bind,src=/run/dsh-portal,dst=/run/dsh-portal,readonly \
    --env PORTAL_PORT=23080 "$@" --entrypoint node "$image" /app/selfPlugin/web-portal/scripts/gateway-entrypoint.mjs >/dev/null
  ready=0
  while [ "$ready" -lt 60 ]; do
    if docker exec "$container" node -e 'const c=JSON.parse(require("node:fs").readFileSync("/srv/portal/gateway/config.json","utf8"));const req=require("node:http").get({host:"127.0.0.1",port:23080,path:"/login",headers:{host:new URL(c.publicOrigin).host}},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on("error",()=>process.exit(1));req.setTimeout(1000,()=>{req.destroy();process.exit(1)})' >/dev/null 2>&1; then break; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || :)" = true ] || break
    ready=$((ready + 1))
    sleep 1
  done
  if [ "$ready" -ge 60 ] || [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || :)" != true ]; then
    stop_gateway
    echo 'Gateway readiness failed; inspect private local Docker logs.' >&2
    exit 1
  fi
  echo 'Gateway started on 23080. Administrator 3080 and public routing were not changed.'
}
case ${1:-} in
  init)
    backup
    if [ ! -e "$runtime/gateway/config.example.json" ]; then cp "$script_dir/../examples/gateway.json" "$runtime/gateway/config.example.json"; fi
    echo 'Edit a private gateway/config.json from config.example.json; create model.key with mode 600. No service started.'
    ;;
  start) backup; start_gateway ;;
  update) backup; sh "$script_dir/build-images.sh" "${2:-/mnt/sata4-2/www/code/deepseek-harness-self}"; start_gateway ;;
  stop) stop_gateway ;;
  status) docker inspect -f '{{.State.Status}}' "$container" ;;
  *) echo 'Usage: portal-service.sh init|start|stop|update [SOURCE]|status' >&2; exit 2 ;;
esac
