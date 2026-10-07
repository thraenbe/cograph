# Version Control view: real-VS-Code click-through (2026-10-07)

**Setup**
- Build: `termi/s262`, first at 3c50a6a, then the re-drive at b19885c, then A and C again at 494c3dd, then the own-panel fallback at 8cbefba.
- Workspace: a fresh clone of this repository with 15 open PRs.
- Driver: `uxtest/vscode/vcs-explore.spec.ts` (stages 1-6). It takes a screenshot after every action, and I judged those
  screenshots as a user.
- Offline was simulated with `core.sshCommand=/bin/false` in the workspace copy. Git fetch fails, while `gh` (HTTPS API)
  still lists the PRs.

## The question: can a person tell which tree they are looking at?

- **Inside the PR panel: always.** Four cues agree there:
  - the tab title `PR #69 · head 23834be`;
  - the banner chip;
  - the Filters line `SUBGRAPH: PR #69 · HEAD 23834BE`;
  - the active sidebar row, "Showing the pull request's own commit …, read-only, in its own panel".
- **Outside it, twice (3c50a6a):**
  1. The editor opened from a PR slot said only `esbuild.js`, and once it was editable. Fixed in b19885c: these are now
     read-only `cograph-pr` documents.
  2. The main `CoGraph` tab never positively says "your checkout", and in the offline fallback it **changes identity in
     place** to `PR #73 · your checkout`. Raised with session-262 as a design question.

## Findings and status

| | 3c50a6a | b19885c re-drive (494c3dd for A and C) |
|---|---|---|
| B: copy file read-only | Not reliable. The command marked whichever editor was active; after leave + reopen the copy opened editable in a third editor group. A saved edit would have been reused as the "PR head" (confirmed by 262) | **Fixed.** Read-only by construction ("Cannot edit in read-only editor"), including the race path; no writeable toggle is offered |
| Copy edited from outside VS Code | not tested | **Fixed.** I appended a function to a copy file from a shell and reopened the PR. The fingerprint discarded and re-copied the tree, and the function is not in the head graph |
| A: banner | At 561 px: name 0 px wide, Leave half off-screen (fully off-screen in the offline fallback), Shelf/Global covered | **Fixed at 494c3dd** (b19885c still lost Leave at 396 px). Two rows: the summary or warning always gets its own row, and Leave has a fixed slot. Leave is visible and topmost (`elementFromPoint`) at every width: 561 px at x 447-494 (262's lab: 446-494); 373 px after opening a copy file beside, at 259-306; offline fallback at 1121 px and at 373 px. Nothing covers Engine/Shelf/Global. **The amber warning leads its sentence and is never truncated**: one line at 1121 px, wrapped over 6 lines at 373 px, readable in the screenshot. The chip drops below 300 px of banner width (it repeats the tab title). The plain summary may ellipsize at 373 px (by design: only warnings wrap) |
| C: head-panel popup | Editable until Save, then refused with a clear sentence; afterwards the tab showed a dirty dot | **Fixed.** b19885c made the textarea read-only. 494c3dd adds the tooltip on the textarea itself, for a popup opened AFTER entering the view (0 popups existed before): "This is a copy of a commit, not your working tree. Edit the file in your checkout." |
| Cancel wording | "Cancelled." in every phase. Clear reported MB and refs, no tree count. A cancel during the base analysis kept 2 copies (4.2 MB), and a kept copy read as junk | **Fixed.** "Cancelled." before the copy; "Cancelled. The copied files are kept, so the next open is faster." after it; Clear reports "1 tree, 2.1 MB, 0 refs" |
| Folders opened vs changed files | Exact match (src, src/test, src/test/suite, src/webview, plus root, against `gh`) | not re-driven |
| Leave / reopen timings | Leave ~2.5 s; #69 5.1 s first, 3.9 s reopen; #70 4.2 s | not re-driven |
| Offline fallback | "The remote could not be reached. Check the connection and try again." plus "Show in the current checkout instead", which colours the main panel with the "your checkout (main)" chip | Banner OK at 594 px, but its amber warning is hidden (see A) |

**Verdict at 494c3dd: every finding of this click-through is fixed and verified in the real host.** The remaining
open point is the design question in point 2 above (the main tab changing identity in the offline fallback).

## Behaviour change at 8cbefba: a PR always opens its own panel (the checkout fallback too)

- **The main panel is really untouched.** Offline, opening #73 adds a new tab beside it, `PR #73 · your checkout`, and
  the first tab stays `CoGraph`.
  - Its state fingerprint is identical at the start, after the open, and after Leave: graph size 1603, zoom, positions
    hash, expansion, git colours, scope, `prView` false, no banner.
  - The main panel was at its opening state (1 visible node), so the positions hash covers little. The decisive checks
    are that `prView` and the banner never appear on it.
  - Leave closes the PR tab.
- **The asymmetry, as a user: can the read-only expectation carry over into false confidence? No.**
  - The head panel never teaches "edits here are throwaway". It refuses edits outright: lock, "Cannot edit in read-only
    editor", nothing to unlock.
  - Someone carrying that expectation into a checkout panel expects not to be able to type. When typing works, VS Code's
    ordinary dirty dot and plain tab say "real file". The surprise points toward caution, not false safety.
- **The confusion that does exist is about version, not writability.**
  - The checkout panel is titled "PR #73" and coloured by the PR's changes. But a slot opens **your checkout's** file:
    `scripts > analyze.py` on main, with nothing mentioning the PR.
  - When the amber line says "checkout differs", that file can lack the PR's change entirely. A user reading the PR can
    conclude "the PR doesn't touch this", or edit believing they work on the PR's code.
  - Suggestion: describe the editor as `your checkout · main (not PR #73)`, or offer "Open PR version on GitHub" next to
    files the checkout lacks.

## Not tested

- **Windows.** session-262 deliberately did **not** make the copy unwritable on disk, because `fs.rm` of read-only files
  is unreliable on Windows.
  - On every OS the disk copy stays writable. The fingerprint check on reuse is the guard.
  - That guard was verified on Linux in the real host (row "Copy edited from outside VS Code"). It is **untested on
    Windows**.
- **GitHub Enterprise.** Not faked on purpose: the code is host-agnostic, because `gh` resolves the host from the remote.
  The one GHE-specific gap, the sign-in message lacking `--hostname`, was fixed in b19885c.
- **A workspace below the git root.** Unit-tested by session-262 only.
