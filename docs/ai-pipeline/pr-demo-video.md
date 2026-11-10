# PR demo videos

Pull requests that change the frontend get a **Demo video** section in their description: the videos of the e2e specs they add or change, recorded on the test stack, each with an animated preview that plays inline and a link to the full WebM. Reviewers see the feature working without checking out the branch, and the [PR check](pr-check.md#videos)'s video critic reads the same links. Pull requests that change only the backend get an [API changes](#api-changes-backend-only-prs) section instead.

## Which PRs get what

`pr-video.mjs scope` sorts the PR's changed files:

- **Frontend**: anything in `src/WebApp`, `src/WebAppComponents`, `src/WebhookClient`, `src/HybridApp` or `src/ClientApp`, plus views, pages and static assets elsewhere in `src/` (`.razor`, `.cshtml`, `.css`, `.js`, `.ts`, `.html`, and `Views/`, `Pages/`, `wwwroot/` folders, such as the Identity.API login pages).
- **Backend**: everything else in `src/` (APIs, domain, infrastructure, event bus, processors), except `src/eShop.AppHost` and `src/eShop.ServiceDefaults`.
- Files outside `src/` (tests, e2e specs, docs, CI) count as neither.

| PR changes | Demo video | API changes |
| --- | --- | --- |
| Frontend only | ✅ | ❌ |
| Frontend and backend | ✅ | ❌ |
| Backend only | ❌ | ✅ |
| Neither | ❌ | ❌ |

Sections that no longer apply (for example after a frontend change is pushed to a backend-only PR) are removed, along with any stored videos.

## How it works

`.github/workflows/pr-demo-video.yml` runs when a PR is opened, reopened, marked ready for review or pushed to. It works the same for PRs that `pipeline implement run --pr` opens and for PRs people open.

1. `node scripts/pr-video/pr-video.mjs specs --base origin/<base>` lists the `e2e/teststack/*.spec.ts` files the PR adds or changes, and `scope` decides whether the PR gets a video, an API summary or neither.
2. If the PR changes the frontend but no spec, the section says so and nothing is recorded.
3. Otherwise it starts the test stack (`testing/teststack up`) and runs those specs with `E2E_KEEP_VIDEOS=1` (`--project scenarios --no-deps`; each spec loads its own scenario).
4. `pr-video.mjs publish` reads `artifacts/e2e-videos/manifest.json`, makes a GIF preview of each video with `ffmpeg` (skipped if it would exceed 9 MB), pushes the files to `pr-videos/pr-<n>/`, and replaces the section between `<!-- pr-demo-video:start -->` and `<!-- pr-demo-video:end -->` in the PR description. Text outside the markers is left alone.
5. The videos are also uploaded as the `pr-demo-video-<n>` artifact. If a spec failed, its video is marked failed in the section and the job fails.

API-only specs have no browser, so they record no video. A user-facing change needs a UI spec; see the `feature-demo-video` skill (`.github/skills/feature-demo-video/SKILL.md`).

## API changes (backend-only PRs)

PRs that change backend code (see [Which PRs get what](#which-prs-get-what)) and no frontend code get an **API changes** section, between `<!-- pr-api-summary:start -->` and `<!-- pr-api-summary:end -->`. For each HTTP endpoint the PR adds, changes or removes, it gives:

- **Method and endpoint**, found by diffing the minimal-API route mappings (`MapGroup` prefixes plus `MapGet`/`MapPost`/`MapPut`/`MapPatch`/`MapDelete`, route constraints stripped) between the merge base and the PR head. An endpoint counts as changed when the diff touches its `Map*` call, its inline lambda, its named handler method or its API versions.
- **Request and response**: parameters, request body type and fields, and response codes and types, read from the OpenAPI documents the test stack serves (`/openapi/v1.json`, plus `v2` for Catalog). Removed endpoints are only listed in the table.
- **Examples**: real calls the changed specs made through Playwright's `request` fixture. The workflow runs them with `E2E_API_LOG=1`, so `e2e/fixtures.ts` attaches each call (method, URL, request headers and body, status, response body) and `e2e/video-reporter.ts` adds them to `manifest.json`. The section shows one example per status code, up to three per endpoint. `Authorization` and cookie headers and JSON keys that look like secrets (password, token, secret, API key) are redacted, and bodies are truncated.

Endpoints the specs called but the PR did not change are listed as *Exercised*, which covers changes inside services the route diff can't see. The specs still run for backend-only PRs (to record the examples), but their videos are not published. The stack is started for backend-only PRs even when no spec changed, so the OpenAPI details are still filled in. The section is removed when there is nothing to show. gRPC (Basket.API) and the Identity endpoints have no OpenAPI document; they appear with recorded examples only.

## Storage

Videos live on the `pr-videos` branch, which is rewritten as a single parentless commit on every publish, so replaced videos don't build up in history. Links use `github.com/<repo>/blob/pr-videos/...`, which works for private repositories too: previews use `?raw=true`, and the PR check rewrites the links to `raw.githubusercontent.com` and downloads them with its token. When a PR is closed without merging, its folder is removed; merged PRs keep theirs as a record of the feature.

Fork and Dependabot PRs get a read-only token, so the workflow skips them.

## Running it by hand

```bash
node scripts/pr-video/pr-video.mjs specs --base origin/main
node scripts/pr-video/pr-video.mjs scope --base origin/main   # frontend/backend/video/api
E2E_KEEP_VIDEOS=1 npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps <specs>
GH_TOKEN=... node scripts/pr-video/pr-video.mjs publish --pr 42 --specs <a,b>
E2E_API_LOG=1 npx playwright test ...                     # record API calls too
node scripts/pr-video/pr-video.mjs api --base origin/main --dry-run   # print the API changes section
node scripts/pr-video/pr-video.mjs cleanup --pr 42
```

`publish` and `cleanup` need push access to the repository and the `gh` CLI.
