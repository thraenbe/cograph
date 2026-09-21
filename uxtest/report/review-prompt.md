# Prompt for the reviewing Claude session

You are reviewing one CoGraph UX test run. Work from files only; do not run the suite.

**Inputs** (all under `uxtest/artifacts/<runId>/`):
1. `findings.json` — every automatic finding with repo, scenario, engine/motion, step, `videoAtMs`, keyframe path.
2. `index.html` — the same data for humans (optional).
3. `<repo>/<scenario>-<engine>-<motion>/run.json` — steps with `still`, `fps`, `metrics`, `consoleErrors`, `note`;
   `hostLog` = every message the webview posted; `perfReport`.
4. `…/steps/NN-*.png` — keyframes. **Read the images**: they are the ground truth for legibility (R1, R3, R4, R6).
5. `…/steps/NN-*.snapshot.json` — raw geometry, if a metric needs re-deriving.
6. If present: `sweep.csv`, `force-recommendations.md`, `contact-sheet.html` (open the PNGs it links).
7. `uxtest/report/rubric.md` — what each criterion means and where its evidence is.

**Method**
1. Group `findings.json` by `rule`; for each group open 1–2 keyframes and decide: real product bug, expected
   behaviour, or harness artefact (say which and why). A finding that appears on the synthetic repo *and* a
   real repo is almost certainly real.
2. Walk `smoke` C1 → C2 → C3 for every repo and score R1–R6 (1–5) from the keyframes + metrics.
3. Read every `failed` step and every `skipped` step whose note is not "selector absent": a skip such as
   "no free background point" or "no folder frame with a grabbable title" usually means the picture is broken.
4. Performance: tabulate P3/P4/P6/P7 per repo × engine from `run.json`. Flag H2/H4 violations.
5. Forces: from the sweep files, judge whether the best samples *look* better on the contact sheet, not
   only whether the score is lower. Prefer values that win on ≥ 2 repos; mention parameters with |ρ| < 0.3
   as "no measurable effect — candidate for removal from the UI".

**Output** — write two files next to `index.html`:

`findings.md`
```
## <short title>            severity: high|medium|low      confidence: high|medium|low
where: <repo> · <scenario> · <engine>/<motion> · step <n> "<name>" · video <m:ss>
evidence: <keyframe path> · <metric = value> · <console error, if any>
repro: <numbered steps a developer can do by hand in VS Code>
suspect: <file:function if the code was read, else "unknown">
```
Order by severity, merge duplicates across repos (list the repos), end with a table R1–R6 × repo and P3/P4/P6/P7 × repo.

`force-recommendations.md` (only when sweep data exists): per engine the proposed default for each force, the
evidence (rank, score delta vs defaults, which repos), the risk, and the sliders that showed no effect.

Do not propose code changes beyond naming the suspect; do not edit anything outside the run folder.
