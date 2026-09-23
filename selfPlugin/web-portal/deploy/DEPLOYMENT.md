# iStoreOS deployment

These scripts prepare and operate only the separate portal on port 23080. They do not change the administrator service on 3080, reverse-proxy configuration, DNS, or public routing. Run them on the Linux Docker host only after separately approving deployment.

## Prerequisites

Use a Harness 0.1.7 source checkout at `/mnt/sata4-2/www/code/deepseek-harness-self` containing the updated `enterprise-auth`, `enterprise-tools`, and `web-portal` plugins. `build-images.sh` automatically runs `prepare-runtime.sh`: a disposable source copy is installed and built in the Linux Node 24 container, the reviewed `@xmanrui/dsh-im` version and identity patch are installed into its temporary Web profile, then each plugin runs setup, check, and test. The portal client runs `npm ci`; its test command builds the host and client before testing. A missing portal build is therefore handled by the preparation step. The active source checkout and administrator service remain untouched.

The checkout must have a real `.git` directory. The trusted preparation container mounts it read-only solely for official client build metadata and the enterprise-tools Harness baseline check; Git history is never copied into a context or image. Linked-worktree `.git` files are rejected with a diagnostic rather than guessed. `LEFTHOOK=0` disables hook installation in the disposable copy, not compatibility checks, builds, type checks or tests. The examined build path uses `scripts/`, `native/`, package configuration and repository manifests; those inputs are retained. Agent workflow metadata remains excluded.

The existing `deepseek-harness-runtime:node24` base image, Docker Engine, `nft`, and standard BusyBox utilities must be installed. Preparation is the explicit networked phase: it uses locked pnpm/npm installs, the existing proxy, and private dependency caches under `portal/build/cache`. If needed, native build tools are installed with apt only inside the disposable preparation container. The final image build is offline and passes no model or business secrets as build arguments. Provide disk space for a preparation copy, a final image context, dependency caches and Docker layers; the full upstream build also needs its normal compiler memory budget.

Preparation and the gateway reuse `/mnt/sata4-2/www/code/deepseek-harness-runtime/deploy/proxy.env` when present; `PORTAL_PROXY_ENV_FILE` selects another existing private proxy-only file. Only `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase forms are accepted. Its contents are neither copied to the build context nor printed or automatically copied from another service. Docker injects the existing file through `--env-file`; user containers receive no inherited proxy environment. Keep it outside the source checkout with mode 600. An absent file is valid when the host already provides transparent egress.

## Prepare without starting services

```sh
cd /mnt/sata4-2/www/code/deepseek-harness-self/selfPlugin/web-portal
sh deploy/build-images.sh /mnt/sata4-2/www/code/deepseek-harness-self
sh deploy/portal-service.sh init
```

After preparation succeeds, `build-images.sh` creates a new whitelist context and one image, `deepseek-harness-portal:0.1.7`, for both gateway and user containers. The Dockerfile copies only the generated `payload` directory. The final context excludes Git state, environment files, credentials, runtime data, backups, unrelated custom plugins, and external symlinks. Internal absolute workspace links are rewritten to `/app`; build-only pnpm links to omitted benchmark/website workspaces are removed. Every retained link is resolved in the virtual `/app` payload before image construction, so dangling links fail the build. Linux dependencies and built outputs are retained. Failed and successful copies remain under `portal/build` for operator review; remove only an explicitly selected copy after inspection.

`init` creates `portal/gateway/config.example.json` without overwriting existing private files. Create `portal/gateway/config.json` from that example, verify the NextBOS field mappings and actual public origin, and write the model secret only to `portal/gateway/model.key`. Set both files to mode 600. The default origin is `http://127.0.0.1:23080` for local tunnel validation; it does not authorize a public cutover. Fixed image, runtime mount, policy marker, and model proxy port are checked before start.

## Install isolation, then start

```sh
sh deploy/portal-service.sh start
sh deploy/portal-service.sh status
```

Start takes a private backup, stops only an existing gateway container bearing the expected ownership label, atomically replaces the `inet dsh_portal_guard` nft table, checks the actual nft JSON matches and verdicts, and runs temporary container canaries. It requires gateway-port connectivity, refusal of another live host service and another user's live private-network service, and public TCP egress to `1.1.1.1:443`. Both target listeners are confirmed alive before their denial can count as evidence. Canary containers and networks are removed on success or failure. IPv6 and all listed private, loopback, link-local, multicast and reserved IPv4 forwarding destinations are denied by inspected rules. Public-canary reachability is required; if the host network blocks it, installation fails rather than writing a success marker.

The rule set selects only `dshp*` bridges. User-to-host INPUT permits TCP 23080 and reply traffic for host-initiated connections; other host services are denied. FORWARD denies private destinations before permitting public egress. Docker's own bridge isolation remains enabled. The installer never flushes the complete ruleset. On iStoreOS with fw4, it also writes managed `00-dsh-portal.nft` files under the official `/usr/share/nftables.d/chain-pre/input/` and `chain-pre/forward/` include hooks. These repeat the full scoped deny-before-allow policy, so fw4 does not subsequently reject legitimate model traffic and its reload retains isolation. It checks `fw4 print`, syntax-checks that output, calls the normal `fw4 reload`, and validates the installed rule sequence before running canaries. An unowned same-name include, unsupported hook layout, or unexpected live sequence causes failure with no marker. Other user-defined chains may still block intended traffic; the live canaries detect that.

Only after both checks pass is `/run/dsh-portal/network-policy.json` written. A missing marker prevents gateway startup. `/run` is intentionally transient: after reboot the policy must be installed and verified again. The gateway mounts that directory read-only, uses the host network to reach loopback-published user ports, and is the only portal container given the Docker socket. User instances are created by the runtime manager with their own network and restricted mounts. Existing administrator data is not mounted.

The service waits for the actual `/login` route with the configured Host header before reporting readiness. A failed or timed-out start removes the new gateway container and leaves user data and the verified firewall rules intact.

## Updates, reboot and recovery

```sh
sh deploy/portal-service.sh update /mnt/sata4-2/www/code/deepseek-harness-self
sh deploy/portal-service.sh stop
```

An update backs up the existing `config.json` and `model.key`, builds from a new context, then performs the same stop–policy verification–start sequence. It never replaces private configuration with the example. A failed build leaves the running gateway alone; a failed policy or start leaves the gateway stopped and reports failure. User home/workspace data remain under `portal/users`. Review backups and a previous image before an operator-directed rollback; these scripts do not downgrade data automatically.

After a verified manual start, an operator may copy `deploy/istoreos.init` to `/etc/init.d/dsh-portal`, set mode 755, and enable it. Check its checkout path first. The init service invokes the full policy installation before each boot start; Docker restart policy is deliberately `no` so Docker cannot start the gateway before firewall verification. Managed fw4 chain-pre includes reapply the scoped policy on fw4 reload, while the separate early guard adds the same restrictions. Stop the portal before any operation that flushes the entire nft ruleset or changes these includes, then run the full start sequence afterward. Reinstall after a firmware upgrade before permitting the gateway to start. There is no automatic public routing change.

Local fixture tests and shell syntax checks do not replace Linux Docker/nft acceptance. This delivery has not executed these scripts against a production host.
