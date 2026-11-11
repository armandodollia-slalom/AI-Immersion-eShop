# Deck data (living)

Running numbers and slide material for the presentation about the first real
end-to-end run of the agent factory on bug epic #64. Updated at every
checkpoint; `summary.md` gets the final version. Times are local (CST).

## Headline numbers (as of 09:59)

| Metric | Value |
| --- | --- |
| Tickets in the epic | 21 bugs (BUG-1 to BUG-21) |
| Wall clock so far | about 5 h 30 min (04:17 start), including about 1 h 35 min of host sleep |
| PR groups chosen by the supervisor | 9 (timeline 04:19) |
| Group PRs open | 3: [#70](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/70) catalog-write-auth, [#71](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/71) token-audience, [#72](https://github.com/armandodollia-slalom/AI-Immersion-eShop/pull/72) login-open-redirect |
| Tickets verified (implemented + tests verified) | 9: BUG-4, 5, 6, 7, 11, 13, 17, 18, 19 |
| Tickets escalated to a human | 1: BUG-1 (QE meta-test), blocking BUG-2/3 |
| Agent runs | 200 |
| Token cost (list price) | $43.03 (opus $15.93 implement; PR checks $12.70) |
| Copilot premium requests | 930 at 08:27, then the monthly quota ran out (~08:55) |
| Pipeline defects found and fixed | 13 (D1-D13) |
| Cache hit rate | 88% |

## Lane counts over time

| Time | Ready | In Progress | Testing | Pending Review | Failed |
| --- | --- | --- | --- | --- | --- |
| 06:21 | - | see board-snapshots.md | | 3 | |
| 08:27 | 0 | 14 | 5 | 3 | 0 |
| 09:10 | 0 | 0 | 0 | 7 | 14 (D12, quota outage) |
| 09:47 | 0 | 12 | 3 | 7 | 0 |

## Cost by stage (09:47)

| Stage | Runs | Cost |
| --- | --- | --- |
| implement (opus orchestrator/implementer) | 48 | $15.93 |
| pr-check (critic panel) | 50 | $12.70 |
| QE plan + verify | 49 | $6.05 |
| QE automation + verify | 31 | $5.11 |
| review | 15 | $1.54 |
| verifier pairs | 6 | $0.93 |

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
7. Cost: where the money goes (implementation vs PR checks vs QE).
8. Lessons: keep the host awake, treat provider limits as interruptions,
   per-worktree cost visibility.

## Charts to build

- Lane counts over time (stacked area) from the table above.
- Cost by stage (bar) and by ticket (bar).
- Defects timeline: when each was found vs fixed (dots on the run timeline).
- Ticket swimlane: Ready, In Progress, Testing, Pending Review per ticket.
