#!/usr/bin/env python3
"""Edit each native object kind in a disposable PPTX and verify LO roundtrip."""
import json
import sys
import tempfile
import subprocess
from pathlib import Path
import studio as s


def main(source):
    source = Path(source).resolve()
    parts, metadata = s.load_package(source)
    slide_parts, size = s.slide_parts(parts)
    if not slide_parts or not size.get('width') or not size.get('height'):
        raise ValueError('Invalid presentation dimensions or no slides')
    samples = {}
    types = {key: {'present': False, 'tested': 'not_run', 'not_supported': []}
             for key in ('text', 'shape', 'table', 'chart', 'connector')}
    unsupported = []
    for slide_index, part in enumerate(slide_parts):
        doc = s.parse(parts[part])
        changed = False
        for node, grouped in s.shape_nodes(doc):
            kind = ('table' if s.first(node, 'a', 'tbl') else 'chart' if node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart') else node.localName)
            pos = s.geometry(s.inherited_transform(parts, part, node))
            category = {'sp': 'shape', 'table': 'table', 'chart': 'chart', 'cxnSp': 'connector'}.get(kind)
            if category:
                types[category]['present'] = True
                if grouped:
                    types[category]['not_supported'].append({'page': slide_index + 1, 'reason': 'grouped_object'})
            else:
                unsupported.append({'page': slide_index + 1, 'kind': kind, 'reason': 'not_a_supported_native_edit_type'})
            body = s.first(node, 'p', 'txBody') if kind == 'sp' else None
            if body is not None:
                types['text']['present'] = True
                if grouped:
                    types['text']['not_supported'].append({'page': slide_index + 1, 'reason': 'grouped_text'})
            if body is not None and not grouped and 'text' not in samples:
                t = s.first(node, 'a', 't')
                if t is not None:
                    t.appendChild(doc.createTextNode(' DELIVERYPROBE'))
                else:
                    s.set_text(body, 'DELIVERYPROBE')
                samples['text'] = {'page': slide_index + 1, 'marker': 'DELIVERYPROBE'}
                changed = True
            if kind == 'table' and not grouped and 'table' not in samples:
                cell = next((c for c in s.nodes(node, 'a', 'tc') if c.getAttribute('hMerge') not in ('1', 'true')
                             and c.getAttribute('vMerge') not in ('1', 'true') and s.first(c, 'a', 'txBody') is not None), None)
                if cell is not None:
                    s.set_text(s.first(cell, 'a', 'txBody'), 'TABLEPROBE')
                    samples['table'] = {'page': slide_index + 1, 'marker': 'TABLEPROBE'}
                    changed = True
            key = {'sp': 'shape', 'chart': 'chart', 'cxnSp': 'connector'}.get(kind)
            if key == 'connector' and not grouped and key not in samples:
                sppr = s.first(node, 'p', 'spPr')
                if sppr is not None:
                    line = s.first(sppr, 'a', 'ln')
                    if line is None:
                        line = doc.createElementNS(s.NS['a'], 'a:ln')
                        sppr.appendChild(line)
                    line.setAttribute('w', '91440')
                    samples[key] = {'page': slide_index + 1, 'kind': kind, 'line_width': 91440}
                    changed = True
                continue
            if key and key not in samples and pos and not grouped:
                transform = s.inherited_transform(parts, part, node)
                off = s.first(transform, 'a', 'off') if transform else None
                if off is not None:
                    delta = 190500 if pos['x'] + pos['width'] + 20 < size['width'] else -190500
                    off.setAttribute('x', str(int(off.getAttribute('x')) + delta))
                    samples[key] = {'page': slide_index + 1, 'kind': kind, 'x': pos['x'] + delta / s.EMU,
                                    'y': pos['y'], 'width': pos['width'], 'height': pos['height']}
                    changed = True
        if changed:
            parts[part] = s.xml_bytes(doc)
    if not samples:
        return {'mode': 'OOXML_edit_LibreOffice_roundtrip', 'source_sha256': s.digest(source),
                'types': types, 'not_supported': unsupported, 'samples': {}, 'status': 'failed',
                'error': 'No supported native object could be edited'}
    with tempfile.TemporaryDirectory(prefix='huiwen-delivery-') as temp:
        root = Path(temp)
        modified = root / 'edited.pptx'
        s.write_package(modified, parts, metadata)
        before = s.inspect_file(modified)
        profile = root / 'profile'
        output = root / 'roundtrip'
        output.mkdir()
        command = ['soffice', '-env:UserInstallation=' + profile.as_uri(), '--headless', '--convert-to',
                   'pptx', '--outdir', str(output), str(modified)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        reopened = output / 'edited.pptx'
        if result.returncode or not reopened.is_file():
            raise ValueError('LibreOffice roundtrip failed: ' + (result.stderr or result.stdout)[-300:])
        after = s.inspect_file(reopened)
        if len(before['slides']) != len(after['slides']):
            raise ValueError('Roundtrip changed slide count')
        verified = {}
        for kind, sample in samples.items():
            elements = after['slides'][sample['page'] - 1]['elements']
            if kind in ('text', 'table'):
                ok = any(sample['marker'] in (str(e.get('cells')) if kind == 'table' else e['text']) and
                         (e['kind'] == 'table' if kind == 'table' else e['kind'] == 'sp') for e in elements)
            else:
                if kind == 'connector':
                    reopened_parts, _ = s.load_package(reopened)
                    part = s.slide_parts(reopened_parts)[0][sample['page'] - 1]
                    doc = s.parse(reopened_parts[part])
                    ok = any(n.localName == 'cxnSp' and (line := s.first(n, 'a', 'ln')) is not None and
                             abs(int(line.getAttribute('w') or '0') - sample['line_width']) < 10000
                             for n, _ in s.shape_nodes(doc))
                else:
                    # LO may remap object IDs and round coordinates; verify native type and edited position.
                    ok = any(e['kind'] == sample['kind'] and e['position'] and
                             abs(e['position']['x'] - sample['x']) < 4 and
                             abs(e['position']['y'] - sample['y']) < 4 and
                             abs(e['position']['width'] - sample['width']) < 4 for e in elements)
            verified[kind] = 'passed' if ok else 'failed'
        for key, details in types.items():
            details['tested'] = verified.get(key, 'not_run')
        return {'mode': 'OOXML_edit_LibreOffice_roundtrip', 'engine': 'libreoffice',
                'source_sha256': s.digest(source), 'samples': verified, 'types': types,
                'not_supported': unsupported,
                'status': 'passed' if all(not item['present'] or item['tested'] == 'passed' for item in types.values()) else 'failed'}


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error), 'mode': 'OOXML_edit_LibreOffice_roundtrip'}))
        sys.exit(1)
