# Deck data (living)

Running numbers and slide material for the presentation about the first real
end-to-end run of the agent factory on bug epic #64. Updated at every
checkpoint; `summary.md` gets the final version. Times are local (CST).

## Headline numbers (as of 11:30)

| Metric | Value |
| --- | --- |
| Tickets in the epic | 21 bugs (BUG-1 to BUG-21) |
| Wall clock so far | about 5 h 30 min (04:17 start), including about 1 h 35 min of host sleep |
| PR groups chosen by the supervisor | 9 (timeline 04:19) |
| Group PRs open | 6: [#102](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/102) basket-cart (3 bugs), [#100](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/100) catalog-item-validation (6 bugs), [#70](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/70) catalog-write-auth, [#71](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/71) token-audience, [#72](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/72) login-open-redirect, [#97](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/97) catalog-paging |
| Group PR CI | #72 green; #70/#71/#97 fail `teststack` (compose drift from BUG-4), #70/#71 also `test` (scopes test, BUG-4) |
| Tickets verified (implemented + tests verified) | 14: BUG-4, 5, 6, 7, 8, 11, 12, 13, 14, 17, 18, 19, 20, 21 |
| Tickets escalated to a human | 1: BUG-1 (QE meta-test), blocking BUG-2/3 |
| Agent runs | 235 |
| Token cost (list price) | $52.48 (implement $20.98; PR checks $12.70) |
| Copilot premium requests | 930 at 08:27, then the monthly quota ran out (~08:55) |
| Pipeline defects found and fixed | 20 (D1-D20) |
| Cache hit rate | 88% |

## Lane counts over time

| Time | Ready | In Progress | Testing | Pending Review | Failed |
| --- | --- | --- | --- | --- | --- |
| 06:21 | - | see board-snapshots.md | | 3 | |
| 08:27 | 0 | 14 | 5 | 3 | 0 |
| 09:10 | 0 | 0 | 0 | 7 | 14 (D12, quota outage) |
| 09:47 | 0 | 12 | 3 | 7 | 0 |
| 10:18 | 0 | 9 | 6 | 7 | 0 |

## Cost by stage

| Stage | 09:47 runs | 09:47 cost | 10:18 runs | 10:18 cost |
| --- | --- | --- | --- | --- |
| implement (opus orchestrator/implementer) | 48 | $15.93 | 60 | $20.98 |
| pr-check (critic panel) | 50 | $12.70 | 50 | $12.70 |
| QE plan | 31 | $4.29 | 35 | $5.22 |
| QE automation | 20 | $4.16 | 27 | $6.04 |

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
