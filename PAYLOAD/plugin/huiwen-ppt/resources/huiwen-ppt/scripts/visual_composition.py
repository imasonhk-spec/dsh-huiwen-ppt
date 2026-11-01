"""Semantic visual selection, deck-wide composition ledger and actual reuse audit.

Standard-library only. Heuristic geometry catches identical compositions; human
visual review remains required for semantically similar but geometrically different pages.
"""
from pathlib import Path
from collections import Counter
import hashlib
import json
import re
import studio as s


def catalog(root):
    path = Path(root) / 'visual-catalog.json'
    if not path.exists():
        return {}
    data = s.read_json(path)
    if data.get('schema_version') != 1:
        raise ValueError('INVALID_VISUAL_CATALOG')
    return {(x['component_id'], x['component_version']): x for x in data['entries']}


def annotation(c, entries):
    row = entries.get((c['component_id'], c['component_version']))
    if row and any(r.get('active') and r['source_sha256'] == row['source_sha256'] for r in c['source_refs']):
        return row
    return {}


def search(root, query='', scope='trial_candidates', project_id=None, relation=None, excluded_ids=None):
    import component_library as lib
    import component_compose as compose
    rows = lib.search(root, '', scope, project_id, relation, excluded_ids)
    entries = catalog(root)
    terms = query.lower().split()
    result = [];source_cache={}
    for c in rows:
        sem = annotation(c, entries)
        hay = ' '.join([c['name'], c['relation_type'], c['component_id'],
                        sem.get('description', ''), *sem.get('tags', [])]).lower()
        if terms and not all(q in hay for q in terms):
            continue
        # Only inspect metadata for exact source versions; no lifecycle bypass.
        score = (6 if c['granularity'] == 'semantic' else 0) + (5 if sem.get('curated') else 0)
        score += sum(3 for q in terms if q in sem.get('tags', []))
        if sem.get('brand_risk'):
            score -= 8
        enriched={**c}
        if c['granularity']=='semantic' and c['lifecycle']!='retired' and c['quality_status']!='requires_repair':
            contracts=compose.native_slot_shapes(c,root,source_cache)
            if contracts:enriched['slots']=[{**slot,'native_shape':{k:v for k,v in contracts[slot['key']].items() if k!='chart_part'}}
                                              if slot['key'] in contracts else slot for slot in c['slots']]
        result.append({**enriched, 'visual_semantics': sem, 'selection_score': score,
                       'selection_reason': '关系/主体标签匹配；查看实际预览后决定，分数不是审美验收结果。'})
    return sorted(result, key=lambda c: (-c['selection_score'], c['component_id']))


def ledger(plan):
    if not isinstance(plan,dict):
        raise ValueError('INVALID_VISUAL_PLAN')
    policy = plan.get('visual_policy', {})
    strict = policy.get('unique_compositions', True)
    pages = plan.get('slides', plan.get('pages', []))
    if not isinstance(pages,list) or not pages:
        raise ValueError('INVALID_VISUAL_PLAN: nonempty slides required')
    seen = {}; conflicts = []; rows = []
    for i, page in enumerate(pages, 1):
        family = page.get('composition_family') or page.get('composition', {}).get('family')
        row = {'page': i, 'slide_id': page.get('slide_id', str(i)), 'composition_family': family}
        if not isinstance(family,str) or not family.strip():
            conflicts.append({'page': i, 'code': 'COMPOSITION_FAMILY_REQUIRED'})
        elif family in seen:
            conflicts.append({'page': i, 'other_page': seen[family], 'code': 'COMPOSITION_REPEATED', 'family': family})
        else:
            seen[family] = i
        rows.append(row)
    return {'schema_version': 1, 'strict': strict, 'status': 'failed' if strict and conflicts else 'passed',
            'pages': rows, 'conflicts': conflicts,
            'limits': 'Family identity and normalized geometry are complementary checks; visual review is still required.'}


def geometry_signature(boxes, size):
    visible=[]
    for kind,b in boxes:
        if not b or b['y'] < size['height'] * .18 or b['y'] > size['height'] * .89:
            continue
        if b['width'] * b['height'] > size['width'] * size['height'] * .75:
            continue
        if b['width'] >= size['width'] * .055 and b['height'] >= size['height'] * .045:
            visible.append((kind,b))
    boxes=visible
    if not boxes:
        return None
    x = min(b['x'] for _,b in boxes); y = min(b['y'] for _,b in boxes)
    w = max(b['x']+b['width'] for _,b in boxes)-x
    h = max(b['y']+b['height'] for _,b in boxes)-y
    normalized = sorted((kind, round((b['x']-x)/max(w,1)*40), round((b['y']-y)/max(h,1)*40),
                         round(b['width']/max(w,1)*40), round(b['height']/max(h,1)*40)) for kind,b in boxes)
    return hashlib.sha256(json.dumps(normalized).encode()).hexdigest()


def page_geometry(parts, part, size):
    import component_library as lib
    doc = s.parse(parts[part]); boxes=[]
    for node in lib.top_shapes(doc):
        prop=s.first(node,'p','cNvPr')
        if prop and prop.getAttribute('hidden') in ('1','true'):
            continue
        boxes.append((node.localName,lib.bounds([node],parts,part)))
    return geometry_signature(boxes,size)


def _visible(node, nodes, parts, part, size):
    import component_library as lib
    prop = s.first(node, 'p', 'cNvPr')
    if prop and prop.getAttribute('hidden') in ('1','true'):
        return False
    b = lib.bounds([node], parts, part)
    if not b or b['y']+b['height'] < size['height']*.19 or b['y'] > size['height']*.9:
        return False
    if b['width']*b['height'] > size['width']*size['height']*.75:
        return False
    if b['x']+b['width'] <= 0 or b['y']+b['height'] <= 0 or b['x'] >= size['width'] or b['y'] >= size['height']:
        return False
    # Full-cover rasterization cannot be counted as visible native reuse.
    for later in nodes[nodes.index(node)+1:]:
        if later.localName != 'pic':
            continue
        cover = lib.bounds([later], parts, part)
        if cover and cover['width']*cover['height'] > size['width']*size['height']*.75:
            if cover['x'] <= b['x'] and cover['y'] <= b['y'] and cover['x']+cover['width'] >= b['x']+b['width'] and cover['y']+cover['height'] >= b['y']+b['height']:
                return False
    return True


def audit(source, plan, state=None, reuse=None):
    import component_library as lib
    source = Path(source); digest = s.digest(source)
    plan = s.read_json(plan) if isinstance(plan, (str,Path)) else plan
    state = s.read_json(state) if isinstance(state, (str,Path)) else state
    reuse = s.read_json(reuse) if isinstance(reuse, (str,Path)) else reuse
    parts,_ = s.load_package(source); slides,size = s.slide_parts(parts)
    errors=[]; warnings=[]; evidence=[]; geometry={}
    comp = ledger(plan)
    errors.extend(comp['conflicts'] if comp['strict'] else [])
    if len(comp['pages']) != len(slides):
        errors.append({'code':'PLAN_SLIDE_COUNT_MISMATCH'})
    if state and state.get('sha256') != digest:
        errors.append({'code':'REUSE_STATE_HASH_MISMATCH'})
    if reuse and reuse.get('output_sha256') != digest:
        errors.append({'code':'REUSE_REPORT_HASH_MISMATCH'})
    if not state and not reuse:
        errors.append({'code':'ACTUAL_REUSE_EVIDENCE_REQUIRED'})
    source_cache={}
    for page,part in enumerate(slides,1):
        doc=s.parse(parts[part]); nodes=lib.top_shapes(doc); byid={s.shape_id(n):n for n in nodes}
        output_ids={n.getAttribute('id') for n in s.nodes(doc,'p','cNvPr')}
        fp=page_geometry(parts,part,size)
        if fp and fp in geometry and comp['strict']:
            errors.append({'code':'GEOMETRY_COMPOSITION_REPEATED','page':page,'other_page':geometry[fp]})
        elif fp:
            geometry[fp]=page
        imported=set(); verified_sources=[]
        batches=[]
        if reuse:
            batches += [r for r in reuse.get('imports',[]) if r.get('sample_page',r.get('page'))==page]
        if state and page <= len(state.get('slides',[])):
            for inst in state['slides'][page-1].get('instances',[]):
                if inst.get('layer')=='background':
                    continue
                for mapping in inst.get('maps',[]):
                    mapped_keys=set(mapping.get('id_map',{}))
                    root=Path(plan.get('component_library',Path(__file__).resolve().parent.parent/'assets/components'))
                    # Current builds record the exact source; legacy group maps also
                    # include child IDs, so resolve against the source XML tree.
                    refs=[inst['actual_source_ref']] if inst.get('actual_source_ref') else [r for r in inst.get('source_refs',[]) if r.get('active')]
                    matched=False
                    for ref in refs:
                        try:
                            filename=root/ref['file'];original=s.load_package(filename)[0]
                            source_doc=s.parse(original[ref['part']])
                            selected=[n for n in lib.top_shapes(source_doc) if s.shape_id(n) in ref['shape_ids']]
                            allowed={n.getAttribute('id') for node in selected for n in s.nodes(node,'p','cNvPr')}
                            if mapped_keys and mapped_keys <= allowed:
                                batches.append({'source_file':str(filename), 'source_sha256':ref['source_sha256'],
                                                'source_part':ref['part'], 'source_shape_ids':list(mapped_keys), 'id_map':mapping['id_map']})
                                matched=True;break
                        except (OSError,KeyError,ValueError):
                            continue
                    if not matched:
                        errors.append({'code':'ACTUAL_REUSE_INVALID','page':page,'detail':'No exact source subtree matches instance '+inst.get('instance_id','')})
        for record in batches:
            try:
                filename=Path(record['source_file'])
                key=(str(filename),record['source_sha256'])
                if key not in source_cache:
                    if s.digest(filename)!=record['source_sha256']:
                        raise ValueError('SOURCE_HASH_MISMATCH')
                    source_cache[key]=s.load_package(filename)[0]
                original=source_cache[key]
                sourcepart=record['source_part']
                src_ids={n.getAttribute('id') for n in s.nodes(s.parse(original[sourcepart]),'p','cNvPr')}
                mapping=record.get('id_map',{})
                if not mapping or not set(mapping)<=src_ids:
                    raise ValueError('SOURCE_OBJECT_MISSING')
                removed=set(record.get('deliberately_removed_output_shape_ids',[]))
                for old,new in mapping.items():
                    if new in removed:
                        continue
                    if new not in output_ids:
                        raise ValueError('OUTPUT_OBJECT_MISSING')
                    if new in byid and _visible(byid[new],nodes,parts,part,size):
                        imported.add(new)
                verified_sources.append({'file':str(filename),'part':sourcepart,'mapped_objects':len(mapping)})
            except (OSError,KeyError,ValueError) as error:
                errors.append({'code':'ACTUAL_REUSE_INVALID','page':page,'detail':str(error)})
        native=[]
        for sid in imported:
            node=byid[sid]
            if node.localName=='grpSp':
                native.extend(s.shape_id(child) for kind in ('sp','cxnSp','graphicFrame') for child in s.nodes(node,'p',kind)
                              if not (s.first(child,'p','cNvPr') and s.first(child,'p','cNvPr').getAttribute('hidden') in ('1','true')))
            elif node.localName in ('sp','cxnSp','graphicFrame'):
                native.append(sid)
        pictures=[sid for sid in imported if byid[sid].localName=='pic']
        requirement=plan.get('slides',plan.get('pages',[]))[page-1].get('reuse_requirement','structural') if page<=len(comp['pages']) else 'structural'
        if requirement=='structural' and len(native)<2:
            errors.append({'code':'STRUCTURAL_REUSE_REQUIRED','page':page,'native_objects':len(native)})
        elif requirement=='asset' and not imported:
            errors.append({'code':'VISIBLE_REUSE_REQUIRED','page':page})
        elif requirement=='original':
            warnings.append({'code':'ORIGINAL_COMPOSITION_REVIEW','page':page})
        evidence.append({'page':page,'geometry_fingerprint':fp,'visible_imported_native_objects':len(native),
                         'visible_imported_pictures':len(pictures),'sources':verified_sources})
    return {'schema_version':1,'source_sha256':digest,'status':'failed' if errors else 'passed',
            'errors':errors,'warnings':warnings,'composition_ledger':comp,'pages':evidence,
            'limits':['Geometry is a heuristic; distinct fingerprints do not prove distinct semantic compositions.',
                      'Reuse checks source identity and visible object presence; visual suitability needs actual rendered-page review.']}
