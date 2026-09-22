# Portal 0.1.7 delivery plan

## P0 Intent
The user approved local completion of the existing account login portal, verification of user isolation, deployment scripts, and subsequent Chinese commit/push. Do not change the production server in this implementation turn.

## P1 Scope and route
risk=full execution=direct-with-disjoint-staging verification=real-path-and-independent. Scope: selfPlugin/web-portal and selfPlugin/README.md. No ERP schema, order tools, or official Harness changes. Keep the existing login design and backend email/password adapter. Existing separate gateway and per-user Docker design remains authoritative.

## P2 Evidence
Server web profile contains only IM, auth, goods, scheduler; anonymous /login is 404. Portal peers and runtime settings seed still target 0.1.6. Existing portal code uses verified tenant/user identity to select containers but has not been fully deployed. Old local staging contains unintegrated fixes that require review before reuse.

## P3 Acceptance
- A1: Setup and all portal builds/tests support current Harness 0.1.7; wrong versions fail before linking.
- A2: Invalid login gets no session; valid fixture backend identity alone selects a runtime; two users and two tenants cannot share native credentials, requests, history, files, model grants, or business tokens.
- A3: Logout/expiry revoke streaming and WebSocket access; no native token is delivered to browser. Existing ERP backend is reused without database changes.
- A4: Formal dsh gateway and user profile entrypoints load current settings/provider interfaces. Keyless local smoke exercises real Harness sessions; real Docker isolation is verified when the local daemon permits it. Record environmental gaps explicitly.
- A5: Deployment is complete and repeatable, uses runtime/portal on /mnt/sata4-2, preserves private config/data, keeps old IM/admin 3080 operational, starts gateway at 23080, and provides actual network policy enforcement. Public reverse-proxy cutover is a documented separate operation.
- A6: README explains real implemented behavior and validation limits; no mock-login claims for a real adapter, no claims of production deployment.

## P4 Ownership
Owner: peers/setup, runtime settings and entrypoints, gateway integration, smoke, docs, serialized integration. Auth reviewer: read-only lifecycle/security review. Deployment worker: deploy/, examples/gateway.json, tests/deploy.test.mjs and tests/network-policy.test.mjs only. Further src fixes assigned explicitly.

## P5 Execution
- [x] Reproduce setup/runtime/profile failures and inspect old staging fixes.
- [x] Fix version guard, settings and profile compatibility with regression tests.
- [x] Repair reviewed isolation defects and integrate deployment scripts.
- [x] Run focused tests, formal profile/browser smokes and independent review; record unavailable Docker evidence below.
- [x] Sync only owned changes to local repo, run required checks, prepare Chinese commit/push; remote publication is verified in the task completion report.

## P6 Evidence
Keep fake credentials in temp test roots, actual model/ERP calls disabled. Use existing source version and session tests plus updated entrypoint fixtures. Never copy the administrator .dsh into user containers. Logs exclude real credentials.

## P7 Integration
Current main branch, initially clean after the Harness compatibility commit. Writable staging is /Users/yifeisun/Documents/Playground/portal-017. Owner integrates tested files and inspects hooks. No force push. Production remains unchanged.

## P8 Review
Acceptance/evidence results and unresolved environment limitations are recorded here before completion. Do not claim Docker or production verification from mock tests.

- Formal compiled CLI: two independent user profiles load the configured model; Alice's created Session appears only in Alice's list; native cookies cannot cross instances. Legacy settings no longer override the provider. Dedicated gateway rejects wrong credentials through the enterprise HTTP adapter.
- Independent lifecycle/proxy review: 71 focused tests passed and no new isolation blocker identified. Real model/ERP calls were excluded.
- Browser acceptance found and fixed URLSearchParams normalization corrupting native module-combo URLs. Real module responses match direct upstream bytes. Browser login, workspace loading, account navigation and logout passed; the account row reserves space above the native layout and does not overlap the right sidebar toggle.
- Full test execution exposed temporary-directory removal before child exit. Cleanup now awaits every child before removing the root; two concurrent independent profile-test processes both passed.
- Deployment context was checked against the actual dependency tree. Linux image build, live nft rules, and container canaries have not been executed locally or in production; scripted host acceptance remains required before public deployment.
- A disposable local Docker nft check made no progress and created no container; its CLI process was terminated. No host firewall or production configuration was modified.
- Final portal build and typecheck passed, with all 110 tests passing in staging. Integration into the actual checkout passed setup/check and 109 tests; the remaining gateway profile test overlapped the documentation build replacing the CLI artifact, then both profile cases passed when rerun after the documentation build finished.
- Repository doc-sync: 39 passed, 3 failed. The failures match the previously verified baseline: five selfPlugin README bilingual pairs, the official configuration catalog, and enterprise-tools compatibility hash references. No hook or check was disabled.
