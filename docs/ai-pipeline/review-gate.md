# Review gate for bug-fix PRs

Part of the [AI development pipeline](README.md). The gate starts only **after the pipeline publishes a fix PR**: a single-ticket bug PR (`implement run BUG-7 --pr`) or a bug-epic group PR ([PR groups](implement.md#bug-epics-pr-groups)). Implementation, verifier pairs, architecture review, QE, the PR check and the grouping of bugs run exactly as before; feature stories and feature epics are never gated.

The code is in `scripts/review-gate/`; its settings are `implement.reviewGate` and `implement.autoMerge` in `scripts/implement/config.json`, and the board field names are `board.fields` in `scripts/board/config.json`.

```mermaid
flowchart LR
  P[implement run opens a fix PR] --> A[bug-triage agent<br/>Impact, Complexity, Fix risk per ticket]
  A --> H[harness: systems touched, Severity,<br/>Confidence from pipeline records]
  H --> R[(issue ## Triage, board fields,<br/>bug-triage decision)]
  H --> G{gate}
  G -->|PR Low, every ticket high confidence,<br/>no reopens, checks green| M[auto-merge<br/>gh pr merge --auto --squash]
  G -->|checks still running| W[wait; board sync checks again]
  G -->|anything else| V[approvals:N + needs-human,<br/>reviewers, notice; card stays in Pending Review]
  V --> Q[review-quorum check<br/>counts distinct approvals on the latest push]
```

## Assessment

Right after the runner opens the PR, it runs `node scripts/review-gate/review-gate.mjs publish --pr <url> --tickets K1,K2 --base <ref>` from the PR's worktree (`scripts/implement/lib/post-publish.mjs`). Like the board events, it is a separate process: a failure is logged and never changes a ticket's outcome.

1. **Triage agent.** `bug-triage` (`.github/agents/bug-triage.agent.md`) is a fresh, read-only run, not the implementer. It gets every ticket's text, the systems the PR touches and the PR's actual diff, and rates each ticket on three separate fields, each **Low / Medium / High / Severe**, with a reason: **Impact** (what the bug does to users or data), **Complexity** (the size and entanglement of the fix) and **Fix risk** (the chance the fix breaks something else). It also names floor categories the fix touches (`auth`, `payments`, `migration`, `security`), its own confidence (0-100) and a one-line summary. An invalid result goes back once with the errors; a ticket that is still not rated counts as not assessed (and its PR can never auto-merge). Model: `agent.models.bugTriage` (`opus`: the ratings decide whether a PR merges without a person, and it runs once per PR).
2. **Systems touched.** Every changed file maps to its project or service (`reviewGate.systems`): Catalog.API, Basket.API, Ordering.API (with Ordering.Domain and Ordering.Infrastructure), Identity.API, Webhooks.API, Promotions.API, WebApp (with WebAppComponents), WebhookClient, OrderProcessor, PaymentProcessor, the mobile clients. Shared infrastructure counts as its own systems: **Integration events** (any `IntegrationEvents/Events/` folder, the contracts), **EventBus** (with EventBusRabbitMQ and IntegrationEventLogEF), **ServiceDefaults** (with `src/Shared`), **AppHost** and **Build** (the root build files). Tests, e2e specs, docs and metrics (`reviewGate.ignore`) touch no system; anything else is **Other**. In a group PR each ticket's files are the diff of its own `<KEY>: Merge into <group branch>` commit.
3. **Severity** (computed by the harness, never by the agent; `scripts/review-gate/lib/severity.mjs`):
   - base = max(Impact, Fix risk). Complexity is shown but feeds into Fix risk instead of counting directly;
   - a floor of **High** (`reviewGate.floor`) when the ticket's files hit an override path (`src/Identity.API/**`, `src/PaymentProcessor/**`, `**/Migrations/**`) or the agent named a floor category;
   - **+1 level per human reopen**, capped at Severe, stored apart so it can be recomputed and explained: "Impact Medium, Fix risk Low → Medium, +1 reopen → High".
4. **Confidence (0-100)** from the records the pipeline already keeps (`lib/confidence.mjs`). High confidence means all of: **no QE bug-fix cycles** (`bugFixCycles` = 0, QE's tests passed on the first try), every **verifier pair approved in ≤ 2 rounds** (`subtask-runs.jsonl`), the **PR check reached 10/10 in ≤ 2 rounds** (`pr-checks.jsonl`), **no edits outside `owns`**, and **CI green** (`gh pr checks`), plus a score of at least `confidence.highMin` (85). Each of the five criteria is worth 16 points; the agent's own estimate is worth the other 20 (`agentWeight` 0.2), so a doubtful agent can block high confidence but never create it. A criterion without a record (no PR check yet, a story run without verifier pairs) earns nothing and is not met; pending CI earns half.
5. **PR severity** = max ticket severity, **+1 level** when the PR touches **3 or more systems** (`manySystems`), and at least **High** (`sharedFloor`) when it changes shared infrastructure or an integration-event contract. The **PR class** is the PR severity, plus `+shared` for shared infrastructure or a contract; the approvals policy and the retro group PRs by it.

### Where it is recorded

| Where | What |
| --- | --- |
| Issue body, `## Triage` | Per ticket: each field with its reason, Severity with its explanation, Confidence with the signals that were not met, the systems, the floor, the human reopens, and a hidden copy of the data (`<!-- bug-triage:data:... -->`). The issue is the source of truth: reopens and bumps are read back from it on any machine. The section sits outside the story's source markers, so agents never read it as part of the story, and `board publish` keeps it |
| Board fields | **Impact**, **Complexity**, **Fix risk**, **Severity** (single-select Low / Medium / High / Severe; Severity is derived), **Confidence** (number) and **Human reopens** (number), created by `board setup` (names in `board.fields`) |
| `.agent-metrics/decisions.jsonl` | One `stage: "bug-triage"` decision per assessment: `pr`, `stories`, `pr_severity`, `pr_class`, `systems`, `shared`, `contract`, `ci`, and per ticket in `items` the three ratings, `severity` with its `severity_base` and `severity_bump`, the floor, `confidence`, `high_confidence`, `agent_confidence`, `reopens` and `systems`. Written in the main checkout (the PR branch gets no new commits for it), like the PR-group outcomes |
| `.agent-state/review-gate/pr-<n>.json` | This machine's copy of the assessment (`review-gate status`) |

The agent's usage is recorded like every other run (stage `bug-triage` in `token-usage.jsonl`, see [costs](costs.md)).

## The gate

`lib/gate.mjs` decides from the assessment, then applies the decision to the PR.

| Decision | When | What happens |
| --- | --- | --- |
| **auto-merge** | the PR severity is **Low**, every ticket has **high confidence**, no ticket has a **human reopen**, the PR's **checks pass**, and `implement.autoMerge.enabled` | see [Auto-merge](#auto-merge) |
| **wait** | everything qualifies but the checks are still running (or none reported yet) | the label `approvals:0` and the notice; `board sync` evaluates the PR again ([Re-evaluation](#re-evaluation)) |
| **review** | anything else: Medium, High or Severe, low confidence, a human reopen, failing checks, a ticket that was not assessed, auto-merge switched off | **1 required approval** (the [approvals policy](#approvals-policy) table; never fewer than 1), the labels `approvals:N` and `needs-human`, review requests, and the notice. The card stays in Pending Review |

Reviewers are requested from each ticket's **assignees**, or, for a ticket without one, the **CODEOWNERS** of the files it touches (`.github/CODEOWNERS`); never the PR's author. CODEOWNERS stay optional reviewers on every PR, and the team can bring in more reviewers themselves: the gate only sets the **number** of required approvals.

The **review notice** is one PR comment, edited in place. It has a row per ticket (the three fields, Severity, Confidence, systems), each ticket's reasoning and confidence signals collapsed, the PR severity with its explanation, and says exactly what triggered review, for example "**What triggered review:** BUG-7 is Medium (Identity.API; Impact Medium, Fix risk Low → Medium). BUG-3 and BUG-9 would have auto-merged." Its hidden marker (`<!-- review-gate:{...} -->`) carries the gate's state on the PR: the decision, the approvals, the triggers, the head it was assessed on and the "changes requested" reviews already counted as reopens.

A PR that needed people stays that way: later evaluations never auto-merge it, even if the trigger went away.

### Enforcement: the review-quorum check

GitHub rulesets set one approval count per branch, not per PR, so `.github/workflows/review-quorum.yml` enforces the count per PR. It runs on `pull_request` (opened, pushed, labeled, ...) and `pull_request_review` (submitted, edited, dismissed), and passes when approvals from **distinct people**, not the author, given on the **latest push** (an approval from before it is stale), reach the PR's `approvals:N` label. Each reviewer's latest approving or "changes requested" review counts; a comment does not change a verdict. A PR without the label, or with `approvals:0`, passes. The check runs `scripts/review-gate/quorum.mjs` from the **base branch**, so a PR cannot change how its own approvals are counted; changes to `.github/workflows/`, `.github/CODEOWNERS` and `scripts/review-gate/` are severity floor paths for the same reason.

**Making it required is a repository setting**, armando's call: Settings → Rules → Rulesets → the ruleset for `main` → "Require status checks to pass" → add `review-quorum`. Until then it is a visible check that nothing blocks on. `main` has no branch protection and no required approvals today; the gate does not change any repository setting.

## Auto-merge

A PR the gate clears is merged with `gh pr merge --auto --squash` (`implement.autoMerge.method`), labeled `auto-merged` (and `approvals:0`), and its notice says so. Its issues close through `Closes #N`, and the cards reach Done through the existing `closed` event of `board sync`. Every merge goes through **one function**, `mergePr` in `lib/github.mjs`, with the identity in `implement.autoMerge.identity`:

| Identity | Who merges | When |
| --- | --- | --- |
| `gh-user` (default) | the `gh` CLI's logged-in user on the pipeline machine | today: `main` requires no approvals from people |
| `app` | a GitHub App with a ruleset bypass, its installation token in the variable named by `appTokenEnv` (`REVIEW_GATE_APP_TOKEN`) becomes `GH_TOKEN` for the merge | once `main` requires approvals from people, a PR that needs none can only merge through a bypass |

`implement.autoMerge.enabled` is the **kill switch**, **on** (`true`). Set it to `false` in `scripts/implement/config.json` to stop all auto-merges: every PR that would auto-merge is then reviewed instead, and its notice says "auto-merge is switched off; it would have auto-merged". A merge GitHub refuses (auto-merge not allowed on the repo, a missing App token) sends the PR to review with the reason.

`--auto` lets GitHub wait for its own requirements; with none (today), it merges at once. For the waiting case, the repository needs **Allow auto-merge** (Settings → General → Pull Requests). The gate itself only asks for the merge once the PR's checks are green.

## Re-evaluation

`board sync` evaluates every open gated PR again (it finds them by their `approvals:N` label, `approvals:0` included), from what GitHub holds (the PR's gate state, each ticket's `## Triage`, the PR's checks), so any machine can do it:

- a PR **waiting** for its checks auto-merges once they pass, goes to review when they fail, and goes to review when someone **pushed** to it after it was assessed (the assessment no longer matches the diff);
- a PR with a new human reopen goes back to review (see below);
- a PR that needs people stays that way.

## Human reopens

A **human reopen** is a person sending a triaged bug fix back after the gate assessed it. It is counted apart from QE's `bugFixCycles` (those are the pipeline's own tests failing before the PR existed). `board sync` finds them (`lib/sync.mjs`, `lib/reopens.mjs`):

| Source | Detected when |
| --- | --- |
| `card` | the card moved back to **In Progress** from Pending Review or Done with **no pipeline event behind it**: the last pipeline event on the card (its hidden marker) left it in review or done. The board is a user project, so `projects_v2_item` webhooks don't fire and GitHub Actions can't watch lane moves; the sync compares the card with that last event instead |
| `issue` | the issue was reopened (open, closed earlier, its card still in Done) |
| `changes-requested` | a "changes requested" review on an open gated PR, against the tickets it **names** (in its body or inline comments), or against **every ticket in the PR** when it names none. Each review counts once (the PR's gate state keeps the ids) |

Each reopen:

- bumps the ticket's severity **+1 level**, capped at Severe, recomputed from the stored ratings and floor ("Impact Medium, Fix risk Low → Medium, +1 reopen → High"), and **blocks auto-merge for that ticket for good** (the reopen stays in its `## Triage`);
- updates the `## Triage` section and the **Severity** and **Human reopens** fields, labels the issue `reopened`, and appends a `type: "reopen"` record to `decision-outcomes.jsonl` (`story`, `pr`, `source`, `by`, `afterMerge`, `reopens`, `severity`);
- adds the reason (the reviewer's comments, or the people's comments on the issue since the last pipeline event) as a new round under **`## Decisions`** in the issue body, so every agent of the re-run gets it as a binding requirement, like a human's answers to escalation questions;
- posts a `reopened` board event (Pending Review or Done → In Progress), which also keeps the next sync from counting the same move again.

What happens next depends on the PR:

- **Before the PR merges:** the PR's auto-merge is turned off (`gh pr merge --disable-auto`), its gate goes back to **review** (`approvals:N`, `needs-human`, the notice names the reopen), and the ticket re-runs **on its PR's branch**: a single-ticket PR's branch (fetched from origin when this machine has none, fast-forwarded to a person's commits on it), or its bug-epic **PR group's branch** (it joins the delivered group while the group PR is open). The push updates the PR, the ticket goes back to Pending Review with it, and the gate assesses the PR again.
- **After it merged:** the fix runs as a **follow-up** on a new branch from the base (`<branch>-r<n>`), and its new PR goes through the same gate; the ticket's reopens keep it from auto-merging.

The re-runs start from [`implement requeue`](escalations.md#requeue-on-a-timer) (by hand or on its timer): `board sync --json` lists the reopened tickets (`reopened`), and requeue runs them with `--force`, apart from the tickets a human resolved. The run removes the `reopened` label when it starts (`board clear-reopened`); the reopen itself stays on the ticket.

## Review data for the retro

When a gated PR closes (merged or not), `board sync` writes one `type: "pr-review"` record to `.agent-metrics/decision-outcomes.jsonl` in the main checkout, next to the `late` records (`lib/pr-review.mjs`):

| Part | Fields |
| --- | --- |
| PR class features | `class`, `severity`, per ticket in `tickets` the three ratings, `severity`, `confidence`, `high` and `reopensBeforeMerge`; `systems`, `systemCount`, `shared`, `contract`, `overridePaths` hit, `ticketCount`, `diff` {`additions`, `deletions`, `files`}, `confidence` (the lowest ticket's) |
| Review | `gate` {`action`, `autoMerged`}, `requiredApprovals` and actual `approvals`; per reviewer in `reviewers`: `login`, `order`, the `verdicts` sequence, `substantiveComments` (at least `substantiveCommentChars`, 20, and not a plain "LGTM" or nit), `ledToCommits` (a commit followed their feedback) and `foundNew`; `changesRequestedRounds`, `timeToFirstReviewMin`, `timeToMergeMin`, `commitsAfterOpen`, `humanCommits` |
| Outcome | known at close (`reopensAfterMerge` 0, no `followUpBugs`, no `reverts`); the later outcome is **joined in** from the `reopen` records (after the merge), the `late` records' `bugStories` (BUG-* tickets naming these keys) and `type: "revert"` records (the sync looks for `This reverts commit <merge sha>` on the base branch) |

`foundNew` is a heuristic the retro reads as a rate over many PRs, never a verdict on one reviewer: the reviewer left a substantive comment on a file no earlier reviewer commented on, or their substantive feedback led to a commit when the earlier reviewers left none.

The [factory retro](qe.md#auto-improvement) groups these records by PR class (`reviews` in its digest, `lib/review-retro.mjs`):

- how often the **2nd and 3rd reviewers** found something the earlier ones didn't (`secondReviewerFound`, `thirdReviewerFound`);
- **escapes by approval count** (`escapesByApprovals`: merged PRs reopened after merge, named by a follow-up BUG ticket, or reverted);
- **review latency per extra reviewer** (`latencyByReviewers`: median minutes to the first review and to merge).

From them it **proposes** changes to the approvals policy table, computed in code with guards: nothing for a class with fewer than `retro.minSample` (5) PRs reviewed by people; one more approval when the next reviewer keeps finding new things (`raiseFindRate` 0.3) or merged PRs escape (`raiseEscapeRate` 0.2); one fewer when the last required reviewer rarely does (`lowerFindRate` 0.05) and nothing escaped; **never fewer than 1** for a PR that is not auto-merged. The lessons run writes the proposals into `implement.reviewGate.approvals` on its branch and opens its usual PR with a "Proposed approvals policy changes" section, which armando approves or closes; the retro never changes the policy itself, and the `qe-lessons` agent cannot edit that file. The same data backs a proposal to **widen auto-merge beyond Low** (a class whose reviewers find nothing and whose PRs never escape); that is only ever written in the PR, because the gate's rule is code a person changes.

## Approvals policy

`implement.reviewGate.approvals` maps a PR class to its required approvals (the [retro](#review-data-for-the-retro) proposes changes as a PR): the entry for the class (`High+shared`), else for its severity (`High`), else `default`. Today every class needs **1**. A PR that does not auto-merge never needs fewer than 1, whatever the table says.

```json
"approvals": { "default": 1, "Low": 1, "Medium": 1, "High": 1, "Severe": 1 }
```

## Switches

| Switch | Effect |
| --- | --- |
| `implement.reviewGate.enabled: false`, or `REVIEW_GATE=0` | The gate does nothing; PRs stay as the pipeline opened them |
| `implement.autoMerge.enabled` (default `true`) | The auto-merge kill switch: off, a PR that qualifies is reviewed (1 approval) instead |
| `implement.autoMerge.identity` | `gh-user` or `app` ([Auto-merge](#auto-merge)) |
| `PIPELINE_NO_PR=1` (experiments) | No PRs, so nothing to gate |
| board inactive (no project, a fork, a test repo, `PIPELINE_BOARD=0`) | The gate does nothing |

## Commands

```bash
node scripts/review-gate/review-gate.mjs publish --pr <url> --tickets BUG-1,BUG-2 --base origin/main   # run by implement run
node scripts/review-gate/review-gate.mjs status [--pr <url>]
node scripts/review-gate/quorum.mjs <pr number> --repo owner/name    # what the review-quorum check runs
node scripts/board/board.mjs setup        # creates the triage fields on the board
node scripts/board/board.mjs sync         # reopens, gated PRs evaluated again
node scripts/pipeline/pipeline.mjs implement requeue   # re-runs reopened bug fixes (and resolved tickets)
```
