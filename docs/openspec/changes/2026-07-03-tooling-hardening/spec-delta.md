# Spec Delta

## bs-java-run Configuration

### ADDED Requirement: Local Override Configuration

`bs-java-run` SHALL load optional local-only configuration from `JAVARUN.local.md` when present.

#### Scenario: Local credentials override tracked placeholders

- GIVEN tracked `JAVARUN.md` contains empty login credential cells
- AND `JAVARUN.local.md` contains login credential values
- WHEN configuration is loaded
- THEN login configuration uses values from `JAVARUN.local.md`

### ADDED Requirement: Private Token Cache

`bs-java-run` SHALL write cached token files with user-only permissions.

#### Scenario: Token cache is saved

- WHEN a token is saved
- THEN the cache directory mode is user-only
- AND the token file mode is user read/write only

## bs-jdbc-tool Batch Semantics

### CHANGED Requirement: Continue Mode Description

`jdbc_batch` continue mode SHALL be documented as best-effort per-statement execution, not an atomic transaction.
