# Split build and start commands

## Why

`bs-java-run start` currently performs Maven packaging before launching services. That makes everyday restarts slower and harder to diagnose: a Maven hang or build failure looks like a startup failure, and one stuck build can prevent all later services from being attempted.

## What Changes

- Add a dedicated `build` command for Maven packaging.
- Make `start` focus on launching existing WAR artifacts by default.
- Add an explicit combined `up` command for build-and-start workflows.
- Keep a compatibility path for users who still pass the old `--skip-build` flag.

## Impact

- Daily service startup becomes faster and more predictable.
- Users who changed Java code should run `bs-java-run build` first, or use `bs-java-run up`.
- Existing `start --skip-build` invocations remain accepted, but the flag is no longer promoted in help or docs.
