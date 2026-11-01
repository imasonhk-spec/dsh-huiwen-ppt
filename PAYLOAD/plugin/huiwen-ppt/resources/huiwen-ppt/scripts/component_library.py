"""Portable component inventory, actual template indexing and version lifecycle."""
import copy
import hashlib
import json
import re
import shutil
from pathlib import Path
from contextlib import contextmanager
from functools import lru_cache
import studio as s

EXTRACTION_VERSION=2

def element_tree(node):
    return {'shape_id':s.shape_id(node),'kind':node.localName,'text':s.text_content(node),
            'bounds':bounds([node]),'coordinate_space':'parent',
            'children':[element_tree(n) for n in s.children(node) if n.namespaceURI==s.NS['p'] and n.localName in ('sp','pic','cxnSp','grpSp','graphicFrame')]}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def load(root):
    path=Path(root)/'index.json'
    data=s.read_json(path) if path.exists() else {'schema_version':1,'templates':{},'components':[]}
    if data.get('schema_version')!=1:raise ValueError('INVALID_SCHEMA: expected version 1')
    return data


@lru_cache(maxsize=4)
def cached_index(path,mtime,size):
    return s.read_json(path)


@contextmanager
def writer(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True);lock=root/'.write-lock'
    try:handle=lock.open('x')
    except FileExistsError:raise ValueError('LIBRARY_BUSY: another write is in progress')
    try:
        handle.write(s.now());handle.close();yield
    finally:lock.unlink(missing_ok=True)


def top_shapes(doc):
    return [n for n in s.children(s.first(doc,'p','spTree')) if n.localName in ('sp','pic','cxnSp','grpSp','graphicFrame')]


def transform(node):
    if node.localName=='grpSp':
        props=s.children(node,'p','grpSpPr')
        return s.first(props[0],'a','xfrm') if props else None
    return s.own_transform(node)


def bounds(nodes,parts=None,part=None):
    boxes=[]
    for n in nodes:
        x=transform(n)
        if x is None and parts is not None:x=s.inherited_transform(parts,part,n)
        b=s.geometry(x)
        if b:boxes.append(b)
    if not boxes:return None
    x=min(b['x'] for b in boxes);y=min(b['y'] for b in boxes)
    return {'x':x,'y':y,'width':max(b['x']+b['width'] for b in boxes)-x,'height':max(b['y']+b['height'] for b in boxes)-y}


def classify(node,box,size):
    prop=s.first(node,'p','cNvPr')
    if prop and prop.getAttribute('hidden') in ('1','true'):return 'hidden'
    if not box:return 'restricted'
    if box['width']>=size['width']*.8 and box['height']>=size['height']*.8:return 'background'
    if box['y']<size['height']*.15:return 'header'
    if box['y']>=size['height']*.85:return 'footer'
    return 'content'


def kind(nodes):
    if any(s.first(n,'a','tbl') for n in nodes):return 'table'
    if any(n.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/chart','chart') for n in nodes):return 'chart'
    if all(n.localName=='pic' for n in nodes):return 'artwork'
    if any(n.localName=='cxnSp' or s.nodes(n,'p','cxnSp') for n in nodes):return 'relationship'
    return 'text' if len(nodes)==1 and s.text_content(nodes[0]) else 'group'


def slots_for(members):
    result=[]
    for node in members:
        leaves=[node] if node.localName!='grpSp' else [n for n in node.getElementsByTagName('*') if n.namespaceURI==s.NS['p'] and n.localName in ('sp','graphicFrame')]
        for n in leaves:
            typ=kind([n])
            if typ in ('text','table','chart'):
                result.append({'key':s.shape_id(n),'type':typ,'example':s.text_content(n) if typ=='text' else ''})
    return result


def dependency_hash(parts,part,members,cache=None):
    cache={} if cache is None else cache
    roots=[];rels=s.relationships(parts,part)
    for member in members:
        for node in [member,*member.getElementsByTagName('*')]:
            for attr in list(node.attributes.values()) if node.attributes else []:
                if attr.namespaceURI==s.NS['r'] and attr.value in rels:
                    rel=rels[attr.value]
                    if rel.getAttribute('TargetMode')!='External':roots.append(s.resolve(part,rel.getAttribute('Target')))
    current=part
    for kind_name in ['slideLayout','slideMaster','theme']:
        current=s.linked_part(parts,current,kind_name) if current else None
        if current:roots.append(current)
    for root in roots:
        if root in cache:continue
        seen={}
        def visit(name):
            if name in seen:return
            if name not in parts:raise ValueError('DEPENDENCY_MISSING: '+name)
            seen[name]=hashlib.sha256(parts[name]).hexdigest()
            for rel in s.relationships(parts,name).values():
                if rel.getAttribute('TargetMode')!='External':visit(s.resolve(name,rel.getAttribute('Target')))
        visit(root);cache[root]=fingerprint(seen)
    return fingerprint({root:cache[root] for root in roots})


def source_path(root,component):
    refs=[r for r in component['source_refs'] if r.get('active',True)] or component['source_refs']
    ref=refs[-1];path=(Path(root)/ref['file']).resolve()
    if not path.is_relative_to(Path(root).resolve()):raise ValueError('INVALID_SOURCE_PATH')
    if not path.exists() or s.digest(path)!=ref['source_sha256']:raise ValueError('SOURCE_CHANGED')
    return path,ref


def index_template(source,library,template_id,project_id,annotations=None):
    source=Path(source).resolve();root=Path(library).resolve()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',template_id):raise ValueError('INVALID_TEMPLATE_ID')
    sha=s.digest(source);parts,_=s.load_package(source);slides,size=s.slide_parts(parts)
    annotations={} if annotations is None else annotations
    if not isinstance(annotations,dict) or any(not isinstance(rows,list) or any(not isinstance(a,dict) or not isinstance(a.get('shape_ids'),list) for a in rows) for rows in annotations.values()):raise ValueError('INVALID_ANNOTATION')
    annotation_hash=fingerprint(annotations)
    with writer(root):
        db=load(root);prior=db['templates'].get(template_id)
        if prior and prior.get('extraction_version')==EXTRACTION_VERSION and prior['source_sha256']==sha and prior.get('annotation_hash')==annotation_hash:
            for c in db['components']:
                if any(r['template_id']==template_id and r.get('active') for r in c['source_refs']) and project_id not in c['project_ids']:c['project_ids'].append(project_id)
            s.save_json(root/'index.json',db)
            return {'template_version':prior['version'],'source_sha256':sha,'coverage':prior['coverage'],
                    'components':[c for c in db['components'] if any(r['template_id']==template_id and r.get('active') for r in c['source_refs'])]}
        version=prior['version']+1 if prior else 1
        relative=f'sources/{template_id}/{sha}.pptx';target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():shutil.copy2(source,target)
        assert s.digest(target)==sha
        for c in db['components']:
            for ref in c['source_refs']:
                if ref['template_id']==template_id:ref['active']=False
        coverage=[];selected=set();dependency_cache={}
        for number,part in enumerate(slides,1):
            doc=s.parse(parts[part]);shapes=top_shapes(doc);byid={s.shape_id(n):n for n in shapes}
            roles={sid:classify(n,bounds([n],parts,part),size) for sid,n in byid.items()}
            cover_order=-1
            for order,n in enumerate(shapes):
                b=bounds([n],parts,part)
                if n.localName=='pic' and b and b['x']<=1 and b['y']<=1 and b['width']>=size['width']*.98 and b['height']>=size['height']*.98:cover_order=order
            for order,n in enumerate(shapes):
                if order<cover_order:roles[s.shape_id(n)]='restricted'
            groups=[]
            for sid,node in byid.items():
                if roles[sid] not in ('hidden','restricted'):
                    groups.append({'shape_ids':[sid],'role':roles[sid],'granularity':'element'})
            body=[sid for sid in byid if roles[sid]=='content']
            if body:groups.append({'shape_ids':body,'role':'content','granularity':'semantic','name':'页面主体组合','relation_type':'page_body'})
            # A container and its enclosed labels/icons form a meaningful reusable block.
            for sid in body:
                node=byid[sid];box=bounds([node],parts,part)
                if node.localName!='sp' or s.text_content(node) or not box or box['width']*box['height']>size['width']*size['height']*.55:continue
                enclosed=[]
                for other in body:
                    b=bounds([byid[other]],parts,part)
                    if b and b['x']>=box['x']-1 and b['y']>=box['y']-1 and b['x']+b['width']<=box['x']+box['width']+1 and b['y']+b['height']<=box['y']+box['height']+1:enclosed.append(other)
                if len(enclosed)>=3 and any(s.text_content(byid[x]) for x in enclosed):
                    groups.append({'shape_ids':enclosed,'role':'content','granularity':'semantic','relation_type':'content_block'})
            repair_ids={str(sid) for a in annotations.get(str(number),[]) if a.get('requires_repair') for sid in a['shape_ids']}
            for annotation in annotations.get(str(number),[]):
                if not annotation.get('shape_ids') or any(str(i) not in byid for i in annotation['shape_ids']):raise ValueError('INVALID_ANNOTATION: top-level shape IDs required')
                if any(roles[str(i)] in ('hidden','restricted') for i in annotation['shape_ids']):raise ValueError('INVALID_ANNOTATION: hidden/covered/restricted member')
                param=annotation.get('parameterization')
                if param is not None:
                    if not isinstance(param,dict) or not isinstance(param.get('node_shape_ids'),list) or not param['node_shape_ids'] or any(i not in byid or i not in annotation['shape_ids'] for i in param['node_shape_ids']):raise ValueError('INVALID_ANNOTATION: node blueprint must reference component members')
                    ids={s.shape_id(n) for sid in param['node_shape_ids'] for n in [byid[sid],*byid[sid].getElementsByTagName('*')] if n.namespaceURI==s.NS['p'] and n.localName in ('sp','pic','grpSp','cxnSp','graphicFrame')}
                    if param.get('anchor_shape_id') not in ids or not isinstance(param.get('fields'),dict) or not param['fields'] or any(v not in ids for v in param['fields'].values()):raise ValueError('INVALID_ANNOTATION: blueprint anchor/fields missing')
                groups.append({**annotation,'shape_ids':[str(x) for x in annotation['shape_ids']],'role':annotation.get('role','content'),'granularity':'semantic'})
            assigned=set();page_cids=[]
            for group in groups:
                members=[byid[x] for x in group['shape_ids']];box=bounds(members,parts,part)
                if not box or box['width']<0 or box['height']<0:continue
                text=' / '.join(s.text_content(n).replace('\n',' ') for n in members).strip(' /')
                relation=group.get('relation_type',kind(members))
                xml=[n.toxml() for n in members]
                # Exact structural identities are reused after page deletion/reordering.
                # Ambiguous changed structures receive new IDs unless explicitly annotated.
                signature=fingerprint({'xml':xml,'role':group['role'],'relation':relation})
                cid=group.get('component_id',f'{template_id}-{signature[:18]}')
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',cid):raise ValueError('INVALID_COMPONENT_ID')
                content_hash=fingerprint({'xml':xml,'dependencies':dependency_hash(parts,part,members,dependency_cache),'spec':group})
                matches=[c for c in db['components'] if c['component_id']==cid]
                current=next((c for c in matches if c['definition_hash']==content_hash),None)
                if current is None:
                    cap=['move','resize','bind_content','restyle']
                    if group.get('parameterization'):cap+=['set_node_count','set_arrangement']
                    edit='raster' if relation=='artwork' else 'native'
                    unsupported=any(n.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/diagram','relIds') or s.nodes(n,'p','oleObj') for n in members)
                    if unsupported:edit='whole_only';cap=['move','resize']
                    current={'schema_version':1,'component_id':cid,'component_version':max([c['component_version'] for c in matches],default=0)+1,
                        'definition_hash':content_hash,'structure_hash':signature,'name':group.get('name',text[:65] or relation),
                        'relation_type':relation,'role':group['role'],'granularity':group['granularity'],
                        'lifecycle':'candidate','quality_status':'requires_repair' if repair_ids.intersection(group['shape_ids']) else 'pending',
                        'editability':edit,'capabilities':cap,'bounds':box,'slide_size':size,'source_refs':[],
                        'project_ids':[project_id],'slots':group.get('slots',slots_for(members)),
                        'element_tree':[element_tree(n) for n in members],
                        'parameterization':group.get('parameterization'), 'use_records':[], 'created_at':s.now()}
                    db['components'].append(current)
                current['element_tree']=[element_tree(n) for n in members]
                if project_id not in current['project_ids']:current['project_ids'].append(project_id)
                ref={'template_id':template_id,'template_version':version,'source_sha256':sha,'file':relative,'slide':number,'part':part,'shape_ids':group['shape_ids'],'active':True}
                if ref not in current['source_refs']:current['source_refs'].append(ref)
                if current['lifecycle']=='retired' and current.get('retirement_reason')=='all_source_references_removed':current['lifecycle']='candidate'
                selected.add((cid,current['component_version']));page_cids.append(cid);assigned.update(group['shape_ids'])
            coverage.append({'slide':number,'part':part,'objects':[{'shape_id':sid,'role':roles[sid],'tree':element_tree(n)} for sid,n in byid.items()],
                'component_ids':list(dict.fromkeys(page_cids)),'restricted_shape_ids':[sid for sid in byid if roles[sid] in ('hidden','restricted')],
                'unassigned_shape_ids':[sid for sid in byid if sid not in assigned and roles[sid] not in ('hidden','restricted')]})
        for c in db['components']:
            if not any(r.get('active') for r in c['source_refs']):
                c['previous_lifecycle']=c['lifecycle'];c['lifecycle']='retired';c['retirement_reason']='all_source_references_removed'
        history=copy.deepcopy(prior.get('history',[])) if prior else []
        if prior:history.append({k:prior[k] for k in ('version','source_sha256','file')})
        db['templates'][template_id]={'version':version,'source_sha256':sha,'file':relative,'coverage':coverage,'history':history,'annotation_hash':annotation_hash,'extraction_version':EXTRACTION_VERSION}
        s.save_json(root/'index.json',db)
        return {'template_version':version,'source_sha256':sha,'coverage':coverage,'components':[c for c in db['components'] if (c['component_id'],c['component_version']) in selected]}


def get_component(root,component_id,version=None):
    path=Path(root)/'index.json';stat=path.stat();db=cached_index(str(path.resolve()),stat.st_mtime_ns,stat.st_size)
    matches=[c for c in db['components'] if c['component_id']==component_id and (version is None or c['component_version']==version)]
    if not matches:raise ValueError('COMPONENT_NOT_FOUND: '+component_id)
    if version is None:
        usable=[c for c in matches if c['lifecycle']!='retired' and c['quality_status']!='requires_repair']
        if usable:matches=usable
    return copy.deepcopy(max(matches,key=lambda c:c['component_version']))


def search(root,query='',scope='formal',project_id=None,relation=None,excluded_ids=None):
    import visual_composition as visual
    if scope not in ('formal','current_project','trial_candidates','history'):raise ValueError('INVALID_SCOPE')
    semantics=visual.catalog(root)
    rows=[];seen=set()
    for c in sorted(load(root)['components'],key=lambda c:c['component_version'],reverse=True):
        if c['component_id'] in seen:continue
        if c['component_id'] in (excluded_ids or []):continue
        if scope!='history' and (c['lifecycle']=='retired' or c['quality_status']=='requires_repair'):continue
        if scope=='formal' and c['lifecycle']!='formal':continue
        if scope=='current_project' and c['lifecycle']!='formal' and project_id not in c['project_ids']:continue
        if scope=='trial_candidates' and c['lifecycle']!='candidate':continue
        if relation and c['relation_type']!=relation:continue
        semantic=visual.annotation(c,semantics)
        hay=' '.join([c['name'],c['relation_type'],c['component_id'],semantic.get('description',''),*semantic.get('tags',[])]).lower()
        if query and not all(q.lower() in hay for q in query.split()):continue
        seen.add(c['component_id'])
        rows.append(c)
    return rows


def mutate(root,cid,version,fn):
    with writer(root):
        db=load(root)
        c=next((c for c in db['components'] if c['component_id']==cid and c['component_version']==version),None)
        if c is None:raise ValueError('COMPONENT_NOT_FOUND')
        fn(c);s.save_json(Path(root)/'index.json',db);return c


def valid_proof(proof):
    if not isinstance(proof,dict) or not (all(proof.get(k)=='passed' for k in ('structure','editability','visual')) and proof.get('status')=='passed' and proof.get('unresolved')==[] and bool(re.fullmatch(r'[a-f0-9]{64}',proof.get('output_sha256','')))):return False
    try:
        return s.digest(proof['output_file'])==proof['output_sha256'] and s.read_json(proof['state_file'])['sha256']==proof['output_sha256']
    except (OSError,KeyError,ValueError,TypeError):return False


def proof_contains(proof,cid,version,task_id=None):
    state=s.read_json(proof['state_file'])
    return (task_id is None or state.get('project_id')==task_id) and any(i.get('component_id')==cid and i.get('component_version')==version for p in state.get('slides',[]) for i in p.get('instances',[]))


def record_use(root,cid,version,task_id,proof):
    if not task_id or not valid_proof(proof) or not proof_contains(proof,cid,version,task_id):raise ValueError('INVALID_EVIDENCE: complete QA, actual output/state and matching task/component required')
    def update(c):
        if c['lifecycle']=='retired' or c['quality_status']=='requires_repair':raise ValueError('COMPONENT_NOT_USABLE')
        c['use_records']=[r for r in c['use_records'] if r['task_id']!=task_id]+[{'task_id':task_id,'proof':proof,'at':s.now()}]
        c['quality_status']='passed'
        if len(c['use_records'])>=3 and c['editability']=='native':c['lifecycle']='formal';c['promotion']={'kind':'three_distinct_tasks','at':s.now()}
    return mutate(root,cid,version,update)


def promote(root,cid,version,confirmed_by,note,proof):
    if not confirmed_by or not note or not valid_proof(proof) or not proof_contains(proof,cid,version):raise ValueError('INVALID_APPROVAL_OR_EVIDENCE')
    def update(c):
        if c['quality_status']=='requires_repair' or c['lifecycle']=='retired':raise ValueError('COMPONENT_NOT_USABLE')
        c.update(lifecycle='formal',quality_status='passed',promotion={'kind':'manual','confirmed_by':confirmed_by,'note':note,'proof':proof,'at':s.now()})
    return mutate(root,cid,version,update)


def retire(root,cid,version,reason):
    def update(c):
        if c['lifecycle']!='retired':c['previous_lifecycle']=c['lifecycle']
        c.update(lifecycle='retired',retirement_reason=reason)
    return mutate(root,cid,version,update)


def restore(root,cid,version):
    def update(c):
        if not any(r.get('active') for r in c['source_refs']):raise ValueError('SOURCE_RETIRED: reimport or explicitly reactivate source first')
        c['lifecycle']=c.get('previous_lifecycle','candidate')
    return mutate(root,cid,version,update)


def thumbnails(root,template_id,render_dir):
    """Crops from actual native slide renders; these show context, not isolated objects."""
    from PIL import Image
    root=Path(root);render_dir=Path(render_dir)
    with writer(root):
        db=load(root);template=db['templates'][template_id]
        report=s.read_json(render_dir/'native-render.json')
        if report.get('source_sha256')!=template['source_sha256'] or report.get('slide_count')!=len(template['coverage']):raise ValueError('RENDER_EVIDENCE_REQUIRED')
        count=0;pages={}
        for c in db['components']:
            refs=[r for r in c['source_refs'] if r['template_id']==template_id and r.get('active')]
            if not refs:continue
            ref=refs[-1];number=ref['slide']
            if number not in pages:
                with Image.open(render_dir/f'slide-{number:03}.png') as im:pages[number]=im.convert('RGB')
            im=pages[number];b=c['bounds'];size=c['slide_size'];sx=im.width/size['width'];sy=im.height/size['height']
            left=max(0,int(b['x']*sx)-3);top=max(0,int(b['y']*sy)-3)
            right=min(im.width,int((b['x']+b['width'])*sx)+3);bottom=min(im.height,int((b['y']+b['height'])*sy)+3)
            if right<=left or bottom<=top:continue
            crop=im.crop((left,top,right,bottom));crop.thumbnail((480,300))
            relative=f"previews/{c['component_id']}-v{c['component_version']}.png";target=root/relative;target.parent.mkdir(parents=True,exist_ok=True);crop.save(target)
            c['preview']={'file':relative,'kind':'source_context_crop','source_sha256':ref['source_sha256'],'slide':number,'engine':report['engine']};count+=1
        s.save_json(root/'index.json',db)
    return {'count':count,'template_id':template_id,'preview_kind':'source_context_crop'}
