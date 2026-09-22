#!/bin/sh
# Real container canaries. Run with the gateway stopped; all probes are removed on exit.
set -eu
image=${1:-deepseek-harness-portal:0.1.7}
port=${2:-23080}
case "$port" in ''|0*|*[!0-9]*) exit 2;; esac
[ "${#port}" -le 5 ] && [ "$port" -lt 65535 ] || exit 2
denied_port=$((port + 1))
name=dsh-portal-check-$$
network_a=$name-a
network_b=$name-b
host_started=0
peer_started=0
network_a_created=0
network_b_created=0
cleanup() {
  [ "$host_started" = 0 ] || docker rm -f "$name-host" >/dev/null 2>&1 || :
  [ "$peer_started" = 0 ] || docker rm -f "$name-peer" >/dev/null 2>&1 || :
  [ "$network_a_created" = 0 ] || docker network rm "$network_a" >/dev/null 2>&1 || :
  [ "$network_b_created" = 0 ] || docker network rm "$network_b" >/dev/null 2>&1 || :
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
docker network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false --opt "com.docker.network.bridge.name=dshpv$$" "$network_a" >/dev/null
network_a_created=1
docker network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false --opt "com.docker.network.bridge.name=dshpw$$" "$network_b" >/dev/null
network_b_created=1
# The first listener proves INPUT permission; the second proves the host deny rule.
docker run -d --name "$name-host" --network host --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --pids-limit 64 --entrypoint node "$image" --input-type=module -e 'import {createServer} from "node:net"; for (const port of process.argv.slice(1)) { const server=createServer(socket=>socket.end()); server.on("error",()=>process.exit(1)); server.listen(Number(port),"0.0.0.0"); }' "$port" "$denied_port" >/dev/null
host_started=1
docker run -d --name "$name-peer" --network "$network_b" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --pids-limit 64 --entrypoint node "$image" --input-type=module -e 'import {createServer} from "node:net"; createServer(socket=>socket.end()).listen(Number(process.argv[1]),"0.0.0.0")' "$denied_port" >/dev/null
peer_started=1
peer_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name-peer")
# Probe readiness from the target namespaces so an absent listener cannot produce a false isolation pass.
ready=0
while [ "$ready" -lt 20 ]; do
  if docker exec "$name-host" node -e 'const net=require("node:net");let n=0;for(const p of process.argv.slice(1)){const s=net.connect(Number(p),"127.0.0.1",()=>{s.destroy();if(++n===2)process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1))}' "$port" "$denied_port" >/dev/null 2>&1 && docker exec "$name-peer" node -e 'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1))' "$denied_port" >/dev/null 2>&1; then break; fi
  ready=$((ready + 1))
  sleep 1
done
[ "$ready" -lt 20 ] || { echo 'Isolation probe listeners unavailable' >&2; exit 1; }
docker exec "$name-host" node -e 'const s=require("node:net").connect(Number(process.argv[2]),process.argv[1],()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1))' "$peer_ip" "$denied_port" || { echo 'Host-initiated runtime connection or reply is blocked' >&2; exit 1; }
docker run --rm --network "$network_a" --add-host host.docker.internal:host-gateway --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --pids-limit 64 --entrypoint node "$image" --input-type=module -e '
import {connect} from "node:net";
const [port,denied,peer]=process.argv.slice(1);
async function reachable(host,port){return new Promise(resolve=>{const s=connect(Number(port),host);let done=false;const finish=value=>{if(done)return;done=true;s.destroy();resolve(value)};s.on("connect",()=>finish(true));s.on("error",()=>finish(false));s.setTimeout(2500,()=>finish(false));})}
if(!await reachable("host.docker.internal",port))throw Error("Gateway route blocked");
if(await reachable("host.docker.internal",denied))throw Error("Host service exposed");
if(await reachable(peer,denied))throw Error("Cross-user private network exposed");
if(!await reachable("1.1.1.1",443))throw Error("Public network route unavailable");
console.log("Gateway route, host isolation, cross-network isolation and public egress verified.");
' "$port" "$denied_port" "$peer_ip"
