# Writing stories for the pipeline

Part of the [AI development pipeline](README.md). The pipeline only knows what the story says: the implementer builds from it, the QE agents plan and test against it, and the PR check holds the pull request to it. This page is the contract between a story author and the agents.

## Where stories live

- Every story is an issue on the [story board](board.md); the issue body holds the whole story in Markdown, between the `board-ticket:source` markers. Create one from a Markdown file (or stdin) with the board, not by adding a file to the repository:

  ```bash
  node scripts/board/board.mjs new PROMO-10.md --epic epic-promotions-and-recommendations [--mockups path/to/PROMO-10-cart] [--dry-run]
  ```

  Bugs work the same way (`**Type:** Bug`, or a `BUG-` key); `--type epic` and `--type spike` create epics and research spikes.
- `<KEY>` is uppercase letters and digits, a dash and a number (`PROMO-10`). Put it in the heading (`# PROMO-10: [FE - WebApp] - Coupon entry in the cart`) or pass `--key`. The issue title is the heading; one issue per key.
- The **slug** (`PROMO-10-coupon-entry-in-the-cart`, kept in the issue metadata) names the branch (`feat/` plus the lowercased slug, first 60 characters) and the test plan folder (`tests/plans/<slug>/`). It never changes after the issue is created, so renaming the title does not orphan a plan.
- The first level-1 heading is the story title. Put `[FE` in it (for example `# PROMO-10: [FE - WebApp] - Coupon entry`) for frontend stories, so the PR check runs its UI design critic.
- Edit a story on GitHub between the markers (or edit the cached `.agent-state/board/<KEY>/story.md` and run `board publish <KEY>`). The next `board fetch`, `pipeline start` or `implement run` picks the change up, and its test plan becomes stale.

## Sections the agents read

| Section | Required | Who uses it | Write it so that |
| --- | --- | --- | --- |
| `# <title>` | yes | everyone | it names the feature; add `[FE]` for UI work |
| `**Blocked by:**` line | when it has blockers | `implement run` (ordering, stacked branches), implementer | it lists story keys, for example `* **Blocked by:** [PROMO-1](PROMO-1-....md), PROMO-2`. Leave it out, or write `None`, when there are none |
| User Story | yes | implementer, critics | the role, need and value are clear |
| Inputs | when there is an API or form | implementer, `qe-plan`, acceptance critic | every field has its type, required or optional, limits and format |
| Outputs | yes | implementer, `qe-plan`, acceptance and design critics | exact fields, status codes, copy and formats; the design critic uses it when there is no mockup |
| Acceptance Criteria | yes | everyone | each one is a testable **Given / When / Then**, including the error cases |
| Technical Notes | optional | implementer | file and line references are hints; the implementer checks them against the code and the code wins |
| Test scope | optional | `qe-plan` | it says which layer tests what, and what is out of scope |
| Related Stories | optional | implementer | context only; agents can't open other stories unless they were handed to the pipeline |
| Open Questions | optional | implementer, `qe-plan` | each question is answered, or clearly minor (see below) |
| `## Implementation Notes` | never by hand | written by the implementer | a story that already has it is skipped by `implement run` (unless `--force`) |

## What makes a story go well

- **Make every rule testable.** `qe-plan` writes a case for every requirement, field constraint, output field, status code and algorithm step, and a sad path only where the story states or implies the outcome. Anything left undefined (exact error bodies, concurrency, outages) becomes an open question instead of a test.
- **Answer design questions before you start.** If an Open Question changes the API shape, auth or data model, the implementer stops and the story ends `blocked`. Minor ones it decides conservatively and records under Implementation Notes.
- **Keep the story self-contained.** The [story guard](README.md#story-guard) denies agents every other ticket and its mockups unless you hand it to `implement run` (the story keys, or `--epic`, which also hands over the epic itself). Copy the parts of an epic or another story the story depends on into the story.
- **List blockers.** A story blocked by another in the same batch runs after it and stacks on its branch. A blocker outside the batch must already be merged, or the implementer reports the story `blocked`.
- **Name exact copy.** Labels, messages and formats in Outputs are checked word for word by the acceptance and design critics.
- **Stay in scope.** The implementer builds exactly the acceptance criteria and lists nice-to-haves in its report instead.

## Mockups (frontend stories)

Attach mockups to the story with `board new --mockups <folder>`: a folder named `<KEY>-<name>` with a `README.md` (the screens and any review changes) and the `.dc.html` design canvas files and images. They go on the `board-assets` branch, show in the issue's Mockups section, and land in `.agent-state/board/<KEY>/mockups/` when the story is fetched. When a mockup exists, the PR check's design critic treats it as the reference for layout, components, states and copy; otherwise it uses the story's Outputs and the existing WebApp design system. A mockup folder for the key also marks the story as frontend.

## Changing a story after work started

The test plan records the story text it was written for (`story-sha`). When the story changes, the plan becomes stale: `node scripts/qe/qe.mjs plan <KEY>` (or `--stale`) updates the affected cases in place and keeps the other case ids, and `pre-push` fails until it does. See [qe.md](qe.md#workflow-1-story-to-test-plan).

## Template

```markdown
# [FE] <Feature title>

* **Blocked by:** <KEY-1>, <KEY-2>

## User Story

As a <role>, I want <capability> so that <value>.

## Inputs

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `code` | string | yes | 3-20 characters, letters and digits, case-insensitive |

## Outputs

* `200 OK` with `{ "total": number, "discount": number }`.
* Message shown under the field: "Coupon applied".

## Acceptance Criteria

1. **Given** <state> **When** <action> **Then** <observable result>.
2. **Given** an expired code **When** the shopper applies it **Then** the API returns `400` and the cart shows "This coupon has expired".

## Technical Notes

* <Services, endpoints, events and files involved.>

## Test scope

* <What is tested at which layer; what is out of scope.>

## Related Stories

* <KEY>: <how it relates>

## Open Questions

* <Question> (answer: <decision>, or "open")
```
