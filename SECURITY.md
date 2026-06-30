# Security Policy

## Supported Versions

CoGraph is distributed through the VS Code Marketplace. Security fixes are
released against the latest published version. Please update to the most recent
release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| < 1.1   | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

- **GitHub Security Advisories** — use the *"Report a vulnerability"* button under
  the repository's **Security** tab (Private Vulnerability Reporting is enabled).
- **Email** — [bela.thraen.bt@gmail.com](mailto:bela.thraen.bt@gmail.com) with the
  subject line `CoGraph security`.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal project or sample is ideal)
- The CoGraph version, VS Code version, and operating system

## What to Expect

- **Acknowledgement** within 5 business days.
- A coordinated assessment and, if confirmed, a fix in a timely follow-up release.
- Credit in the release notes if you would like to be named.

## Scope Notes

CoGraph runs entirely **locally** — it performs static analysis of files in your
open workspace and renders the result in a webview. It has **no backend**, no
authentication, and does not transmit your code to any server. The most relevant
security surface is therefore local: analyzer subprocess handling, the webview
content-security policy, and parsing of untrusted project files.
