"""Fetch current US mortgage rate averages (Freddie Mac PMMS via FRED) into rates.json."""
import csv, io, json, os, subprocess
from datetime import datetime, timezone

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US,MORTGAGE15US"
raw = subprocess.run(["curl", "-sSfL", "--retry", "4", "--max-time", "90", URL], check=True, capture_output=True, text=True).stdout
rows = list(csv.reader(io.StringIO(raw)))
data = [r for r in rows[1:] if len(r) == 3 and r[1] not in ("", ".") and r[2] not in ("", ".")]
if not data:
    raise SystemExit("No rate data returned")
history = [{"date": d, "rate30": float(a), "rate15": float(b)} for d, a, b in data[-52:]]
latest = history[-1]
out = {
    "source": "Freddie Mac Primary Mortgage Market Survey (via FRED)",
    "asOf": latest["date"],
    "rate30": latest["rate30"],
    "rate15": latest["rate15"],
    "checked": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "history": history,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rates.json")
with open(path, "w", encoding="utf-8") as fp:
    json.dump(out, fp, indent=1)
print(f"30yr {latest['rate30']}%  15yr {latest['rate15']}%  as of {latest['date']}")
