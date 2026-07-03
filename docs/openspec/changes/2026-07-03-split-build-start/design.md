# Design

## Command Semantics

`build` performs Maven packaging for one service or all services:

```bash
bs-java-run build [service] --yes
```

`start` starts services from already-built WAR artifacts. It does not run Maven unless `--build` is explicitly supplied:

```bash
bs-java-run start [service] --yes
bs-java-run start [service] --yes --build
```

`up` is the explicit combined workflow. It packages selected services, then starts them with the same runtime options supported by `start`:

```bash
bs-java-run up [service] --yes
```

`restart` keeps the operational meaning of stop-then-start. It does not build by default, but supports `--build` for the explicit combined restart workflow.

## Compatibility

The old `--skip-build` flag is accepted as a hidden no-op for `start` and `restart`. This avoids breaking aliases or old notes while keeping the visible CLI focused on the new model.
