#!/usr/bin/env bash
# Runs Python tests with coverage and appends a snapshot to coverage-history.json
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
HISTORY_FILE="${REPO_DIR}/coverage-history.json"

cd "$SCRIPT_DIR"

# Install coverage if needed
pip install -q coverage 2>/dev/null || pip install -q --user coverage 2>/dev/null

# Run tests with coverage
python -m coverage run --source=. -m unittest discover -s . -p 'test_*.py' 2>/dev/null || true

# Generate JSON report
python -m coverage json -o /tmp/aa-py-coverage.json --quiet 2>/dev/null

# Extract totals
SNAPSHOT=$(python3 -c "
import json, datetime
with open('/tmp/aa-py-coverage.json') as f:
    data = json.load(f)
totals = data['totals']
snapshot = {
    'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
    'repo': 'openclaw-agent-archive',
    'statements': {
        'pct': round(totals['percent_covered'], 2),
        'covered': totals['covered_lines'],
        'total': totals['num_statements'],
    },
    'branches': {
        'pct': round(totals.get('percent_covered_branches', 0), 2) if 'percent_covered_branches' in totals else 0,
        'covered': totals.get('covered_branches', 0),
        'total': totals.get('num_branches', 0),
    },
    'functions': {'pct': 0, 'covered': 0, 'total': 0},
    'lines': {
        'pct': round(totals['percent_covered'], 2),
        'covered': totals['covered_lines'],
        'total': totals['num_statements'],
    },
}
print(json.dumps(snapshot))
")

# Append to history file
if [ -f "$HISTORY_FILE" ]; then
  python3 -c "
import json
with open('${HISTORY_FILE}') as f:
    history = json.load(f)
history.append(json.loads('${SNAPSHOT}'))
with open('${HISTORY_FILE}', 'w') as f:
    json.dump(history, f, indent=2)
    f.write('\n')
"
else
  python3 -c "
import json
with open('${HISTORY_FILE}', 'w') as f:
    json.dump([json.loads('${SNAPSHOT}')], f, indent=2)
    f.write('\n')
"
fi

# Cleanup
rm -f /tmp/aa-py-coverage.json
python -m coverage erase 2>/dev/null || true

echo ""
echo "Coverage snapshot saved to coverage-history.json"
python3 -c "
import json
s = json.loads('${SNAPSHOT}')
print(f\"  Statements: {s['statements']['pct']}% ({s['statements']['covered']}/{s['statements']['total']})\")
print(f\"  Lines:      {s['lines']['pct']}% ({s['lines']['covered']}/{s['lines']['total']})\")
"
