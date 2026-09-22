# Web portal plugin implementation plan

**Goal:** Package the approved login preview as a Harness plugin in selfPlugin/web-portal.

**Architecture:** Public /login and /web-portal assets; the unauthenticated root displays the login page. Native Connection remains the only authority granting access to the original Harness UI and API. No database, account verification, credential storage, or user isolation is introduced.

**Tech stack:** Cordis, Node HTTP, TypeScript, React 18, Ant Design 5, Vite.

- [x] Add HTTP regression tests before routing implementation: anonymous page, native token/cookie exchange, protected API, denied untrusted requests, GET/HEAD, static containment, effect teardown.
- [x] Implement src/index.ts using public webServer and connection services. Fail startup when built assets are absent. Never inject native boot state into public HTML.
- [x] Copy the approved UI into client/, build assets under /web-portal/, and keep account-service-unavailable messaging explicit.
- [x] Add package metadata, setup script, bundle patch, README and deployment instructions. Keep existing plugins and server untouched.
- [x] Run npm run check and npm test, then a disposable dsh profile on a separate local port and browser verification.

This is an in-place local implementation; no Git commit, branch change or server deployment is part of this task.

Validation on 2026-09-22: TypeScript check, Vite build, 10 HTTP tests and targeted oxlint passed. An isolated dsh web profile on port 3088 loaded the linked plugin: anonymous root 200; native token exchange 303; authenticated native index 200; POST /api/session/list anonymous 401 and authenticated 200 with an empty session list. Browser validation confirmed required fields, mock-submit disclosure, password clearing, no console errors and no horizontal overflow at 390px. The profile contains no copied model/business credentials or IM plugins.
