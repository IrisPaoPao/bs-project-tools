# Stop on missing Maven dependency

## Why

When `bs-java-run build`, `start --build`, or `up` fails because Maven cannot resolve an artifact, the failure should be treated as an external dependency/repository problem instead of a service startup problem. The tool should stop immediately and report actionable evidence for a human to verify publication, repository access, proxy, or version coordinates.

## What Changes

- Classify Maven build failures that indicate missing or unresolved dependencies.
- Print a clear "manual investigation required" message for dependency resolution failures.
- Stop the current build/start task when such a failure is detected.
- Keep ordinary compile/package failures as normal build failures.

## Impact

- Agents and users no longer get nudged into temporary dependency fixes such as changing `pom.xml`, copying jars, or repeatedly retrying with flags.
- Dependency failures produce more concise evidence: command, project path, Maven summary, dependency coordinates, and repository hints when available.
