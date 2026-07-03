# Spec Delta

## bs-java-run Maven Build Failures

### ADDED Requirement: Stop on Dependency Resolution Failure

`bs-java-run` SHALL stop the current build/start workflow when Maven output indicates dependency resolution failure.

#### Scenario: Missing artifact during build

- WHEN `bs-java-run build <service> --yes` runs Maven
- AND Maven reports that an artifact cannot be found or resolved
- THEN the command exits non-zero
- AND prints a manual-investigation message with the failed command, project path, Maven summary, and artifact coordinates when available.

#### Scenario: Missing dependency during build-and-start

- WHEN `bs-java-run start <service> --yes --build` or `bs-java-run up <service> --yes` runs Maven
- AND Maven reports dependency resolution failure
- THEN no Java service process is started for that service after the failed build
- AND the command exits non-zero.

### ADDED Requirement: Preserve Generic Build Failures

`bs-java-run` SHALL keep non-dependency Maven failures as generic build failures.

#### Scenario: Compilation failure

- WHEN Maven fails because Java compilation fails
- THEN the command exits non-zero
- AND the failure is not labeled as a dependency resolution failure.
