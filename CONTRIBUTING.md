# Contributing to Betterbase

Thank you for your interest in contributing to Betterbase! This guide covers the basics of setting up your development environment and submitting changes.

## Getting Started

1. Fork the relevant repository
2. Clone and set up the dev environment:

```bash
git clone https://github.com/BetterbaseHQ/betterbase-dev.git
cd betterbase-dev
just setup
just dev
```

See the [README](README.md) for detailed setup instructions.

## Repository Structure

Betterbase is split across several repositories, each checked out as a subdirectory of `betterbase-dev`:

| Repository | Description |
|---|---|
| [betterbase](https://github.com/BetterbaseHQ/betterbase) | SDK (Rust/WASM + TypeScript) |
| [betterbase-accounts](https://github.com/BetterbaseHQ/betterbase-accounts) | Auth service (Rust/Axum) |
| [betterbase-sync](https://github.com/BetterbaseHQ/betterbase-sync) | Sync service (Rust/Axum) |
| [betterbase-inference](https://github.com/BetterbaseHQ/betterbase-inference) | Inference proxy (Rust/Axum) |
| [betterbase-examples](https://github.com/BetterbaseHQ/betterbase-examples) | Example applications |

Submit PRs to the individual repository that your change applies to.

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run the relevant checks:

```bash
# Rust services
just check

# SDK
cd betterbase && pnpm check

# Full platform
just check-all
```

4. Commit with a clear, descriptive message in imperative mood
5. Open a pull request against `main`

## Code Style

- **Rust**: Follow `rustfmt` and `clippy` defaults. All crates use `#![forbid(unsafe_code)]`.
- **TypeScript**: Prettier for formatting. ESM-only, strict TypeScript.
- **Commits**: Imperative mood ("Add feature" not "Added feature"). Keep the subject under 72 characters.

## Testing

- Write tests for new functionality and bug fixes
- Ensure all existing tests pass before submitting
- Integration tests require running services (`just dev` then `just test`)
- E2E tests: `just e2e`

## Reporting Issues

- Use GitHub Issues on the relevant repository
- Include steps to reproduce, expected behavior, and actual behavior
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
