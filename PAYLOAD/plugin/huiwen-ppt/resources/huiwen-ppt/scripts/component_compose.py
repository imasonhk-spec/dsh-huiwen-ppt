"""Compile and revise native component compositions without changing source decks."""
import copy
import hashlib
import math
from pathlib import Path
import studio as s
import component_library as lib
import component_ooxml as ox


def intersect(a,b):
    return a['x']<b['x']+b['width']-.1 and b['x']<a['x']+a['width']-.1 and a['y']<b['y']+b['height']-.1 and b['y']<a['y']+a['height']-.1


def rect_ok(rect,size):
    if not isinstance(rect,dict) or set(rect)!=set(('x','y','width','height')):raise ValueError('INVALID_PLAN: rectangle fields')
    if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in rect.values()):raise ValueError('INVALID_PLAN: nonfinite rectangle')
    if rect['width']<=0 or rect['height']<=0 or rect['x']<0 or rect['y']<0 or rect['x']+rect['width']>size['width']+.1 or rect['y']+rect['height']>size['height']+.1:raise ValueError('CONTENT_OVERFLOW: rectangle outside slide')


def native_slot_shapes(component,library,cache=None):
    slots=[slot for slot in component.get('slots',[]) if slot['type'] in ('text','table','chart')]
    if not slots:return {}
    source,ref=lib.source_path(library,component)
    cache={} if cache is None else cache
    if str(source) not in cache:cache[str(source)]=s.load_package(source)[0]
    parts=cache[str(source)];doc=s.parse(parts[ref['part']])
    byid={s.shape_id(node):node for node,_ in s.shape_nodes(doc)}
    contracts={}
    for slot in slots:
        key=slot['key'];node=byid.get(key)
        if node is None:raise ValueError('SOURCE_CHANGED: native slot '+key)
        if slot['type']=='text':
            bounds=s.geometry(s.inherited_transform(parts,ref['part'],node))
            sizes=[int(prop.getAttribute('sz'))/100 for kind in ('rPr','defRPr') for prop in s.nodes(node,'a',kind)
                   if prop.hasAttribute('sz')]
            numeric=isinstance(slot.get('example'),str) and len(slot['example']) in (1,2) and slot['example'].isascii() and slot['example'].isdecimal()
            if bounds and numeric and 0<bounds['width']<=48 and 0<bounds['height']<=48 and sizes:
                contracts[key]={'type':'sequence_badge','width':bounds['width'],'height':bounds['height'],
                                'font_pt':max(sizes),'max_chars':2}
            elif bounds:
                body=s.first(node,'a','bodyPr')
                insets={name:float(body.getAttribute(attr))/s.EMU if body is not None and body.hasAttribute(attr) else default
                        for name,attr,default in [('left','lIns',9.6),('right','rIns',9.6),('top','tIns',4.8),('bottom','bIns',4.8)]}
                contracts[key]={'type':'text','width':bounds['width'],'height':bounds['height'],
                                'font_pt':max(sizes) if sizes else None,'text_insets':insets}
        elif slot['type']=='table':
            table=s.first(node,'a','tbl')
            if table is None:raise ValueError('SOURCE_CHANGED: table slot '+key)
            row_nodes=s.children(table,'a','tr')
            rows=[s.children(row,'a','tc') for row in row_nodes]
            merged=[[ri,ci] for ri,row in enumerate(rows) for ci,cell in enumerate(row)
                    if cell.getAttribute('hMerge') in ('1','true') or cell.getAttribute('vMerge') in ('1','true')]
            grid=s.first(table,'a','tblGrid');columns=[float(col.getAttribute('w'))/s.EMU for col in s.children(grid,'a','gridCol')]
            heights=[float(row.getAttribute('h'))/s.EMU for row in row_nodes]
            text_cells=[]
            for ri,row in enumerate(rows):
                contracts_row=[]
                for ci,cell in enumerate(row):
                    sizes=[int(prop.getAttribute('sz'))/100 for kind in ('rPr','defRPr') for prop in s.nodes(cell,'a',kind) if prop.hasAttribute('sz')]
                    props=s.first(cell,'a','tcPr')
                    insets={name:float(props.getAttribute(attr))/s.EMU if props is not None and props.hasAttribute(attr) else default
                            for name,attr,default in [('left','marL',9.6),('right','marR',9.6),('top','marT',4.8),('bottom','marB',4.8)]}
                    contracts_row.append({'type':'text','width':sum(columns[ci:ci+int(cell.getAttribute('gridSpan') or 1)]),
                        'height':sum(heights[ri:ri+int(cell.getAttribute('rowSpan') or 1)]),'font_pt':max(sizes) if sizes else None,'text_insets':insets})
                text_cells.append(contracts_row)
            contracts[key]={'type':'table','row_lengths':[len(row) for row in rows],'merged_continuations':merged,'text_cells':text_cells}
        else:
            charts=node.getElementsByTagNameNS(ox.CNS,'chart')
            if len(charts)!=1:raise ValueError('SOURCE_CHANGED: chart slot '+key)
            rid=charts[0].getAttributeNS(s.NS['r'],'id');rel=s.relationships(parts,ref['part']).get(rid)
            if not rel:raise ValueError('DEPENDENCY_MISSING: chart '+key)
            chart=s.resolve(ref['part'],rel.getAttribute('Target'))
            contracts[key]={'type':'chart','series_count':len(s.parse(parts[chart]).getElementsByTagNameNS(ox.CNS,'ser')),
                            'chart_part':chart}
    return contracts


def compile_plan(plan,library,geometry_preflight=True,retained_source=None,previous_state=None,expected_sha256=None):
    if not isinstance(plan,dict):raise ValueError('INVALID_PLAN: object required')
    if plan.get('schema_version')!=1 or not plan.get('project_id'):raise ValueError('INVALID_PLAN: schema_version/project_id')
    if plan.get('mode','quick') not in ('quick','standard'):raise ValueError('INVALID_PLAN: mode')
    if not isinstance(plan.get('slides'),list) or not 1<=len(plan['slides'])<=500:raise ValueError('INVALID_PLAN: slides')
    result=copy.deepcopy(plan);profile=ox.style_profile(plan['style_source'])
    if plan.get('style_sha256') and plan['style_sha256']!=profile['source_sha256']:raise ValueError('SOURCE_CHANGED: style template')
    result['style_sha256']=profile['source_sha256'];result['style_profile']=profile;seen=set();warnings=[];source_cache={}
    for slide in result['slides']:
        if not isinstance(slide,dict):raise ValueError('INVALID_PLAN: slide object required')
        sid=slide.get('slide_id')
        if not sid or sid in seen:raise ValueError('INVALID_PLAN: duplicate slide_id')
        seen.add(sid);used=set();instances=slide.get('instances',[]);originals=slide.get('originals',[])
        if not isinstance(instances,list) or not isinstance(originals,list):raise ValueError('INVALID_PLAN: instances/originals must be arrays')
        if not instances and (slide.get('reuse_requirement')!='original' or not originals):raise ValueError('INVALID_PLAN: no component instances without explicit original content')
        original_ids={};original_rects=[]
        for original in originals:
            if not isinstance(original,dict) or original.get('kind') not in ('text','shape','connector','image'):
                raise ValueError('INVALID_ORIGINAL: native object kind')
            allowed={'original_id','kind','rect','evidence_refs'}|({'text'} if original['kind'] in ('text','shape') else
                   {'asset_id','asset_path'} if original['kind']=='image' else {'start_id','end_id'})
            if set(original)-allowed:
                raise ValueError('INVALID_ORIGINAL: cannot claim template source or unrelated fields')
            oid=original.get('original_id')
            if not isinstance(oid,str) or not oid or oid in original_ids:raise ValueError('INVALID_ORIGINAL: duplicate/missing original_id')
            refs=original.get('evidence_refs')
            if not isinstance(refs,list) or not refs or any(not isinstance(ref,str) or not ref for ref in refs):raise ValueError('MISSING_EVIDENCE: original object')
            if original['kind']=='connector':
                start=original_ids.get(original.get('start_id'));end=original_ids.get(original.get('end_id'))
                if not start or not end or start['kind']=='connector' or end['kind']=='connector' or start is end:raise ValueError('INVALID_ORIGINAL: connector endpoints')
                a=start['rect'];b=end['rect'];x1=a['x']+a['width']/2;y1=a['y']+a['height']/2;x2=b['x']+b['width']/2;y2=b['y']+b['height']/2
                original['rect']={'x':min(x1,x2),'y':min(y1,y2),'width':abs(x2-x1),'height':abs(y2-y1)}
            else:
                rect_ok(original.get('rect'),profile['slide_size'])
                if original['kind']=='text' and not isinstance(original.get('text'),str):raise ValueError('INVALID_ORIGINAL: native text')
                if original['kind']=='shape' and not isinstance(original.get('text',''),str):raise ValueError('INVALID_ORIGINAL: shape label')
                if original['kind']=='image' and (not original.get('asset_id') or not original.get('asset_path')):raise ValueError('SOURCE_NOT_FOUND: original asset')
                original_rects.append(original['rect'])
            original_ids[oid]=original
        for inst in instances:
            if not isinstance(inst,dict):raise ValueError('INVALID_PLAN: instance object required')
            iid=inst.get('instance_id')
            if not iid or iid in used:raise ValueError('INVALID_PLAN: duplicate instance_id')
            used.add(iid);rect_ok(inst['rect'],profile['slide_size'])
            c=lib.get_component(library,inst['component_id'],inst.get('component_version'))
            inst['component_version']=c['component_version']
            if c['lifecycle']=='retired' and not inst.get('allow_historical'):raise ValueError('COMPONENT_RETIRED')
            if c['quality_status']=='requires_repair':raise ValueError('COMPONENT_REQUIRES_REPAIR')
            if c['lifecycle']=='candidate' and result['project_id'] not in c['project_ids'] and not inst.get('trial_candidate'):raise ValueError('CANDIDATE_SCOPE: explicit trial required')
            lib.source_path(library,c)
            if not inst.get('evidence_refs') and not inst.get('allow_template_examples'):raise ValueError('MISSING_EVIDENCE: bind user material or explicit placeholders')
            bindings=inst.get('bindings',{});tr=inst.get('transform',{})
            if not isinstance(bindings,dict) or not isinstance(tr,dict):raise ValueError('INVALID_PLAN: bindings/transform must be objects')
            if tr:
                param=c.get('parameterization')
                if not param:raise ValueError('UNSUPPORTED_TRANSFORM: no semantic node blueprint')
                count=tr.get('node_count',len(bindings.get('steps',bindings.get('items',[]))))
                if not isinstance(count,int) or isinstance(count,bool) or not 2<=count<=8:raise ValueError('UNSUPPORTED_TRANSFORM: node_count must be 2..8; split or author new structure')
                items=bindings.get('steps',bindings.get('items',[]))
                if not isinstance(items,list) or len(items)!=count or any(not isinstance(i,dict) or not i.get('title') for i in items):raise ValueError('INVALID_BINDING: one title per node required')
                tr['node_count']=count
                if tr.get('arrangement','horizontal') not in ('horizontal','vertical','two_rows','grid','radial'):raise ValueError('UNSUPPORTED_TRANSFORM: arrangement')
            elif c['slots'] and not inst.get('allow_template_examples'):
                missing=[slot['key'] for slot in c['slots'] if slot['type'] in ('text','table','chart') and slot['key'] not in bindings]
                if missing:raise ValueError('UNBOUND_TEMPLATE_TEXT: '+','.join(missing))
            if not tr:
                contracts=native_slot_shapes(c,library,source_cache)
                for key,contract in contracts.items():
                    if key not in bindings:continue
                    value=bindings[key]
                    if contract['type']=='sequence_badge':
                        if not isinstance(value,str) or value and (len(value)>2 or not value.isascii() or not value.isdecimal()):
                            raise ValueError('SLOT_CAPACITY: component '+c['component_id']+' slot '+key+
                                             ' is a '+str(contract['width'])+'x'+str(contract['height'])+'px sequence badge; '
                                             'bind empty or at most two digits, keep complete content in a body slot')
                    elif contract['type']=='table':
                        source,ref=lib.source_path(library,c);parts=source_cache[str(source)]
                        doc=s.parse(parts[ref['part']]);node=next(node for node,_ in s.shape_nodes(doc) if s.shape_id(node)==key)
                        try:ox.bind_table(node,value)
                        except (ValueError,AttributeError) as error:
                            raise ValueError('INVALID_BINDING: component '+c['component_id']+' slot '+key+' native table row_lengths='+str(contract['row_lengths'])+
                                             ' merged_continuations='+str(contract['merged_continuations'])+'; '+str(error)) from error
                    elif contract['type']=='chart':
                        source,ref=lib.source_path(library,c);parts=source_cache[str(source)]
                        try:ox.bind_chart(parts.copy(),contract['chart_part'],value)
                        except (ValueError,AttributeError) as error:
                            raise ValueError('INVALID_BINDING: component '+c['component_id']+' slot '+key+' native chart series_count='+str(contract['series_count'])+'; '+str(error)) from error
            allowed={'steps','items'} if tr else {slot['key'] for slot in c['slots']}
            if set(bindings)-allowed:raise ValueError('INVALID_BINDING: unknown slot keys')
            if c['editability'] in ('raster','whole_only'):warnings.append({'slide_id':sid,'instance_id':iid,'code':'EDITABILITY_LIMIT','editability':c['editability']})
        for i,a in enumerate(instances):
            for b in instances[i+1:]:
                if intersect(a['rect'],b['rect']) and not (a.get('layer')=='background' or b.get('layer')=='background'):raise ValueError('CONTENT_OVERLAP: component rectangles overlap')
            if a.get('layer')!='background' and any(intersect(a['rect'],r) for r in original_rects):raise ValueError('CONTENT_OVERLAP: native original and component overlap')
        protected=[]
        if not isinstance(slide.get('locks',[]),list):raise ValueError('INVALID_LOCK')
        for lock in slide.get('locks',[]):
            if not isinstance(lock,dict):raise ValueError('INVALID_LOCK')
            if 'instance_id' in lock:
                if lock['instance_id'] not in used:raise ValueError('INVALID_LOCK: missing instance')
                protected.append(lock['instance_id'])
            elif 'rect' in lock:
                rect_ok(lock['rect'],profile['slide_size'])
                protected.extend(i['instance_id'] for i in instances if intersect(i['rect'],lock['rect']))
            else:raise ValueError('INVALID_LOCK')
        slide['protected_instance_ids']=sorted(set(protected))
    result['warnings']=warnings
    retained=retained_base(result,retained_source,previous_state,expected_sha256) if any(v is not None for v in (retained_source,previous_state,expected_sha256)) else None
    if result.get('visual_policy'):
        import visual_composition as visual
        checked=visual.ledger(result)
        if checked['status']!='passed':raise ValueError('COMPOSITION_CONFLICT: '+str(checked['conflicts']))
        if checked['strict'] and geometry_preflight:
            geometry={};package=retained[0] if retained else ox.Package(result['style_source'])
            for page,slide in enumerate(result['slides'],1):
                part=package.originals[page-1] if retained and page<=retained[2] else append_page(package,slide,library,profile)['part']
                fingerprint=visual.page_geometry(package.parts,part,profile['slide_size'])
                if fingerprint and fingerprint in geometry:
                    raise ValueError('COMPOSITION_CONFLICT: GEOMETRY_COMPOSITION_REPEATED page '+str(page)+' / '+str(geometry[fingerprint]))
                if fingerprint:geometry[fingerprint]=page
        result['composition_ledger']=checked
        result['component_library']=str(Path(library).resolve())
    return result


def append_originals(package,part,doc,rels,slide,profile):
    created=[];byid={}
    for original in slide.get('originals',[]):
        kind=original['kind'];rect=original['rect']
        if kind=='text':sid=ox.text_shape(doc,original['text'],rect,profile)
        elif kind=='shape':sid=ox.native_shape(doc,original.get('text',''),rect,profile)
        elif kind=='image':sid=ox.image_shape(package,part,doc,rels,original['asset_path'],rect)
        else:
            start=byid[original['start_id']];end=byid[original['end_id']]
            a=start['rect'];b=end['rect']
            p1=(a['x']+a['width']/2,a['y']+a['height']/2);p2=(b['x']+b['width']/2,b['y']+b['height']/2)
            sid=ox.connector(doc,p1,p2,start['shape_id'],end['shape_id'],profile)
        entry={'original_id':original['original_id'],'kind':kind,'origin':'original','shape_id':sid,'rect':rect,
               'evidence_refs':list(original['evidence_refs'])}
        if kind in ('text','shape'):entry['text']=original.get('text','')
        if kind=='image':entry.update({'asset_id':original['asset_id'],'asset_sha256':s.digest(original['asset_path'])})
        if kind=='connector':entry.update({'start_id':original['start_id'],'end_id':original['end_id']})
        created.append(entry);byid[entry['original_id']]=entry
    return created


def arrangement(rect,count,mode):
    gap=30
    if mode=='radial':
        if count<3:raise ValueError('UNSUPPORTED_TRANSFORM: radial requires at least 3 nodes')
        w=h=min(rect['width'],rect['height'])*.27;cx=rect['x']+rect['width']/2;cy=rect['y']+rect['height']/2
        return [{'x':cx-w/2,'y':cy-h/2,'width':w,'height':h}]+[{'x':cx+math.cos(2*math.pi*i/(count-1)-math.pi/2)*(rect['width']-w)/2-w/2,'y':cy+math.sin(2*math.pi*i/(count-1)-math.pi/2)*(rect['height']-h)/2-h/2,'width':w,'height':h} for i in range(count-1)]
    cols=count if mode=='horizontal' else 1 if mode=='vertical' else math.ceil(count/2) if mode=='two_rows' else math.ceil(math.sqrt(count))
    rows=math.ceil(count/cols);w=(rect['width']-(cols-1)*gap)/cols;h=(rect['height']-(rows-1)*gap)/rows
    if w<80 or h<60:raise ValueError('CONTENT_OVERFLOW: nodes cannot fit; change layout or split slide')
    cells=[]
    for i in range(count):
        row=i//cols;col=i%cols
        # Serpentine flow avoids a diagonal connection through other nodes.
        if row%2:col=cols-1-col
        cells.append({'x':rect['x']+col*(w+gap),'y':rect['y']+row*(h+gap),'width':w,'height':h})
    return cells


def append_instance(package,part,doc,rels,inst,library,profile):
    c=lib.get_component(library,inst['component_id'],inst['component_version']);source,ref=lib.source_path(library,c)
    parts,_=s.load_package(source);tr=inst.get('transform');maps=[];allids=[];dependencies=[]
    if tr:
        param=c['parameterization'];items=inst.get('bindings',{}).get('steps',inst.get('bindings',{}).get('items',[]))
        cells=arrangement(inst['rect'],len(items),tr.get('arrangement','horizontal'));anchors=[]
        for i,(item,cell) in enumerate(zip(items,cells)):
            fields={key:str(i+1).zfill(2) if key=='number' else str(item.get(key,'')) for key in param['fields']}
            bindings={shape_id:fields[key] for key,shape_id in param['fields'].items()}
            m=package.import_nodes(parts,ref['part'],param['node_shape_ids'],part,doc,rels,cell,profile,bindings)
            maps.append(m);allids+=m['shape_ids'];dependencies+=m['dependencies'];anchors.append(m['id_map'][param['anchor_shape_id']])
        if c['relation_type']=='process_chain':
            for i in range(len(cells)-1):
                a,b=cells[i:i+2]
                if abs(a['y']-b['y'])>.1:
                    start=(a['x']+a['width']/2,a['y']+a['height']);end=(b['x']+b['width']/2,b['y']);vertical=True
                elif b['x']>a['x']:
                    start=(a['x']+a['width'],a['y']+a['height']/2);end=(b['x'],b['y']+b['height']/2);vertical=False
                else:
                    start=(a['x'],a['y']+a['height']/2);end=(b['x']+b['width'],b['y']+b['height']/2);vertical=False
                allids.append(ox.connector(doc,start,end,anchors[i],anchors[i+1],profile,vertical))
        elif c['relation_type']=='hub' and cells:
            # First node is the center when a hub is requested.
            for i in range(1,len(cells)):
                a,b=cells[0],cells[i]
                ac=(a['x']+a['width']/2,a['y']+a['height']/2);bc=(b['x']+b['width']/2,b['y']+b['height']/2)
                dx,dy=bc[0]-ac[0],bc[1]-ac[1];vertical=abs(dy)>abs(dx)
                if vertical:
                    start=(ac[0],a['y']+a['height'] if dy>0 else a['y']);end=(bc[0],b['y'] if dy>0 else b['y']+b['height'])
                else:
                    start=(a['x']+a['width'] if dx>0 else a['x'],ac[1]);end=(b['x'] if dx>0 else b['x']+b['width'],bc[1])
                allids.append(ox.connector(doc,start,end,anchors[0],anchors[i],profile,vertical))
    else:
        m=package.import_nodes(parts,ref['part'],ref['shape_ids'],part,doc,rels,inst['rect'],profile,inst.get('bindings'))
        maps=[m];allids=m['shape_ids'];dependencies=m['dependencies']
    return {'instance_id':inst['instance_id'],'component_id':c['component_id'],'component_version':c['component_version'],'shape_ids':allids,'dependencies':dependencies,'maps':maps,'rect':inst['rect'],'source_refs':c['source_refs'],'actual_source_ref':copy.deepcopy(ref),'layer':inst.get('layer','content'),'editability':c['editability']}


def instance_fingerprint(parts,part,instance):
    doc=s.parse(parts[part]);byid={s.shape_id(n):n for n in lib.top_shapes(doc)}
    content=[byid[i].toxml() for i in instance['shape_ids'] if i in byid]
    if len(content)!=len(instance['shape_ids']):raise ValueError('SOURCE_CHANGED: instance object missing')
    deps={p:hashlib.sha256(parts[p]).hexdigest() for p in instance['dependencies'] if p in parts}
    return lib.fingerprint({'xml':content,'dependencies':deps})


def finish(package,compiled,state,output):
    output=Path(output).resolve()
    if output.exists() or output.with_suffix('.state.json').exists():raise ValueError('OUTPUT_EXISTS')
    package.write(output)
    state['sha256']=s.digest(output);state['output']=str(output);state['plan']=compiled
    parts,_=s.load_package(output)
    for page in state['slides']:
        for inst in page['instances']:inst['fingerprint']=instance_fingerprint(parts,page['part'],inst)
    statepath=output.with_suffix('.state.json');s.save_json(statepath,state)
    if compiled.get('visual_policy'):
        import visual_composition as visual
        state['visual_audit']=visual.audit(output,compiled,state=state)
        s.save_json(statepath,state)
        if state['visual_audit']['status']!='passed':
            return {'output':str(output),'sha256':state['sha256'],'state':str(statepath),'revision':state['revision'],'warnings':compiled.get('warnings',[]),'qa_status':'blocked','visual_audit':state['visual_audit']}
    return {'output':str(output),'sha256':state['sha256'],'state':str(statepath),'revision':state['revision'],'warnings':compiled.get('warnings',[]),'qa_status':'pending'}


def order_page(doc,title_id,instances,slide,originals=()):
    tree=s.first(doc,'p','spTree');nodes={s.shape_id(n):n for n in lib.top_shapes(doc)}
    backgrounds={i['instance_id'] for i in slide['instances'] if i.get('layer')=='background'}
    sequence=[sid for i in instances if i['instance_id'] in backgrounds for sid in i['shape_ids']]+[title_id]+[sid for i in instances if i['instance_id'] not in backgrounds for sid in i['shape_ids']]+[o['shape_id'] for o in originals]
    for sid in sequence:
        if sid in nodes:tree.appendChild(nodes[sid])


def cached_result(output,statepath,state):
    result={'output':str(output),'sha256':state['sha256'],'state':str(statepath),'revision':state['revision'],'warnings':state['plan'].get('warnings',[]),'qa_status':'pending','reused':True}
    if state['plan'].get('visual_policy'):
        import visual_composition as visual
        report=visual.audit(output,state['plan'],state=state)
        result['visual_audit']=report
        if report['status']!='passed':result['qa_status']='blocked'
    return result


def append_page(package,slide,library,profile):
    part,doc,rels=package.blank_page()
    title_id=ox.text_shape(doc,slide.get('title',''),{'x':52,'y':32,'width':profile['slide_size']['width']-104,'height':70},profile,28)
    instances=[append_instance(package,part,doc,rels,inst,library,profile) for inst in sorted(slide['instances'],key=lambda i:i.get('layer')!='background')]
    originals=append_originals(package,part,doc,rels,slide,profile)
    order_page(doc,title_id,instances,slide,originals)
    package.save_page(part,doc,rels)
    return {'slide_id':slide['slide_id'],'part':part,'title_shape_id':title_id,'instances':instances,'originals':originals}


def retained_base(compiled,source,previous_state,expected_sha256):
    if any(v is None for v in (source,previous_state,expected_sha256)):raise ValueError('VERSION_CONFLICT: incomplete retained sample')
    source=Path(source).resolve()
    old=s.read_json(previous_state) if isinstance(previous_state,(str,Path)) else copy.deepcopy(previous_state)
    if s.digest(source)!=expected_sha256 or old.get('sha256')!=expected_sha256 or old.get('project_id')!=compiled['project_id']:
        raise ValueError('VERSION_CONFLICT: sample source/state')
    oldplan=old.get('plan',{});oldstyle=oldplan.get('style_source')
    if not oldstyle or s.digest(oldstyle)!=oldplan.get('style_sha256'):raise ValueError('SOURCE_CHANGED: saved sample style')
    if compiled['style_sha256']!=oldplan['style_sha256']:
        raise ValueError('SOURCE_CHANGED: retained sample cannot change master style')
    prefix=oldplan.get('slides',[])
    if not prefix or len(compiled['slides'])<=len(prefix) or compiled['slides'][:len(prefix)]!=prefix:
        raise ValueError('PLAN_PREFIX_MISMATCH: sample pages must be retained unchanged')
    package=ox.Package(source)
    if len(package.originals)!=len(prefix) or len(old.get('slides',[]))!=len(prefix) or [x['part'] for x in old['slides']]!=package.originals:
        raise ValueError('VERSION_CONFLICT: sample page order or state')
    package.pages=list(package.originals)
    return package,old,len(prefix)


def build(plan,library,output,source=None,previous_state=None,expected_sha256=None):
    output=Path(output).resolve();statepath=output.with_suffix('.state.json')
    request_hash=lib.fingerprint({'plan':plan,'expected_sha256':expected_sha256})
    if output.exists() and statepath.exists():
        old=s.read_json(statepath)
        if old.get('request_hash')==request_hash and old.get('sha256')==s.digest(output):
            return cached_result(output,statepath,old)
        raise ValueError('OUTPUT_EXISTS: request or artifact differs')
    # Retained objects are audited from their embedded package, not rebuilt from deleted uploads.
    compiled=compile_plan(plan,library,geometry_preflight=source is None);profile=compiled['style_profile']
    if any(v is not None for v in (source,previous_state,expected_sha256)):
        package,old,start=retained_base(compiled,source,previous_state,expected_sha256)
        state=copy.deepcopy(old);state['slides']=copy.deepcopy(old['slides']);state['revision']+=1;state['parent_sha256']=expected_sha256
    else:
        package=ox.Package(compiled['style_source']);start=0
        state={'schema_version':1,'project_id':compiled['project_id'],'revision':1,'slides':[]}
    state['request_id']=compiled.get('request_id');state['request_hash']=request_hash
    for slide in compiled['slides'][start:]:
        state['slides'].append(append_page(package,slide,library,profile))
    return finish(package,compiled,state,output)


def apply_revision(source,state,operations,library,output,expected_sha256):
    source=Path(source);state=s.read_json(state) if isinstance(state,(str,Path)) else copy.deepcopy(state)
    if s.digest(source)!=expected_sha256 or state.get('sha256')!=expected_sha256:raise ValueError('VERSION_CONFLICT')
    if not isinstance(operations,list) or not 1<=len(operations)<=1000:raise ValueError('INVALID_OPERATIONS')
    request_hash=lib.fingerprint({'parent':expected_sha256,'operations':operations,'state':state})
    output=Path(output).resolve();statepath=output.with_suffix('.state.json')
    if output.exists() and statepath.exists():
        old=s.read_json(statepath)
        if old.get('request_hash')==request_hash and old.get('sha256')==s.digest(output):
            return cached_result(output,statepath,old)
        raise ValueError('OUTPUT_EXISTS: request or artifact differs')
    plan=copy.deepcopy(state['plan']);changed=set();raw=[];raw_owners={};titles={};native=[]
    for op in operations:
        if not isinstance(op,dict):raise ValueError('INVALID_OPERATIONS: object required')
        slide=next((x for x in plan['slides'] if x['slide_id']==op.get('slide_id')),None)
        if slide is None:raise ValueError('INVALID_SLIDE')
        action=op.get('op');iid=op.get('instance_id');inst=next((x for x in slide['instances'] if x['instance_id']==iid),None)
        if action in ('lock-component','unlock-component'):
            if inst is None:raise ValueError('COMPONENT_NOT_FOUND')
            slide['locks']=[l for l in slide.get('locks',[]) if l.get('instance_id')!=iid]
            if action=='lock-component':slide['locks'].append({'instance_id':iid})
        elif action in ('lock-region','unlock-region'):
            lockid=op.get('lock_id')
            if not lockid:raise ValueError('INVALID_LOCK')
            slide['locks']=[l for l in slide.get('locks',[]) if l.get('lock_id')!=lockid]
            if action=='lock-region':slide['locks'].append({'lock_id':lockid,'rect':op['rect']})
        else:
            protected={l['instance_id'] for l in slide.get('locks',[]) if 'instance_id' in l}
            protected.update(i['instance_id'] for l in slide.get('locks',[]) if 'rect' in l for i in slide['instances'] if intersect(i['rect'],l['rect']))
            if action in ('insert-text','insert-image','delete-shape'):
                page=next(x for x in state['slides'] if x['slide_id']==slide['slide_id'])
                if action.startswith('insert-'):
                    rect={key:op.get(key,default) for key,default in (('x',80),('y',80),('width',240),('height',120))}
                    rect_ok(rect,plan['style_profile']['slide_size'])
                    if action=='insert-text' and not isinstance(op.get('text'),str):raise ValueError('INVALID_BINDING: text required')
                    if action=='insert-image' and not op.get('asset_path'):raise ValueError('SOURCE_NOT_FOUND: image required')
                    reserved=[l['rect'] for l in slide.get('locks',[]) if 'rect' in l]+[i['rect'] for i in slide['instances'] if i['instance_id'] in protected]
                    if any(intersect(rect,lock) for lock in reserved):raise ValueError('LOCK_CONFLICT: insertion touches locked region')
                    native.append((slide['slide_id'],op,rect));continue
                sid=str(op.get('shape_id'))
                owner=next((i for i in page['instances'] if sid in i['shape_ids']),None)
                if owner and owner['instance_id'] in protected:raise ValueError('LOCK_CONFLICT: protected component')
                if not owner and sid!=str(page.get('title_shape_id')) and not any(str(o['shape_id'])==sid for o in page.get('originals',[])):
                    raise ValueError('SOURCE_NOT_FOUND: native shape')
                native.append((slide['slide_id'],op,None));continue
            if action=='set-title':
                if not isinstance(op.get('text'),str):raise ValueError('INVALID_BINDING')
                title_rect={'x':52,'y':32,'width':plan['style_profile']['slide_size']['width']-104,'height':70}
                if any('rect' in l and intersect(title_rect,l['rect']) for l in slide.get('locks',[])):raise ValueError('LOCK_CONFLICT')
                slide['title']=op['text'];titles[slide['slide_id']]=op['text'];continue
            if action in ('set-text','replace-text','geometry','table-cell'):
                page=next(x for x in state['slides'] if x['slide_id']==slide['slide_id'])
                owner=next((x for x in page['instances'] if str(op.get('shape_id')) in x['shape_ids'] or any(str(op.get('shape_id')) in m['id_map'].values() for m in x['maps'])),None)
                original=next((o for o in page.get('originals',[]) if str(o['shape_id'])==str(op.get('shape_id'))),None)
                if owner is None and original is None or owner and owner['instance_id'] in protected:raise ValueError('LOCK_CONFLICT: unowned or protected object')
                if original:
                    reserved=[l['rect'] for l in slide.get('locks',[]) if 'rect' in l]+[i['rect'] for i in slide['instances'] if i['instance_id'] in protected]
                    if original.get('rect') and any(intersect(original['rect'],rect) for rect in reserved):
                        raise ValueError('LOCK_CONFLICT: original object is already inside protected region')
                rawop={k:v for k,v in op.items() if k not in ('slide_id','instance_id')}|{'slide':state['slides'].index(page)+1}
                raw.append(rawop);raw_owners[len(raw)-1]=(slide['slide_id'],owner['instance_id'] if owner else None);continue
            if action=='regenerate-region':
                region=op['rect'];targets=[i for i in slide['instances'] if intersect(i['rect'],region)]
                if any(i['instance_id'] in protected for i in targets):raise ValueError('LOCK_CONFLICT')
                replacements=op.get('instances')
                if not isinstance(replacements,list) or not replacements:raise ValueError('INVALID_PLAN: model must supply replacement instances')
                for replacement in replacements:
                    if not (replacement['rect']['x']>=region['x'] and replacement['rect']['y']>=region['y'] and replacement['rect']['x']+replacement['rect']['width']<=region['x']+region['width'] and replacement['rect']['y']+replacement['rect']['height']<=region['y']+region['height']):raise ValueError('INVALID_PLAN: replacement escapes region')
                slide['instances']=[i for i in slide['instances'] if i not in targets]+replacements
                changed.update((slide['slide_id'],i['instance_id']) for i in targets+replacements);continue
            if inst is None:raise ValueError('COMPONENT_NOT_FOUND')
            if iid in protected:raise ValueError('LOCK_CONFLICT')
            if inst.get('native_geometry_override') and not op.get('discard_native_edits'):raise ValueError('NATIVE_EDIT_REQUIRES_REEXTRACT: lock/re-extract or explicitly discard native geometry')
            if op.get('discard_native_edits'):inst.pop('native_geometry_override',None)
            if action=='set-binding':inst.setdefault('bindings',{})[op['key']]=op['value']
            elif action=='set-geometry':inst['rect']=op['rect']
            elif action=='set-node-count':
                inst.setdefault('transform',{})['node_count']=op['count']
                if 'items' in op:inst.setdefault('bindings',{})['steps']=op['items']
            elif action=='set-arrangement':inst.setdefault('transform',{})['arrangement']=op['arrangement']
            elif action=='replace-component':
                replacement=copy.deepcopy(op['instance']);replacement['instance_id']=iid
                slide['instances'][slide['instances'].index(inst)]=replacement
            else:raise ValueError('INVALID_OPERATION: '+str(action))
            changed.add((slide['slide_id'],iid))
    compiled=compile_plan(plan,library,geometry_preflight=False);package=ox.Package(source);package.pages=package.originals[:]
    newstate=copy.deepcopy(state);newstate['revision']+=1;newstate['parent_sha256']=expected_sha256;newstate['request_hash']=request_hash
    for page in newstate['slides']:
        slide=next(x for x in compiled['slides'] if x['slide_id']==page['slide_id']);part=page['part']
        targets={iid for sid,iid in changed if sid==page['slide_id']}
        if not targets and page['slide_id'] not in titles:continue
        doc=s.parse(package.parts[part]);rels=s.parse(package.parts[s.rel_path(part)]);tree=s.first(doc,'p','spTree')
        remove={i for inst in page['instances'] if inst['instance_id'] in targets for i in inst['shape_ids']}
        for n in list(lib.top_shapes(doc)):
            if s.shape_id(n) in remove:tree.removeChild(n)
        page['instances']=[i for i in page['instances'] if i['instance_id'] not in targets]
        for inst in slide['instances']:
            if inst['instance_id'] in targets:page['instances'].append(append_instance(package,part,doc,rels,inst,library,compiled['style_profile']))
        if page['slide_id'] in titles:
            node=next((n for n in lib.top_shapes(doc) if s.shape_id(n)==page['title_shape_id']),None)
            if node is None:page['title_shape_id']=ox.text_shape(doc,titles[page['slide_id']],{'x':52,'y':32,'width':compiled['style_profile']['slide_size']['width']-104,'height':70},compiled['style_profile'],28)
            else:ox.replace_body(s.first(node,'p','txBody'),titles[page['slide_id']])
        order_page(doc,page['title_shape_id'],page['instances'],slide,page.get('originals',[]))
        package.save_page(part,doc,rels)
    if raw:
        if set(raw_owners.values()) & changed:raise ValueError('INVALID_OPERATIONS: apply raw and component rebuild in separate revisions')
        s.apply_operations(package.parts,raw)
        for ri,op in enumerate(raw):
            sid,iid=raw_owners[ri];page=next(p for p in newstate['slides'] if p['slide_id']==sid)
            sl=next(p for p in compiled['slides'] if p['slide_id']==sid)
            doc=s.parse(package.parts[page['part']]);allshapes=[n for n,_ in s.shape_nodes(doc)]
            node=next(n for n in allshapes if s.shape_id(n)==str(op['shape_id']))
            if iid is None:
                original=next(o for o in page['originals'] if str(o['shape_id'])==str(op['shape_id']))
                original['rect']=s.geometry(s.inherited_transform(package.parts,page['part'],node))
                if op['op'] in ('set-text','replace-text'):original['text']=s.text_content(node)
                planned=next((item for item in sl.get('originals',[]) if item['original_id']==original.get('original_id')),None)
                if planned:
                    planned['rect']=original['rect']
                    if 'text' in original:planned['text']=original['text']
                reserved=[l['rect'] for l in sl.get('locks',[]) if 'rect' in l]+[i['rect'] for i in page['instances'] if any(l.get('instance_id')==i['instance_id'] for l in sl.get('locks',[]))]
                if original['rect'] and any(intersect(original['rect'],r) for r in reserved):raise ValueError('LOCK_CONFLICT: original enters protected region')
                continue
            im=next(i for i in page['instances'] if i['instance_id']==iid)
            inst=next(i for i in sl['instances'] if i['instance_id']==iid)
            if op['op']=='geometry':
                box=lib.bounds([n for n in lib.top_shapes(doc) if s.shape_id(n) in im['shape_ids']],package.parts,page['part']);im['rect']=box;inst['rect']=box;inst['native_geometry_override']=True
            else:
                value={'cells':[[s.text_content(c) for c in s.children(row,'a','tc')] for row in s.nodes(node,'a','tr')]} if op['op']=='table-cell' else s.text_content(node)
                mapped=next((mi,old) for mi,m in enumerate(im['maps']) for old,new in m['id_map'].items() if new==str(op['shape_id']))
                mi,old=mapped
                if inst.get('transform'):
                    c=lib.get_component(library,inst['component_id'],inst['component_version']);field=next((key for key,value_id in c['parameterization']['fields'].items() if value_id==old),None)
                    if field is None:raise ValueError('NATIVE_EDIT_REQUIRES_REEXTRACT: unbound repeated node')
                    key='steps' if 'steps' in inst['bindings'] else 'items';inst['bindings'][key][mi][field]=value
                else:inst.setdefault('bindings',{})[old]=value
    for sid,op,rect in native:
        page=next(p for p in newstate['slides'] if p['slide_id']==sid)
        slide=next(p for p in compiled['slides'] if p['slide_id']==sid)
        part=page['part'];doc=s.parse(package.parts[part]);rels=s.parse(package.parts[s.rel_path(part)])
        if op['op']=='insert-text':
            shape_id=ox.text_shape(doc,op['text'],rect,compiled['style_profile'])
        elif op['op']=='insert-image':
            shape_id=ox.image_shape(package,part,doc,rels,op['asset_path'],rect)
        else:
            shape_id=str(op['shape_id']);match=next(((n,grouped) for n,grouped in s.shape_nodes(doc) if s.shape_id(n)==shape_id),None)
            if not match or match[1]:raise ValueError('UNSUPPORTED_OBJECT: grouped or missing shape')
            node=match[0];ids={n.getAttribute('id') for n in s.nodes(node,'p','cNvPr')}
            if any(anchor.getAttribute('id') in ids for tag in ('stCxn','endCxn') for anchor in s.nodes(doc,'a',tag) if not node.isSameNode(anchor.parentNode)):
                raise ValueError('DEPENDENCY_CONFLICT: shape has connector')
            bounds=s.geometry(s.inherited_transform(package.parts,part,node))
            reserved=[l['rect'] for l in slide.get('locks',[]) if 'rect' in l]+[i['rect'] for i in page['instances'] if any(l.get('instance_id')==i['instance_id'] for l in slide.get('locks',[]))]
            if bounds and any(intersect(bounds,r) for r in reserved):raise ValueError('LOCK_CONFLICT: deletion touches protected region')
            owner=next((i for i in page['instances'] if shape_id in i['shape_ids']),None)
            if owner:
                if len(owner['shape_ids'])<=1:raise ValueError('NATIVE_EDIT_REQUIRES_REEXTRACT: cannot remove entire component')
                owner['shape_ids'].remove(shape_id)
                for mapping in owner['maps']:
                    mapping['shape_ids']=[v for v in mapping['shape_ids'] if v!=shape_id]
                    mapping['id_map']={k:v for k,v in mapping['id_map'].items() if v not in ids}
                next(i for i in slide['instances'] if i['instance_id']==owner['instance_id'])['native_geometry_override']=True
            elif shape_id==str(page.get('title_shape_id')):
                page['title_shape_id']=None;slide['title']=''
            else:
                original=next(o for o in page.get('originals',[]) if str(o['shape_id'])==shape_id)
                if any(o.get('kind')=='connector' and original.get('original_id') in (o.get('start_id'),o.get('end_id')) for o in page.get('originals',[])):
                    raise ValueError('DEPENDENCY_CONFLICT: connector depends on original')
                page['originals']=[o for o in page['originals'] if o is not original]
                slide['originals']=[o for o in slide.get('originals',[]) if o.get('original_id')!=original.get('original_id')]
            node.parentNode.removeChild(node)
        if op['op'].startswith('insert-'):
            entry={'shape_id':shape_id,'kind':'text' if op['op']=='insert-text' else 'image','origin':'original','rect':rect}
            if op['op']=='insert-text':entry['text']=op['text']
            else:entry['asset_id']=op.get('asset_id');entry['asset_sha256']=s.digest(op['asset_path'])
            page.setdefault('originals',[]).append(entry)
        package.save_page(part,doc,rels)
    # Compare protected objects and dependent parts before writing a revision.
    for page in newstate['slides']:
        slide=next(x for x in compiled['slides'] if x['slide_id']==page['slide_id'])
        oldpage=next(x for x in state['slides'] if x['slide_id']==page['slide_id'])
        locks=slide.get('locks',[])
        reserved=[l['rect'] for l in locks if 'rect' in l]+[i['rect'] for l in locks if 'instance_id' in l for i in oldpage['instances'] if i['instance_id']==l['instance_id']]
        touched={iid for sid,iid in changed|set(raw_owners.values()) if sid==page['slide_id']}
        for inst in page['instances']:
            if inst['instance_id'] in touched and any(intersect(inst['rect'],rect) for rect in reserved):raise ValueError('LOCK_CONFLICT: changed object enters protected area')
        for inst in oldpage['instances']:
            if inst['instance_id'] in slide['protected_instance_ids'] and instance_fingerprint(package.parts,page['part'],inst)!=inst['fingerprint']:raise ValueError('LOCK_CONFLICT: locked XML or dependency changed')
    compiled=compile_plan(compiled,library,geometry_preflight=False)
    return finish(package,compiled,newstate,output)
