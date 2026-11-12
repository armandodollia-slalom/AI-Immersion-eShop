# Deck data (living)

Running numbers and slide material for the presentation about the first real
end-to-end run of the agent factory on bug epic #64. Updated at every
checkpoint; `summary.md` gets the final version. Times are local (CST).

## Headline numbers (final, 11:49)

| Metric | Value |
| --- | --- |
| Tickets in the epic | 21 bugs (BUG-1 to BUG-21) |
| Wall clock | 7 h 32 min (04:17–11:49), including about 1 h 35 min of host sleep |
| Batch starts | 11 (restarts to apply fixes, after the outage, after sleep) |
| PR groups chosen by the supervisor | 9 (timeline 04:19) |
| Group PRs opened | 7: #70, #71, #72, #97, #100 (6 bugs), #102 (3 bugs), #103; resubmitted as the GitHub App at 15:50: #119, #120, #121, #122, #123, #124, #118 (all gated; #118 Low) |
| Group PR CI | #72 green; #70/#71/#97/#100 fail on BUG-4's compose drift and scopes test; #100 MD012; #102 a cross-ticket test assumption |
| Tickets verified | **18**: BUG-1 (15:21, after the human decision), BUG-2, BUG-3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21 |
| Escalated to a human | 1: BUG-1 (QE meta-test); 5 more wait behind it (BUG-2, 3, 9, 10, 15) |
| Agent runs | 309 |
| Token cost (list price) | **$75.63**: Copilot $38.08, Claude Code $37.56 |
| Cost by model | Opus 5.5 $46.79, Sonnet 5.5 $28.81, Haiku 5.5 $0.03 (CLI background), Sol 6.1 $0 |
| Copilot premium requests | 1,037 (Opus 930, Sonnet 107), then the monthly quota ran out |
| Pipeline defects found and fixed | **24** (D1–D24, plus D13b); D16 superseded by main's fix (#99) |
| Cache hit rate | 87% |

## Escalation questions (PR #101, merged at 12:00)

| Item | Value |
| --- | --- |
| Merged into the run | 12:02 (`05b272f`), 9 conflicted files, all checks green |
| First new-style failure comment | [BUG-2 #42](https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/42#issuecomment-6803834756), 12:20 (blocked ticket, D22) |
| First comment with questions | [BUG-1 #31](https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/31#issuecomment-6804680354), 13:00: one question, 3 options + Other, A recommended (remove the fixme, drop the nested-run test) |
| Hand-labeled re-run | BUG-1 labeled `escalation-resolved` without answers: a 30-minute opus re-run to the same escalation |
| `implement requeue` | 13:02: nothing to requeue; 14:59: BUG-1 re-queued after Armando's answer |
| Human decision | 14:58: Q1 → **C** (not the recommended A): drop the nested-run test, manual PR check for the fixme removal |
| Resolve → re-run | the first resolved re-run hit D24 (QE state not reset); fixed and re-run at 15:09 |
| Environment | GitHub Actions outage 14:22–14:58; #115 cut the resolve Action's runs (124 of the last 200 Actions runs) |
| Comments posted in run 10 | 5 (BUG-2, 3, 9, 10, 15), all for tickets blocked behind BUG-1 |
| Defect found in the new flow | D22: blocked tickets described as "no result" / mechanical, re-posted every run |
| Waiting for a human | BUG-1: answer Q1 on #31 and tick Resolved |

Slide idea: "From Failed to a decision": a failure comment with questions and
the Resolved box, the Action that checks the answers, and `implement requeue`.

## Review gate (#110, #112: merged at 14:26)

| Item | Value |
| --- | --- |
| Merged into the run | 14:35 (`2a0d3ac`), 2 conflicted files, all checks green (367 tests) |
| Defect found in the gate's integration | D23: a group PR finishing across restarts would be gated on part of its tickets (with auto-merge on) |
| Group PRs opened before the gate | #70, #71, #72, #97, #100, #102, #103: resubmitted as the GitHub App with main merged in (#119, #120, #121, #122, #123, #124, #118) and gated by Armando's session |
| Gated PRs opened by this run | [#125](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/125) `ordering-ownership` (BUG-1, 2, 3), 22:16, opened by the GitHub App: severity **Severe**, review with 1 approval, confidence 82/100 (CI unknown), CODEOWNERS reviewers requested |

Slide idea: "Who merges a bug fix?": triage ratings → severity and confidence
→ auto-merge for Low, approvals for the rest; why a group's gate must see
every ticket (D23).

## Lane counts over time

| Time | Ready | In Progress | Testing | Pending Review | Failed |
| --- | --- | --- | --- | --- | --- |
| 06:21 | - | see board-snapshots.md | | 3 | |
| 08:27 | 0 | 14 | 5 | 3 | 0 |
| 09:10 | 0 | 0 | 0 | 7 | 14 (D12, quota outage) |
| 09:47 | 0 | 12 | 3 | 7 | 0 |
| 10:18 | 0 | 9 | 6 | 7 | 0 |
| 11:49 | 0 | 0 | 0 | 15 | 6 |

## Cost by stage

| Stage | 09:47 runs | 09:47 cost | 10:18 runs | 10:18 cost |
| --- | --- | --- | --- | --- |
| implement (opus orchestrator/implementer) | 48 | $15.93 | 60 | $20.98 |
| pr-check (critic panel) | 50 | $12.70 | 50 | $12.70 |
| QE plan | 31 | $4.29 | 35 | $5.22 |
| QE automation | 20 | $4.16 | 27 | $6.04 |

Final by stage (11:49): PR checks $26.37 (87 runs), implementation $25.02
(71), QE automation + verify $11.82 (60), QE plan + verify $8.15 (61), review
$2.58 (23), verifier pairs $0.93 (6), epic plan $0.77 (1).

## Story beats for the deck

1. The factory: board ticket to PR with independent verifiers at every step.
2. The run: 21 bugs, the supervisor groups them into 9 PRs with reasons.
3. Parallelism is resource-driven (auto: memory per ticket): 1 to 3.
4. What broke in the pipeline, and how each fix shipped mid-run (D1-D12).
5. The outage: Copilot quota exhausted; the pipeline misread it as 14 ticket
   failures (D12); switched CLI to Claude Code in 20 minutes with no
   model-policy change. Proof point: BUG-11 and BUG-18, "failed" during the
   outage, verified within 25 minutes on Claude.
6. Verifiers doing their job: BUG-1 escalated rather than shipping a bad test.
   And where the gates had holes: CI on the group PRs caught what the harness
   never checked (compose drift D15, unit tests never matched D16).
7. Cost: where the money goes (implementation vs PR checks vs QE).
8. Lessons: keep the host awake, treat provider limits as interruptions,
   per-worktree cost visibility, don't re-run what waits for a human (D13),
   and watch the CLI's own hidden model calls (O7).

## Charts to build

- Lane counts over time (stacked area) from the table above.
- Cost by stage (bar) and by ticket (bar).
- Defects timeline: when each was found vs fixed (dots on the run timeline).
- Ticket swimlane: Ready, In Progress, Testing, Pending Review per ticket.
