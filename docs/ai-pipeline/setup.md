# Setting up the pipeline

Part of the [AI development pipeline](README.md). What a Windows or macOS machine needs to run the pipeline, locally or on a CI runner. For Copilot itself (CLI, T3 Code, graphify), see [copilot-setup.md](../copilot-setup.md).

## Prerequisites

| Tool | Needed for | Notes |
| --- | --- | --- |
| Git | worktrees, branches, git hooks | on Windows, Git for Windows also provides Git Bash, which the shell scripts and git hooks need |
| Node.js 20 or later | every stage (`scripts/*/*.mjs`, no npm dependencies) and the hooks | the git hooks skip silently when `node` is missing |
| An agent CLI, signed in | every agent the pipeline starts | Claude Code (`claude`, default), GitHub Copilot CLI (`copilot`) or OpenAI Codex (`codex`) |
| Python 3 with `pyyaml` and `jsonschema` | the Architecture Policy Pack step of the review | the review calls `python`, then `python3`. Without Python, the policy step is skipped with a note and the LLM review still runs |
| graphify | agents' code lookups | see [copilot-setup.md](../copilot-setup.md#3-enable-graphify-for-copilot) |
| .NET SDK (version in `global.json`), Aspire CLI, Docker Desktop | building the code and the QE teststack | |
| npm dependencies (Playwright) | e2e tests, video keyframes, PR check frame extraction | `npm ci`, then `npx playwright install chromium` |
| `gh`, signed in | `implement run --pr`, `pr-check run --pr N` | or set `GITHUB_TOKEN` / `GH_TOKEN` for the PR check. The pipeline's PRs are opened by your [PR bot](#the-pipelines-pr-bot) once it is set up |
| `ffmpeg` | optional, faster video frame extraction in the PR check | falls back to Playwright's Chromium |

## macOS

1. Install the tools with [Homebrew](https://brew.sh):

   ```bash
   brew install git node python gh ffmpeg
   brew install --cask docker
   ```

   Start Docker Desktop once so the daemon is running.
2. Run the one-shot setup. It installs the .NET SDK (to `~/.dotnet`) and the Aspire CLI if missing, runs `npm ci`, installs graphify and builds the graph, sets `git config core.hooksPath .githooks` (which turns on the pipeline's git hooks) and builds the solution:

   ```bash
   scripts/setup.sh --no-run
   ```

3. Install the policy pack's Python packages and Playwright's browser:

   ```bash
   python3 -m pip install --user -r architecture-policy/requirements.txt
   npx playwright install chromium
   ```

   If Homebrew's Python refuses (`externally-managed-environment`), install them into a virtual environment or with `--break-system-packages`.
4. Install and sign in to the agent CLI the pipeline will drive (for example `brew install --cask copilot-cli`, then `copilot` and `/login`), and choose it for this shell or in your `~/.zshrc`:

   ```bash
   export PIPELINE_AGENT_CLI=copilot   # or claude (default), codex
   ```

## Windows

`scripts/setup.sh` targets macOS and Linux, so on Windows install the tools yourself, then run the same setup steps.

1. Install the tools with WinGet from PowerShell:

   ```powershell
   winget install Git.Git OpenJS.NodeJS.LTS Python.Python.3.13 GitHub.cli Gyan.FFmpeg Docker.DockerDesktop Microsoft.DotNet.SDK.10
   irm https://aspire.dev/install.ps1 | iex
   ```

   Open a new terminal afterwards so `PATH` picks them up, and start Docker Desktop once.
2. Install graphify by following [copilot-setup.md](../copilot-setup.md#windows-1) (it also adds Python's `Scripts` folder to `PATH`).
3. Run the setup steps from PowerShell in the repository root:

   ```powershell
   npm ci
   npx playwright install chromium
   python -m pip install --user -r architecture-policy/requirements.txt
   git config core.hooksPath .githooks
   bash scripts/graphify-build.sh
   dotnet build eShop.Web.slnf
   ```

   `bash` is Git Bash's; if PowerShell can't find it, run that line from a Git Bash window instead.
4. Install and sign in to the agent CLI the pipeline will drive (for example `winget install GitHub.Copilot`, then `copilot` and `/login`), and choose it for this session or for your user:

   ```powershell
   $env:PIPELINE_AGENT_CLI = 'copilot'                                      # this session
   [Environment]::SetEnvironmentVariable('PIPELINE_AGENT_CLI', 'copilot', 'User')  # every new session
   ```

Windows notes:

- Git runs the hooks in `.githooks/` with Git Bash, so they work from PowerShell and from agent tools without extra setup.
- Prefer a native install of the agent CLI (WinGet or the vendor installer) that puts an `.exe` on `PATH`. Some pipeline calls start the CLI directly, without a shell, and cannot run an npm `.cmd` shim.
- `PIPELINE_AGENT_CMD` runs its command with `sh -c`, so Git's `usr\bin` folder (for example `C:\Program Files\Git\usr\bin`) must be on `PATH` to use it.
- Paths in these docs use forward slashes; PowerShell accepts them as written.

## Both platforms

1. Trust the repository's hooks in your interactive agent tool, so `pipeline done` triggers the stages. See [Agent tool coverage](README.md#agent-tool-coverage) for each tool's trust step (for Copilot CLI: add the repo to `trustedFolders` in `~/.copilot/config.json`, which is `%USERPROFILE%\.copilot\config.json` on Windows).
2. Instead of an environment variable, you can set `agent.cli` in `scripts/pipeline/config.json`. `PIPELINE_AGENT_CMD` runs any other command, with the prompt on stdin.
3. Check the pipeline itself, without any LLM calls (the same commands in Terminal or PowerShell):

   ```bash
   npm run test:pipeline
   node scripts/pipeline/pipeline.mjs stages
   node scripts/pipeline/pipeline.mjs implement run --epic promotions-and-recommendations --dry-run
   ```

## The pipeline's PR bot

GitHub never lets a PR's author approve it. So the pipeline does not open its PRs with your `gh` login: it pushes their branches and opens them as **`dev-bot-<your gh login>`** (here `dev-bot-armandodollia-slalom`), a GitHub App each developer creates once. You then approve the pipeline's PRs with GitHub's normal review flow, like your teammates, and `review-quorum` counts your approval. Only the PR's author changes: commits keep their authors, and every other `gh` call (board, labels, reviews, review requests) stays yours. The code is `scripts/pipeline/lib/bot.mjs`.

It covers every PR the pipeline opens: single-ticket PRs (`implement run --pr`), bug-epic group PRs and epic PRs, the push of a reopened bug fix onto its open group PR, and the lessons PR. With `implement.autoMerge.identity: "bot"` the [review gate](review-gate.md#auto-merge) also merges with it.

### One-time setup (per developer)

```bash
node scripts/pipeline/pipeline.mjs bot setup
```

It needs your `gh` login and two clicks in the browser; GitHub does not let a script do either:

1. **Create.** The command starts a local page on `127.0.0.1` that sends GitHub the App's manifest: the name `dev-bot-<login>`, private, no webhook, the permissions Contents, Pull requests and Issues (read and write) and Metadata (read), no events. Click **Create GitHub App**. GitHub sends you back to the local page, which saves the App's credentials.
2. **Install.** The command then opens the App's install page: choose **Only select repositories**, pick this repository and click **Install**. The command waits (up to 10 minutes) until the installation works, mints a test token and says so.

Then check it at any time (exit code 0 when it is configured, installed and can mint a token, 1 otherwise):

```bash
node scripts/pipeline/pipeline.mjs bot status
```

Until the bot is set up, every PR the pipeline opens logs a warning naming `pipeline bot setup` and uses your own `gh` login, as before. The same happens, with a warning, when the bot cannot get a token (for example it is not installed on the repository).

Notes:

- **Name.** `bot.namePattern` (`dev-bot-{login}`), lowercased. GitHub App names are global and at most 34 characters: a longer name keeps its first 27 characters (without a trailing hyphen) and ends with `-` and 6 characters of a hash of the full name. If GitHub says the name is taken, change it on the Create page; the pipeline uses the App it gets back.
- **Owner.** A private App can be installed only on the account that owns it. When the repository belongs to an organization or another user, run `bot setup --org <org>` (an organization admin creates the App there) or `bot setup --public` (anyone may install it; it still acts only where it is installed).
- `bot setup --force` creates a new App even when credentials exist.

### Where the credentials live

Outside the repository, in `bot.credentialsDir` (`~/.config/eshop-pipeline`; `%USERPROFILE%\.config\eshop-pipeline` on Windows): `dev-bot-<login>.json` (`appId`, `slug`, `owner`, `privateKeyFile`) and the App's private key `dev-bot-<login>.private-key.pem`, both readable only by you (0600). Nothing else is kept: the App's client secret is not saved. The pipeline signs a short-lived JWT with the key, asks GitHub for an installation token limited to this repository (valid for an hour, kept in memory and renewed 5 minutes before it expires), and gives it to `gh` as `GH_TOKEN` and to `git push` as an HTTP header from the environment, so the token never appears on a command line, in a URL, in a log or in an error.

### Settings

| Setting | Effect |
| --- | --- |
| `bot.enabled` in `scripts/pipeline/config.json` (default `true`), or `PIPELINE_BOT=0` | off: the pipeline's PRs are opened with your `gh` login, without a warning |
| `bot.namePattern` (`dev-bot-{login}`) | the App's name |
| `bot.credentialsDir` (`~/.config/eshop-pipeline`), or `PIPELINE_BOT_CREDENTIALS_DIR` | where the credentials are read and written |
| `PIPELINE_BOT_APP_ID` with `PIPELINE_BOT_PRIVATE_KEY` (the PEM text; `\n` escapes are accepted) or `PIPELINE_BOT_PRIVATE_KEY_FILE` | CI or a scheduled runner: the App's id and key from the environment instead of the credentials file (store the key as a secret) |
| `PIPELINE_BOT_LOGIN` | the login used for the name instead of asking `gh` |

### Rotate or revoke

- **Rotate the key:** on GitHub, Settings → Developer settings → GitHub Apps → `dev-bot-<login>` → Private keys → **Generate a private key**. Replace the `.pem` file in the credentials folder with the downloaded one (keep its name, `chmod 600` it), then delete the old key on the same page. `bot status` confirms it.
- **Stop using it on one machine:** delete the two files; the pipeline falls back to your `gh` login (with the warning), or set `PIPELINE_BOT=0`.
- **Revoke:** uninstall the App from the repository (Settings → Integrations → GitHub Apps, or the App's Install page), or delete the App (its settings → Advanced → **Delete GitHub App**), which revokes its keys and tokens at once. PRs it already opened keep it as their author.

## Optional settings

| Setting | Effect |
| --- | --- |
| `git config qe.autoPlan true` | write test plans in the background for stories added or changed by a commit or merge |
| `git config qe.autoLessons true` | run lessons after merges |
| `PIPELINE_BASE_REF` | base branch for diffs and new stories (default `origin/main`) |
| `PIPELINE_DISABLE=1` | turn off every hook, including the story guard |
| `QE_SKIP=1`, `PR_CHECK_SKIP=1` | skip one stage's gate |

Setting a variable for one command:

| macOS (zsh, bash) | Windows (PowerShell) |
| --- | --- |
| `QE_SKIP=1 git push` | `$env:QE_SKIP = '1'; git push; Remove-Item Env:QE_SKIP` |
| `export PIPELINE_DISABLE=1` (rest of the session) | `$env:PIPELINE_DISABLE = '1'` (rest of the session) |

Per-stage limits, timeouts and models are in each stage's `scripts/<stage>/config.json`; see the stage pages and the [agent catalog](agents.md).

## Review gate for bug-fix PRs

The [review gate](review-gate.md) needs nothing extra to assess PRs and request reviews (the pipeline machine's `gh` login with the `project` scope; run `board setup` once to create its board fields). Repository settings it relies on are the owner's call, and the gate never changes them:

| Setting | Where | Why |
| --- | --- | --- |
| `review-quorum` as a required status check on `main` | Settings → Rules → Rulesets → `main` → Require status checks to pass | enforces each PR's `approvals:N`; until then it is a visible check only |
| Allow auto-merge | Settings → General → Pull Requests | `gh pr merge --auto` waits for GitHub's own requirements instead of failing |
| A GitHub App with a ruleset bypass, its token in `REVIEW_GATE_APP_TOKEN`, and `implement.autoMerge.identity: "app"` (or the [PR bot](#the-pipelines-pr-bot) on the bypass list and `identity: "bot"`) | the App's settings; the ruleset's bypass list | only once `main` requires approvals from people: a Low PR that needs none can then merge only through a bypass |

Auto-merge is on (`implement.autoMerge.enabled` in `scripts/implement/config.json`); set it to `false` to stop it.

## CI

`.github/workflows/ai-pipeline.yml` runs on pull requests without any LLM calls. Two workflows call agents: `pr-check.yml` (the `ai-pr-check` label) and `qe-lessons.yml` (weekly). Both use `.github/actions/setup-agent-cli`, so they work with any provider. Pick it with repository variables (**Settings → Secrets and variables → Actions → Variables**) and add its credential as a secret:

| Provider | Variable | Secret |
| --- | --- | --- |
| Claude Code (default) | none, or `PIPELINE_AGENT_CLI` = `claude` | `ANTHROPIC_API_KEY` |
| GitHub Copilot CLI | `PIPELINE_AGENT_CLI` = `copilot` | none: the workflow's `GITHUB_TOKEN` is used (the workflows grant `copilot-requests: write`; your organization must allow Copilot CLI). Or set `COPILOT_GITHUB_TOKEN` to a fine-grained token with the Copilot Requests permission |
| OpenAI Codex | `PIPELINE_AGENT_CLI` = `codex` | `OPENAI_API_KEY` |
| Any other CLI | `PIPELINE_AGENT_CMD` = the command, which reads the prompt on stdin; optionally `PIPELINE_AGENT_INSTALL` = a shell command that installs it | `PIPELINE_AGENT_API_KEY`, available to the command as `$PIPELINE_AGENT_API_KEY` |

When the chosen provider's secret is missing, the workflow logs a notice and skips instead of failing. Per-role PR check models are set in `scripts/pr-check/config.json` for `claude` and `copilot`; other providers use their CLI's default model unless you add a `prCheck.models.<cli>` entry.

To run `implement run` from a scheduled job, the runner needs everything above, including a signed-in agent CLI.
