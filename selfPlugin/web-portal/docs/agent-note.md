# Agent Note: Public login presentation for a single-user Harness

Status: implemented

## Decision

Mount the public page using named WebServer routes owned by the web-portal plugin. Leave the official fallback and API registrations in place. The anonymous root serves standalone HTML without index injections; the authenticated root uses Connection authorization and WebServer index rendering. A launch-token request always goes through the native token exchange, never the preview form.

## Rationale

The login page must render before Harness authentication. A client module would depend on the authenticated boot payload. Claiming another fallback conflicts with frontend-static, and modifying official source creates unnecessary upgrade conflicts. Named root routing permits removal through ordinary Cordis effects.

## Consequences

The host preloads packaged static files and must restart after rebuilding. Native frontend resolution must be reviewed if upstream composition changes. Login presentation introduces no account system or isolation; an existing native cookie still grants shared instance administration. The preview never sends passwords, grants access, or pretends account validation succeeded.

## Verification

Owner-local HTTP tests combine real WebServer and Connection services with temporary files and in-memory signing credentials. They exercise public responses, native token and cookie handling, API denial, static resource containment, methods, route teardown/reload, and atomic registration after build files are loaded. Browser verification covers the built page and form interaction. No model-facing event or session-format change is introduced, so no recorded agent-session snapshot is affected.
