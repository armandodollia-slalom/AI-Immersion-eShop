# Summary: bug epic #64 run (2026-11-11)

The first real end-to-end run of the eShop agent factory: the 21-ticket bug
epic [#64 Epic: Test Stack Bug Findings](https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/64),
run unattended with `implement run --epic epic-teststack-bug-findings --pr --parallel auto`.
Details: [timeline](timeline.md), [board snapshots](board-snapshots.md),
[defects](defects.md), [deck data](deck-data.md).

## Outcome

**15 of 21 bugs verified** (implemented, architecture-reviewed, tests planned,
automated and verified) and delivered in **7 group PRs** for human review. The
other 6 wait for one human decision: BUG-1's QE escalation.

| Group (supervisor's choice) | Tickets | PR | Result | CI at the end |
| --- | --- | --- | --- | --- |
| `catalog-write-auth` (security, alone) | BUG-4 | [#70](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/70) | verified | fails `teststack` (compose drift) and `test` (scopes test), both from BUG-4 |
| `token-audience` (security, alone) | BUG-6 | [#71](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/71) | verified | inherits #70's failures (stacked on it) |
| `login-open-redirect` (security, alone) | BUG-5 | [#72](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/72) | verified | **green** |
| `catalog-paging` | BUG-11, BUG-12 | [#97](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/97) | verified | inherits #70's failures; `record` hit an apt mirror error |
| `catalog-item-validation` | BUG-13, 17, 18, 19, 20, 21 | [#100](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/100) | verified | inherits #70's failures; Markdownlint MD012 in BUG-13's plan (O8) |
| `basket-cart` | BUG-7, BUG-8, BUG-14 | [#102](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/102) | verified | `teststack` green; `test` fails: BUG-14's table-row count vs BUG-7/8's edits (O9) |
| `webhooks-event-validation` | BUG-16 | [#103](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/103) | verified | running at the end of the run |
| `ordering-ownership` | BUG-1, BUG-2, BUG-3 | none | BUG-1 `qe-escalated`, BUG-2/3 blocked | - |
| `ordering-error-handling` (stacked on `ordering-ownership`) | BUG-9, BUG-10, BUG-15 | none | blocked by its group dependency | - |

**BUG-1's escalation is legitimate:** its 8 direct tests pass, but its
meta-test TC-BUG-1-07 runs a nested Playwright run that picks up the whole
suite. The QE automation verifier refused to pass it in 5 rounds, which is the
gate working. A human needs to rework that test case (then `qe automate
BUG-1` in its worktree clears the escalation and the next run continues the
ordering groups, D13b).

**For the reviewer of the group PRs:** regenerate `deploy/teststack` with
`testing/teststack publish` and update `ApiResourcesAndScopesStayAligned` on
`catalog-write-auth` (#70), then merge it up the stacked groups (PRs
\#71, #97 and #100); fix the MD012 blank lines in BUG-13's plan files (#100); make
`TC_BUG_14_06` not depend on the other tickets' rows (#102).

## Totals

| Metric | Value |
| --- | --- |
| Wall clock | 7 h 32 min (04:17–11:49), including about 1 h 35 min of host sleep and a 20-minute quota outage |
| Batch runs (starts and restarts) | 11 |
| Agent runs | 309 |
| Pair rounds (implementer + fresh verifier) | 20 recorded; 1 story in delegate mode, the rest self mode |
| Design/scope disputes | 0 nits, 0 out-of-scope |
| Token cost (list price) | **$75.63**: Copilot $38.08 (179 runs), Claude Code $37.56 (199 runs) |
| By model | Opus 5.5 $46.79 (123 runs), Sonnet 5.5 $28.81 (221 runs), Haiku 5.5 $0.03 (34 CLI background calls, O7); Sol 6.1: 0 runs (allowed, not the default) |
| By stage | PR checks $26.37 (87 runs), implementation $25.02 (71), QE automation + verify $11.82 (60), QE plan + verify $8.15 (61), review $2.58 (23), pairs $0.93, epic plan $0.77 |
| Copilot premium requests | 1,037 (Opus 930, Sonnet 107), then the monthly quota ran out |
| Cache hit rate | 87% |
| Pipeline flow defects found and fixed | **21** (D1–D21, plus D13b), all with tests |
| Observations recorded | 9 (O1–O9) |

## What worked

- **Grouping by the supervisor.** The epic plan was accepted first try (121 s):
  9 groups with reasons (security fixes ship alone; shared service and root
  cause together) and cross-group `dependsOn`.
- **Independent verifiers held the line.** BUG-1 was escalated instead of
  shipping a broken meta-test; the pre-push QE gate blocked a group whose
  verification had gone stale (D17), and was never bypassed.
- **Recovery.** Restarts resumed tickets in their worktrees, kept done work
  and re-delivered groups with their existing PRs. After the Copilot quota ran
  out, switching the agent CLI to Claude Code took 20 minutes with no
  model-policy change, and the tickets "failed" during the outage verified
  within 25 minutes.
- **Fixes shipped mid-run.** Each defect was fixed on the operator branch with
  a test and took effect at the next restart (pipeline code loads from this
  checkout; tickets build on `origin/main`).
- **Cost visibility** once fixed (D11): per ticket, stage, model and CLI.

## What broke (by theme)

| Theme | Defects |
| --- | --- |
| Restart and resume | D3 stale findings, D6 resume without worktree, D13/D13b escalations re-run, D14 resume hash against the wrong base |
| Group (bug epic) delivery | D2 `dependsOn` ignored, D7/D7b stale tickets at push, D8 duplicate PR checks, D9 existing PR, D17 shared spec files, D19 dirty metrics blocked a merge |
| Gates that did not gate | D4/D5 QE commit failed lint, D15 no drift check, D16 unit tests never matched (no ticket ran Basket/Ordering/Application tests) |
| Provider and environment | D1 Copilot prompt file outside cwd, D10 QE on the user's slot-0 stack, D12 quota outage read as ticket failures, O6 host sleep, O7 hidden background model |
| Board | D18 blocked-on-plan never restarted (QE), D20 Failed → Pending Review, D21 earlier-merged tickets' cards |
| Monitoring | D11 live cost invisible |

## Lessons

1. **Treat provider limits as interruptions, not outcomes** (D12): one quota
   message turned into 14 "failed" cards in 15 minutes.
2. **Test every gate against the real repo layout** (D16): a naming mismatch
   meant no unit tests ran between rounds all day, and CI caught what the
   verifiers never saw.
3. **Shared files across tickets in one branch** need group-level handling:
   stale verification hashes (D17), merge conflicts, and cross-ticket test
   assumptions (O9). Run the tests on the merged group before the PR.
4. **Restarts are the normal case** for a long run (11 starts here): every
   resume path needs tests with stacked branches (D6, D14, D19, D21).
5. **Hash and compare against the same base** everywhere (D14).
6. **Escalations need a lifecycle** (D13b): keep them while they stand, clear
   them when a stage re-run passes.
7. **Unattended means awake** (O6): run under `caffeinate` and watch quotas.

## Suggested slide outline

1. **The agent factory, end to end:** board ticket → plan → verifier pairs →
   architecture review → QE plan and tests → PR check → group PR. One run, 21
   real bugs, unattended.
2. **The epic and the plan:** 21 bugs from the test stack findings; the
   supervisor's 9 PR groups and why (security alone, shared root cause);
   cross-group dependencies. *Visual: group map with dependsOn arrows.*
3. **The run at a glance:** 7 h 32 min, 11 batch starts, 309 agent runs,
   $75.63, 15/21 verified, 7 PRs. *Chart: stacked area of lanes over time
   (deck-data "Lane counts over time").*
4. **Where the money goes:** PR checks 35%, implementation 33%, QE 26%.
   Opus vs Sonnet. *Chart: cost by stage and by model; cost per ticket.*
5. **Verifiers doing their job:** BUG-1 escalated (8 tests pass, the
   meta-test does not); the pre-push gate blocked a stale group. Gates are
   never bypassed to get past a failure.
6. **The outage:** Copilot quota gone at 08:55 → 14 cards wrongly Failed in
   15 minutes (D12) → Claude Code in 20 minutes → BUG-11/18 verified within 25
   minutes. *Visual: timeline strip 08:27–09:56.*
7. **21 pipeline defects in one day:** by theme (table above). *Chart: defect
   found/fixed dots on the run timeline.*
8. **Gates with holes:** unit tests never matched (D16), no drift check (D15),
   so CI caught BUG-4's breakage on the group PRs. Lesson: test the gates.
9. **Groups are harder than tickets:** shared spec files (D17), dirty merges
   (D19), cross-ticket test assumptions (O9), board lanes after restarts
   (D20/D21).
10. **Restarts are the normal case:** what resume must handle; D6, D13, D14,
    D21; the confirmations in the live run.
11. **Running unattended:** host sleep (O6), quotas, hidden background
    models (O7), memory-driven parallelism (1–3).
12. **Results for review:** the 7 group PRs and their CI; what a human does
    next (BUG-1's test, BUG-4's compose and scopes test).
13. **Next steps:** tests on the merged group before the PR (O9), lint whole
    plan folders (O8), pin the CLI background model in the harness (O7),
    start `caffeinate` from `implement run`.
