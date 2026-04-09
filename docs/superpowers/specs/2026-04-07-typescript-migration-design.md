# TypeScript Migration Design

**Date:** 2026-04-07
**Status:** Approved for planning

## Goal

Migrate the repository's root learning project from Python to TypeScript so the default learning path, runnable examples, tests, and all user-facing documentation use Node.js and TypeScript instead of Python.

## Scope

This migration covers the root teaching project and its documentation:

- Replace the root `agents/*.ts` teaching implementations with TypeScript equivalents.
- Replace Python-based tests in `tests/*.py` with `vitest` tests.
- Replace Python project configuration and commands with Node.js and TypeScript tooling.
- Rewrite the root documentation to present TypeScript as the primary and only supported implementation language.
- Update all three documentation languages: English, Chinese, and Japanese.

This migration does not redesign the educational curriculum and does not turn the `web/` app into the main runtime for the agent code. The `web/` app remains a separate TypeScript frontend and should only receive compatibility updates if it depends on root project content.

## Non-Goals

- Maintaining Python as a supported runtime or side-by-side reference implementation.
- Reordering or renumbering the `s01` to `s12` teaching sequence.
- Broad visual or architectural changes to the `web/` frontend beyond required compatibility fixes.
- Inventing new harness concepts that are not already part of the course structure.

## Product Direction

The repository should continue teaching the same Claude Code harness concepts, in the same order, with the same session structure. The difference is that every runnable example, setup instruction, and code walkthrough should now assume a TypeScript and Node.js environment.

The migration should favor learning clarity over literal source translation. The result should feel like a TypeScript-native teaching project, not a Python codebase mechanically rewritten into TS syntax.

## Technical Decisions

### Runtime Stack

- Package manager: `npm`
- Runtime execution: `tsx`
- Language: TypeScript
- Test framework: `vitest`
- Type checking: `tsc --noEmit`
- Environment loading: `.env` support retained
- LLM SDK: TypeScript Anthropic SDK

### Project Shape

Keep the current top-level teaching structure:

- `agents/` remains the home for session implementations and `s_full`
- `tests/` remains the home for runtime verification
- `docs/en`, `docs/zh`, and `docs/ja` remain the documentation roots
- `web/` remains a separate TypeScript frontend

Add a shared TypeScript runtime layer for reusable implementation details:

- `src/core/anthropic.ts`
- `src/core/types.ts`
- `src/core/bash.ts`
- `src/core/fs.ts`
- `src/core/tools.ts`
- Additional narrowly scoped support modules as needed

The teaching files in `agents/` must stay readable and session-focused. Shared modules should only absorb repeated infrastructure that would otherwise distract from the lesson of each session.

## Migration Strategy

### Code Migration

Use a one-session-per-file TypeScript migration while allowing light refactoring into shared modules.

That means:

- Preserve the educational purpose and naming of `s01` through `s12` and `s_full`
- Replace `.py` implementations with `.ts` implementations
- Avoid line-by-line transliteration where TypeScript supports a cleaner structure
- Keep the code examples simple enough to be read as teaching artifacts

### Test Migration

Replace Python smoke and regression tests with `vitest`.

Tests should focus on:

- Importability and basic integrity of the `agents/*.ts` modules
- Regression protection for behavior-sensitive pieces such as background task handling
- Mocked Anthropic and environment interactions where needed

This project does not need exhaustive unit coverage. It needs reliable verification that the educational examples still load and that key harness mechanisms do not regress silently.

### Documentation Migration

Rewrite all user-facing documentation so TypeScript is the default implementation language.

Apply these rules across README and chapter docs in English, Chinese, and Japanese:

- Replace Python commands with Node.js and TypeScript commands
- Replace Python code blocks with TypeScript code blocks
- Replace Python-specific dependency and tooling references
- Preserve the teaching narrative, chapter order, and conceptual explanations
- Rewrite wording that depends on Python semantics when those details no longer apply

Do not keep Python as a parallel track in the docs. The docs should read as if the project was designed around TypeScript from the start.

## Directory and Command Design

### Expected Root Layout

- `agents/*.ts`
- `src/core/*.ts`
- `tests/*.test.ts`
- `package.json`
- `tsconfig.json`
- optional Vitest configuration if required

### Expected Commands

- `npm install`
- `npm run s01`
- `npm run s_full`
- `npm test`
- `npm run typecheck`

The default workflow should not require a build step before running examples. `tsx` should execute the teaching files directly to keep the onboarding path simple.

## Compatibility Rules

- Retain existing environment variable names where practical, including `MODEL_ID` and `ANTHROPIC_BASE_URL`
- Preserve chapter identifiers, filenames, and conceptual mapping where possible
- Avoid unnecessary renames that would force unrelated documentation churn
- Update `web/` only when root-file path changes or generated content assumptions require it

## Risks and Mitigations

### Risk: The migration becomes a syntax-only rewrite

Mitigation: use shared modules where TypeScript benefits from clearer factoring, while keeping session files instructional.

### Risk: Documentation drifts across languages

Mitigation: treat all three doc trees as part of the same migration scope and update them in the same pass, especially commands, file paths, and code blocks.

### Risk: The TypeScript implementation becomes too abstract for learners

Mitigation: keep abstractions narrow and local to repeated runtime plumbing; leave the teaching logic visible inside each session file.

### Risk: Existing frontend content depends on Python-oriented paths or text

Mitigation: audit `web/` references during implementation and make minimal compatibility updates only where breakage is concrete.

## Acceptance Criteria

The migration is complete when all of the following are true:

- The root learning project runs through Node.js and TypeScript rather than Python
- `agents/*.ts` replace the Python session implementations as the main teaching code
- Root tests run via `vitest`
- The repository can be set up with `npm install`
- English, Chinese, and Japanese documentation present TypeScript as the primary implementation
- Python is no longer part of the primary developer and learner workflow

## Implementation Handoff

The implementation plan should be written next. It should preserve the approved scope above, decompose the migration into small tasks, and explicitly include code, tests, docs, and verification work.
