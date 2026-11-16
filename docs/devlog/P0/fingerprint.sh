#!/usr/bin/env bash
# Regenerates the three "behaviour unchanged" fingerprints into a directory.
# Usage: bash docs/devlog/P0/fingerprint.sh [outdir]      (default: docs/devlog/P0)
# Compare a refactor against the baseline with:
#   d=$(mktemp -d); bash docs/devlog/P0/fingerprint.sh "$d"; diff -r docs/devlog/P0 "$d" | grep -v '^Only in docs/devlog/P0'
# Run from the repository root. Needs `pnpm -C web install` (for typescript) and Go.
set -euo pipefail
out="${1:-docs/devlog/P0}"
mkdir -p "$out"

# 1. contract samples: SHA-256 of every file, sorted by path.
(cd httpapi/testdata/contract && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$out/contract-sha256.txt"

# 2. Go public API: go doc -all per package.
for pkg in tangent domain store httpapi; do
  if [ "$pkg" = tangent ]; then path="github.com/Rynvex/tangent"; else path="github.com/Rynvex/tangent/$pkg"; fi
  go doc -all "$path" > "$out/go-api-$pkg.txt"
done

# 3. web package exports (TypeScript compiler API; name<TAB>value|type, sorted).
node docs/devlog/P0/exports.mjs web/packages/client/src/index.ts web/packages/client/tsconfig.json > "$out/web-exports-client.txt"
node docs/devlog/P0/exports.mjs web/packages/react/src/index.ts web/packages/react/tsconfig.json > "$out/web-exports-react.txt"
echo "fingerprints written to $out"
