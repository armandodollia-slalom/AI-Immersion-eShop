# PR demo videos

Every pull request gets a **Demo video** section in its description: the videos of the e2e specs it adds or changes, recorded on the test stack, each with an animated preview that plays inline and a link to the full WebM. Reviewers see the feature working without checking out the branch, and the [PR check](pr-check.md#videos)'s video critic reads the same links.

## How it works

`.github/workflows/pr-demo-video.yml` runs when a PR is opened, reopened, marked ready for review or pushed to. It works the same for PRs that `pipeline implement run --pr` opens and for PRs people open.

1. `node scripts/pr-video/pr-video.mjs specs --base origin/<base>` lists the `e2e/teststack/*.spec.ts` files the PR adds or changes.
2. If there are none, the section says so and nothing is recorded.
3. Otherwise it starts the test stack (`testing/teststack up`) and runs those specs with `E2E_KEEP_VIDEOS=1` (`--project scenarios --no-deps`; each spec loads its own scenario).
4. `pr-video.mjs publish` reads `artifacts/e2e-videos/manifest.json`, makes a GIF preview of each video with `ffmpeg` (skipped if it would exceed 9 MB), pushes the files to `pr-videos/pr-<n>/`, and replaces the section between `<!-- pr-demo-video:start -->` and `<!-- pr-demo-video:end -->` in the PR description. Text outside the markers is left alone.
5. The videos are also uploaded as the `pr-demo-video-<n>` artifact. If a spec failed, its video is marked failed in the section and the job fails.

API-only specs have no browser, so they record no video. A user-facing change needs a UI spec; see the `feature-demo-video` skill (`.github/skills/feature-demo-video/SKILL.md`).

## API changes (backend PRs)

PRs that change backend API code (`src/<Service>.API/**/*.cs`) also get an **API changes** section, between `<!-- pr-api-summary:start -->` and `<!-- pr-api-summary:end -->`. For each HTTP endpoint the PR adds, changes or removes, it gives:

- **Method and endpoint**, found by diffing the minimal-API route mappings (`MapGroup` prefixes plus `MapGet`/`MapPost`/`MapPut`/`MapPatch`/`MapDelete`, route constraints stripped) between the merge base and the PR head. An endpoint counts as changed when the diff touches its `Map*` call, its inline lambda, its named handler method or its API versions.
- **Request and response**: parameters, request body type and fields, and response codes and types, read from the OpenAPI documents the test stack serves (`/openapi/v1.json`, plus `v2` for Catalog). Removed endpoints are only listed in the table.
- **Examples**: real calls the changed specs made through Playwright's `request` fixture. The workflow runs them with `E2E_API_LOG=1`, so `e2e/fixtures.ts` attaches each call (method, URL, request headers and body, status, response body) and `e2e/video-reporter.ts` adds them to `manifest.json`. The section shows one example per status code, up to three per endpoint. `Authorization` and cookie headers and JSON keys that look like secrets (password, token, secret, API key) are redacted, and bodies are truncated.

Endpoints the specs called but the PR did not change are listed as *Exercised*, which covers changes inside services the route diff can't see. The stack is started for backend PRs even when no spec changed, so the OpenAPI details are still filled in. The section is removed when there is nothing to show. gRPC (Basket.API) and the Identity endpoints have no OpenAPI document; they appear with recorded examples only.
## Storage

Videos live on the `pr-videos` branch, which is rewritten as a single parentless commit on every publish, so replaced videos don't build up in history. Links use `github.com/<repo>/blob/pr-videos/...`, which works for private repositories too: previews use `?raw=true`, and the PR check rewrites the links to `raw.githubusercontent.com` and downloads them with its token. When a PR is closed without merging, its folder is removed; merged PRs keep theirs as a record of the feature.

Fork and Dependabot PRs get a read-only token, so the workflow skips them.

## Running it by hand

```bash
node scripts/pr-video/pr-video.mjs specs --base origin/main
E2E_KEEP_VIDEOS=1 npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps <specs>
GH_TOKEN=... node scripts/pr-video/pr-video.mjs publish --pr 42 --specs <a,b>
E2E_API_LOG=1 npx playwright test ...                     # record API calls too
node scripts/pr-video/pr-video.mjs api --base origin/main --dry-run   # print the API changes section
node scripts/pr-video/pr-video.mjs cleanup --pr 42
```

`publish` and `cleanup` need push access to the repository and the `gh` CLI.
