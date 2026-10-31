/**
 * The engine's headless side, which the private CLI bundles: `cograph-tour fetch` and `build`
 * call these and nothing else of this repository. No vscode import anywhere below (a test
 * walks the imports). docs/ci-engine.md says what a run may read and what it may not.
 */
export { analyzerScriptPath, probePython } from '../analyzerSpawn';
export { ensureCommits, fetchExec } from './fetch';
export type { EnsureCommitsOptions, EnsuredCommits } from './fetch';
export { createHeadlessApi } from './headlessApi';
export type { HeadlessAi, HeadlessOptions, HeadlessRun } from './headlessApi';
export { STAGE_ROOT, stageData } from './stageData';
export type { StageData } from './stageData';
export { gitExec, resolveGit, toolEnv } from './toolEnv';
export { CI_MAX_OUTPUT_BYTES, analysisState, ciTarget, prepareCiTrees } from './trees';
export type { CiChange, CiContext, CiTrees, CiTreesDeps } from './trees';
