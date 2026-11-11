# Agent catalog

Part of the [AI development pipeline](README.md). Every agent is defined once in `.github/agents/<name>.agent.md` and rendered to `.claude/agents/` by `npm run agents:sync` (see [Agent definitions](README.md#agent-definitions-for-copilot-and-claude-code)). Each pipeline call starts a fresh headless process, so no agent sees another's reasoning, and every agent ends with an `AGENT_RESULT: {json}` line the stage parses.

## By stage

| Agent | Stage | Started by | Access | Sees | Returns |
| --- | --- | --- | --- | --- | --- |
| `implementer` | [implement](implement.md) | `implement run`, or you | writes code, commits; no push, reset or branch switch | the story, the codebase, `docs/`, review or bug findings | `done`, `blocked` or `needs-input` |
| `pair-implementer` | [implement](implement.md#what-happens) | implement harness, one per delegated subtask (never by hand) | writes and commits only the files the subtask owns, in its own worktree | the subtask spec, the codebase, the previous round's findings | the subtask's commits |
| `pair-verifier` | [implement](implement.md#what-happens) | implement harness, every pair round | read-only | the subtask spec, its diff, build, unit test and diagnostics output | `APPROVED` or `CHANGES_REQUESTED` with findings |
| `pair-ui-verifier` | [implement](implement.md#ui-verification) | implement harness, every round of a `verify: "ui"` subtask | runs shell commands and Playwright against a leased stack slot; no source edits | the subtask spec, its diff, the running app, mockups and their renders | `APPROVED` or `CHANGES_REQUESTED` with findings citing screenshots |
| `arch-review` | [review](review.md) | review stage (as `architecture-policy/agents/arch_review.py review`), before each LLM review; any agent on request | read-only | changed files, Architecture Policy Pack rules | `PASS`, `WARN` or `BLOCK` with rule findings |
| `architecture-reviewer` | [review](review.md) | review stage | read-only | the story, the implementation diff, `AGENTS.md`, `CONTRIBUTING.md` | `APPROVED` or `CHANGES_REQUESTED` with findings |
| `qe-plan` | [qe](qe.md) | `qe plan`, or QE after review approval | writes `tests/plans/` | the story (and its diff when it changed) | test plan files |
| `qe-plan-verifier` | [qe](qe.md) | plan loop | read-only | the story and the plan | score 0-10 and gaps |
| `qe-automation` | [qe](qe.md) | QE after review approval, or `qe automate` | writes tests and `testing/scenarios/` | the verified plan, the implementation | tests, or `product-bug` |
| `qe-automation-verifier` | [qe](qe.md) | automation loop | read-only | case files, tests, scenario, keyframes | score 0-10 and gaps (with `root_stage`) |
| `qe-lessons` | [qe](qe.md#auto-improvement) | `qe lessons` (weekly) | writes `.github/agents/lessons/`, plus agent definitions and docs in `lessons.retro.allowedPaths` (other edits are discarded) | aggregated metrics, the decision-log retro digest and existing lessons | updated lessons files and proposed factory changes (opened as a PR) |
| `pr-check` | [pr-check](pr-check.md) | you (Copilot or Claude Code) | runs `npm run pr-check` | the PR or branch | summary of the report |
| `pr-check-acceptance` | [pr-check](pr-check.md) | PR check round | read-only | story, diff | lens score and findings |
| `pr-check-flow` | [pr-check](pr-check.md) | PR check round | read-only | story, diff | lens score and findings |
| `pr-check-design` | [pr-check](pr-check.md) | PR check round, frontend stories only | read-only | story (or every ticket of an epic check), diff, mockups and their renders, frames | lens score and findings |
| `pr-check-style` | [pr-check](pr-check.md) | PR check round | read-only | diff, repo conventions | lens score and findings |
| `pr-check-video` | [pr-check](pr-check.md) | PR check round, when a video exists | read-only | video frames, story | lens score and findings |
| `pr-check-defender` | [pr-check](pr-check.md) | PR check round | read-only | the round's findings, story, diff | concede, rebut or partial per finding |
| `pr-check-judge` | [pr-check](pr-check.md) | PR check round | read-only | the full debate | upheld or dismissed per finding |
| `pr-check-fixer` | [pr-check](pr-check.md) | PR check fix mode | writes code | upheld findings | fixes (the script commits) |

Read-only agents are enforced per CLI: Claude Code tool lists in `scripts/agents-claude.json`, Copilot `--deny-tool` flags and Codex's `read-only` sandbox in `scripts/pipeline/lib/agents.mjs`.

## Models

Unset models use the agent CLI's default.

| Setting | Agents |
| --- | --- |
| `agent.models.default` in `scripts/pipeline/config.json` | every agent without a more specific setting |
| `agent.models.implementer` in `scripts/implement/config.json` | `implementer` |
| `agent.models.reviewer` in `scripts/review/config.json` | `architecture-reviewer` |
| `agent.models.verifier`, `agent.models.audit` in `scripts/qe/config.json` | QE verifiers; the stricter calibration auditor |
| `prCheck.models.<cli>.<role>` in `scripts/pr-check/config.json`, or `PR_CHECK_MODEL_<ROLE>` | PR check critics, defender, judge and fixer (see [pr-check.md](pr-check.md#models)) |

`<ROLE>` is `JUDGE`, `ACCEPTANCE`, `FLOW`, `DESIGN`, `STYLE`, `VIDEO`, `DEFENDER` or `FIXER`. To override the judge for the current terminal session:

| macOS (zsh, bash) | Windows (PowerShell) |
| --- | --- |
| `export PR_CHECK_MODEL_JUDGE=claude-opus-5.5` | `$env:PR_CHECK_MODEL_JUDGE = 'claude-opus-5.5'` |

## Lessons

Each agent appends `.github/agents/lessons/<name>.md` to its prompt when that file exists; the file's hash is part of the agent's prompt version in the metrics. Files appear once a mistake recurs in 3 or more stories. See [Auto-improvement](qe.md#auto-improvement).

| Lessons file | Learns from |
| --- | --- |
| `implementer.md` | blocking architecture review findings; product bugs the integration tests found; PR check findings upheld in round 1 |
| `qe-plan.md`, `qe-automation.md` | verifier denials attributed to that agent |
| `qe-plan-verifier.md`, `qe-automation-verifier.md` | gaps the calibration audit found that the verifier missed |
| `pr-check-<lens>.md` | that critic's findings the judge dismissed |
| `pr-check-fixer.md` | findings upheld again after a fix round |

## Changing an agent

1. Edit `.github/agents/<name>.agent.md` (never the `.claude/agents/` copy).
2. Run `npm run agents:sync`; CI's `npm run agents:check` fails if the copies differ.
3. Run `npm run test:pipeline`. A prompt change starts a new prompt version, so `pipeline metrics` shows whether it helped.
