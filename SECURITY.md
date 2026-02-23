# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Betterbase, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@betterbase.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

This policy covers all Betterbase repositories:

- `betterbase` (SDK)
- `betterbase-accounts` (auth service)
- `betterbase-sync` (sync service)
- `betterbase-inference` (inference proxy)
- `betterbase-examples` (example applications)

## Security Design

Betterbase is built around an encrypt-at-boundary architecture:

- Data is stored plaintext on-device for full queryability
- All data is encrypted (AES-256-GCM) before leaving the device
- The server only ever sees encrypted blobs
- Authentication uses OPAQUE (server never sees passwords)
- Encryption keys are delivered via JWE during OAuth flow

For more details, see the architecture sections in each repository's README.

## Supported Versions

We provide security updates for the latest release only.
