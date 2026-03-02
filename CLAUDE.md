# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is a solo-founder codebase. Fill in `.ai/context/architecture.md` and `.ai/context/product.md` as the project grows — they are currently empty templates.

Key architectural decision: **monolith over microservices** (lower cognitive load for solo development).

## AI Workflow

All non-trivial tasks follow a three-phase pipeline defined in `.ai/workflow.md`:

1. **Planner** (`.ai/agents/planner.md`) — Analyze, break into steps, identify risks, define test strategy. Output a plan and **wait for approval**. Do not write code.
2. **Executor** (`.ai/agents/executor.md`) — Implement only the approved plan. Minimal file changes. No scope expansion.
3. **Reviewer** (`.ai/agents/reviewer.md`) — Review the diff for code quality, architecture, security, performance, and test coverage.

## Hard Constraints (from `.ai/system.md`)

- Never delete files without explicit instruction
- Never modify authentication logic silently
- Never change database schemas without a migration plan
- Never introduce breaking API changes without warning
- When unsure about product decisions, ask — do not assume

## Coding Standards

**Naming:** camelCase for variables, PascalCase for components, snake_case for DB columns.

**Size limits:** Files < 400 LOC preferred; functions < 50 LOC preferred.

**Error handling:** All async functions must handle errors explicitly. Never swallow exceptions.

**Logging:** Use structured logs. No `console.log` in production code.

**Testing:** Minimum 80% coverage. Mock external APIs.

## Context Files to Consult

| File | Purpose |
|------|---------|
| `.ai/context/architecture.md` | Stack, folder structure, core flows, design decisions |
| `.ai/context/product.md` | Target user, value proposition, non-goals |
| `.ai/memory/decision.md` | Log of architectural decisions with rationale |
| `.ai/memory/tech-dept.md` | Tech debt tracking (review weekly, fix 1 item max) |

## Templates

- **New task:** Use `.ai/templates/task-template.md` (Problem / Constraints / Acceptance Criteria / Out of Scope)
- **PR description:** Use `.ai/templates/pr-template.md`
