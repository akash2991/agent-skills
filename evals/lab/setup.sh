#!/bin/bash
# Build the brain-installed fixtures beside the plain ones and a pytest venv for the runner.
set -e
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
python3 -m venv venv && ./venv/bin/pip -q install pytest
for f in fixture fixture2; do
  rm -rf "$f-brain" && cp -R "$f" "$f-brain"
  node "$ROOT/scripts/agent-brain.js" pull --target "$PWD/$f-brain" > /dev/null
  printf '@AGENTS.md\n' > "$f-brain/CLAUDE.md"
  python3 - "$f-brain/AGENTS.md" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
add="\n- Tests: `python -m pytest -q` from the repository root. Services live under `contentos/services/`; the contract is `contracts/kreate.openapi.yaml` and the web decodes it in `web/src/jobs.ts`. Linear and GitHub are not reachable in this lab: skip ticket and PR steps and say what you would have done.\n"
assert s.count('## This project')==1
open(p,'w').write(s.rstrip('\n')+add)
PY
done
echo "fixtures ready: fixture-brain fixture2-brain"
