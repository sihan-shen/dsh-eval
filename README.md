# @han_05/dsh-eval

Offline evaluation, governance-evidence validation, and bounded local telemetry analysis for DeepSeek Harness (DSH).

This package originates in the [DS-Plugins monorepo](https://github.com/sihan-shen/DS-Plugins). It is intentionally usable as a standalone npm package and has no network, provider, or model-runtime requirement.

## Availability

- **Library:** public source repository; npm publication is prepared but is not implied by a GitHub release.
- **CLI:** `dsh-telemetry` is an offline, local-files-only CLI included by this package.
- **Fixtures:** the checked-in `fixtures/v0.2a` corpus is packaged for deterministic baseline and optimized evaluation tests.
- **DSH/Cordis:** this package does not mount a Cordis plugin itself. Its optimized evaluator consumes `@han_05/dsh-code-intelligence`, whose compatibility target is DSH `0.1.1-rc.2` and Cordis `4.0.1`.

## Install

```sh
pnpm add @han_05/dsh-eval @han_05/dsh-context @han_05/dsh-code-intelligence @han_05/dsh-telemetry
```

Use Node `^22.19.0 || >=24` and pnpm `11.7.0`.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm pack --dry-run
```

The runtime dependencies are `@han_05/dsh-context`, `@han_05/dsh-code-intelligence`, `@han_05/dsh-telemetry`, and `@dqbd/tiktoken`. DSH and Cordis are not direct runtime dependencies of this package.
