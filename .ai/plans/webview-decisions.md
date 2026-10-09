# Browser view and premium split: the decisions, in depth

## Outcome (2026-10-08, Bela's answers via session-110)

| # | Answer |
|---|--------|
| E1 | **"There is no premium tier yet."** |
| E2 | Resolved by E1: **no split**, no private repo, no export, no licence change. Nothing to protect. |
| E3 | Resolved by E1: **no licence-key machinery**. Nothing to unlock. |
| E4 | **Deferred**; Bela picks the name himself. Still true: `cograph` is taken on GitHub (a user account) and on npm (`cograph`, `cograph-mcp`, another project), so nothing may be published under it. |
| P1 | **"Open in browser"**, for when the browser view is built. The old "Open Chat" button was removed outright on `fix/remove-open-chat-button` (9dfdcc5), so step 6 of `webview.md` adds a new button rather than renaming one. |
| N3, M4 | The Version Control / PR graph view is **MIT**. |

**What to keep from this document when someone returns to it.** The browser view is deferred, not
cancelled; `webview.md` is the starting point. The lasting finding is in E1: **the credible
premium candidates are team and CI surfaces, not views.** The views are the free product. The costed
candidates, updated for what shipped in 1.4.0:

| Candidate | Status | Estimate |
|-----------|--------|----------|
| P-A: PR impact check in CI | Still the first candidate if a revenue path is wanted | **4 to 6 days** (was 6 to 9): base/head analysis and the graph diff now ship free in the 1.4.0 Version Control view, so P-A only adds the headless runner, the PR comment, Action packaging and a key. Its engine is MIT, so what it would sell is running in CI for teams, not the analysis |
| P-B: structural diff between refs | **Off the list**: Bela commissioned head-ref analysis (262's N2 option b) as part of the free Version Control view, shipped in 1.4.0 | n/a |
| P-C: architecture rules | Unchanged | 6 to 7 days, CI part on top of P-A |

If a premium surface is ever chosen, E2's re-costed answer still applies: a CI surface (P-A, P-C's
checker) gets its own private repo that depends on the public one (the analyzer boundary moved 5
times in a quarter, the view 69 times); only a premium surface *inside* the view would need the
private monorepo + export. The rest of this document is the material Bela decided on, unchanged.

Planner: session-183, 2026-10-06. For Bela, via session-110. Base: `main` @ 1fc1156 (v1.3.0).
Status: **decision material only.** Nothing built, published, registered or moved.
Companions (unchanged, accurate against 1.3.0): `.ai/plans/webview.md` (browser view),
`.ai/plans/webview-private-repo-strategy.md` (split mechanics). This file replaces their
"Product questions" sections (P1 to P11) as the thing to answer.

## How to read this

Eleven questions were listed as if they were the same size. They are not. Four of them decide
what CoGraph sells and what it can never take back; the rest are five-minute changes. So:

- **Part 1: four decisions that need Bela** (E1 to E4). Each one says what it commits us to, what
  it forecloses, what reversing it in three months would cost, and the one fact that would change
  my recommendation.
- **Part 2: the evidence** behind them: what the split really costs a solo founder day to day, what
  the free tier must keep for the MCP to be a way in, what each sales channel makes easy or hard,
  and the sequencing constraint.
- **Part 3: everything else.** Defaults I take **unless Bela objects**. No answer needed.

The four depend on each other in one direction: **E1 sets the price of E2.** After Bela's N3
answer (the PR graph is MIT), E1 has changed shape: there is no premium product today, so E1 now
asks whether one is needed and which surface would be worth a price, and E2 mostly answers itself
("do not split yet"). E3 and E4 are unaffected.

| # | Decision | Cost of a wrong answer | My recommendation |
|---|----------|------------------------|-------------------|
| E1 | Is there anything to sell, and if not, what would be | Low today (nothing exists to sell); the cost is time to revenue | Say plainly there is no premium tier yet. If a revenue path is wanted, build **P-A, a PR impact check in CI**, first (6 to 9 days) |
| E2 | Where premium code lives, under which licence | High if done for nothing: setup plus a daily tax to protect a deferred view | **Do not split now.** When P-A starts: its own private repo that depends on the public one (one-way). The monorepo + export only if a premium surface lives *inside* the view |
| E3 | How premium is sold and checked | Medium: cheap until the first paid key, expensive after | One Marketplace listing + an offline signed licence key, built only when there is a premium surface to unlock |
| E4 | Public names (GitHub org, npm scope, MCP package name) | Medium: names are first-come and `cograph` is already taken on both | Pick a name that is free on GitHub, npm and the Marketplace together, before 214 publishes anything |

## Measured facts this rests on

All from `main` @ 1fc1156 unless dated otherwise.

| Fact | Number | How measured |
|------|--------|--------------|
| Graph view code | 41 scripts in `src/webview/` (11,358 LOC) + `styles.css` (1,380 LOC) | `git ls-tree` + `wc -l` |
| Tests that `require` a webview file | 43 of 78 suites, ~707 of ~1,224 tests | grep over `src/test/suite` |
| `uxtest/` + `scripts/perf/` | 72 + 5 files | `git ls-tree` |
| Webview commits, Jul to Sep 2026 | 69 (6 Jul, 1 Aug, 62 Sep) | `git log -- src/webview` |
| ... of which also touch host code in the same commit | 20; 16 of those only `webviewHtmlBuilder.ts` (moves with the view), so ~5 truly cross the line | per-commit file lists |
| ... of which also touch tests | 64 of 69 | same |
| A feature release, v1.2.0 to v1.3.0 | 34 webview files **and** 23 host files changed; 17 new host-to-view message sends in `graphProvider.ts` | `git diff v1.2.0 v1.3.0` |
| A polish release, v1.1.1 to v1.2.0 | 3 webview files, 1 host file, 0 new messages | same |
| Release cadence | v1.1.1 Jul 3, v1.2.0 Aug 28, v1.3.0 Sep 25 | tags |
| Outside contributors to `src/webview` | KoljaBeck 6, Mashrur-Gain 5, GoonerMAK 1 (12 of ~194 commits, 6%); 7 of the 69 since July (10%) | `git log --format=%an` |
| Outside PRs, Apr to Oct 2026 | 4 (GoonerMAK), plus 16 Dependabot | `gh pr list` |
| Repo reach | `thraenbe/cograph`: 9 stars, 1 fork | `gh repo view`, 2026-10-06 |
| Who triggers analysis | Only the graph panel (`graphProvider.ts`); the sidebar never analyses | `extension.ts` commands, `cacheStore.writeCache` callers |
| GitHub `cograph` | **A user account** (someone else's, created 2020-12-22), so no org of that name can exist | `gh api users/cograph`, 2026-10-06 |
| npm `cograph`, `cograph-mcp` | **Both taken** by another project, "Onta (formerly Cograph)", published since 2026-04-27 | `npm view`, 2026-10-06 |
| npm scope `@cograph` | Unknown (the org page answers 403 to an anonymous check) | `curl` |

The commit-level number (~5 of 69 cross the line) understates the cost. The release-level number is
the honest one: **polish stays on one side, features cross.** v1.3.0 (subgraphs, annotate, Shelf)
changed both sides in lockstep and added 17 new messages. The next three features in flight cross
too: the PR graph (new host module + colour/expand driving in the view), the UX4 hover card
(`get-func-source` with `maxLines`) and the browser view itself.

---

# Part 1: the four decisions that need Bela

## E1. Is there anything to sell, and if not, what would be

*Reworked 2026-10-06 after Bela answered N3 (the PR graph is MIT). The previous E1 asked "which
views are premium"; that question no longer has an answer worth asking.*

**Where it stands, plainly.** 1.3.0 is MIT forever. The PR graph is MIT. The browser view is
deferred. So **CoGraph has no premium product today**: the premium tier would consist of one view
that is not being built. Every surface that exists or is in flight (panel graph, subgraphs,
annotate, timeline, the MCP server, the PR graph) is free.

**Would the browser view alone carry a price? No, in my view.** It shows the same graph, from the
same data, in another window. Its uses are real (a second monitor, a bigger canvas, showing the
graph in a meeting) but they are conveniences, and a price on the window invites the obvious
question "why is the window paid when the graph is free?". It is also a mode of an MIT view, so its
code would sit next to MIT code and is the hardest kind to keep separate (see E2). Building it is
about a week (my estimate for the eight steps in `webview.md`, including the Playwright parity
test). It is worth building when users ask for it, free or as a sweetener, not as the thing a price
rests on.

**So the honest answer to "what is premium" is: nothing yet, and that is a fine state to be in**
as long as it is a decision and not a drift. What it costs: no revenue path; and every month of new
code lands under MIT, which is permanent (so a premium candidate, once chosen, should start in its
own home on day one, not be carved out later).

**What would be enough.** Three candidates, all built on things that already exist. Costs are my
estimates, except the headless analyzer core, which is session-214's (step 6, ~1 day).

| | P-A: PR impact check in CI | P-B: structural diff between refs | P-C: architecture rules |
|-|----------------------------|------------------------------------|-------------------------|
| What it does | On every PR, a GitHub Action analyses base and head and posts a comment: changed functions, their transitive callers grouped by file, entry points and tests hit, callers with no test; optionally fails the check above a threshold | In the editor: what a branch changed *structurally* (calls and cross-folder dependencies added and removed, ghost nodes for removed ones), between any two refs. This is option (b) of 262's N2, which the MIT PR graph leaves out | Declare boundaries (`.cograph/rules`: "analyzers never call the view", "domain never calls infra"); violations become red edges in the view and a failing check in CI |
| Who pays, and why | Teams. It saves reviewer time on every PR, works without anyone opening an editor, and code never leaves their CI (no server of ours) | The same reviewers, inside the editor | Tech leads; value recurs on every PR, not once |
| Builds on (all MIT) | analyzers, 214's `impact` query, the PR graph's changed-file logic, headless core | the MIT PR graph, the timeline's git plumbing | the graph and its edges, P-A's CI runner |
| New work | headless core (1 d), base and head analysis + graph diff (2 to 3 d), comment renderer (1 to 2 d), Action packaging + key from a CI secret (1 to 2 d) | temporary worktree + second analysis + graph diff (3 to 4 d, shared with P-A), view rendering of added/removed edges and nodes + new messages (3 to 4 d) | rule format + checker over the graph (3 to 4 d), view highlighting (2 d), CI reuse of P-A (1 d) |
| Estimate | **6 to 9 days** | **7 to 10 days**; 3 to 4 if P-A exists | **6 to 7 days**; CI part needs P-A |
| Where the code lives | A new entry point in a new process. Depends on the analyzers; nothing in the view | Inside the view and the host, across the protocol | Checker standalone; a small view mode |
| Main risk | Analyzers need their runtimes (Python for `analyze.py`) in the customer's CI; static analysis misses dynamic calls, so the comment must say "possible callers", not "all callers" | Two analyses per view open is slow on large repos; needs caching per ref | Rule language design; a rule nobody writes is worth nothing, so it needs good defaults |

**Not candidates:** hosted or shared team graphs (needs a server and accounts; CoGraph's rule is
"no server, no tokens"; weeks of work plus operations); heavier MCP tools (214's D6 mentions
cross-repo and history-aware impact; plausible later, but gating the MCP narrows the way in);
the browser view on its own (above).

**What the candidates show.** The two strongest (P-A, P-C) are team and CI surfaces **outside the
graph view**. That inverts the original premise ("the webview is the premium part"). With N3
decided, the views are the free product and the advert; money attaches where teams already spend
it, in review and CI. This fits "the MCP is the distribution channel" well and "the views are the
product" not at all: under today's decisions the views are what is given away. Worth saying to
Bela as a direction question, not slipping past him.

**Reversal in three months.**
- "Nothing yet": reverses any day, at no cost. The cost is time, not lock-in.
- Starting P-A: if it does not sell, it is a free CI action or it is shelved; nothing in the editor
  changes. Cheap.
- Starting P-B or the browser view as premium: a premium mode inside an MIT view; backing out means
  either making it MIT (cheap) or keeping a gate in public code (awkward). Cheap to medium.

**My recommendation:** no premium tier now: no split, no key, no licence work. If Bela wants a
revenue path in the next months, **P-A first**: most value per day of work, sold to the people who
hold budgets, and its code is separable by construction (which makes E2 cheap). P-C follows on top
of it; P-B shares P-A's diff engine and comes third.

**The one fact that would change it:** if the teams Bela talks to do not review on GitHub with CI
on their PRs (for example they review in the editor, or use another forge), P-A has no home and
P-B, the in-editor diff, becomes the first candidate.

## E2. Where premium code lives, and under which licence

**The question.** Once something is premium, where is its source, and what licence covers it?

*Re-costed 2026-10-06 against the reworked E1.* With no premium product, the first answer is **(0)
do not split**: no repo, no package, no export, no licence change. It costs nothing, forecloses
nothing, and reverses any day. The reasoning below (features cross host and view, v1.3.0 added 17
messages, a two-repo split taxes every feature and splits Termi sessions) now argues for (0): a
private monorepo to protect one deferred, readable-when-shipped view is a lot of permanent
machinery for about a week of code.

What changes the answer is *which* premium surface gets built, because that decides which boundary
the split runs along:

| Surface | Boundary it crosses | How often that boundary moved, Jul to Sep 2026 | Right shape |
|---------|---------------------|-----------------------------------------------|-------------|
| P-A (CI impact), P-C's checker | analyzers + cache format + `impact` queries | **5 commits** on analyzers/cache | **(d) a separate private repo that depends on the public one.** The dependency points one way, so the public build never needs private code: no lite view, no token in public CI, no frozen view protocol. Setup about a day; it is also its own Termi project, so view sessions are unaffected |
| P-B, browser view (modes of the view) | the host/view protocol | **69 commits** on the view, 17 new messages in one release | (b) below, if at all; the full reasoning applies |

(d) still needs a way to consume the public code: a git dependency on a tag works today; an npm
package needs the E4 name. Friction appears only when a premium change needs an analyzer change,
which the data says is rare.

The three structures below are the options for a premium surface **inside** the view (P-B or the
browser view); (a) is no longer recommended for anything. Each with its natural licence:

| Option | Shape | Licence of premium code |
|--------|-------|-------------------------|
| (a) Private package (the strategy doc's plan) | Public MIT repo + private repo `…-webview` published as a private npm package, pulled in at build time | Proprietary EULA |
| **(b) Private monorepo + public MIT export (recommended)** | You develop in **one private repo** that holds everything; a CI job exports the MIT file list to the public repo on every release (or every merge) | Proprietary EULA |
| (c) Open core in one public repo | Premium files sit in a `premium/` folder of the public repo under a source-available licence; a key gates them at runtime | FSL-1.1-MIT (converts to MIT after 2 years) or Elastic 2.0 |

**What each commits us to, forecloses, and costs to reverse.** Part 2 has the full cost model; the
summary:

| | (a) private package | (b) private monorepo + export | (c) open core |
|-|---------------------|-------------------------------|----------------|
| One-off setup | 3 to 5 days (repo + history import, jsdom runner for the moved tests, lite view, CI matrix with and without token, esbuild resolution, local linking) | 1 to 2 days (export path list, CI job, a check that the export builds and tests on its own; a lite view only if the whole view were premium) | Under 1 day (licence file, folder, key check) |
| Daily dev loop | Two repos, two watchers, linked package; features that cross need two branches, two PRs, a package release and a bump | **Unchanged**: one repo, one CI, one Termi project | Unchanged |
| Every release | + package publish + bump + one more expiring token (`NODE_AUTH_TOKEN`) | + export job (automated); one more token for the push | Unchanged |
| Outside contributors | Host PRs as today; graph-view PRs impossible | Every outside PR lands on the export repo and must be applied by hand in the private repo | As today, they can even read premium code |
| Commits us to | A frozen, versioned protocol between two repos | An export allow-list that must never leak a premium file (a leak is permanent) | Premium source and unreleased work visible to competitors |
| Forecloses | Cheap cross-cutting features | A public history that matches the real one (the public repo shows export commits) | Ever making that source private again |
| Reverse in 3 months | 1 to 2 days: import back, delete package, unwind CI; nothing published is lost | Hours: stop the export, or make the private repo public | Can go private for future work; what was published stays published under FSL |

Why (b) over (a) for a solo founder: (a)'s plan rests on a **frozen interface** between the repos.
The release data says that interface is not frozen: v1.3.0 added 17 messages in one release, and
the three features in flight all add more. In (a) every one of those becomes a cross-repo change
with version skew as a new class of bug. (b) keeps the development loop exactly as it is today and
moves the cost to a release-time export that a script does. (c) is the cheapest of all but publishes
the premium source and your roadmap; since the shipped JS is readable anyway, the real difference
between (b) and (c) is unreleased work and history, not the shipped product.

For a premium mode inside the view, nothing that exists moves; only the new mode is private, so all
three are smaller than the table suggests. The full table is the cost if the whole view moved.

**Licence.** For (a) and (b): a proprietary licence (all rights reserved + a one-page EULA for the
shipped bundle), with a lawyer's pass before the first paid key, not before the split. For (c):
FSL-1.1-MIT, which is written for exactly this (source visible, no competing use, becomes MIT after
two years). The licence follows the structure; it is not a separate decision.

**My recommendation: (0) now.** When P-A (or P-C's checker) starts: **(d)**, created on the day
the first premium line is written, so nothing has to be carved out later. **(b)** only if Bela picks
a premium surface inside the view, and then only after the sequencing constraint (Part 2). Licence
for (d) and (b): the proprietary one above.

**The one fact that would change it:** if Bela wants premium to live in the editor view after all
(P-B or the browser view first), (d) does not fit and (b) is the shape; and if outside
contributions then grow past a couple of PRs a month, (a) beats (b), because hand-applying them from
the export repo becomes the bottleneck. Today it is 4 outside PRs in six months.

## E3. How premium is sold and checked

**The question.** What does a paying user install, and what stops a non-paying one? Price is yours;
this is only about what the technical options make easy and hard.

| Channel | Easy | Hard |
|---------|------|------|
| **One Marketplace listing + licence key (recommended)** | One install, auto-update, a trial is a key with an expiry, upgrading is pasting a key | Nothing hides the code (true of every option; the shipped JS is readable); payment happens outside the Marketplace |
| Private VSIX for paying users | Premium code never appears on the Marketplace | No auto-update for side-loaded extensions; two builds with the same extension id cannot be installed side by side; every update is a support email |
| Separate "CoGraph Pro" Marketplace listing | Clean separation, auto-update, own page | Still public JS, so it still needs a key; a versioned API between two extensions; installs and reviews split across two listings |

| Check | Easy | Hard |
|-------|------|------|
| **Offline signed key** (Ed25519, public half in the bundle) | No server, works offline, issued by a script until there is a checkout | A determined user can patch it out (acceptable); no seat counting |
| Online account (`vscode.authentication` or own OAuth) | Seats, teams, revocation | Needs a backend, a privacy story, and breaks offline |

As far as I know the VS Code Marketplace has no purchase flow of its own for VS Code extensions, so
money moves through an external checkout (e.g. a merchant-of-record service that also handles EU VAT).
I have not verified this against current Marketplace terms; check before planning around it.

*Note after the E1 rework:* if the first premium surface is P-A, the same signed key works
unchanged; it is read from a CI secret instead of a VS Code setting, and the "channel" is the Action's
README rather than the Marketplace listing. Nothing else in E3 changes.

**Commits us to (recommended path):** a key format and a public key in every build from then on;
honouring every key issued. **Forecloses:** nothing until the first paid key. **Reversal in three
months:** before any paid key, delete the check (an hour). After paid keys, refunds or keep honouring
them.

**My recommendation:** one listing + offline key, built in the same release as the first premium
view, keys issued by hand until sales justify a checkout. No key system before there is something
to unlock.

**The one fact that would change it:** if the buyers are teams that need seat management or SSO,
an online account check is needed from day one and the offline key is wasted work.

## E4. Public names

**The question.** Under which names does CoGraph publish: GitHub organisation, npm scope, the MCP
package (session-214 plans `npx cograph-mcp`), the private package?

**What I found (2026-10-06):**
- `github.com/cograph` is an existing **user** account (not yours, created 2020). A `cograph` GitHub
  org cannot be created.
- On npm, `cograph` and `cograph-mcp` are **published by another project**: "Onta (formerly
  Cograph)", an MCP server for a context-graph platform, since April 2026. So `npx cograph-mcp` would
  run *their* server. Session-214's D2 needs a different name.
- `@cograph` as an npm scope: could not tell from outside.

**Commits us to:** once a package is published and people put `npx <name>` into their `.mcp.json`,
the name is effectively permanent. **Forecloses:** a name someone else takes first. **Reversal in
three months:** a renamed package leaves every existing config pointing at the old one; npm
deprecation messages help, but users have to edit their config.

**My recommendation:** before 214 publishes anything, pick one name that is free on GitHub (org),
npm (scope) and the Marketplace together, and register the GitHub org and npm scope (free, minutes,
publishes nothing). Candidates to check, not decided: `cograph-dev`, `cographhq`, `getcograph`. The
MCP package would then be `@<scope>/mcp`. This is outward-facing, so it needs your yes, and the name
is a brand question, so it is yours.

**The one fact that would change it:** if the "Onta" project has a trademark on "Cograph" in your
markets, the question becomes the product name, not the package name. Worth a quick check before
anything is registered.

---

# Part 2: the evidence

## What the split really costs, day to day

This costs option E2 (a) with the whole graph view moving, the most expensive combination, because
that is what the strategy doc planned. After N3 nobody proposes that combination any more; it is
kept as the reference point that shows why (0) and (d) are cheaper.

**One-off: 3 to 5 days.** Private repo + `git filter-repo` history import; a jsdom + mocha runner for
~707 tests that today run inside VS Code's test host (that they need nothing from VS Code is
plausible but **unverified**: one suite should be run first); `webview-lite/`; esbuild resolution;
CI matrix (with and without token); `docs/protocol.md`; licence wording.

**Per day.** Two checkouts, two watchers, a linked package. F5 debugging works only if esbuild
resolves a sibling checkout (a path override, part of the setup). Polish work (most commits) stays
in one repo and costs nothing extra.

**Per cross-cutting feature** (every feature release so far): two branches, two PRs, a prerelease of
the private package, a version bump in the public repo, two CI runs. My estimate: one to two extra
hours per feature, plus a new class of bug, host and view at different protocol versions, which
cannot happen today.

**Per release** (one a month recently): package publish, bump, tag both repos, roughly 30 extra
minutes, and one more expiring token. An expired `VSCE_PAT` has already broken a release once; this
adds a second token that can do the same.

**Multi-session work.** Termi's worktrees and merge-on-close live inside one repo (`.termi/worktrees`
of the project). Rounds 1 to 3 ran ux, perf and annotate sessions side by side in `src/webview`.
After the split those sessions work in the private repo, and a feature that touches the host too
needs a worktree in each repo and cannot be merged as one unit. This is the largest real cost for
how you work, and it does not show up in a file count.

**Dependabot** roughly doubles (16 PRs in six months today).

**Contributors.** 10% of webview commits since July came from outside. After the split, outside
contributors can no longer touch the graph view at all; fork PRs to the host build against the lite
view, so they cannot even see their change in the real graph.

## What the free tier must keep for the MCP to be a way in

For a developer who arrives through the MCP and should end up paying for views:

1. **The analysers and the cache writer**: the MCP v1 (session-214's D3) only reads the cache.
   Host-side, MIT under every option. Fine.
2. **A way to produce the cache.** Today only the graph panel triggers analysis. The panel is
   free, so this holds. Agents outside VS Code still get nothing until someone has opened the panel
   once; 214's headless core (step 6) fixes that, and P-A needs the same core anyway.
3. **The MCP server itself, MIT, installable without asking anyone**: 214's D6 recommends MIT; I
   agree. A premium MCP would block the `npx` path for agents outside VS Code, which is the whole
   point of a way in.
4. **A visible next step**: the free graph shows what CoGraph sees. Under the reworked E1 the next
   step for a team is P-A in their CI, not a paid view.
5. **A name that resolves to us** (E4): today `npx cograph-mcp` resolves to someone else.

## Sequencing

Three things land before any split, and each changes what would move:

1. **Chat removal (session-214, planned for 1.4.0).** `sidebar-chat.js` and `markdown.js` are
   **deleted**, not moved (P6 resolved). About 1,100 LOC leave the codebase.
2. **Version Control view (session-262).** Fills the sidebar space Chat leaves:
   `src/webview/sidebar-vcs.js` + a new host module, plus a PR mode in the graph view (colours from
   the PR diff, expand exactly the changed folders). Consequences:
   - The sidebar is **not** a candidate for moving out wholesale. It stays in the free public build
     (or is gated per E1 at the PR click), so any split is a **file list**, not "`src/webview/*`".
     `src/webview/` will hold both graph and sidebar scripts.
   - The PR mode adds protocol messages. A frozen interface (E2 a) cannot be frozen before it ships.
3. **Other sessions with webview files in flight.** UX4 (session-216: hover card, `funcBrief.ts`
   shared with the MCP) and uxtest (session-181: 29 commits not yet in `main`). Moving `uxtest/` or
   graph files while those are open turns their merge into a cross-repo port.

**So the earliest point for any split is the release after the Version Control view ships**, with
no session holding webview files. Under E2 (b) this constraint mostly disappears: nothing moves in
the development repo, only the export list changes. A cheap preparatory step for whichever option
wins (not done now): one commit that separates graph-view scripts from sidebar scripts into two
folders, so "what is premium" becomes a folder, not a list.

---

# Part 3: defaults I take unless Bela objects

No answer needed. Each is cheap to change later.

| Was | Default | Why it is cheap |
|-----|---------|-----------------|
| P1 Button label | **"Open in browser"**, tooltip "Open this graph in your browser". The "sidebar chat loses its button" half is moot (Chat is removed). | A string. |
| P2 Mirror or independent view | **Mirror** (D1). Scope is host state, so panel and tab share it; hides stay per view. | Independent mode can be added later; mirror is the smaller build. |
| P3 Tab survives closing the panel | **No.** Banner with "Reopen in VS Code". | Changing it later is a lifetime change in one module. |
| P4 `cograph.browserView.enabled` setting | **Yes, default on.** | A setting. |
| P5 Browser view free in 1.3.x or premium | **Deferred**: not being built this round. When it is built, free unless E1 has produced a premium tier it fits into. | Nothing exists yet. |
| P6 Sidebar chat in the split | **Resolved**: Chat is removed (214). | n/a |
| P7 Where `uxtest/` lives | **Follows E2.** Under (b) or (c) it stays where it is. Under (a): lab, scenarios, sweep and report private; `uxtest/vscode` public. | Only matters under (a). |
| P8 Free tier | **Moved to E1.** | n/a |
| P9 Key now or repo privacy only | **Moved to E3**: no key before there is a premium surface. | n/a |
| P10 Repo and package names | **Moved to E4.** | n/a |
| P11 Lawyer's review | **Yes, before the first paid key**, not before the split. | Timing only. |
| D4 Chat in the browser | **Never** (Chat is removed). | n/a |
| Contributors' OK (strategy step 1) | Not needed: under the reworked E1 nothing of theirs moves into a proprietary bundle. If that ever changes, I draft a two-line request and **you send it** (outward-facing). | Optional either way; MIT notices suffice. |
| Graph/sidebar folder separation | Propose it as one commit when no session holds webview files; not now. | A rename. |

## What I need from Bela, in order

1. **E1**: agree that there is no premium tier today? And is a revenue path wanted in the next
   months? If yes, P-A (PR impact check in CI) first, or one of P-B / P-C? Also the direction
   question underneath: with the views free, money would attach to team/CI surfaces, not views.
2. **E4**: the name. `cograph` is taken on GitHub and npm; pick one free everywhere before 214
   publishes. A yes to register the org and scope once you have picked it.
3. **E2**: only after E1. With no premium tier: nothing to decide (no split). With P-A: a separate
   private repo that depends on the public one.
4. **E3**: one listing + offline key when the first premium surface ships (my recommendation), or an
   online account for teams?
