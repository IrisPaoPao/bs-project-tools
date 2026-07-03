# Spec Delta

## bs-java-run Command Model

### ADDED Requirement: Dedicated Build Command

`bs-java-run` SHALL provide a `build` command that packages selected Java services without starting them.

#### Scenario: Build all services

- WHEN the user runs `bs-java-run build --yes`
- THEN Maven packaging is executed for every configured service
- AND no Java service process is started.

### CHANGED Requirement: Start Does Not Build By Default

`bs-java-run start` SHALL launch selected services from existing build artifacts without running Maven by default.

#### Scenario: Start existing artifacts

- WHEN the user runs `bs-java-run start --yes`
- THEN no Maven packaging step is executed
- AND selected services are launched from existing WAR artifacts.

### ADDED Requirement: Explicit Combined Workflow

`bs-java-run` SHALL provide an explicit build-and-start workflow.

#### Scenario: Build and start all services

- WHEN the user runs `bs-java-run up --yes`
- THEN Maven packaging is executed for every configured service
- AND the selected services are started after packaging succeeds.

### CHANGED Requirement: Restart Does Not Build By Default

`bs-java-run restart` SHALL stop and start services without running Maven by default.

#### Scenario: Restart existing artifacts

- WHEN the user runs `bs-java-run restart --yes`
- THEN selected services are stopped
- AND selected services are started from existing WAR artifacts without Maven packaging.
