# Board stage

Part of the [AI development pipeline](README.md). Every story, bug, epic and research spike is an issue on the **[eShop Story Board](https://github.com/users/armandodollia-slalom/projects/1)**, a GitHub Project whose default view shows the epics. An engineer starts the pipeline by hand for a story or a whole epic, and the card moves as the pipeline reaches each step: claimed, under test, back to the implementer on a product bug, ready for review, failed or done.

The issue is the story's **source of truth**: its body carries the complete story, and the pipeline reads it from there (see [Tickets](#tickets-the-issue-is-the-source-of-truth)).

The stage CLI is `scripts/board/board.mjs`; settings are in `scripts/board/config.json`. The state machine is `scripts/board/lib/flow.mjs`.

```mermaid
flowchart LR
  B[Backlog<br/>not ready] -->|you move it when ready| T[Ready]
  T -->|implement run / pipeline start<br/>claims it| P[In Progress<br/>implementer, review]
  P -->|review approved,<br/>QE starts| Q[Testing<br/>QE writes and verifies tests]
  Q -->|QE finds a product bug| P
  Q -->|tests verified, PR opened| R[Pending Review<br/>PR + evidence]
  R -->|PR merged: Closes #issue<br/>board sync| D[Done]
  P -.->|pipeline stops| F[Failed<br/>needs-human, reason in a comment]
  Q -.->|pipeline stops| F
  F -.->|you fix it and run it again| P
```

## Lanes

| Lane | Reached by |
| --- | --- |
| Backlog | `board setup` (new stories). Not ready for implementation |
| Ready | you, when a story is ready for implementation |
| In Progress | the **claim** when `pipeline implement run` (or an interactive `pipeline start <KEY>`) begins the story, with a comment naming the user and machine; and the **product-bug** event when QE finds bugs in the implementation and the story goes back to the implementer, with a comment listing the bugs |
| Testing | the **testing** event: the architecture review approved the code and QE started writing and verifying the automated tests (again after every bug fix) |
| Pending Review | the **verified** event: the tests are verified and the PR is open (headless), or the line of work is done and verified (interactive, no PR). The issue gets the review notes and evidence; the epic gets the same links |
| Failed | the **failed** event: any outcome of `pipeline implement run` other than done (`blocked`, `unresolved`, `plan-rejected`, `pair-exhausted`, `limit-*`, `qe-*`, a blocker that failed, a PR that could not be opened, ...). The card gets the `needs-human` label and a comment with the outcome, reason, findings, branch and log path |
| Done | `board sync`: closed story issues move to Done. The PR body gets `Closes #<issue>`, so merging the PR closes the issue. (The project's built-in "Item closed" workflow does the same instantly if you turn it on under the project's Workflows; GitHub has no API for that.) |

The board is informational: GitHub errors are logged and never block an agent or change a pipeline outcome.

## The state machine

Pipeline events move a card only along these transitions; any other event is ignored and logged.

| Event | Sent by | From | To |
| --- | --- | --- | --- |
| `claim` | `implement run` (each story it runs), `pipeline start` (story-start hook) | no lane, Backlog, Ready, Failed, In Progress; Testing, Pending Review or Done only with `--force`; a card another machine holds only with `--takeover` | In Progress |
| `testing` | the runner after the review approves; the Stop hook (interactive) | In Progress | Testing |
| `product-bug` | the runner when QE reports bugs and a bug-fix cycle starts; the Stop hook | Testing, In Progress | In Progress |
| `verified` | the runner after it opens the PR (`board review`); the Stop hook | In Progress, Testing | Pending Review |
| `failed` | `implement run` for every story that did not finish (`board fail`) | no lane, Backlog, Ready, In Progress, Testing | Failed |
| `closed` | `board sync` | any lane but Done | Done |

Testing goes back to In Progress only on a product bug. A claim of a card in Testing by the machine that holds it (a resumed run) leaves it in Testing.

**Claims.** A claim fails when the card is in In Progress or Testing and its latest event came from another user or machine (`<gh login>@<host>`). `implement run` then skips that story (and any story stacked on it) and says who holds it; `--takeover` takes it over (`--force` is for running a story in Pending Review or Done again). While another machine holds a card, events from this machine are ignored (`not-owner`), so a stale run cannot move a card someone else took over.

**Sequence numbers.** Every event carries a per-ticket number that only grows. The last applied number is stored in two places:

- on this machine, in `<git common dir>/ai-pipeline/board/<KEY>.json` (shared by the main checkout and every worktree, so the batch and its story workers agree), with the number each event id was given;
- on the card, in a hidden marker at the end of the comment each transition posts (`<!-- pipeline-board:{"seq":4,"owner":"me@host","event":"testing",...} -->`), so other machines see it.

An event whose number is not above the last applied one is stale or a replay and is ignored. Events carry ids derived from the pipeline state (`testing:<approved hash>`, `bug:<QE finish time>`, `verified:<verified hash>`), and an id keeps the number it was first given, so the runner and the Stop hook can report the same event any number of times and it applies once, in order.

**Moving cards by hand.** `board move <KEY> <lane>` moves a card forward in board order (Backlog, Ready, In Progress, Testing, Pending Review, Failed, Done); `--force` moves it anywhere. Hand moves bypass the state machine.

## Starting the pipeline

Automatic pickup (`board pick`, which polled the board and ran the stories assigned to you) was removed; it will be reworked later. An engineer starts the pipeline by hand from an up-to-date checkout of `main`:

```bash
node scripts/pipeline/pipeline.mjs implement run --epic promotions-and-recommendations --pr   # every story of an epic
node scripts/pipeline/pipeline.mjs implement run PROMO-3 --pr                                  # one story
node scripts/board/board.mjs mine                                                              # the stories assigned to you
```

`implement run` first runs `board sync`, then claims every story it will run. The headless runner reports `testing`, `product-bug` and `verified` from each story's worktree as they happen, and after the batch it moves every story that did not finish to Failed. Fix a failed story, remove the `needs-human` label and run it again (the claim takes it out of Failed), or move it back to Ready by hand (`board move <KEY> ready --force`).

**Interactive sessions.** `pipeline start <KEY>` claims the card (story-start hook; a card another machine holds is not taken: `board claim <KEY> --takeover` takes it). The board stage's Stop hook reads the story's pipeline state and reports, in order, a product bug QE found since the last stop, the review approving the code QE is now testing, and the verified tests of a finished line of work, so the card moves the same way as in a headless run. Headless runs (`PIPELINE_HEADLESS=1`) skip both hooks because the runner reports its own events.

## board sync

`board sync` does the bookkeeping that belongs to no single run. `implement run` runs it at start; run it by hand any time.

- Closed story issues move to Done, and their section on the epic's evidence comment shows Done.
- Their late outcome is recorded for the [implement decision log](implement.md#decision-log): whether the PR merged, how many commits and lines humans added on the branch before merge, and which BUG-* stories name the story (`type: "late"` in `.agent-metrics/decision-outcomes.jsonl` of the checkout, left uncommitted). Only stories this machine implemented have a run record to compare with.
- Every epic card moves to the lane its stories call for.

## Pending Review evidence

When a story reaches Pending Review, the issue gets a comment with the PR link and:

- **API stories** (`[BE - ...]` in the title): the requests and responses of the story's verified Playwright tests. The stage re-runs the tests whose names carry the story's case ids (`TC-<KEY>-`) against the test stack with tracing on, reads the API calls from each trace, and posts them grouped by test case. Secrets (`token`, `password`, `secret`, ... keys) are redacted, bodies and the comment are capped (`evidence` in the config), and the full log stays in `.agent-state/evidence/<KEY>/api-evidence.md`. Stories with only .NET tests point to the PR instead. The test stack must be up (`testing/teststack up`), as it is for QE.
- **UI stories** (`[FE - ...]`): the feature video. The PR demo video workflow adds the recording to the PR; until `featureVideo()` in `scripts/board/lib/evidence.mjs` returns its URL, the comment points to the PR.

## Epic evidence

Whenever a story posts evidence (Pending Review), fails, or reaches Done, its epic issue gets the same links on **one rolling comment**, edited in place and found by a hidden marker (`<!-- pipeline-epic-evidence:{...} -->`, which also carries the data, so any machine can update its story's section without losing the others). The comment has:

- per story: its lane, the PR link (and the epic branch it was merged into) or the branch, the feature video, screenshots, and a link to the API evidence comment on the story issue (the requests and responses themselves stay on the story issue);
- for an epic delivered as one branch: the epic PR, its branch and its video (`board epic-pr <epic issue> --pr <url> [--branch <name>] [--video <url>]`; `board review <KEY> --pr <url> --epic-branch <branch>` records that a story's PR was merged into the epic branch).

Over 60,000 characters every story shrinks to one line of links, below GitHub's comment limit.

## Epics and mockups

Every epic is an issue (label `epic`, title `Epic: ...`) with a card. Each story is a sub-issue of its epic, and each research spike a sub-issue of the epic it feeds. The project's views, in tab order:

| View | Shows |
| --- | --- |
| Epics (default) | Epic cards only, with each one's sub-issue progress. Open an epic to see its stories and click through to them |
| Stories by epic | Story cards, one swimlane per epic (grouped by the built-in Parent issue field) |
| Stories | Story cards, no swimlanes |
| All items | Table of everything |

GitHub can't reorder views, so `setup` recreates them in this order if they drift (the view URLs change when it does).

An epic's lane follows its stories; the first rule that matches wins:

| Epic lane | When its stories are |
| --- | --- |
| Done | all done |
| Pending Review | all in Pending Review or Done |
| In Progress | any in progress |
| Testing | none in progress, any in testing |
| Failed | any failed, and none can still move on its own (none in progress, testing or ready) |
| Ready | any ready |
| In Progress | some in Pending Review or Done, the rest in Backlog |
| Backlog | otherwise |

Every story transition, `board sync` and `setup` recompute it, so moving an epic card by hand is undone.

**Assigning an epic assigns its stories.** The `board-epic-assign` workflow runs when an epic is assigned or unassigned, and `board sync-epic <issue>` gives every open story of the epic exactly the epic's assignees. A story can still be reassigned on its own afterwards; the next change to the epic's assignees overrides it. The workflow runs from the default branch, so it works once this lands on main; until then run `sync-epic` by hand.

Mockups belong to a ticket: they are its assets on the `board-assets` branch, shown in its **Mockups** section (images inline, other files linked, pinned to one commit) and downloaded into its cache folder by `board fetch` (see [Assets](#assets)). Attach mockups to a new ticket with `board new --mockups <dir>`.

Who sees them: the agents implementing a story read its own mockups (and, in an `implement run --epic`, the epic's) from the start, the UI verifier compares renders of every mockup screen and state with the running app each pair round, and the PR check's design lens holds the finished branch to them ([implement](implement.md#mockups), [PR check](pr-check.md#mockup-renders)). The [story guard](README.md#story-guard) keeps every other ticket's mockups closed. Keep the mockup folder's `README.md` listing the screens and their states: builders and verifiers use it to match each screen to a page.

## Tickets: the issue is the source of truth

Stories, bugs, epics and research spikes are GitHub issues on the board repo, and the issue body holds the **complete** source Markdown. There is no story folder in the repository: every stage reads a ticket through one loader (`scripts/pipeline/lib/tickets.mjs`) from a local cache that `board fetch` (or the loader, on demand) fills from the issues.

| Type | Key | Labels | Parent |
| --- | --- | --- | --- |
| story | `PROMO-3` (title `PROMO-3: ...`) | `story`, `enhancement`, `frontend` or `backend` | the epic its **Part of** line links |
| bug | `BUG-9` (or `**Type:** Bug`) | `story`, `bug`, `frontend` or `backend` | the epic its **Part of** line links |
| epic | `epic-<slug>` | `epic` | - |
| spike | `spike-<slug>` (research write-ups) | `spike` | an epic (the research spike from the old folder sits under the "Targeted Advertising" epic) |

### Issue body format

`scripts/board/lib/ticket-format.mjs` renders and parses it:

```markdown
<!-- board-ticket:v1
{"schema":1,"key":"PROMO-3","type":"story","title":"PROMO-3: [BE - Promotions.API] - Cart pricing evaluation API","slug":"PROMO-3-cart-pricing-evaluation-api","source":"stories/PROMO-3-cart-pricing-evaluation-api.md","parent":"epic-promotions-and-recommendations","blockedBy":["PROMO-1","PROMO-2"],"sourceHash":"<sha256 of the source bytes>","eol":"lf","finalNewline":true,"content":"inline","assets":{"repo":"armandodollia-slalom/AI-Immersion-eShop","branch":"board-assets","commit":"<asset commit>","files":[{"path":"mockups/PROMO-2/PROMO-2-promotions-admin/Main.dc.html","name":"PROMO-2-promotions-admin/Main.dc.html","kind":"mockup","sha256":"<sha256>","size":1234}]}}
-->
> **PROMO-3** · Story · part of #63 · blocked by #52, #53
>
> The text between the `board-ticket:source` markers below is the source of truth for the pipeline (`board fetch` reads it back verbatim). Edit it there; everything outside the markers is generated.

<!-- board-ticket:source:begin -->
# PROMO-3: [BE - Promotions.API] - Cart pricing evaluation API
...the story, every section, verbatim...
<!-- board-ticket:source:end -->

---

## Mockups

![Main.png](https://github.com/<repo>/blob/<asset commit>/mockups/.../Main.png?raw=true)
- [`Main.dc.html`](https://github.com/<repo>/blob/<asset commit>/mockups/.../Main.dc.html)

---

Assign this issue to yourself and move it to **Ready** when it is ready for implementation ...
```

- **Hidden metadata** (an HTML comment, `>` escaped so it can never close early): key, type, title, slug (it names the branch and `tests/plans/<slug>/`), parent, blockers, the source's sha256 and line-ending style, and the **asset manifest**: every file's path on the assets branch, sha256 and size, pinned to one asset commit.
- **Round trip:** `parseBody(renderBody(file)).content` is the file byte for byte. The one normalisation: GitHub may store a body with CRLF line endings (web edits do), so the body is read with CRLF as LF, and the source's own line endings (`eol`) and final newline come back from the metadata. A text that differs from `sourceHash` was edited on GitHub; that edit is the new truth.
- **Edit the story** between the markers on GitHub, or edit the cached `story.md` and run `board publish <KEY>`.
- **Size:** an issue body is capped at 65,536 characters. A source that would not fit (or has mixed line endings, or contains a marker) is **spilled**: stored on the assets branch as `files/<KEY>/<file>.md`, linked from the body with a preview, and `content` in the metadata names it. Fetch downloads it and checks its sha256. None of the current tickets needs it (the largest body is about 26,000 characters).

### Assets

Mockups, images and other non-Markdown files live on the orphan branch **`board-assets`**: `mockups/<KEY>/<folder>/<file>` for mockups and `files/<KEY>/<path>` for everything else (a spike's images, spilled sources). `scripts/board/lib/assets.mjs` builds its commits with git plumbing (`hash-object`, a temporary index, `write-tree`, `commit-tree`, `update-ref`), so your branch and working tree are never touched. Only `migrate --apply` and `new --mockups` push the branch. Bodies embed images and link files by the pinned commit, so a later asset change never alters what an existing body shows.

### Fetch and the local cache

```bash
node scripts/board/board.mjs fetch PROMO-3 PROMO-4      # or --epic <EPIC>, or --all; --refresh to re-download
```

```text
.agent-state/board/<KEY>/story.md     the source Markdown, exactly as in the issue
.agent-state/board/<KEY>/meta.json    the metadata, the issue (number, url, updatedAt, state), the story sha
.agent-state/board/<KEY>/mockups/     mockups, downloaded at the pinned commit and checked by sha256
.agent-state/board/<KEY>/files/       other attachments
.agent-state/board/<KEY>/history/     every version fetched, by story sha (QE diffs a stale plan against it)
```

- An issue whose `updatedAt` did not change is not downloaded again; `--refresh` re-downloads.
- Offline, the cached copy is used with a warning; a ticket that is neither cached nor on the board is a clear error that says how to create it.
- Local edits to a cached story (the implementer's Implementation Notes) are never overwritten: if the issue changed too, fetch reports a conflict and keeps your copy until you `publish` it or fetch with `--refresh`.
- `pipeline start <KEY>`, `implement run <KEY>` and `qe plan <KEY>` re-check the issue themselves; hooks only read the cache, so no hook waits on GitHub.
- With `git config qe.autoPlan true`, a fetch that brings a changed story starts its test plan in the background (commits no longer do: stories are not committed files).
- `.agent-state/` is gitignored; the cache is per checkout. `implement run` copies a story's cache folder into its worktree (and into each subtask worktree).

### Creating and changing tickets

```bash
node scripts/board/board.mjs new story.md [--epic epic-promotions-and-recommendations] [--mockups path/to/PROMO-10-cart]
node scripts/board/board.mjs new - --type spike < findings.md
node scripts/board/board.mjs publish PROMO-3            # the cached story (e.g. with Implementation Notes) back to its issue
```

`new` takes the format in [writing-stories.md](writing-stories.md); the key comes from the heading (`# PROMO-10: ...`) or `--key`. It creates the issue with its labels, makes it a sub-issue of its epic, adds it to the project and caches it. `publish` refuses when the issue changed since you fetched it (`--force` overwrites). `implement run` publishes a finished story itself.

## Migration from the story folder

The stories, epics, mockups and research once lived in a folder in the repository (`tickets.legacyDir` in `scripts/pipeline/config.json`). `board migrate` moves all of it to the board, and is safe to run again:

```bash
node scripts/board/board.mjs migrate                 # dry run: where every file goes; report in .agent-state/board/migration-report-plan.md
node scripts/board/board.mjs migrate --apply         # GitHub writes (idempotent)
node scripts/board/board.mjs migrate --verify        # fetch every ticket into a temp cache and compare
node scripts/board/board.mjs migrate --delete-local  # only after a passing verify of exactly these files
```

| Step | What it does |
| --- | --- |
| dry run | Classifies every file: `stories/<KEY>-*.md` is a story or bug, `epic-*.md` an epic, any other Markdown document (a research write-up) a **research spike** under a new **Targeted Advertising** epic (whose body is generated), `mockups/<owner>-*/` files are mockups of the story key or epic they are named after, files a ticket links to (a spike's images) are its attachments, and files in a spike's folder or named after a ticket go to that ticket. Anything else is **unplaced** (the target is none; the current folder has none). Prints counts; the full table (file, ticket, existing issue or "create", asset path) is in the report. |
| `--apply` | Builds and pushes the `board-assets` commit, creates the `spike` label, creates or updates every issue (epics first, so links get numbers), adds new issues to the project and links sub-issues. A second run changes nothing. |
| `--verify` | Fetches every ticket from GitHub into a temporary cache and compares it with the files: content byte for byte, every asset by sha256. Any difference (or an unplaced file, unless `--allow-unplaced`) fails it. Writes `.agent-state/board/migration-report.md` with a fingerprint of the folder. |
| `--delete-local` | Refuses unless the last verify passed and its fingerprint matches the files now. Then it stages the folder's removal (`git rm -r --cached`), deletes it, and removes every reference: the config keys and guard entry, ignore-file and workflow path lines, and `story-file:` in test plan indexes (replaced by `story-issue: <url>`). It lists any reference it could not edit. Review and commit the result. |

## Setup

One-time, already done for this repo (project #1). Run it again after adding columns; it is idempotent.

```bash
gh auth refresh -s project                       # Projects need the project scope
node scripts/board/board.mjs setup
```

`setup` enables issues on the repo, creates the labels (`story`, `epic`, `spike`, `needs-human`, `frontend`, `backend`), creates and links the project (saving its number in `scripts/board/config.json`), sets the Status columns, sets up the views, and puts every card without a lane in Backlog. It never writes issue bodies: tickets are created by `board new` and `board migrate --apply`. It renames columns in place (Todo became Ready) and adds new ones without losing their cards. **Run `board setup` once after pulling the change that adds the Testing lane**: until then, moving a card to Testing is logged and skipped. Any repo collaborator can be assigned.

The board is active only when `scripts/board/config.json` has a `projectNumber`, the checkout's `origin` is the configured repo (so test fixtures and forks never touch it), and `PIPELINE_BOARD` is not `0`. Everyone who runs the pipeline needs `gh` logged in with the `project` scope.

## Commands

```bash
node scripts/board/board.mjs setup
node scripts/board/board.mjs fetch <KEY>... | --epic <EPIC> | --all [--refresh]   # tickets into .agent-state/board/
node scripts/board/board.mjs new <file.md|-> [--type story|bug|epic|spike] [--key KEY] [--epic <epic-key>] [--mockups <dir>] [--dry-run]
node scripts/board/board.mjs publish <KEY> [--force]       # the cached story back to its issue
node scripts/board/board.mjs migrate [--apply|--verify [--allow-unplaced]|--delete-local [--dry-run]]
node scripts/board/board.mjs sync                          # closed stories to Done, late outcomes, epic lanes
node scripts/board/board.mjs mine
node scripts/board/board.mjs claim <KEY>... [--force] [--takeover]  # claim for this machine (implement run does this)
node scripts/board/board.mjs event <KEY> claim|testing|product-bug|verified|failed|closed [--id <id>] [--force] [--takeover]
node scripts/board/board.mjs fail <KEY>                    # Failed + needs-human from the implement run record
node scripts/board/board.mjs move <KEY> backlog|ready|inProgress|testing|review|failed|done [--force]
node scripts/board/board.mjs review <KEY> [--pr <url>] [--epic-branch <branch>]   # Pending Review + evidence
node scripts/board/board.mjs epic-pr <epic issue> --pr <url> [--branch <name>] [--video <url>]
node scripts/board/board.mjs status [KEY]                  # lane and last event (number, owner)
node scripts/board/board.mjs sync-epic <issue>             # give an epic's open stories its assignees
node scripts/board/board.mjs hook story-start <KEY> | hook stop   # called by the dispatcher
npm run test:pipeline
```
