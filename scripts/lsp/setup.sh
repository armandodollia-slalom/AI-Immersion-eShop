#!/usr/bin/env bash
# Makes the language servers available to agents in this checkout (main checkout or git worktree). Idempotent
# and quick when everything is in place; scripts/setup.sh calls it, and worktree setup can call it directly.
#
# Usage: scripts/lsp/setup.sh [--check]
#   --check  also start this checkout's lspd daemon and run the smoke test (scripts/lsp/check.mjs)
#
# Installs nothing globally: Node servers and the MCP bridge are npm devDependencies (package.json), the C#
# server is a .NET local tool (.config/dotnet-tools.json) cached in ~/.nuget/packages and shared by all checkouts.
set -euo pipefail

CHECK=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"

# Node: this checkout's node_modules, or the main checkout's (a fresh worktree falls back to it at runtime).
if [ ! -f node_modules/lsp-mcp-server/package.json ] && [ ! -f "$main/node_modules/lsp-mcp-server/package.json" ]; then
  echo "lsp: installing npm devDependencies"
  npm ci --no-audit --no-fund
fi

# C#: Roslyn language server pinned in the local tool manifest.
dotnet tool restore >/dev/null
echo "lsp: roslyn-language-server $(dotnet tool list --local | awk '$1=="roslyn-language-server"{print $2}') ready"

if [ "$CHECK" = 1 ]; then
  node scripts/lsp/lspd.mjs start
  node scripts/lsp/check.mjs
fi
