# Delivery experiments

Does delivering an epic on one branch (an epic plan, stories merged into the epic branch, one PR) cost less and produce better code than a branch and PR per story? `pipeline experiment` runs the same epic both ways from the same base commit, grades every result with the same tests and the same PR check, and reports the numbers side by side. See [implement](implement.md#delivery-modes) for the two modes.

```bash
node scripts/pipeline/pipeline.mjs experiment run --epic promotions-and-recommendations --modes epic,story [--repeat 2] [--sequential]
node scripts/pipeline/pipeline.mjs experiment grade <id>            # grade (again) after fixing the test stack, for example
node scripts/pipeline/pipeline.mjs experiment report <id> [--json]
```

| Option | Meaning |
| --- | --- |
| `--epic <EPIC>` | The epic to implement (its stories come from the board once, at the start) |
| `--modes epic,story` | The delivery modes to compare (default both) |
| `--repeat N` | Run every mode N times (arms `epic-1`, `story-1`, `epic-2`, ...) to see how much one mode varies |
| `--sequential` | Run the arms one after another instead of at the same time (wall clock without contention, at the cost of time) |
| `--base <ref>` | The base commit every arm starts from (default `baseRef`) |
| `--parallel N\|auto` | Passed to every arm's `implement run` (default `auto`) |
| `--no-grade` | Skip the grading step (run `experiment grade <id>` later) |

## How an arm runs

Each arm is `implement run --epic <EPIC> --delivery <mode>` in its own worktree (`../<repo>-experiments/<id>-<mode>-<n>`) on its own branch `exp/<id>-<mode>-<n>`, created at the same base commit, with the epic's tickets copied into its ticket cache. Its story, epic and bug-group branches are prefixed `exp/<id>/<mode>-<n>/` (`IMPLEMENT_BRANCH_PREFIX`, `IMPLEMENT_EPIC_BRANCH_PREFIX`, `IMPLEMENT_BUGFIX_BRANCH_PREFIX`), so arms never share a branch. The arm's environment:

| Variable | Effect |
| --- | --- |
| `PIPELINE_EXPERIMENT_ID`, `PIPELINE_EXPERIMENT_ARM`, `PIPELINE_DELIVERY` | Every usage, decision, outcome, subtask-run and implement-run record gets `experiment_id`, `experiment_arm` and `delivery` ([costs](costs.md#where-the-data-lives)) |
| `PIPELINE_BOARD=off` | No board reads or writes: `implement run` neither syncs nor claims cards, and the runner's board events spawn nothing (`scripts/implement/lib/board-events.mjs`) |
| `PIPELINE_LESSONS=off` | No lessons or factory-retro writes: `qe lessons` returns `disabled`, its recovery and the post-merge auto run are skipped, so one arm cannot teach the agents of another mid-experiment |
| `PIPELINE_NO_PR=1` | No pushes and no PRs, whatever the flags (so the review gate has nothing to assess or merge) |
| `PIPELINE_TICKETS_OFFLINE=1` | The arm reads its copied tickets; nothing is fetched |

When the arm finishes, its result is merged into the arm branch so every arm has one tree to grade: the epic (or bug-group) branches of an epic arm, or every story branch that finished `done` of a story arm, in key order. A story branch that does not merge (stories built apart that conflict) is left out and counted (`integrationConflicts`). The experiment's state, logs and grades are in `.agent-state/experiments/<id>/`.

## Grading

1. **Shared tests.** Every spec that carries an epic-level case id (`TC-EPIC-<n>-NN`, written by an epic arm's [epic-level QE](implement.md#epic-delivery)) is pooled, and each pooled spec runs against every arm's result: an arm's own specs as they are, other arms' specs copied in as `<name>.from-<arm>.spec.ts` (removed afterwards). The command is `experiment.testCmd` (default `npx playwright test -c playwright.teststack.config.ts {file}`); a spec passes on exit 0. Story arms write no epic-level specs, so they are graded on the epic arms' journeys.
2. **PR check.** One report-only run of the PR check (no fixer) over every ticket of the epic against the arm's whole diff from the base (`pr-check run --stories K1,K2 --no-fix`); the open (upheld) findings are counted.

## Report

`experiment report <id>` shows one row per arm, from the arm's records (on any of its branches, or still in its worktree):

| Column | Meaning |
| --- | --- |
| Cost $, Tokens, Prem. req | Sums over the arm's usage records ([costs](costs.md)) |
| Wall min | The arm's wall clock |
| Overhead | Overhead tokens over all tokens. Overhead: planning (the orchestrator's plan step, the epic plan, QE plans), the architecture review, QE automation and its verifiers, and the PR check. Implementation: the orchestrator implementing and the pair implementers. Pair verifiers are a third bucket (in `--json` as `tokensByBucket.verify`) |
| Agent runs | Distinct agent runs |
| Pair rnds, Escal., Bug fixes | Sums of `pair_rounds`, `escalations` and `bug_fix_cycles` over the arm's `implement-runs.jsonl` |
| Rework | Files created by an earlier ticket and modified by a later one, over files created, from the arm's history (`git log --no-merges`, commits attributed by their `<KEY>:` prefix; `.agent-metrics/` is not counted) |
| Shared tests | Pooled specs passed / run against the arm |
| Upheld | Open findings of the grading PR check |
| Done | Stories done / stories run |

Under the table: each arm's [decision labels](implement.md#decision-log) (`over-provisioned`, `under-provisioned`, `bad-split`, `should-have-been-self`, `weak-verification`, `bad-grouping`) and its integration conflicts. `--json` gives every number, the bucketed tokens and the caveats.

## Caveats

- **n is small.** One epic and a few repeats per mode. Treat a difference as a hint, not a result; repeat with `--repeat` and with other epics before changing the default.
- **Agents are nondeterministic.** Two runs of the same arm differ. Compare the spread between repeats of one mode with the gap between modes.
- **Shared machine.** Parallel arms share agent slots, stack slots and the build lock, so wall clock depends on what ran alongside; `--sequential` isolates it.
- **Asymmetric tests.** Only epic arms write epic-level e2e journeys; story arms are graded on them but contribute none. The PR check grades every arm the same way.
- **Overhead is a token share.** It says where tokens went, not whether they were wasted: a review round that catches a bug is overhead too.
- **Board and lessons are off.** Nothing an experiment does reaches the board or the lessons files; its records stay in the arms' branches until you merge or delete them (`git branch -D exp/<id>-*`, `git worktree remove`).
