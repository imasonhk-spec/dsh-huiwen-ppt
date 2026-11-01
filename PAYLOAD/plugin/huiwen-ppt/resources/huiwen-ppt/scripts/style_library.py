"""Search bundled layouts and illustrations, or verify their files."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'assets' / 'style-library'
LIBRARIES = {'illustrated': ROOT, 'clean': ROOT.parent / 'clean-business'}

def select(catalog, query, kind):
    rows = []
    tokens = query.lower().split()
    for key, label in [('layouts', 'layout'), ('assets', 'asset')]:
        if kind not in ('all', label):
            continue
        for item in catalog[key]:
            search = json.dumps({k: v for k, v in item.items() if k in ('id', 'name', 'tags', 'composition', 'required_fields')}, ensure_ascii=False).lower()
            if all(token in search for token in tokens):
                rows.append({'entry_type': label, **item})
    return rows

def validate(catalog, root=ROOT):
    errors = []
    ids = {a['id'] for a in catalog['assets']}
    if len(ids) != len(catalog['assets']):
        errors.append('Duplicate asset IDs')
    if len({l['id'] for l in catalog['layouts']}) != len(catalog['layouts']):
        errors.append('Duplicate layout IDs')
    for item in catalog['sources'] + catalog['assets']:
        path = (root / item['path']).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            errors.append(f"Missing or invalid path: {item['path']}")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            errors.append(f"Hash mismatch: {item['id']}")
    for layout in catalog['layouts']:
        for aid in layout['asset_ids'] + layout.get('optional_scene_asset_ids', []):
            if aid not in ids:
                errors.append(f"Unknown asset {aid} in {layout['id']}")
        for name in ('reference_preview', 'template_preview'):
            path = (root / layout[name]).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file():
                errors.append(f"Missing or invalid preview: {layout['id']} {name}")
    path = (root / catalog['editable_template']).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        errors.append('Missing or invalid editable template')
    elif catalog.get('template_sha256') and hashlib.sha256(path.read_bytes()).hexdigest() != catalog['template_sha256']:
        errors.append('Template hash mismatch')
    if catalog.get('geometry_sha256'):
        geometry = root / 'icons/primitives.json'
        if not geometry.is_file() or hashlib.sha256(geometry.read_bytes()).hexdigest() != catalog['geometry_sha256']:
            errors.append('Native icon geometry missing or changed')
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'search', 'validate'])
    parser.add_argument('query', nargs='?', default='')
    parser.add_argument('--kind', choices=['all', 'layout', 'asset'], default='all')
    parser.add_argument('--style', choices=['all', *LIBRARIES], default='all', help='Filter a visual family; default searches both')
    args = parser.parse_args()
    output, failed = [], False
    for family, root in LIBRARIES.items():
        if args.style not in ('all', family):
            continue
        catalog = json.loads((root / 'catalog.json').read_text(encoding='utf-8'))
        if args.command == 'validate':
            errors = validate(catalog, root)
            failed |= bool(errors)
            output.append({'style': family, 'ok': not errors, 'sources': len(catalog['sources']), 'layouts': len(catalog['layouts']), 'assets': len(catalog['assets']), 'errors': errors})
        else:
            output.extend({'style': family, 'library_root': str(root), **row} for row in select(catalog, args.query if args.command == 'search' else '', args.kind))
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 1 if failed else 0

if __name__ == '__main__':
    raise SystemExit(main())
