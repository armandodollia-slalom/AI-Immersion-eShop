# First epic run of the AI pipeline: Promotions & Recommendations (in progress)

> **Status: epic in progress; PROMO-2 done.** Numbers are from 2026-11-11 (UTC). PROMO-2 was verified and merged into the epic branch at 19:18. PROMO-3 and PROMO-6 started at 19:24, and no other story has finished. This page will be updated as the epic finishes.

**The epic run took four attempts to get a story through the pipeline, and each failure was a path the pipeline had never run before, fixed generically. On the fourth attempt PROMO-2 finished: its automated tests found two real bugs that the code reviewers had not, the implementer fixed them in two short runs, and the retest passed 10/10 in one round.**

This follows the [PROMO-1 runs](demo-first-results.md), which took one story through the pipeline. Here the unit is the whole epic: `node scripts/pipeline/pipeline.mjs implement run --epic promotions-and-recommendations --pr`. Numbers come from the run's own logs and metrics.

## The flow

Epic delivery uses one branch, `epic/promotions-and-recommendations`. Each story gets its own branch and is merged into the epic branch once verified. QE then tests the journeys that cross stories, one PR check runs, and the run opens one epic PR.

```mermaid
flowchart LR
  E["Epic on the board"] --> O["Opus orchestrator<br/>design note (329 s)"]
  O --> F["FOUNDATION<br/>done once, before any story"]
  F --> S["Each story on its own branch<br/>implement, review, QE plan, QE tests"]
  S -->|verified| M["Merge into the epic branch"]
  S -->|QE finds a bug| B["Back to the implementer<br/>max 2 bug-fix cycles"]
  B --> S
  M --> Q["Epic-level QE<br/>cross-story journeys"]
  Q --> P["PR check"]
  P --> R["One epic PR"]
```

Plan order: PROMO-1 (already merged as #98, skipped), PROMO-2, PROMO-3, PROMO-5, PROMO-4, PROMO-6, PROMO-7, PROMO-8, PROMO-9.

## The epic plan

The orchestrator wrote the design note in 329 s. Its key decision was a **foundation** to do once before any story. PROMO-2, PROMO-4 and PROMO-7 all need an admin, so the foundation adds:

- an `admin` role in Identity.API, issued as a role claim, with alice seeded as admin
- a `PromotionsAdmin` policy in Promotions.API
- an `Admin` policy in the WebApp

## Four attempts

| Attempt | What happened | Cause | Fix |
| --- | --- | --- | --- |
| 1 | Foundation failed | Adding the admin role rows to the default test-stack scenario broke an existing test (`PasswordsTests`, `Steps.Single()`). The fix was one line, but that test file was not in the foundation's allowed files (`owns`), so the agent stopped. | Added the file to `owns` in the design note. The rerun reused the note and the committed work. |
| 2 | Foundation failed 3 verifier rounds | "Outside owns" findings on `.agent-metrics/token-usage.jsonl` and `decisions.jsonl`, which the harness itself commits. The agent flagged this as a follow-up itself. | PR #104: scope checks ignore `.agent-metrics/`, `.agent-state/` and `graphify-out/` |
| 3 | Foundation approved in round 1 (175 s implement, 23 s verify). PROMO-2 was implemented, then its new migration was blocked. The rest of the epic was skipped behind it. | The Architecture Policy Pack's DATA-001 ("applied EF migrations are immutable") fired. The review sent changed files as a plain list, which the policy engine reads as "every file modified". This was the first run with the Policy Pack actually on; it used to be skipped because Python's `yaml` module was missing. | PR #108: send each file with its status (A, M or D). On PROMO-2's real diff, the plain list gave BLOCK (DATA-001) and the status map gave a WARN only. |
| 4 | PROMO-2 done (below) | | |

## PROMO-2: done (attempt 4)

Verified and merged into `epic/promotions-and-recommendations` at 19:18 UTC. Commits: `a56cee7` (implementation), `5741d45` (verified test plan and automated tests) and `ead4a9c` (merge into the epic branch).

- **Implement.** PROMO-2's implementer was approved by its verifier in round 1.
- **Architecture review.** Approved.
- **QE plan.** Verified 9/10 in round 2 (round 1 was 8/10 with 5 gaps). 66 cases.
- **QE automation, first pass.** Found 2 **real implementation bugs**. TC-PROMO-2-22 and TC-PROMO-2-23 expect invalid targets (`{Brand, null}` and `{All, 5}`) to return 400 with errors keyed `targets`, but the validator keyed them `targets[0].targetId`.
- **Bug-fix cycle 1 of 2.** The story went back to the Opus implementer, and the board moved card #53 from Testing back to In Progress. The implementer fixed the key (errors are now keyed `targets`) in two short runs, 76 s and 40 s. The fix passed review again, and card #53 went back to Testing.
- **QE retest.** Automation verified 10/10 in round 1, 0 gaps.
- **Run record.** 50.35 minutes, `self` mode, 5 agent runs (2 of them implementer runs), 0 review blocks, 1 bug-fix cycle, 1 pair round, 0 escalations, 2,058,260 tokens, $1.91 recorded cost.

## What we learned

1. **The pipeline catches real bugs, and the tests are what caught them.** The validation-key bug passed the implementer's verifier and the architecture review. The QE tests, written from the story, found it, and the loop closed it: a fix of about two minutes, then 10/10 in one round.
2. **Each failure was a first-time path, and a restart costs only the failed step.** A restart keeps the design note and the committed foundation, so the four attempts did not repeat finished work.
3. **The epic planner has to include the tests of whatever the foundation changes.** The foundation changed a shared test-stack scenario, which broke `PasswordsTests`. That file belongs in `owns`.
4. **Turning on a check can expose an integration bug that unit tests did not cover.** The Policy Pack had been skipped for as long as Python's `yaml` module was missing. Once it ran, it blocked a legitimate new migration because of how the review passed it the changed files.
5. **The harness's own commits are not the agent's scope.** The agent was blocked for files the harness writes.

## What's next

- **Finish the stories in flight.** PROMO-3 (cart pricing evaluation API) and PROMO-6 (storefront promotion display) started in parallel at 19:24 UTC. PROMO-7 also depends only on PROMO-2 and should start when a slot frees up: the run allows 3 at once, and stories whose planned files overlap never run together.
- **Run the rest of the epic.** PROMO-5, PROMO-4, PROMO-8 and PROMO-9, then epic-level QE, the PR check and the epic PR.
- **Planner: foundation tests.** Have the epic planner add the tests of whatever the foundation changes to its `owns`.
- **Final numbers.** Times, rounds, tokens and cost per story, once the run finishes.
