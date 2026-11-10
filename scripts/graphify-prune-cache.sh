#!/usr/bin/env bash
# Prune the shared graphify semantic cache (graphify-out/cache/semantic/).
#
# Usage: scripts/graphify-prune-cache.sh [--dry-run] [--grace-days N] [--no-fetch]
#
# Cache entries are keyed by graphify's hash of a doc's path and content, so every
# doc edit leaves the old entry behind. Builds keep those entries on purpose: a
# branch that still has the old doc reuses them instead of re-running LLM extraction.
# This script deletes a tracked entry only when
#   * no doc on any remote branch or open pull request hashes to it, and
#   * it was committed more than --grace-days ago (default 14), which protects
#     local branches that have not been pushed yet.
# Run weekly by .github/workflows/graphify-cache-prune.yml, which opens a PR. To commit a
# local prune, set GRAPHIFY_ALLOW_CACHE_PRUNE=1 (the pre-commit hook drops cache deletions).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

dry_run=0
grace_days=14
fetch=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --grace-days) grace_days="$2"; shift ;;
    --no-fetch) fetch=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v graphify >/dev/null 2>&1 || { echo "graphify not installed (see scripts/setup.sh)" >&2; exit 1; }
GRAPHIFY_VERSION="$(sed -n 's/^GRAPHIFY_VERSION="\([^"]*\)".*/\1/p' scripts/graphify-build.sh)"
installed="$(graphify --version 2>/dev/null | awk '{print $NF}')"
if [ "$installed" != "$GRAPHIFY_VERSION" ]; then
  echo "[graphify] refusing to prune: graphify $installed installed, repo pins $GRAPHIFY_VERSION (cache keys could differ)." >&2
  exit 1
fi
# graphify's own interpreter, so cache keys are computed by the pinned graphify code.
python="$(head -1 "$(command -v graphify)" | sed 's/^#![[:space:]]*//')"
case "$python" in
  */env\ *) python="${python#*/env }" ;;
esac

if [ "$fetch" = 1 ]; then
  git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*'
  if command -v gh >/dev/null 2>&1 && prs="$(gh pr list --state open --limit 200 --json number --jq '.[].number' 2>/dev/null)"; then
    for n in $prs; do
      git fetch -q origin "+refs/pull/$n/head:refs/graphify-prune/pr-$n" || true
    done
  else
    echo "[graphify] gh unavailable: open pull requests from forks are not considered." >&2
  fi
fi

refs="$(git for-each-ref --format='%(refname)' refs/remotes/origin refs/graphify-prune | grep -v '/HEAD$' || true)"
[ -n "$refs" ] || { echo "[graphify] no remote refs found; refusing to prune." >&2; exit 1; }

DRY_RUN="$dry_run" GRACE_DAYS="$grace_days" REFS="$refs" "$python" - <<'PY'
import os, subprocess, sys, tempfile, time
from pathlib import Path

from graphify.cache import file_hash
from graphify.detect import FileType, classify_file

SEMANTIC_TYPES = {FileType.DOCUMENT, FileType.PAPER, FileType.IMAGE}
git = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True).stdout


def semantic(path: str) -> bool:
    try:
        return classify_file(Path(path)) in SEMANTIC_TYPES
    except Exception:
        return True  # unknown: keep its entry rather than risk deleting it


# Every (path, blob) a doc has on any ref. Hashing them with graphify gives the live keys.
blobs: dict[tuple[str, str], None] = {}
refs = os.environ["REFS"].split()
for ref in refs:
    for line in git("ls-tree", "-r", "-z", ref).split(b"\0"):
        if not line:
            continue
        meta, path = line.split(b"\t", 1)
        mode, kind, sha = meta.split()
        path = path.decode()
        if kind == b"blob" and not mode.startswith(b"12") and not path.startswith("graphify-out/") and semantic(path):
            blobs[(path, sha.decode())] = None

live: set[str] = set()
with tempfile.TemporaryDirectory() as tmp:
    root, cache = Path(tmp) / "tree", Path(tmp) / "cache"
    cat = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for path, sha in blobs:
        cat.stdin.write(sha.encode() + b"\n")
        cat.stdin.flush()
        size = int(cat.stdout.readline().split()[2])
        data = cat.stdout.read(size)
        cat.stdout.read(1)
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        try:
            live.add(file_hash(target, root, cache_root=cache))
        except OSError:
            pass
        target.unlink()
    cat.stdin.close()
    cat.wait()

added: dict[str, int] = {}
stamp = 0
for line in git("log", "--diff-filter=A", "--format=%x00%ct", "--name-only", "--",
                "graphify-out/cache/semantic", "graphify-out/cache/semantic-deep").decode().splitlines():
    if line.startswith("\0"):
        stamp = int(line[1:])
    elif line.strip():
        added.setdefault(line.strip(), stamp)  # log is newest first: keep the latest add

cutoff = time.time() - int(os.environ["GRACE_DAYS"]) * 86400
tracked = git("ls-files", "-z", "--", "graphify-out/cache/semantic", "graphify-out/cache/semantic-deep").decode().split("\0")
entries = [f for f in tracked if f.endswith(".json")]
orphans = [f for f in entries if Path(f).stem not in live]
prune = sorted(f for f in orphans if added.get(f, time.time()) < cutoff)

print(f"[graphify] {len(refs)} refs, {len(blobs)} doc versions, {len(entries)} cache entries: "
      f"{len(entries) - len(orphans)} live, {len(orphans) - len(prune)} unused but within the grace period, "
      f"{len(prune)} to prune.")
for f in prune:
    print(f"  prune {f}")
    if os.environ["DRY_RUN"] != "1":
        Path(f).unlink(missing_ok=True)
PY
