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
| `gh`, signed in | `implement run --pr`, `pr-check run --pr N` | or set `GITHUB_TOKEN` / `GH_TOKEN` for the PR check |
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
