# Web login and per-user Harness implementation plan

## P0 Original request

The user approved replacing mock login with existing NextBOS account validation, opaque browser sessions, per-user Docker Harness environments, a shared HTTP/WebSocket entry point, and all durable storage under /mnt/sata4-2. No shared administrator launch token is exposed to users.

## P1 Scope

Scope: selfPlugin/web-portal, narrow enterprise-auth exports/runtime adapter, per-user business tool credential wiring, selfPlugin documentation. No official packages changes, ERP schemas, order API changes, IM duplication, Git commits or public-server cutover before test evidence. Route: risk=full execution=direct-with-disjoint-staged-writers verification=real-path-and-independent. Preserve existing uncommitted changes. Maximum 45 owned source/config/test files.

## P2 Context evidence

Native webserver permits one fallback and exact upgrade paths; gateway must be a separate dsh profile without native Connection. Existing enterprise-auth HTTP backend validates email/password and returns tenant/user/token, while its tool entry is IM-only. Existing goods_list uses a configured shared token; per-user instances must supply their own token. Native Harness startup refuses --host 0.0.0.0 but the webserver schema permits an explicit config patch. Docker server and data root are on /mnt/sata4-2; gateway and isolated containers must not share live admin home or Docker socket with user instances.

## P3 Acceptance

- A1: Real backend login adapter reused; invalid credentials never produce a browser session or user runtime. Passwords are neither persisted nor logged nor sent to model.
- A2: Opaque HttpOnly cookie, bounded in-memory sessions, expiry/revocation, same-origin mutations, bounded login input/rate/concurrency, and no account/tenant ids trusted from browser.
- A3: Verified tenant/user selects a stable hashed runtime key; HTTP and WebSocket proxy only that runtime; client headers/cookies cannot override identity/internal destination. Native tokens/cookies never reach browser.
- A4: Per-user Docker network, no host-network/privileged/socket/shared data mounts, nonroot user, limited resources, bounded activation and same-user singleflight, persistent private home/workspace; cap rejects additional users without switching them into another instance.
- A5: Business credentials are per-user, shared model secrets stay outside model-visible user containers, IM/scheduler excluded. No production writes or model calls in tests.
- A6: UI uses real login/session/logout lifecycle, clears passwords, reports account and runtime errors, removes mock success paths.
- A7: Tests cover two users, forged identifiers/cookies, expiry/logout, rejected login, Docker launch/cleanup limits, proxy streaming/WebSocket and failure teardown; staging profile and real Docker two-user smoke verify formal entry.

## P4 Worker slices

Auth/UI worker owns sessions.ts, login-controller.ts, identity.ts, their tests, and client src only. Runtime worker owns docker-client.ts, runtime-manager.ts and focused runtime tests. Owner owns gateway/proxy, profiles/scripts, per-user business/model adapter, docs, integration, and repository sync. Common types are src/contracts.ts. Work in staging first; main owner serializes copying into actual repo.

## P5 Dispatch

Use test-first implementation and report exact commands/outcomes. No commits, no live-service writes, no credentials in test output. Independent reviewers inspect the final changed surface and security invariants before runtime deployment.

## P6 Verification

Typecheck/build, focused node tests with fake secrets, targeted lint. Real gateway composition via dsh profile, browser login failure/form/expiry checks, two-user Docker isolation on server using local test identity backend, private file canaries, revoked WebSocket checks. Production auth enabled separately; no genuine user passwords have been supplied, so real-account success must not be claimed from fake-backend tests.

## P7 Integration

Current local branch; no commit/push. Keep old server/IM service running while validating alternate entry port. Deliver runnable configuration and explicit evidence; only migrate public entry after all necessary safety/compatibility checks. Staging logs remain outside repository.

## P8 Ledger

- [ ] Authentication/session and UI
- [ ] Container manager and secure seed layout
- [ ] HTTP/WebSocket gateway and business/model identity wiring
- [ ] Test-first failures observed, focused checks passing
- [ ] Independent review findings closed
- [ ] Real profile and Docker/browser evidence
- [ ] README, deployment and remaining acceptance documented
