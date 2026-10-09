# Decision document: the graph webview moves to a private, non-MIT repository

Planner: session-183, 2026-09-23. For Bela. Companion plan: `.ai/plans/webview.md`.
Status: **not needed (2026-10-08).** Bela: "There is no premium tier yet", so there is no split.
Kept as the mechanics reference if a premium surface inside the view is ever chosen; see the
outcome in `.ai/plans/webview-decisions.md`. Nothing executed, no repo created, no licence changed.

## Summary of the recommendation

| Topic | Recommendation |
|-------|----------------|
| Licence of the private repo | Proprietary: "CoGraph Commercial Licence" (all rights reserved + a one-page EULA for the shipped bundle). Revisit BSL 1.1 only if source-available becomes a marketing goal. |
| What moves | `src/webview/*` except `sidebar-chat.js`/`markdown.js`, the `getWebviewHtml` half of `webviewHtmlBuilder.ts`, `styles.css`, the `dist/webview` build step, the 37 webview test suites (621 tests), `uxtest/` lab + scenarios + sweep + report, `scripts/perf/`. Part A's browser transport moves too (host entry of the package). |
| How history is carried | `git filter-repo --path …` into the new repo (multi-path; `subtree split` handles one prefix). Public history is **not** rewritten. |
| How the public extension consumes it | Private npm package `@cograph/webview` on GitHub Packages, a `devDependency` installed at build time; esbuild copies its files into `dist/webview`. Contributors without a token get an open **lite** webview (`webview-lite/`, MIT) so `npm ci`, `npm test` and `npm run package` still work. |
| Premium enforcement | The panel stays free. The browser view (and future premium views) is unlocked by an offline-verified licence key (`cograph.licenseKey`, Ed25519-signed payload). "Private repo" alone is not enforcement. |
| When | After 1.3.0 is released and the four feature sessions are closed. Not while ux/perf/annotate work in `src/webview`. |

## Plain facts first

- **The .vsix is readable.** Everything in `dist/webview` ships as JavaScript that anyone can unzip
  and read. A private repo hides the source history and future development and lets the licence
  forbid redistribution; it does not make the shipped code secret. Minification (esbuild) raises the
  bar slightly. Enforcement is legal (licence) and practical (key check), not technical secrecy.
- **1.3.0 and everything before it stays MIT forever.** MIT cannot be revoked; anyone may fork the
  public webview at `v1.3.0` and keep it under MIT. Only new work in the private repo is proprietary.
- **Outside contributions exist.** `git log` on the webview paths: Bela 197 commits (three identities),
  KoljaBeck 6, Mashrur-Gain 6. Bela may relicense their own code. The 12 outside commits are MIT
  licensed and MIT allows sublicensing, so they may be included in a proprietary bundle **as long as the
  MIT notice for those parts is kept** (a `THIRD_PARTY_NOTICES.md` line). Getting a short written OK
  from both contributors is cheap and removes the question entirely.
- **Third-party code that moves:** d3 7.9.0 (ISC), d3-force in the worker bundle (ISC). Fine under
  a proprietary licence with the notices kept.
- **The Marketplace allows proprietary extensions.** The `license` field becomes
  `"SEE LICENSE IN LICENSE"` and the package's `LICENSE` file states both parts: MIT for the host,
  commercial for the graph view. The GitHub repo keeps its MIT `LICENSE`. README badge and footer
  are reworded ("Host MIT; graph view is a commercial component").

## Licence options

| Option | One-paragraph assessment | Fits "cannot be MIT"? |
|--------|--------------------------|------------------------|
| **Proprietary EULA (recommended)** | All rights reserved plus a one-page commercial licence covering the bundle: use inside CoGraph only, no redistribution, no reverse engineering claims beyond what the law allows, key terms. Simplest, matches a private repo (nobody sees the source anyway), no promises about the future. Needs a lawyer's pass before money changes hands. | Yes |
| BSL 1.1 (Business Source License) | Source-available with an "Additional Use Grant" and a Change Date (max 4 years) after which it becomes an open licence (e.g. Apache 2.0). Used by MariaDB, HashiCorp. Good signal for developer trust, but it only makes sense if the source is published; in a private repo the conversion clause is a free gift with no upside. | Yes |
| Elastic License 2.0 | Source-available, forbids offering as a managed service and circumventing licence keys. Written for SaaS lock-out; the "circumventing the key" clause is useful, but again assumes visible source. | Yes |
| PolyForm Noncommercial / Strict | Ready-made "you may use it, not commercially" (Noncommercial) or "no modification, no distribution" (Strict). Strict is close to a EULA but was drafted for source distribution; Noncommercial would allow free noncommercial use, which conflicts with a premium tier. | Yes, but Noncommercial undercuts premium |

What stays MIT: the public repo as a whole (host, analyzers, AI features, sidebar, tests, the
`webview-lite` placeholder). No MIT file is moved without its notice.

## Split mechanics

### Files that move (verified list, develop 2747ad3)

| From public repo | To private repo | Note |
|------------------|-----------------|------|
| `src/webview/*.js` (36 files) minus `sidebar-chat.js`, `markdown.js` | `src/*.js` | The two sidebar files stay: the chat is a free VS Code view. P6 asks Bela. |
| `src/webview/styles.css` | `src/styles.css` | |
| `src/webviewHtmlBuilder.ts` `getWebviewHtml` + `bundledWebviewAssets` | `src/html.ts` | `getLoadingHtml`, `getEmptyStateHtml`, `getErrorHtml` stay public (the lite view needs them). |
| `esbuild.js` simWorker context + d3 copy | private `esbuild.js` | Public esbuild copies `node_modules/@cograph/webview/dist/*` into `dist/webview`. |
| 37 test suites in `src/test/suite` that `require` webview files (621 of 1091 tests) | private `test/` with a jsdom + mocha runner (no VS Code needed: they only stub `vscode.postMessage`) | Public suite keeps 470 tests. |
| `uxtest/` lab, scenarios, sweep, report, unit; `scripts/perf/` | private | They test the webview. `uxtest/vscode/*` (cold-open through the real extension) needs both; keep it public against the packaged .vsix. P7. |
| Part A: `src/browserView/*`, `src/webview/browserBridge.js` | private, `host` entry | Whole premium feature in one repo. |

### History

`git filter-repo` on a fresh clone of the public repo with the path list above, then push to the new
private remote. Keeps the ~200 commits touching those paths with authorship intact. The public repo is
left as is (no rewrite, no force push, tags unchanged); the public copy of the files is deleted in one
commit titled "chore: graph view moves to @cograph/webview". `git subtree split` is the fallback if
`filter-repo` is not installed; it needs one run per prefix and a manual merge.

### Consumption options

| Option | CI / secrets | Outside contributors | Verdict |
|--------|--------------|----------------------|---------|
| **(1) private npm package on GitHub Packages (recommended)** | `NODE_AUTH_TOKEN` (fine-grained PAT, `read:packages`) as a repo secret; `.npmrc` with `@cograph:registry=https://npm.pkg.github.com`. Release workflow runs on tag push in the same repo, so the secret is available. PR builds from forks have no secrets: they build the lite view. | Lite view, full host tests. | Clean versioning (`@cograph/webview@1.4.0`), standard tooling, esbuild copy means no `.vscodeignore` change (the CONTRIBUTING gotcha). |
| (2) git submodule | Deploy key in CI; every clone needs access or fails at `git submodule update`. | Broken clone unless they skip submodules. | Fragile for open source; no. |
| (3) build artefact fetched in CI | Custom script + token; no local dev story. | Nothing local. | Worse than (1). |
| (4) runtime download of a licensed bundle | Server + auth; Marketplace review dislikes downloaded executable code; offline users blocked. | n/a | No. |

Public-side wiring for (1): `esbuild.js` resolves `@cograph/webview` (present) or `webview-lite/`
(absent) and copies to `dist/webview`; `graphProvider.ts` imports `getWebviewHtml` from a tiny
`src/webviewModule.ts` that does the same resolution at compile time (`try require` with a typed
fallback). The interface between the repos is frozen and documented publicly in `docs/protocol.md`:
the message list (host to view, view to host), `getWebviewHtml(webview, extensionUri, opts)`,
`window.COGRAPH_CONFIG`, and the `host` entry (`startBrowserView(hub)`, `verifyLicense(key)`).

### The lite view

`webview-lite/` (MIT, ~150 LOC): one script + css that renders the file list and folder counts from
`structure`, shows "The interactive graph view is part of the CoGraph Marketplace build" and keeps
the protocol alive (`ready`, `navigate`). It exists so the public repo remains a working, testable
extension and a fork PR can still run `npm test` and `npm run package`.

## Premium enforcement

| Model | What gates | Free tier shows | Assessment |
|-------|------------|-----------------|------------|
| (a) Repo privacy only | nothing at runtime | everything | Not premium at all; every Marketplace user has it. Only protects source. |
| **(b) Offline licence key (recommended default)** | `cograph.licenseKey`; payload `{email, plan, expires}` signed with an Ed25519 key whose public half ships in the bundle; verified in the private `host` entry | Panel graph view free; browser view and future premium views locked with an "Unlock" hint | No server, works offline, standard for desktop tools. Patchable by a determined user; acceptable. Key issuing is a small script now, a checkout page later. |
| (c) Account / online check | login via `vscode.authentication` or own OAuth | same as (b) | Needs a backend and a privacy story; later, if seats/teams matter. |

Default proposal: **the current panel stays free**, including everything shipped in 1.x (removing it
would break the 1.x user base and the EXIST/Marketplace story). Premium = browser view now, then
whatever Bela decides next (timeline, sweeps, exports). The gate lives in the private bundle.

## What stays where (ownership after the split)

| Public repo `cograph` (MIT) | Private repo `cograph-webview` (commercial) |
|-----------------------------|---------------------------------------------|
| analyzers, `analyzerRunner`, `structureScanner`, `gitService`, `cacheStore`, `sourceEditor`, `graphMerge` | `src/*.js` graph modules, `styles.css`, `html.ts` |
| `graphProvider.ts`, `extension.ts`, `webviewReadyGate.ts`, `webviewModule.ts`, loading/empty/error HTML | `host/` browser server, view hub, licence check |
| `graphIntelligence/*`, sidebar + chat (free AI, decided 2026-09-18) | worker bundle build, d3 vendoring |
| `webview-lite/`, 470 host tests, `uxtest/vscode`, CI, release, Marketplace publish | 621 webview tests, uxtest lab/scenarios/sweep/report, `scripts/perf` |
| `docs/protocol.md` (the contract) | `THIRD_PARTY_NOTICES.md`, `LICENSE` (commercial) |

**Branch point: MCP licence (open, Bela's call via session-214's brief).** The table assumes the
MCP server that replaces the Chat is MIT and sits in the public column in place of "sidebar + chat".
If Bela makes MCP premium, this is the only paragraph to rewrite: MCP moves to the private column as
an `mcp` entry of `@cograph/webview` (preferred: one package, one licence check in `verifyLicense`)
or as a second private package; the public side gets an `mcpModule.ts` resolver like
`webviewModule.ts` with a "part of the Marketplace build" stub. Nothing else in this document
changes.

Sessions: ux, perf and annotate own webview files today; after the split their work happens in the
private repo, and `00-common.md`'s ownership table is rewritten per repo. The current push must finish
first.

## Migration plan

| Step | Action | Risk / check |
|------|--------|--------------|
| 0 | Release 1.3.0 from `main` as today (MIT). Close the four feature sessions. | Nothing moves before this. |
| 1 | Get the two outside contributors' written OK (optional but cheap); draft the commercial licence; lawyer pass. | Without OK: keep their MIT notice in `THIRD_PARTY_NOTICES.md`. |
| 2 | Create private repo `thraenbe/cograph-webview`; `git filter-repo` import; add `package.json` (`@cograph/webview`, `private: false`, `publishConfig` GitHub Packages), esbuild, jsdom test runner, CI (test + publish on tag). | Test runner: the 621 tests today run inside VS Code's mocha; they need only jsdom/sinon, verify one suite first. |
| 3 | Public repo: `webview-lite/`, `webviewModule.ts`, esbuild resolution, `.npmrc`, `NODE_AUTH_TOKEN` secret, `docs/protocol.md`, README/CHANGELOG/LICENSE wording, `license` field, delete moved files (this plan is the instruction for those deletions). | CI must pass both with and without the token (matrix job). |
| 4 | Part A (browser view) lands in the private repo's `host` entry with the licence gate. | Depends on Bela's answers to P1 to P5. |
| 5 | Release 1.4.0: first Marketplace build with the commercial component. | Marketplace listing text and the combined LICENSE reviewed. |
| Rollback | `v1.3.0` tag has everything under MIT; revert the step 3 commit to restore the in-repo webview. The private repo can be archived. | Nothing irreversible until 1.4.0 is published. |

Risks not covered above: CHANGELOG/README wording must not claim the whole extension is MIT after
1.4.0; the `cograph` npm scope must be registered on GitHub Packages (it is the org/user namespace,
`@thraenbe/webview` if no org exists); two-repo development means two PRs per webview change that
also touches the protocol; `uxtest/vscode` needs the packaged .vsix in CI.

## Product questions for Bela (via session-110)

- **P6** Does "the webview" include the sidebar chat (`sidebar-chat.js`, `markdown.js`)? This plan
  says no (chat is free).
- **P7** Where should `uxtest/` live? Proposal: lab/scenarios/sweep/report private, `uxtest/vscode` public.
- **P8** Free tier: the panel graph stays free and only the browser view (and future views) is premium,
  yes? Or does the whole graph view become premium (then `webview-lite` is what free users see)?
- **P9** Licence key (b) now, or repo privacy only (a) until there is a checkout page?
- **P10** Repo/package name: `cograph-webview` / `@cograph/webview` (needs a GitHub org `cograph`)
  or under `thraenbe`?
- **P11** Is a lawyer's review of the commercial licence planned before the first paid key?
