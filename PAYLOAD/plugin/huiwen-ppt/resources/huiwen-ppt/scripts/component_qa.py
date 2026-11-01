"""Structural gates and explicit native-render/visual-review evidence."""
import math
import hashlib
from pathlib import Path
import studio as s
import component_library as lib
import component_compose as compose


def check(source,state=None,engine=None,render_dir=None,review=None):
    source=Path(source);sha=s.digest(source);parts,_=s.load_package(source);slides,size=s.slide_parts(parts)
    errors=[];warnings=[];text_boxes=[]
    for number,part in enumerate(slides,1):
        doc=s.parse(parts[part]);ids=[n.getAttribute('id') for n in s.nodes(doc,'p','cNvPr')]
        if len(ids)!=len(set(ids)):errors.append({'slide':number,'code':'DUPLICATE_SHAPE_ID'})
        for r in s.relationships(parts,part).values():
            if r.getAttribute('TargetMode')!='External' and s.resolve(part,r.getAttribute('Target')) not in parts:errors.append({'slide':number,'code':'DEPENDENCY_MISSING'})
        for tag in ('stCxn','endCxn'):
            for n in s.nodes(doc,'a',tag):
                if n.getAttribute('id') not in ids:errors.append({'slide':number,'code':'DANGLING_CONNECTOR'})
        for n,grouped in s.shape_nodes(doc):
            if grouped:continue # Native renderer measures nested group geometry.
            b=s.geometry(s.inherited_transform(parts,part,n));text=s.text_content(n)
            if not b:continue
            if b['x']<-.5 or b['y']<-.5 or b['x']+b['width']>size['width']+.5 or b['y']+b['height']>size['height']+.5:errors.append({'slide':number,'shape_id':s.shape_id(n),'code':'OUT_OF_BOUNDS'})
            if text:
                sizes=[int(p.getAttribute('sz'))/100 for p in s.nodes(n,'a','rPr')+s.nodes(n,'a','defRPr') if p.hasAttribute('sz')]
                if sizes and min(sizes)<10:warnings.append({'slide':number,'shape_id':s.shape_id(n),'code':'SMALL_TEXT','min_pt':min(sizes)})
                text_boxes.append({'slide':number,'shape_id':s.shape_id(n),'rect':b})
    # Traverse all package relationships, including chart -> workbook dependencies.
    for rp in parts:
        if not rp.endswith('.rels'):continue
        part='' if rp=='_rels/.rels' else rp.replace('/_rels/','/')[:-5]
        for r in s.nodes(s.parse(parts[rp]),'rel','Relationship'):
            if r.getAttribute('TargetMode')!='External' and s.resolve(part,r.getAttribute('Target')) not in parts:errors.append({'part':part,'code':'DEPENDENCY_MISSING'})
    for part,data in parts.items():
        if not part.endswith('.xml'):continue
        doc=s.parse(data);rels=s.relationships(parts,part)
        for n in doc.getElementsByTagName('*'):
            for attr in n.attributes.values() if n.attributes else []:
                if attr.namespaceURI==s.NS['r'] and attr.value not in rels:errors.append({'part':part,'code':'RELATIONSHIP_ID_MISSING','relationship_id':attr.value})
    if state:
        state=s.read_json(state) if isinstance(state,(str,Path)) else state
        if state.get('sha256')!=sha:errors.append({'code':'VERSION_CONFLICT'})
        for index,part in enumerate(slides):
            planned=state['plan']['slides'][index] if index<len(state['plan']['slides']) else {}
            page=state['slides'][index] if index<len(state['slides']) else {}
            originals=page.get('originals',[]);planned_originals={o['original_id']:o for o in planned.get('originals',[])};expected=set(planned_originals)
            actual={o.get('original_id') for o in originals}
            if planned.get('reuse_requirement')=='original' and (not originals or not expected<=actual):
                errors.append({'slide':index+1,'code':'ORIGINAL_MISSING'})
            doc=s.parse(parts[part]);byid={s.shape_id(n):n for n,grouped in s.shape_nodes(doc) if not grouped}
            relationships=s.relationships(parts,part)
            for original in originals:
                sid=str(original.get('shape_id'));node=byid.get(sid);kind=original.get('kind')
                if (original.get('origin')!='original' or original.get('actual_source_ref') or original.get('maps') or node is None or
                    kind not in ('text','shape','connector','image') or node.localName!=('pic' if kind=='image' else 'cxnSp' if kind=='connector' else 'sp')):
                    errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_SOURCE_INVALID'});continue
                planned_item=planned_originals.get(original.get('original_id'))
                if planned_item and original.get('evidence_refs')!=planned_item.get('evidence_refs'):
                    errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_EVIDENCE_MISMATCH'})
                if kind in ('text','shape') and s.text_content(node)!=original.get('text',''):
                    errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_TEXT_MISMATCH'})
                recorded=original.get('rect');measured=s.geometry(s.inherited_transform(parts,part,node))
                if not isinstance(recorded,dict) or not measured or any(not isinstance(recorded.get(key),(int,float)) or abs(measured[key]-recorded[key])>1 for key in ('x','y','width','height')):
                    errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_GEOMETRY_MISMATCH'})
                if kind=='image':
                    blip=s.first(node,'a','blip');rid=blip.getAttributeNS(s.NS['r'],'embed') if blip else ''
                    rel=relationships.get(rid);media=s.resolve(part,rel.getAttribute('Target')) if rel else ''
                    if media not in parts or hashlib.sha256(parts[media]).hexdigest()!=original.get('asset_sha256'):
                        errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_ASSET_MISMATCH'})
                if kind=='connector':
                    anchors=[n.getAttribute('id') for tag in ('stCxn','endCxn') for n in s.nodes(node,'a',tag)]
                    targets=[next((str(o.get('shape_id')) for o in originals if o.get('original_id')==original.get(key)),None) for key in ('start_id','end_id')]
                    if anchors!=targets:errors.append({'slide':index+1,'shape_id':sid,'code':'ORIGINAL_CONNECTOR_MISMATCH'})
        warnings.extend(state['plan'].get('warnings',[]))
        if state['plan'].get('visual_policy'):
            import visual_composition as visual
            visual_report=visual.audit(source,state['plan'],state=state)
            errors.extend(visual_report['errors']);warnings.extend(visual_report['warnings'])
    report={'schema_version':1,'source_sha256':sha,'slide_count':len(slides),'structure':'passed' if not errors else 'failed',
            'visual':'pending','editability':'pending','status':'blocked' if errors else 'review_required','errors':errors,'warnings':warnings,'unresolved':errors[:],
            'engine':None,'powerpoint':'not_verified','checked_at':s.now()}
    if engine:
        if not render_dir:raise ValueError('RENDER_DIRECTORY_REQUIRED')
        try:report['render']=s.render(source,render_dir,engine);report['engine']=engine
        except (ValueError,OSError) as error:report['errors'].append({'code':'RENDER_UNAVAILABLE','detail':str(error)});report['status']='blocked'
    if review:
        review=s.read_json(review) if isinstance(review,(str,Path)) else review
        if review.get('source_sha256')!=sha:raise ValueError('REVIEW_HASH_MISMATCH')
        render=review.get('render_report',report.get('render'))
        if isinstance(render,str):render=s.read_json(render)
        if not render or render.get('source_sha256')!=sha or render.get('slide_count')!=len(slides):raise ValueError('RENDER_EVIDENCE_REQUIRED')
        report['render']=render;report['engine']=render['engine']
        if review.get('visual')=='passed' and sorted(review.get('reviewed_pages',[]))==list(range(1,len(slides)+1)) and review.get('reviewer'):
            report['visual']='passed'
        if review.get('editability')=='passed' and review.get('editability_report'):
            evidence=s.read_json(review['editability_report'])
            if evidence.get('source_sha256')==sha and evidence.get('status')=='passed':report['editability']='passed';report['editability_evidence']=evidence
        report['unresolved']+=review.get('unresolved',[])
    if report['errors']:report['unresolved']=report['errors']+report['unresolved'];report['status']='blocked'
    elif report['visual']=='passed' and report['editability']=='passed' and not report['unresolved']:report['status']='passed'
    report['output_sha256']=sha
    return report
