# Implement stage

Point the pipeline at a folder of stories and it implements them: one worktree and feature branch per story, the [implementer agent](../../.github/agents/implementer.agent.md) running headless, the [architecture review](review.md) loop, and [verified tests](qe.md). It is the interactive flow (`pipeline start`, implement, `pipeline done`, review, tests) with the runner standing in for the person at the keyboard.

```bash
node scripts/pipeline/pipeline.mjs implement run product-research/stories --dry-run
node scripts/pipeline/pipeline.mjs implement run path/to/stories               # one story at a time
node scripts/pipeline/pipeline.mjs implement run path/to/stories --parallel 3 --pr
node scripts/pipeline/pipeline.mjs implement run product-research/stories/PROMO-3-cart-pricing-evaluation-api.md
node scripts/pipeline/pipeline.mjs implement status                            # live progress, from another terminal
node scripts/pipeline/pipeline.mjs implement metrics
```

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print the order, branches and bases, then stop. No agents run. |
| `--parallel N` | Run up to N stories at once (default 1). Each has its own worktree; dependents still wait for their blockers. |
| `--base <ref>` | Base for stories with no in-batch blocker (default `baseRef`, `origin/main`; fetched first). |
| `--pr` | Push each finished branch and open a PR with `gh`, against its base branch (stacked PRs for dependents). |
| `--force` | Also implement stories that already have `## Implementation Notes`. |

## What happens

1. **Plan.** Every `<KEY>-<title>.md` in the folders and files given is a story. A story that already has `## Implementation Notes` is skipped. Each story's `**Blocked by:**` line is parsed. Stories blocked by others in the batch run after them, and a dependency cycle is an error. Blockers outside the batch are left to the implementer, which checks that their code exists.
2. **Worktree.** Each story gets `../<repo>-worktrees/<key>` on `feat/<key>-<title>`. A story with no in-batch blocker branches from the base. A dependent stacks on the branch of the blocker that already contains the most of its other blockers and merges in the rest; a merge conflict marks the story `blocked`. Rerunning reuses existing worktrees and branches. The story file is committed to the branch (`<KEY>: Add story`) if it is not already there.
3. **Implement and review.** The runner calls `pipeline start`, then runs the implementer with the story. The implementer may commit, but cannot push, reset, switch branches or touch worktrees. The runner commits anything left over, runs `pipeline done`, and fires the stop hook as an agent tool would. If the review requests changes, its findings become the next implementer task. Review rounds, escalation and the `maxRounds` limit are the review stage's own.
4. **Tests.** On approval the QE stage writes and verifies the test plan and automated tests in the background, and the runner waits for its verdict. If the tests find implementation bugs, the bugs go back to the implementer and the loop repeats, up to `maxBugFixCycles` times.
5. **Finish.** The runner appends a record to `.agent-metrics/implement-runs.jsonl` and commits it with the QE output (`<KEY>: Add verified test plan and automated tests`). With `--pr`, it pushes and opens the PR.

The review and QE stages run against the worktree (`PIPELINE_ROOT`) using the pipeline from the checkout you ran the command in, so a base branch that predates the pipeline still works. A dependent's review diff is against its blocker's branch, so it sees only its own changes.

## Outcomes

`implement run` prints a table at the end and exits 0 only when every story is `done` (or skipped as already implemented).

| Outcome | Meaning | Dependents |
| --- | --- | --- |
| `done` | Implemented, approved by the review, tests verified, all committed | run |
| `blocked` | The implementer reported the story unimplementable (for example an Open Question that changes the design), or blockers' branches conflict | skipped |
| `no-changes` | The implementer finished without changing implementation files | skipped |
| `review-escalated` | The review did not approve within its round limit; see `.agent-state/escalations/` | skipped |
| `unresolved` | Still not approved after `maxImplementerRuns` implementer runs | skipped |
| `qe-<status>` | Tests did not verify: `product-bug` (after the bug-fix cycles), `escalated`, `blocked-on-plan`, `crashed`, `timed-out` | skipped |
| `skipped` | Already implemented, or a blocker did not finish | skipped |
| `error` | The runner itself failed; see the story's log | skipped |

Each story's log is under `.agent-state/logs/implement-<KEY>-*.log` in the main checkout. `implement status` shows where each story is. Per-story pipeline state (review rounds, QE status, escalations) is in the worktree's own `.agent-state/`; run `pipeline status <KEY>` from inside the worktree to see it.

## Config

`scripts/implement/config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `implement.worktreeDir` | `../{repo}-worktrees` | Where worktrees go, relative to the repo root |
| `implement.branchPrefix` | `feat/` | Branch name prefix |
| `implement.parallel` | 1 | Default `--parallel` |
| `implement.implementerTimeoutSec` | 5400 | Per implementer run |
| `implement.maxImplementerRuns` | 8 | Implementer runs per story (first run, review fixes and bug fixes) |
| `implement.maxBugFixCycles` | 2 | Times QE-found bugs go back to the implementer |
| `implement.qeTimeoutSec` | 14400 | How long to wait for QE |
| `agent.models.implementer` | `null` (CLI default) | Model for the implementer |

The agent CLI is the pipeline's (`PIPELINE_AGENT_CLI`, Claude Code by default). Parallel stories each run their own implementer, reviewer and QE agents, so `--parallel` multiplies LLM usage. Implementers must not use the shared teststack (the implementer agent already avoids it). QE's precheck may still run tests, so keep `--parallel` low if your tests share infrastructure.

## Not automatic

Adding or merging stories to `product-research/stories` starts nothing: no implementation and no test plans (unless you opted in with `git config qe.autoPlan true`). Run `implement run` yourself, or from a scheduled job or CI runner that has an agent CLI logged in.
