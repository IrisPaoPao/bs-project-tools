# Tooling hardening

## Why

The project works, but a few operational details increase maintenance and security risk:

- Login credentials are documented in a tracked file.
- `npm run login` points at a stale script filename.
- Token cache files are written without explicit private permissions.
- `jdbc_batch` continue-mode wording suggests stronger transaction semantics than the implementation provides.
- The MCP SDK dependency is pinned to `latest`, reducing reproducibility.

## What Changes

- Add a local override path for bs-java-run configuration and remove real login credentials from the tracked `JAVARUN.md`.
- Fix package scripts and documentation to reference `login-script.cjs`.
- Write cached token files with private filesystem permissions.
- Clarify `jdbc_batch` continue mode as best-effort per-statement execution.
- Pin the MCP SDK dependency to the lockfile-resolved major version range.

## Impact

- Login now requires credentials through environment variables or a local untracked override file.
- Existing service start/stop behavior remains unchanged.
- Database batch behavior is unchanged; only the exposed description is corrected.
