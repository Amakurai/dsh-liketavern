# Security Policy

## Supported Versions

Security fixes are shipped on the active `0.5.x` release line. Please upgrade to the latest release before reporting an issue when possible.

| Version | Supported |
| --- | --- |
| `0.5.x` | Yes |
| `< 0.5.0` | No |

## Reporting a Vulnerability

Please **do not** report undisclosed security vulnerabilities in public GitHub issues, discussions, or pull requests.

Use [GitHub Private Vulnerability Reporting](https://github.com/Amakurai/dsh-liketavern/security/advisories/new) to submit a confidential report directly to the maintainer.

Include as much of the following as practical:

- Affected plugin version (`package.json` / release tag), DeepSeek Harness (`dsh`) version, Node.js version, and OS.
- Minimal reproduction steps or a synthetic character card / preset / story fixture (never include real API keys or personal data).
- The security boundary crossed and its concrete impact.

You can expect an initial acknowledgement within **7 days**, followed by triage status updates and coordinated remediation prior to public disclosure.

## Security Architecture & Boundaries

`dsh-liketavern` treats third-party character cards, prompt presets, lorebooks, regex rules, EJS prompt templates, and interactive HTML card scripts as untrusted input:

- **Air-gapped template & regex execution**: Prompt assembly, EJS evaluation, worldbook conditions, and regex replacement run inside terminable Worker threads and QuickJS/WASM sandboxes without Node.js APIs, filesystem access, network access, DOM globals, or host function bridges.
- **Sandboxed interactive HTML cards**: Card HTML renders inside opaque-origin `sandbox="allow-scripts"` iframes and communicates with the host exclusively through a schema-validated, lease-scoped `postMessage` protocol.
- **Filesystem link & archive safety**: `dsh-tavern-doctor` and `dsh-tavern-backup` reject symlinked roots, path traversal entries, and oversized inputs rather than following external filesystem targets.
