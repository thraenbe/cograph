# Version Control view: real-VS-Code click-through (2026-10-07)

**Setup**
- Build: `termi/s262`, first at 3c50a6a, then the re-drive at b19885c.
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

| | 3c50a6a | b19885c re-drive |
|---|---|---|
| B: copy file read-only | Not reliable. The command marked whichever editor was active; after leave + reopen the copy opened editable in a third editor group. A saved edit would have been reused as the "PR head" (confirmed by 262) | **Fixed.** Read-only by construction ("Cannot edit in read-only editor"), including the race path; no writeable toggle is offered |
| Copy edited from outside VS Code | not tested | **Fixed.** I appended a function to a copy file from a shell and reopened the PR. The fingerprint discarded and re-copied the tree, and the function is not in the head graph |
| A: banner | At 561 px: name 0 px wide, Leave half off-screen (fully off-screen in the offline fallback), Shelf/Global covered | **Fixed at 594 px**: name and Leave visible, nothing covered. **Still broken at 396 px**, the width produced by opening a copy file beside the panel: Leave at x 395-442 is off-screen. The summary is 0 px at both widths, so the fallback's amber "coloured as whole files (checkout differs)" warning is invisible |
| C: head-panel popup | Editable until Save, then refused with a clear sentence; afterwards the tab showed a dirty dot | **Fixed.** The textarea is read-only, and no dirty dot appears. No tooltip was found on the textarea |
| Cancel wording | "Cancelled." in every phase. Clear reported MB and refs, no tree count. A cancel during the base analysis kept 2 copies (4.2 MB), and a kept copy read as junk | **Fixed.** "Cancelled." before the copy; "Cancelled. The copied files are kept, so the next open is faster." after it; Clear reports "1 tree, 2.1 MB, 0 refs" |
| Folders opened vs changed files | Exact match (src, src/test, src/test/suite, src/webview, plus root, against `gh`) | not re-driven |
| Leave / reopen timings | Leave ~2.5 s; #69 5.1 s first, 3.9 s reopen; #70 4.2 s | not re-driven |
| Offline fallback | "The remote could not be reached. Check the connection and try again." plus "Show in the current checkout instead", which colours the main panel with the "your checkout (main)" chip | Banner OK at 594 px, but its amber warning is hidden (see A) |

## Not tested

- **Windows.** session-262 deliberately did **not** make the copy unwritable on disk, because `fs.rm` of read-only files
  is unreliable on Windows.
  - On every OS the disk copy stays writable. The fingerprint check on reuse is the guard.
  - That guard was verified on Linux in the real host (row "Copy edited from outside VS Code"). It is **untested on
    Windows**.
- **GitHub Enterprise.** Not faked on purpose: the code is host-agnostic, because `gh` resolves the host from the remote.
  The one GHE-specific gap, the sign-in message lacking `--hostname`, was fixed in b19885c.
- **A workspace below the git root.** Unit-tested by session-262 only.
