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

## D3: a fresh restart kept the previous attempt's findings and metrics

- **Symptom:** after BUG-4 restarted fresh (its first attempt was
  pair-exhausted by D1), `implement status` reported 9 agent runs, and the run
  record `.agent-state/implement/BUG-4.json` still listed the first attempt's
  findings for the old subtask `identity-admin-role`, with `pairRounds` 6 and 2
  escalations.
- **Root cause:** `saveRun` merges every patch into the existing record, and a
  worker start only reset `status`, `outcome` and `reason`. A successful result
  carries no `findings`, so the old ones would survive even after the story is
  done. `board fail` builds the card's failure comment from this record, so a
  failed restart could quote the earlier attempt's findings.
- **Fix:** a fresh (non-resume) start writes a new record (key, branch,
  worktree, base, run fields). A resume still keeps the record. The e2e
  implement test now seeds stale fields and checks that they are gone.
- **Commit:** `c55ed59`.
- **Impact on this run:** the batch already running keeps the old code. BUG-4's
  record keeps the stale fields until the run is restarted, and the per-story
  metrics in `.agent-metrics/implement-runs.jsonl` are not affected.

## D4: the pipeline's own QE commit failed the repo's markdown lint

- **Symptom:** BUG-7 and BUG-16 got a verified plan and verified tests, then
  ended `error` at `git commit -m "<KEY>: Add verified test plan and automated
  tests"`: the pre-commit hook's markdownlint reported MD025 (multiple
  top-level headings) on every test case and MD060 on the index table. Group
  dependents were skipped (BUG-14) and the groups got no PR.
- **Root cause:** the documented test-case format puts the title in the front
  matter and repeats it as the `# <id>: <title>` heading (`precheckPlan`
  requires both). markdownlint counts a front-matter `title` as a top-level
  heading. The markdown lint hook arrived after the QE format, and the QE
  stage never ran the linters, so the first lint was the harness's last
  commit, where nobody can fix it.
- **Fix:** `.markdownlint.json` sets MD025 `front_matter_title: ""`. QE
  `precheck.lint` mirrors the hook (markdownlint, eslint,
  `dotnet format whitespace`) on the plan and test files, and failures go back
  to the producing agent like any precheck error. The qe-plan agent is told
  the table style. Unit test for `lintFiles`.
- **Commit:** `e865f2f` on the run branch, shipped to `main` early as
  [#69](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/69)
  because the hook reads the ticket worktree's lint config, which comes from
  `origin/main`.
- **Impact on this run:** every ticket would have failed at this commit. The
  failed tickets keep their verified QE work in their worktrees and resume
  after `origin/main` (with the fix) is merged into their branches.

## D5: verified plans with compact tables could never be committed

- **Symptom:** after D4, BUG-4/BUG-7 would still fail the QE commit on MD060 (`|----|----|` delimiter rows in `_index.md`), because their plan was already verified and a resume goes straight to the commit; the D4 precheck only runs inside a plan round.
- **Root cause:** agents write compact delimiter rows, which markdownlint's MD060 rejects and `markdownlint --fix` cannot repair. Any hand edit would change `plan-sha` and invalidate the verification.
- **Fix:** `tidyPlan` (`scripts/qe/lib/plans.mjs`) normalizes delimiter rows to `| --- |` after each plan producer round and, through the new `qe tidy <story>`, right before the pipeline's QE commit. When the plan was verified it re-stamps `plan-sha` (and `automation-plan-sha` when the tests were verified against that plan), since only whitespace changed. A first version missed `automation-plan-sha`, caught in a pre-flight on the real worktrees before resuming.
- **Commits:** `30d205d`, `856d226` (e2e test in `scripts/pipeline/test/e2e.test.mjs`).
- **Impact:** without it every ticket whose plan agent wrote a compact table needed another plan round (tokens) or failed at the commit.

## Cosmetic

- **Fixed (`1d9b9a2`):** `implement run --epic` on a bug epic printed
  `Delivery: epic.` and labelled every ticket `<- the epic's branch`, although
  each group gets its own `bugfix/…` branch. It now says `Delivery: bug groups`
  and `<- its group branch`.
- **Not fixed:** `board status` without a ticket key prints only the board URL.
  This is by design, but it is not useful for a lane overview, so the operator
  used `gh project item-list` for the board snapshots.
- **Not fixed:** after a run is killed, `implement status` keeps showing the
  killed run's units (`token-audience` "running", BUG-6 "error", its subtask
  "verifying") until they run again.

## D6: resumed tickets restarted from scratch over their own work

- **Symptom:** after the 05:24 resume, BUG-5 (whose QE run had been stopped)
  was implemented again from round 1. `pipeline start` reset its review state,
  and the implementer's commit then failed the pre-commit lint on the half-written
  QE files still in the worktree (MD060 in the plan index, CHARSET in a test file).
  BUG-5 ended `error` and its group `login-open-redirect` got no PR. BUG-6 was
  restarted fresh the same way.
- **Root cause:** `plan()` resumes a ticket only when its run record names a
  worktree that exists. Epic runs never write a queued record (unlike the batch
  path), and records written before D3 had no `worktree`, so every interrupted
  epic ticket (BUG-5, 6, 7, 8, 16) looked new.
- **Fix:** fall back to the ticket's standard worktree path (`worktreeFor`) when
  the record has none. Test in `batch.test.mjs`. Commit `ec7c834`.
- **Impact:** one wasted opus implementer run on BUG-5 and one on BUG-6. The
  operator tidied BUG-5's leftover plan (`qe tidy`) and fixed the test file's BOM
  before resuming.

## D7: a delivered group opened no PR (push blocked by a stale plan)

- **Symptom:** `catalog-write-auth` (BUG-4 merged, PR check done) ended `done`
  with no PR and nothing in the run log. Its saved reason was
  `push failed: QE: push blocked`.
- **Root cause:** `prepareUnitWorktree` copies the ticket cache into the group
  worktree once, before its tickets run. Each ticket's implementer then adds
  Implementation Notes to the ticket in its own worktree, and the QE plan's
  `story-sha` covers them. In the group worktree, the pre-push QE check saw the
  older ticket text and reported `plan=stale`. The PR check also read the old
  text. The `openPr` failure was not logged.
- **Fix:** `syncTickets` copies each ticket worktree's cached ticket into the
  group (or epic) worktree right before the unit PR check and push, and the run
  log prints `no PR: <reason>`. The epic test asserts the group PR check sees the
  notes. Commit `8bf1c3c`.
- **Impact:** the first group PR was delayed about 40 minutes. On resume, PR
  [#70](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/70)
  opened straight away.

- **Follow-up (D7b):** the next group, `token-audience`, stacks on
  `catalog-write-auth`, so its branch also carries BUG-4's plan, and its push
  failed the same way (`FAIL BUG-4 plan=stale`). A stacked group now also syncs
  the tickets of every group below it (transitively). The test fails without the
  fix. Commit `0599c43`.

## D8: a redundant per-ticket PR check in group delivery

- **Symptom:** every ticket's worktree had a background
  `pr-check.mjs hook-run` waiting for QE. BUG-4's and BUG-7's ran the full
  critic panel (4-5 critics, a defender and a judge on opus) after QE. Waiters
  for killed QE runs stayed orphaned.
- **Root cause:** the agent Stop hook starts a background PR check after QE
  unless `PR_CHECK_SKIP` is set, and `implement` never set it. In epic and
  bug-group delivery, the unit runs one PR check over all its tickets anyway
  (implement.md step 6), so each ticket was checked twice.
- **Fix:** a ticket worker running under epic or group delivery sets
  `PR_CHECK_SKIP=1` for its agents. Single-ticket runs keep the hook check.
  Documented in implement.md. Commit `c76fe3c`.
- **Impact:** about 7 premium opus/sonnet agent runs saved per ticket (21
  tickets). Three orphaned waiters were stopped.

## D9: a re-delivered group failed to "open" the PR it already had

- **Symptom:** on the 06:02 resume, `catalog-write-auth` (PR #70 open) was
  re-delivered (every unit is, on resume) and logged
  `no PR: gh pr create failed: a pull request ... already exists`. The unit's
  result had no PR, so the epic summary would report "PRs were not all opened".
- **Root cause:** `openPr` always ran `gh pr create`. It never looked at the PR
  saved in the unit state, or on GitHub.
- **Fix:** `deliverUnit` passes the unit's saved PR. `openPr` pushes, reuses that
  PR (or an open PR for the branch found with `gh pr list --head`), and refreshes
  its body. Test: a second run hands the existing PR over and reports the same
  PRs. Commit `f18bde0`.
- **Impact:** cosmetic for this run (PR #70 kept, card already in Pending
  Review). The next restart applies the fix.

## D10: QE used the user's slot-0 stack at parallel 1

- **Symptom:** after auto resources dropped to `--parallel 1` (05:35), QE ran
  each story's e2e specs on slot 0 (`eshop-teststack`, the user's stack) behind
  the machine-wide lock instead of on a leased slot. The QE agents rebuilt slot
  0 from their own worktree (`bug-1` at 05:36, `bug-5` at 06:02), so the user's
  stack ended up running unreviewed ticket code. If an agent had skipped the
  rebuild, the specs would have tested `main`.
- **Root cause:** `wantsSlot` leased a slot only when `IMPLEMENT_PARALLEL > 1`.
  At 1 it assumed slot 0 was the right stack, but under `implement` the ticket
  lives in its own worktree, and slot 0 was never built from it.
- **Fix:** lease a slot whenever `IMPLEMENT_PARALLEL` is set (any `implement`
  run). A developer's own `qe` run outside `implement` still uses slot 0.
  `qe.md` and `implement.md` are updated, and the test is updated. Commit
  `839c842`.
- **Impact:** BUG-1's and BUG-5's results stand (they tested their own code).
  The user's slot 0 should be rebuilt from `main` after the run (`testing/teststack up`
  from the main checkout).

## D11: live run cost was invisible

- **Symptom:** mid-run, `pipeline costs` showed 1 run ($0.77, the epic plan)
  while about 145 agent runs had finished.
- **Root cause:** every agent run appends to `.agent-metrics/token-usage.jsonl`
  in the worktree it ran in. Ticket and group branches merge to `main` only
  after human review, so the main checkout only sees the epic planner's run.
  This is correct for the committed record, but an operator could not watch
  spend during a run.
- **Fix:** `pipeline costs --worktrees` reads the file from every git worktree
  and drops identical records (a group branch carries its tickets' records).
  Test added; `costs.md` updated. Commit `c70f369`.
- **Impact:** monitoring only; no run behavior changed.

## Observations (not changed)

- **O1, lspd leak on kill.** The implement runner has no signal handlers, so
  killing a run leaves its language-server daemons up until their 15-minute
  idle timeout. One held a C# slot, and BUG-4 started without C# LSP. The idle
  timeout is the designed safety net; the operator stopped it by hand.
- **O2, zero LSP calls.** Several stories report 0 LSP calls. The `lsp` MCP
  works from a fresh worktree under Copilot (checked by hand), so this is how
  the agents chose to work, not a broken handoff. `implement status` flags
  "signature changed without find-references" where it matters.
- **O3, re-plan on resume.** BUG-5 (self mode) was planned again on resume
  (new decision `1d5bf6b2`). This is documented: only orchestrated stories with
  a saved plan skip re-planning. It cost one opus read run.
- **O4, group worktrees are reused as-is on resume.** A group worktree created
  before D2 was fixed would stay based on `main` instead of stacking on its
  prerequisite group, because resume reuses an existing worktree and only
  merges the extra branches. The operator removed the empty `token-audience`
  worktree before resuming so it is recreated stacked.
- **O5: killing the batch leaves QE runs orphaned.** `qe.mjs automate` runs are spawned detached (by design, so QE survives an agent turn), so killing the batch and its workers leaves them and their agents running. The operator stopped them by hand; a resume would otherwise have found the automation lock held. Not changed (detaching is intended), but a `implement stop` command would make operator interventions safer.
- **O6: wall-clock timeouts count host sleep.** The laptop slept (deep idle)
  from 06:50 to 08:26. BUG-13's planner hit its 33-minute timeout without
  having had 33 minutes of compute, and was retried. For unattended runs, keep
  the host awake (`caffeinate -dimsu -w <batch pid>` on macOS); a future
  `implement run` could start it itself.

## D12: a provider quota outage failed 14 tickets

- **Symptom:** at about 08:55 the Copilot monthly quota ran out. Every agent
  answered `You have exceeded your monthly quota`, and within 15 minutes the
  batch recorded BUG-18 `pair-exhausted`, BUG-11/BUG-14 `plan-rejected` ("no
  plan found"), BUG-8/BUG-16 `qe-blocked-on-plan`, skipped their dependents,
  closed four groups without a PR and moved 14 cards to Failed.
- **Root cause:** an agent that fails because its provider refuses all requests
  looks like any failed agent run. The harness spent its plan retries, pair
  rounds and QE rounds on it, then reported an ordinary outcome, and the
  scheduler cascaded "blocker failed" skips.
- **Fix:** `scripts/pipeline/lib/outage.mjs` recognizes quota and usage-limit
  answers (Copilot quota, Claude usage/5-hour limits, low credit) in stderr or
  short/failed answers. `runAgent*` records a run-wide marker
  (`PIPELINE_OUTAGE_FILE`, inherited by worker and QE processes). An
  orchestrated story stops at once (`agent-unavailable`), a story that does not
  finish `done` during the outage ends `error` (resumable, not retried), the
  story and group schedulers start nothing more and skip nothing, and the
  runner moves no card to Failed, leaves the batch unfinished and exits 75 so
  `implement resume` continues later. Tests in `outage.test.mjs` and
  `epic.test.mjs`; `implement.md` "Agent provider outages". Commit: see
  timeline 09:45.
- **Impact:** about 15 minutes of wasted agent runs and 14 cards wrongly in
  Failed; recovered by switching the agent CLI to Claude Code at 09:29 and
  re-running the non-done tickets.

## D13: an escalated ticket was re-run on every restart

- **Symptom:** after each batch restart, BUG-1 (QE escalated at 06:11) was
  re-planned and re-implemented by opus (about 5 minutes and three agent runs)
  and then ended `qe-escalated` again within minutes, because its QE
  escalation still stood.
- **Root cause:** `plan()` keeps only `done` stories and resumes interrupted
  ones; every other outcome starts over, including outcomes that wait for a
  human.
- **Fix:** `qe-escalated` and `review-escalated` are kept by later runs (the
  story is skipped with that outcome, stays a dependency, and its dependents
  are skipped for it as before). `--force` retries it once the escalation is
  handled. Tests in `batch.test.mjs` and `epic.test.mjs`; `implement.md`
  "Interrupted runs". Commit `e3ec3a0`.
- **Impact:** about $1–2 and 5–10 minutes of an agent slot per restart (five
  restarts so far).

## Observation O7: Claude Code's background model

Each Claude Code run records a second model besides the one the pipeline asked
for: `claude-haiku-5.5`, its built-in model for small background calls (about
18 output tokens per run, about $0.001). The pipeline's model policy covers
the models it requests, not the CLI's internal calls. The operator pinned the
background model to sonnet for this run (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) so
only allowed models run. A follow-up could set it in `cliInvocation` from the
policy for every Claude run.
