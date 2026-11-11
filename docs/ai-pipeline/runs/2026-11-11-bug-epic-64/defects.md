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
  plan found"), BUG-8 `qe-blocked-on-plan`, skipped their dependents,
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

## D14: resumed group tickets re-ran their implementer next to their QE

- **Symptom:** after the 10:18 restart, BUG-12 and BUG-14 (review approved,
  QE running detached) re-ran the opus implementer instead of "resuming after
  the approved review". BUG-14's harness commit swept in QE's unfinished files
  and failed the pre-commit lint (`CHARSET` on a QE-written test), so BUG-14
  ended `error` and its group lost its PR for this run.
- **Root cause:** the resume check compared `implChanges(wt).hash` with the
  review's `approvedHash`. The review hook runs with `PIPELINE_BASE_REF` set to
  the story's base (the group branch); the worker's worktree config used the
  default `origin/main`. For a ticket stacked on a group branch, the group's
  earlier tickets are in the `origin/main` diff, so the hashes never matched.
  Stand-alone stories (base `origin/main`) were not affected, which is why
  BUG-6's resume at 06:02 worked.
- **Fix:** `approvedOnDisk(wt, prior, base)` hashes against the story's own
  base. Test in `batch.test.mjs` with a real stacked repo; `implement.md`
  "Interrupted runs". Commit `3161049`.
- **Impact:** one extra opus implementer run per resumed group ticket on every
  restart, plus BUG-14 failing (recoverable) and running an implementer
  concurrently with QE in the same worktree.

## D13b: escalations kept forever, and a stale plan escalation

- **Symptom:** BUG-16 ended `qe-blocked-on-plan` on every run since 05:04,
  each time after a fresh opus implementer run. Its plan escalation was caused
  by pipeline defect D4 (markdownlint MD025 in the QE commit), fixed at 05:15,
  but escalation notes are never cleared by a fix, only by a stage re-run that
  passes.
- **Root cause:** D13 (first version) would have kept escalated outcomes until
  `--force`, and did not cover `qe-blocked-on-plan`; it also could not tell a
  handled escalation from a standing one.
- **Fix:** keep `qe-escalated`, `qe-blocked-on-plan` and `review-escalated`
  only while the matching `.agent-state/escalations/<KEY>-<stage>.md` is still
  in the worktree. Commit `ce7e49e`. The operator re-ran BUG-16's QE plan stage
  (verifier gate unchanged) to clear the stale escalation.
- **Impact:** BUG-16 lost about 5 hours and three opus implementer runs.

## D15: CI's generated-stack drift check was not a harness check

- **Symptom:** #70, #71 and #97 fail CI `teststack`: `deploy/teststack is out
  of date with the AppHost`. BUG-4's implementer added `Identity__Url` to the
  compose file by hand, in a different place than the generator writes it.
- **Root cause:** `implement.checks` ran only the build; the implementer
  instructions say to run `testing/teststack publish`, but nothing checked it.
- **Fix:** a second check runs `testing/teststack publish --check` when the
  branch changes `src/eShop.AppHost` or `deploy/teststack`. Commit `e249243`.
- **Impact:** three group PRs fail CI until a human regenerates the file on
  `catalog-write-auth` and merges it up the stack.

## D16: per-service unit tests never matched

- **Symptom:** #70 and #71 fail `Application.UnitTests`
  (`ApiResourcesAndScopesStayAligned`, expected 3 scopes, found 4) although
  every round's checks "passed".
- **Root cause:** `unitTests.project` is `tests/{service}.UnitTests` with
  `{service}` the `src/` folder name: `Basket.API`, `Ordering.API`,
  `Identity.API`... Only `ClientApp` and `eShop.AppHost` have matching
  projects, so the harness ran no Basket, Ordering or Application unit tests
  for any ticket.
- **Fix:** match the service name, the name without `.API`, or its first
  part, and fall back to `tests/Application.UnitTests` (which covers Identity,
  Webhooks and the processors). Commit `ef25d0c`.
- **Impact:** verifiers approved changes that break existing unit tests;
  caught only by CI on the group PRs.

## D17: shared spec files make earlier tickets' tests "stale"

- **Symptom:** the complete `catalog-item-validation` group (6 tickets) got no
  PR: `push failed:` with an empty reason. The pre-push QE check said BUG-4,
  BUG-13 and BUG-19: "tests or scenario edited after verification".
- **Root cause:** `automationSha` hashes the whole content of every test file
  that mentions a ticket's case ids. Tickets of one group add cases to the
  same spec file, so each later ticket changes the hash of the earlier ones.
  The failed push's reason was empty because the hook prints its FAIL lines
  on stdout.
- **Fix:** before a unit is pushed, `reverifyStale` runs `qe check`, and QE
  automates each stale ticket again in the unit worktree (its verifier
  re-runs) and commits; a ticket that does not verify again ends the unit
  `qe-reverify-failed`. The pre-push gate is unchanged and never bypassed.
  The push reason includes stdout. Commit `532790c`.
- **Impact:** the largest group of the run (6 bugs) was held back; any stacked
  group whose tickets share spec files hits this.

## D18: a blocked-on-plan automation never restarted

- **Symptom:** BUG-16's plan verified at 10:29, but the next run ended
  `qe-blocked-on-plan` again after its implementer re-ran; no automation log
  was written.
- **Root cause:** the QE stop hook returns early when automation already ran
  on the same implementation hash (`workingHash === hash`) and was not
  interrupted, whatever its outcome. A `blocked-on-plan` run therefore stayed
  terminal after the plan was fixed, and the implement worker read that
  status back.
- **Fix:** `automationUpToDate()` treats a `blocked-on-plan` run as out of
  date once the plan is verified. Unit test in `scripts/qe/test/unit.test.mjs`.
  Commit `15f7450`.
- **Impact:** BUG-16 needed two extra runs (each with an opus implementer).

## D19: metrics left in a group worktree blocked the next merge

- **Symptom:** BUG-14 (verified) ended `merge-conflict`: "Your local changes
  to the following files would be overwritten by merge:
  .agent-metrics/token-usage.jsonl".
- **Root cause:** the agent that resolved BUG-8's conflict ran in the group
  worktree and recorded its usage there after the merge commit; nothing
  committed it, and git refuses to merge over a dirty file.
- **Fix:** `mergeStory` commits pending metrics in the unit worktree before
  each merge (metrics logs merge as a union). Test in `epic.test.mjs`.
  Commit `0865621`.
- **Impact:** the `basket-cart` group (3 bugs) was held back one run.

## D20: a card in Failed could not reach Pending Review

- **Symptom:** BUG-14 was verified and its group PR #102 opened, but the board
  answered "verified ignored: not allowed from Failed".
- **Root cause:** the board's transition table allowed `verified` only from In
  Progress and Testing. The docs expect a re-run to claim a failed card first,
  but a ticket that is only merged by a later run (its worker was `done`) is
  not claimed.
- **Fix:** `verified` is allowed from Failed. Test in `flow.test.mjs`;
  `board.md` updated. Commit `a162378`. The operator re-sent BUG-14's review
  event.
- **Impact:** one card showed Failed while its PR was open.

## D21: earlier-merged tickets missed their group PR's card move

- **Symptom:** after restarts, BUG-8, BUG-11, BUG-18 and BUG-20 stayed in
  Testing although their group PRs (#97, #100, #102) were open.
- **Root cause:** when the unit's PR opened, only the tickets that finished in
  the current run were reported to the board; tickets merged into the group by
  an earlier run are `skipped` ("merged ... in a previous run") in that run.
- **Fix:** report every ticket merged into the unit (epic state `merged`).
  Test in `epic.test.mjs`. Commit `c674f78`. Run 9 moved the four cards.
- **Impact:** four cards showed the wrong lane for up to an hour.

## Observation O8: plan files with MD012 reached a PR

BUG-13's plan files (committed by the QE harness at 08:38) have two blank lines
in a row, so #100's Markdownlint job fails. Harness commits run with
`PIPELINE_DISABLE=1`, and the QE precheck lints only the files the agent wrote
in that round. Follow-up: lint the whole plan folder before the QE commit.

## Observation O9: no tests run on the merged group

Every ticket's tests are verified on its own branch. After the tickets are
merged into a group (with conflict resolution), only the PR check (a review)
runs, so cross-ticket breakage reaches CI: on #102, BUG-14's test counts the
rows of a doc table that BUG-7 and BUG-8 also edited. Follow-up: run the
harness checks and the touched services' unit tests in the unit worktree
before the PR (and the group's QE specs when the stack is available).

## D22: tickets skipped for a blocker got a misleading failure comment

- **Symptom:** the first questions-style failure comments (run 10, after
  merging #101) on BUG-2, 3, 9, 10 and 15 read "The pipeline stopped: **no
  result**. This looks like a mechanical failure (crash, timeout or agent
  outage)", although they were skipped because BUG-1 is escalated.
- **Root cause:** in epic delivery a ticket skipped for a failed blocker never
  runs, so it has no `.agent-state/implement/<KEY>.json`. `board fail` read an
  empty result (no outcome, so "mechanical"), and its event id fell back to
  the current time, so every run would post another comment.
- **Fix:** `recordUnrun()` records the outcome of a ticket the batch never ran
  (keeping its first finish time, and never touching a record of a story that
  ran); the comment names the blocker and says to resolve it first. Tests in
  `batch.test.mjs` and `escalation.test.mjs`; `escalations.md`. Commit
  `e28c656`.
- **Impact:** five confusing comments on the board, one per run.

## D23: a group PR was gated on part of its tickets

- **Symptom (found reading the merged code before any gated run):** after a
  group PR opened, the runner called the review gate with
  `results.filter(done)`, the tickets that finished in that run only.
- **Root cause:** a group can finish across restarts (here `basket-cart`:
  BUG-7/8 in one run, BUG-14 in a later one; `catalog-item-validation`: six
  tickets over three runs). Tickets merged by an earlier run are `skipped`
  ("merged ... in a previous run") in the run that opens the PR, the same
  pattern as D21. With `implement.autoMerge.enabled` on, a Low rating on the
  last ticket could auto-merge fixes the `bug-triage` agent never rated. A
  re-delivered group with an existing PR was also handed to the gate again,
  and skipped only because its key list happened to be empty.
- **Fix:** `openPr` reports an existing PR; the runner gates only a PR it
  opened, with every ticket merged into the group. Tests in `epic.test.mjs`
  (a group finishing across two runs is gated with all three tickets; a
  re-delivered PR is not gated again). `review-gate.md` updated. Commit
  `0917392`.
- **Impact:** none in this run (no group PR opened since the gate merged);
  it would have under-rated the next group PR to finish across restarts.

## D24: a resolved re-run never re-ran the escalated QE stage

- **Symptom:** after Armando answered BUG-1's question (Q1 → C: drop the
  nested-run test) and ticked Resolved, `implement requeue` re-ran BUG-1, but
  it ended `qe-escalated` again within five minutes and no QE automation log
  was written. The round-2 failure comment said "No decision is needed".
- **Root cause:** the resolved re-run (from #101) clears the escalation notes
  but not the QE stage state. Automation stayed `escalated` with `workingHash`
  equal to the review's approved hash: a decision about the tests leads to no
  code change, so the QE stop hook (`automationUpToDate`) treated the
  escalated run as current, and the implement worker read its status back.
  Same family as D18 (blocked-on-plan).
- **Fix:** `resetEscalatedQe()` resets escalated automation and plan stages in
  the ticket worktree when a resolved ticket re-runs. Test in
  `batch.test.mjs`. Commit `b7f2e35`. The operator applied it to BUG-1 by hand
  and re-ran it.
- **Impact:** one wasted resolved re-run (two opus agents) and a misleading
  failure comment on #31.

## Observation O10: a requeue runs only the resolved ticket

`implement requeue` runs the resolved ticket alone; it joins its in-progress
epic run, and its dependents (BUG-2/3 in its group, and the
`ordering-error-handling` group stacked on it) run only when the epic run
continues (`implement run --epic` or `implement resume`). That is how
`epicToJoin` is documented; an operator (or the requeue) has to continue the
epic afterwards.

## Observation O11: re-delivery of groups whose PRs people took over

Every run re-delivers each done group: it syncs tickets, re-verifies stale
tests, pushes the group branch and refreshes the recorded PR's body. After
Armando merged main into the seven group branches and resubmitted the PRs as
the GitHub App (#118–#124), this run's state still names the closed PRs and
its local branches are behind. The push is rejected (non-fast-forward), so the
new PRs are never touched, but the re-delivery is wasted work and logs "no
PR: push failed". Follow-up: a group whose recorded PR is closed or merged, or
whose remote branch moved past the local one, should be reported and skipped,
not re-delivered.
