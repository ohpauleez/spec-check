# Archive Record — 2026-11-15

- Change: `improve-ears-smt-analysis`; schema: `srs-driven`.
- User explicitly selected the active change and requested synchronization before archive.
- Proposal, design, specs and tasks were complete; all 79 task checkboxes were checked.
- Synchronized six canonical capability specs: 18 modified requirements, 17 added
  requirements, 171 scenarios; no removals or renames. Complete blocks match the
  deltas apart from archive-relative reference rebasing. Unrelated canonical
  content, including the Sol/high default and user-required level-three state-
  machine heading, was preserved.
- All six synchronized requirement projections passed strict validation. Full
  canonical validation added no errors; pre-existing missing-scenario errors on
  trailing model headings remain in catalog, claim-graph, formalization, reporting
  and source-traceability. The catalog heading is retained by explicit user request.
- Moved all 27 original change files without byte changes, including `.openspec.yaml`.
  After the move, only repository-relative links in proposal/verification prose
  were rebased for the additional archive directory depth. Historical command
  strings, model/evaluation bytes and prior snapshot evidence remain unchanged.
- Updated the three executable model/evaluation references in two test files to
  their archive locations. Copied canonical archive links and rebased repository
  links were checked after the move; 35/35 synchronized blocks were verified.
- Sync comparison/validation records: `/tmp/opencode/improve-ears-spec-sync/`.
- Post-archive full acceptance log: `/tmp/opencode/archive-ears-smt-check.log`.
- Post-archive `make check` passed 1,154 tests in 128 files, with three existing
  opt-in skips in two files. Strict TypeScript/ESLint, canonical trace accounting,
  relocated model/evaluation evidence and compiled/bundled CLI checks passed.
- `git diff --check` passed after archive bookkeeping.
- `openspec list --json` reports no active changes. No Git commit was performed.
