# Pipeline defects found during the bug epic #64 run

Each entry is a problem in the pipeline's own flow (not a bug ticket the agents
worked on): symptom, root cause, fix, commit and impact.

## D1: delegated pair agents could not read their prompt (Copilot CLI)

- **Found:** 04:22, three minutes into the run.
- **Symptom:** BUG-4 (group `catalog-write-auth`) ended `pair-exhausted` after
  about three minutes. Every pair-implementer run took about 10 s and committed
  nothing, and the escalation run exited 1 after 13 s.
- **Root cause:** `prepare()` in `scripts/pipeline/lib/agents.mjs` wrote the
  Copilot prompt file under `config.root`, the story worktree (`bug-4`). Pair
  agents run with their cwd in a subtask worktree (`bug-4--identity-admin-role`),
  so the agent was told to read `../bug-4/.agent-state/prompts/…`. Headless
  Copilot (`-p`, `--trust-folder <cwd>`) denies reads outside the trusted folder:
  "the command was denied because it needed interactive approval". Every
  delegated pair-implementer, pair-verifier and escalation ran without its task.
  Single-implementer ("self") stories were not affected, because their cwd is
  the story worktree. A second, latent problem: prompt file names were
  `<name>-<pid>-<ms>`, so two pairs started in the same millisecond by one
  process would overwrite each other's prompt.
- **Fix:** write the prompt file under the agent's own cwd
  (`<cwd>/.agent-state/prompts/`) with a random suffix. A regression test runs
  two concurrent agents with a fake `copilot` and checks the location and that
  the files are distinct.
- **Commit:** `7f050e8` (pipeline: write the Copilot prompt file under the
  agent's cwd).
- **Impact:** any delegated (multi-subtask) story run with Copilot as the agent
  CLI failed. This is the first real Copilot run of the delegate mode; the
  Claude CLI path passes the prompt on stdin and was not affected. BUG-4 was
  lost (cleaned up and restarted). BUG-5 and BUG-6 were interrupted by the stop
  and resumed in their worktrees.

## D2: bug groups ignored the epic note's cross-group `dependsOn`

- **Found:** 04:24, while reviewing the plan after D1.
- **Symptom:** the epic plan said `token-audience` "ships alone after
  catalog-write-auth" and `ordering-error-handling` "merges after
  ordering-ownership", and its stories had `dependsOn` across groups (BUG-6,
  BUG-11, BUG-17 → BUG-4; BUG-10 → BUG-2). But all 9 groups were saved with
  `deps: []` and would run in parallel from `origin/main`, each without the fix
  it builds on.
- **Root cause:** `groupDeps()` and `validateGroups()` in
  `scripts/implement/lib/epic-plan.mjs` derived group ordering only from the
  tickets' `**Blocked by:**` lines. These bug tickets have none, so the
  orchestrator's `dependsOn` was used only for ordering inside a group.
- **Fix:** a ticket's prerequisites for grouping are its Blocked-by tickets
  plus the note's `dependsOn`. A dependent group now waits for its prerequisite
  group, stacks on its branch, and is skipped if that group fails. The
  validator rejects a `dependsOn` that points to a later group. The planner
  prompt explains the cost of a cross-group `dependsOn`. Tests and
  `implement.md` are updated.
- **Commit:** `4c7c5b1` (implement: bug groups wait for the groups their note
  dependsOn names).
- **Impact on this run:** after the resume, `token-audience`,
  `ordering-ownership`, `catalog-item-validation` and `catalog-paging` wait for
  `catalog-write-auth`, and `ordering-error-handling` waits for
  `ordering-ownership`. Their PRs stack on the prerequisite group's branch.

## Cosmetic (not fixed)

- `implement run --epic` on a bug epic prints `Delivery: epic.` and labels every
  ticket `<- the epic's branch`, although each group gets its own `bugfix/…`
  branch. The next line ("Bug epic: the orchestrator groups the tickets into
  PRs") is correct.
- `board status` without a ticket key prints only the board URL. This is by
  design, but it is not useful for a lane overview, so the operator used
  `gh project item-list` for the board snapshots.
