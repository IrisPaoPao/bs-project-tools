# Design

## Maven Failure Classification

`buildService` captures Maven output instead of streaming it directly through `stdio: inherit`. On failure it combines stdout and stderr, echoes the output for visibility, then classifies the text.

Dependency resolution failures are detected with Maven error patterns such as:

- `Could not resolve dependencies`
- `Could not find artifact`
- `Could not transfer artifact`
- `Failure to find ... was cached`
- `Non-resolvable parent POM`
- `Plugin ... could not be resolved`
- `Could not resolve artifact`
- `The following artifacts could not be resolved`

## Error Contract

Dependency failures throw `DependencyResolutionError`. The error includes:

- failed command
- project path
- concise Maven summary
- artifact coordinates when they can be extracted
- repository URL hints when present

Command handlers catch this error and return exit code `1` without attempting later services or startup steps.

Non-dependency Maven failures keep the existing generic failure behavior.
