"""Verify this local review slice without dependencies or network."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[2]
manifest = json.loads(Path(__file__).with_name('manifest.json').read_text())
errors = []
for entry in manifest['files']:
    file = root / entry['path']
    if not file.is_file():
        errors.append(entry['path'] + ': missing')
        continue
    data = file.read_bytes()
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        errors.append(entry['path'] + ': mismatch')
if errors:
    raise SystemExit('\n'.join(errors))
print(f"OK: {len(manifest['files'])}/{len(manifest['files'])} files")
