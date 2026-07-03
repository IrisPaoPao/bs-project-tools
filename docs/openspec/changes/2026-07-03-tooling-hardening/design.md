# Design

## Configuration

`bs-java-run` keeps `JAVARUN.md` as the shared, tracked documentation/configuration source. A new optional `JAVARUN.local.md` file may override table values for local-only secrets or machine-specific values. Environment variables remain highest priority.

Precedence:

1. Environment variables
2. `JAVARUN.local.md`
3. `JAVARUN.md`

## Security

Token cache writes use explicit private permissions:

- Directory: `0700`
- Token files: `0600`

The tracked login table no longer contains concrete account values.

## Batch Semantics

`jdbc_batch` keeps current behavior:

- `abort`: one transaction; rollback on first failure.
- `continue`: autocommit per statement; record failures and continue.

The tool description and documentation are updated to avoid implying atomicity in continue mode.
