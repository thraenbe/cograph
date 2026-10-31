# The engine in CI

What `src/ci` does and what it may reach, for whoever changes it or has to explain it to a customer. The tour's contract is
`docs/tour-protocol.md`, section 10; this file says how the public side keeps its part. Every statement here has a test in
`src/test/suite/ci*.test.ts` or is listed under "Not verified".

`src/ci` is what the private CLI bundles for `cograph-tour fetch` and `build`. Nothing it loads imports `vscode`.

## Two steps, two kinds of access

| | `fetch` (`ensureCommits`) | `build` (`createHeadlessApi`, `stageData`) |
|---|---|---|
| Runs as | Part of the parent, `ci` | A child process with a deadline |
| Git network | Yes: the job's own remote | None. See "Network" |
| Job's credentials | Whatever the checkout left | No token in its environment |
| Reads | Git objects | Git objects. Never the working tree |
| Writes | Objects and `.git/shallow` | Only under `--work-dir` |

The scrubbed environment is defence in depth, not a boundary: `build` runs as the same user and could read `.git/config`, where a
checkout may have persisted a token. It keeps a token out of tools that read a pull request's files, so one bug does not put it in a
bundle.

## Network

`build` makes no network call apart from optional AI, with one exception that `fetch` closes.

**Partial clones.** In a clone with `filter: blob:none`, git fetches a missing blob from the user's own remote the moment something
reads it. No pull request picks that server, but it is a network call, and `build` has no credentials for it. So:

- `fetch` brings in one request every blob `build` will read: the analysable files of head and merge base, both sides of every
  changed file, and the target tip's team files. Everything else stays on the remote.
- `build` runs with `GIT_NO_LAZY_FETCH=1`. A blob `fetch` did not bring fails the copy, and the job reports a failed analysis. It
  does not go to the network.
- Git before 2.45 ignores that variable, so there a missing blob is fetched from the customer's own remote, one object at a time.

A `fetch` that cannot bring those blobs stops the run with "the head commit could not be fetched".

## A copy is not a checkout

Both trees are written from git's object store. Nothing a commit selects runs, which is what makes this safe, and it has visible
effects:

| In the commit | In the copy |
|---|---|
| A file tracked by Git LFS | **Its pointer text.** No LFS server is contacted. Its functions are missing from the graph and the diff, and a `.py` pointer counts in `filesNotParsed` |
| Any other filter (`git-crypt`, `ident`, `working-tree-encoding`) | The bytes as stored: `git-crypt` stays ciphertext, `$Id$` stays literal |
| The execute bit | **Never set.** Nothing in a copy runs |
| CRLF conversion | Not applied. Line numbers still match a checkout |
| A symlink or a submodule | Left out |
| A path with a control character | Left out of the copy and the analysis, except a tab. `changedPaths` still lists it |

## What the team decides, and what a pull request cannot

`.cograph/tour.json` and committed annotations come from the **target tip's** objects (`--config-sha`). Not from the pull request's
head, which its author writes, and not from the merge base, which its author can pick by rebasing onto an older commit with a broader
`security.allow`. The working tree is never a fallback. With no target tip the run falls back to `--base` and logs that this is the
weaker case.

Names from a platform are data. A branch name reaches git only after the check in `isBranchName`, as `refs/heads/<name>`, after `--`.
Git itself is resolved to an absolute path and is the only tool a run can call. An analyzer runs from the work dir, never the checkout.

## When analysis falls short

| What happens | Effect | `analysis` |
|---|---|---|
| An analyzer fails as a process on either side: no interpreter, timeout, output cap, crash | That language leaves **both** sides before the diff, and the overview says so in a fixed sentence. One side alone would paint all of it as added or removed | `partial` |
| A file will not parse | It is missing from the graph and counts in `filesNotParsed`, on the head side only. The language stays | `complete` |
| No merge base | A head-only tour: no diff, nothing scanned. Never a diff against the target tip | `complete` |
| An interpreter is missing, and the tree holds no file of that language | Nothing: nothing was lost | `complete` |

A sentence never quotes an analyzer: a Python traceback holds source lines.

## Limits and toolchains

Measured on 2026-10-31 on this machine, one run at a time, through the real tour host. A hosted runner is slower.

| Limit | Value | Past it | Measured |
|---|---|---|---|
| Analyzer, each side | 300 s | The language fails | Guava, the largest of the corpus, takes about 80 s per side |
| Analyzer output | 200 MB | The language fails | Largest real output: guava's graph, 122 MB, with a long work path |
| Python analyzer memory | 2.8 GB of address space, Linux and macOS only | The file in hand counts as not parsed; past it outside a parse, the language fails | pandas 0.76 GB. A 24 MB file of one-line functions: 2.85 GB, 6 s, that file lost. Without the limit: 4.18 GB and growing with the file |
| Node analyzer heap | 4 GB | The language fails | Guava 3.3 GB. A 24 MB Java file of one-line methods: 4.6 GB, then the language fails |
| Analyzer stderr | First 64 KB kept | Dropped | |
| `fetch` | 240 s of deepening, 120 s per git fetch, 8 rounds | Head-only tour | 3 to 9 s from an empty repository against public GitHub, deepening from 32 commits |
| A copy | 50,000 source files | The build fails | |

The largest real source file among 17,340 in the corpus is 1.18 MB, so none of these lines is near anything but a hostile file.


| Language | Tool | Needs on the runner |
|---|---|---|
| Python | `analyze.py`, standard library `ast` | Python 3.8 or newer. Syntax newer than the interpreter counts as not parsed |
| TypeScript, JavaScript, Vue, Svelte | `analyze_ts.js`, `analyze_js.js` | Node |
| Java | `analyze_java.js`, `java-parser` | Node, no JVM |
| C, C++ | `analyze_c.js`, `analyze_cpp.js`, tree-sitter wasm next to the script | Node |
| All | | git 2.20 or newer; 2.29 for a partial clone's batch |

## Not verified

- **Windows and macOS.** No such machine here. Above all the search rule that makes an absolute `git` matter: on Windows, libuv looks
  for a bare name in the child's working directory first (from its source, not run). On Linux the same guard is tested with a relative
  `PATH` entry.
- **Real platforms.** Fetching a bare id on GitLab, Bitbucket and Azure, and whether credentials survive their checkouts. The fallback
  to `refs/heads/` is tested against a local server that refuses.
- **Hosted runners.** Whether a runner has `filter.lfs.*` no longer matters to a copy; memory and time on a small runner do.
- **A shallow merge base.** Deepening stops at the first common commit it sees. With criss-cross merges a better one can lie beyond the
  shallow boundary, and the tour then shows a little more than the platform's own diff.
