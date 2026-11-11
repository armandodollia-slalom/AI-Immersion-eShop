#!/usr/bin/env bash
# Starts one language server over stdio for the checkout this script lives in. lsp-mcp-server, inside the
# checkout's lspd daemon, runs it; stdout is the LSP channel, so everything else goes to stderr.
#
# Usage: scripts/lsp/server.sh <csharp|typescript|bash|json|yaml|css|html>
#
# Binaries come from this checkout's node_modules and .NET local tool manifest. A git worktree without
# node_modules falls back to the main checkout's, so new worktrees need no setup.
set -euo pipefail

name="${1:?usage: server.sh <language>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
main="$(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/.." 2>/dev/null && pwd || echo "$root")"

node_bin() {
  local r
  for r in "$root" "$main"; do
    if [ -x "$r/node_modules/.bin/$1" ]; then echo "$r/node_modules/.bin/$1"; return; fi
  done
  echo "lsp: $1 is not installed; run scripts/lsp/setup.sh" >&2
  exit 127
}

case "$name" in
  csharp)
    # Roslyn (the server behind the VS Code C# extension), pinned in .config/dotnet-tools.json.
    # Restoring is a no-op once the package is in the NuGet cache, which every checkout shares.
    dotnet tool restore >&2 || { echo "lsp: dotnet tool restore failed" >&2; exit 1; }
    export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
    # roslyn-proxy.mjs opens $ESHOP_LSP_SOLUTION (set by lspd: eShop.slnx or a story's .slnf) and reports load state.
    export ESHOP_LSP_SOLUTION="${ESHOP_LSP_SOLUTION:-$root/eShop.slnx}"
    exec node "$root/scripts/lsp/roslyn-proxy.mjs" dotnet tool run roslyn-language-server \
      --stdio --telemetryLevel off --logLevel Warning
    ;;
  typescript) exec "$(node_bin typescript-language-server)" --stdio ;;
  bash) exec "$(node_bin bash-language-server)" start ;;
  json) exec "$(node_bin vscode-json-language-server)" --stdio ;;
  css) exec "$(node_bin vscode-css-language-server)" --stdio ;;
  html) exec "$(node_bin vscode-html-language-server)" --stdio ;;
  yaml) exec "$(node_bin yaml-language-server)" --stdio ;;
  *) echo "lsp: unknown language server '$name'" >&2; exit 2 ;;
esac
