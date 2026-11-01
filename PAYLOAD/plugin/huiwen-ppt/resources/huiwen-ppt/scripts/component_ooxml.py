"""Native OOXML composition. Reuses studio's guarded package I/O."""
import colorsys
import copy
import math
import posixpath
import io
import zipfile
from pathlib import Path
from collections import Counter
from xml.sax.saxutils import escape
import studio as s
import component_library as lib

CNS='http://schemas.openxmlformats.org/drawingml/2006/chart'


def element(doc,prefix,name,attrs=None):
    n=doc.createElementNS(s.NS[prefix],prefix+':'+name)
    for k,v in (attrs or {}).items():n.setAttribute(k,str(v))
    return n


def rgb(value):return tuple(int(value[i:i+2],16)/255 for i in (0,2,4))
def hexrgb(values):return ''.join(f'{round(max(0,min(1,v))*255):02X}' for v in values)


def style_profile(source):
    parts,_=s.load_package(source);slides,size=s.slide_parts(parts)
    colors=Counter();fonts=Counter();schemes={};theme_names=[]
    for part,data in parts.items():
        if part.startswith('ppt/theme/') and part.endswith('.xml'):
            doc=s.parse(data);scheme=s.first(doc,'a','clrScheme')
            if scheme:
                for n in s.children(scheme):
                    child=next(iter(s.children(n)),None)
                    if child:schemes.setdefault(n.localName,child.getAttribute('val') if child.localName=='srgbClr' else child.getAttribute('lastClr'))
            theme_names.append(doc.documentElement.getAttribute('name'))
    for part in slides:
        doc=s.parse(parts[part])
        for n in s.nodes(doc,'a','srgbClr'):
            value=n.getAttribute('val').upper()
            if len(value)==6:colors[value]+=1
        for tag in ('latin','ea','cs'):
            for n in s.nodes(doc,'a',tag):
                value=n.getAttribute('typeface')
                if value and not value.startswith('+'):fonts[value]+=1
    saturated=[(v,n) for v,n in colors.items() if colorsys.rgb_to_hls(*rgb(v))[2]>.25 and .12<colorsys.rgb_to_hls(*rgb(v))[1]<.75]
    primary=max(saturated,key=lambda t:t[1])[0] if saturated else schemes.get('accent1','086440')
    h,_,sat=colorsys.rgb_to_hls(*rgb(primary))
    return {'schema_version':1,'source_sha256':s.digest(source),'slide_size':size,'font':fonts.most_common(1)[0][0] if fonts else '微软雅黑',
            'colors':{'primary':primary,'text':hexrgb(colorsys.hls_to_rgb(h,.12,min(sat,.5))),'surface':hexrgb(colorsys.hls_to_rgb(h,.96,min(sat,.4))),'background':'FFFFFF'},
            'schemes':schemes,'direct_color_counts':dict(colors),'theme_names':theme_names,'line_width_pt':1.5}


def mapped_color(value,profile):
    try:h,l,sat=colorsys.rgb_to_hls(*rgb(value))
    except (ValueError,IndexError):return value
    if sat<.12:return value
    ph,pl,ps=colorsys.rgb_to_hls(*rgb(profile['colors']['primary']))
    if l>.88:return profile['colors']['surface']
    # Preserve luminance hierarchy and readable white labels, adapt hue to target.
    return hexrgb(colorsys.hls_to_rgb(ph,max(.12,min(.76,l)),min(max(.35,sat),max(.55,ps))))


def restyle(node,profile,source_schemes=None):
    schemes=source_schemes or profile.get('schemes',{})
    for n in list(s.nodes(node,'a','schemeClr')):
        key=n.getAttribute('val');key={'tx1':'dk1','tx2':'dk2','bg1':'lt1','bg2':'lt2'}.get(key,key)
        if key in schemes and len(schemes[key])==6:
            new=element(n.ownerDocument,'a','srgbClr',{'val':mapped_color(schemes[key],profile)})
            for child in list(n.childNodes):new.appendChild(child.cloneNode(True))
            n.parentNode.replaceChild(new,n)
    for n in s.nodes(node,'a','srgbClr'):n.setAttribute('val',mapped_color(n.getAttribute('val'),profile))
    for tag in ('latin','ea','cs'):
        for n in s.nodes(node,'a',tag):n.setAttribute('typeface',profile['font'])
    for props in s.nodes(node,'a','rPr')+s.nodes(node,'a','defRPr')+s.nodes(node,'a','endParaRPr'):
        for tag in ('latin','ea','cs'):
            if not s.children(props,'a',tag):props.appendChild(element(props.ownerDocument,'a',tag,{'typeface':profile['font']}))


def fit_node(node,src_box,dst_box,parts=None,part=None):
    sx=dst_box['width']/max(src_box['width'],.001);sy=dst_box['height']/max(src_box['height'],.001)
    x=lib.transform(node)
    if x is None and parts is not None:
        inherited=s.inherited_transform(parts,part,node)
        sp=s.children(node,'p','spPr')
        if inherited is not None and sp:
            x=inherited.cloneNode(True);sp[0].insertBefore(x,sp[0].firstChild)
    if x is None:raise ValueError('UNSUPPORTED_TRANSFORM: missing geometry')
    b=s.geometry(x)
    if b is None:raise ValueError('UNSUPPORTED_TRANSFORM: missing bounds')
    if node.localName in ('pic','grpSp'):
        # Fit pictures and grouped artwork within their mapped cell without distortion.
        scale=min(sx,sy)
        dst_box={'x':dst_box['x']+(b['x']-src_box['x'])*sx+b['width']*(sx-scale)/2,
                 'y':dst_box['y']+(b['y']-src_box['y'])*sy+b['height']*(sy-scale)/2,
                 'width':b['width']*scale,'height':b['height']*scale}
        src_box=b;sx=sy=scale
    # A group keeps its inner coordinate system; scale only the outer transform.
    off=s.first(x,'a','off');ext=s.first(x,'a','ext')
    for key,attr in [('x','x'),('y','y')]:off.setAttribute(attr,str(round((dst_box[key]+(b[key]-src_box[key])*(sx if key=='x' else sy))*s.EMU)))
    ext.setAttribute('cx',str(round(b['width']*sx*s.EMU)));ext.setAttribute('cy',str(round(b['height']*sy*s.EMU)))
    if node.localName!='grpSp':
        for tag in ('rPr','defRPr','endParaRPr'):
            for p in s.nodes(node,'a',tag):
                if p.hasAttribute('sz'):p.setAttribute('sz',str(round(int(p.getAttribute('sz'))*min(sx,sy))))
        for p in s.nodes(node,'a','gridCol'):
            if p.hasAttribute('w'):p.setAttribute('w',str(round(int(p.getAttribute('w'))*sx)))
        for p in s.nodes(node,'a','tr'):
            if p.hasAttribute('h'):p.setAttribute('h',str(round(int(p.getAttribute('h'))*sy)))


def replace_body(body,value):
    if not isinstance(value,str):raise ValueError('INVALID_BINDING: text must be string')
    # Preserve paragraph/run properties for unchanged run layouts. A replacement
    # with differing length keeps the first run style and explicitly marks rebinding.
    s.set_text(body,value)


def bind_table(node,value):
    table=s.first(node,'a','tbl');rows=s.children(table,'a','tr') if table else []
    cells=value.get('cells') if isinstance(value,dict) else None
    if not isinstance(cells,list) or len(cells)!=len(rows):raise ValueError('INVALID_BINDING: table row count')
    for row,values in zip(rows,cells):
        columns=s.children(row,'a','tc')
        if not isinstance(values,list) or len(values)!=len(columns):raise ValueError('INVALID_BINDING: table column count')
        for cell,text in zip(columns,values):
            if cell.getAttribute('hMerge') in ('1','true') or cell.getAttribute('vMerge') in ('1','true'):
                if text not in ('',None):raise ValueError('INVALID_BINDING: merged continuation cell')
            else:replace_body(s.first(cell,'a','txBody'),str(text))


def bind_chart(parts,part,data):
    if not isinstance(data,dict):raise ValueError('INVALID_BINDING: chart object required')
    categories=data.get('categories');series=data.get('series')
    doc=s.parse(parts[part]);nodes=list(doc.getElementsByTagNameNS(CNS,'ser'))
    if not isinstance(categories,list) or not categories or not isinstance(series,list) or len(series)!=len(nodes):raise ValueError('INVALID_BINDING: chart categories/series count')
    if any(not isinstance(x,dict) or not isinstance(x.get('values'),list) or len(x['values'])!=len(categories) or not x.get('name') or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in x['values']) for x in series):raise ValueError('INVALID_BINDING: chart finite numeric values')
    allowed=[]
    for node in nodes:
        for root in s.children(node):
            if root.namespaceURI==CNS and root.localName in ('tx','cat','val'):allowed.extend(root.getElementsByTagNameNS(CNS,'f'))
    if any(f not in allowed for f in doc.getElementsByTagNameNS(CNS,'f')):raise ValueError('UNSUPPORTED_CHART: linked titles/error bars or other workbook formulas must be preserved by a specialized editor')
    workbook=s.linked_part(parts,part,'package')
    if not workbook:raise ValueError('UNSUPPORTED_CHART: no embedded workbook')
    def col(n):
        result=''
        while n:n,r=divmod(n-1,26);result=chr(65+r)+result
        return result
    def tag(name,text=None,attrs=None):
        n=doc.createElementNS(CNS,'c:'+name)
        for k,v in (attrs or {}).items():n.setAttribute(k,str(v))
        if text is not None:n.appendChild(doc.createTextNode(str(text)))
        return n
    def ref(parent,name,formula,values,numeric=False):
        for n in list(parent.childNodes):parent.removeChild(n)
        r=tag(name);r.appendChild(tag('f',formula));cache=tag('numCache' if numeric else 'strCache')
        if numeric:cache.appendChild(tag('formatCode','General'))
        cache.appendChild(tag('ptCount',attrs={'val':len(values)}))
        for i,value in enumerate(values):
            p=tag('pt',attrs={'idx':i});p.appendChild(tag('v',value));cache.appendChild(p)
        r.appendChild(cache);parent.appendChild(r)
    for i,(node,values) in enumerate(zip(nodes,series),2):
        cat=next(iter(node.getElementsByTagNameNS(CNS,'cat')),None);val=next(iter(node.getElementsByTagNameNS(CNS,'val')),None);tx=next(iter(node.getElementsByTagNameNS(CNS,'tx')),None)
        if cat is None or val is None:raise ValueError('UNSUPPORTED_CHART: only category/value charts can bind data')
        if tx is None:tx=tag('tx');node.insertBefore(tx,cat)
        ref(tx,'strRef',f'Sheet1!${col(i)}$1',[values['name']])
        ref(cat,'strRef',f'Sheet1!$A$2:$A${len(categories)+1}',categories)
        ref(val,'numRef',f'Sheet1!${col(i)}$2:${col(i)}${len(categories)+1}',values['values'],True)
    parts[part]=s.xml_bytes(doc)
    ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rows=[]
    matrix=[['Category']+[x['name'] for x in series]]+[[category]+[x['values'][i] for x in series] for i,category in enumerate(categories)]
    for ri,values in enumerate(matrix,1):
        cells=[]
        for ci,value in enumerate(values,1):
            address=f'{col(ci)}{ri}'
            cells.append(f'<c r="{address}"><v>{value}</v></c>' if isinstance(value,(int,float)) else f'<c r="{address}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        rows.append(f'<row r="{ri}">{"".join(cells)}</row>')
    files={
      '[Content_Types].xml':f'<Types xmlns="{s.NS["ct"]}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      '_rels/.rels':f'<Relationships xmlns="{s.NS["rel"]}"><Relationship Id="rId1" Type="{s.NS["r"]}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':f'<workbook xmlns="{ns}" xmlns:r="{s.NS["r"]}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':f'<Relationships xmlns="{s.NS["rel"]}"><Relationship Id="rId1" Type="{s.NS["r"]}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{ns}"><dimension ref="A1:{col(len(series)+1)}{len(categories)+1}"/><sheetData>{"".join(rows)}</sheetData></worksheet>'}
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for filename,xml in files.items():z.writestr(filename,xml.encode())
    parts[workbook]=out.getvalue()


class Package:
    def __init__(self,source):
        self.parts,self.metadata=s.load_package(source);self.ct=s.parse(self.parts['[Content_Types].xml'])
        self.originals,self.size=s.slide_parts(self.parts);self.sequence=0;self.pages=[]
    def unique(self,part):
        self.sequence+=1;folder,name=posixpath.split(part);stem,ext=posixpath.splitext(name)
        target=f'{folder}/{stem}_component_{self.sequence}{ext}'
        while target in self.parts:
            self.sequence+=1;target=f'{folder}/{stem}_component_{self.sequence}{ext}'
        return target
    def content_type(self,source,old,new):
        ct=s.parse(source['[Content_Types].xml'])
        overrides={n.getAttribute('PartName'):n.getAttribute('ContentType') for n in s.nodes(ct,'ct','Override')}
        kind=overrides.get('/'+old)
        if kind:
            n=self.ct.createElementNS(s.NS['ct'],'Override');n.setAttribute('PartName','/'+new);n.setAttribute('ContentType',kind);self.ct.documentElement.appendChild(n)
        else:
            ext=old.rsplit('.',1)[-1];defaults={n.getAttribute('Extension'):n for n in s.nodes(ct,'ct','Default')}
            if ext in defaults and not any(n.getAttribute('Extension')==ext for n in s.nodes(self.ct,'ct','Default')):self.ct.documentElement.appendChild(self.ct.importNode(defaults[ext],True))
    def clone_part(self,source,part,cache,profile=None):
        if part in cache:return cache[part]
        if part not in source:raise ValueError('DEPENDENCY_MISSING: '+part)
        target=self.unique(part);cache[part]=target;self.parts[target]=source[part];self.content_type(source,part,target)
        if profile and part.endswith('.xml') and ('/charts/' in part or '/theme/' in part):
            doc=s.parse(self.parts[target]);restyle(doc,profile);self.parts[target]=s.xml_bytes(doc)
        relname=s.rel_path(part)
        if relname in source:
            doc=s.parse(source[relname])
            for rel in s.nodes(doc,'rel','Relationship'):
                if rel.getAttribute('TargetMode')=='External':continue
                linked=s.resolve(part,rel.getAttribute('Target'))
                if rel.getAttribute('Type').endswith('/slide'):raise ValueError('UNSUPPORTED_DEPENDENCY: slide hyperlink requires explicit remapping')
                dest=self.clone_part(source,linked,cache,profile)
                rel.setAttribute('Target',posixpath.relpath(dest,posixpath.dirname(target)))
            self.parts[s.rel_path(target)]=s.xml_bytes(doc)
        return target
    def blank_page(self):
        sourcepart=self.originals[0];doc=s.parse(self.parts[sourcepart]);tree=s.first(doc,'p','spTree')
        for n in list(s.children(tree)):
            if n.localName not in ('nvGrpSpPr','grpSpPr'):tree.removeChild(n)
        for n in list(s.children(doc.documentElement)):
            if n.localName in ('timing','transition','extLst'):doc.documentElement.removeChild(n)
        doc.documentElement.setAttribute('showMasterSp','0')
        # Avoid the source's inherited background content in new compositions.
        common=s.first(doc,'p','cSld')
        for n in s.children(common,'p','bg'):common.removeChild(n)
        bg=element(doc,'p','bg');props=element(doc,'p','bgPr');fill=element(doc,'a','solidFill');fill.appendChild(element(doc,'a','srgbClr',{'val':'FFFFFF'}));props.appendChild(fill);props.appendChild(element(doc,'a','effectLst'));bg.appendChild(props);common.insertBefore(bg,tree)
        part=self.unique('ppt/slides/slide.xml');self.content_type(self.parts,sourcepart,part)
        rels=s.parse(f'<Relationships xmlns="{s.NS["rel"]}"/>'.encode())
        layout=s.linked_part(self.parts,sourcepart,'slideLayout')
        if layout:self.add_rel(rels,part,s.NS['r']+'/slideLayout',layout)
        return part,doc,rels
    def add_rel(self,rels,part,kind,target,external=False):
        ids={r.getAttribute('Id') for r in s.nodes(rels,'rel','Relationship')};i=1
        while 'rIdComponent'+str(i) in ids:i+=1
        rid='rIdComponent'+str(i);r=rels.createElementNS(s.NS['rel'],'Relationship')
        r.setAttribute('Id',rid);r.setAttribute('Type',kind);r.setAttribute('Target',target if external else posixpath.relpath(target,posixpath.dirname(part)))
        if external:r.setAttribute('TargetMode','External')
        rels.documentElement.appendChild(r);return rid
    def import_nodes(self,source,sourcepart,ids,part,doc,rels,rect,profile=None,bindings=None):
        srcdoc=s.parse(source[sourcepart]);byid={s.shape_id(n):n for n in lib.top_shapes(srcdoc)}
        if any(str(i) not in byid for i in ids):raise ValueError('SOURCE_CHANGED: object missing')
        selected=[doc.importNode(byid[str(i)],True) for i in ids];sourcebox=lib.bounds(selected,source,sourcepart)
        if not sourcebox:raise ValueError('UNSUPPORTED_TRANSFORM')
        tree=s.first(doc,'p','spTree');nextid=max([int(n.getAttribute('id')) for n in s.nodes(doc,'p','cNvPr')],default=0)+1
        idmap={};rmap={};cache={};source_rels=s.relationships(source,sourcepart)
        for n in selected:
            for attr in srcdoc.documentElement.attributes.values():
                if attr.name.startswith('xmlns:'):n.setAttributeNS('http://www.w3.org/2000/xmlns/',attr.name,attr.value)
            for nv in s.nodes(n,'p','cNvPr'):
                old=nv.getAttribute('id');idmap[old]=str(nextid);nv.setAttribute('id',str(nextid));nextid+=1
        for n,oldid in zip(selected,ids):
            for tag in ('stCxn','endCxn'):
                for anchor in s.nodes(n,'a',tag):
                    old=anchor.getAttribute('id')
                    if old not in idmap:raise ValueError('DEPENDENCY_MISSING: connector endpoint outside component')
                    anchor.setAttribute('id',idmap[old])
            for node in [n,*n.getElementsByTagName('*')]:
                for attr in list(node.attributes.values()) if node.attributes else []:
                    if attr.namespaceURI==s.NS['r']:
                        rid=attr.value
                        if rid not in source_rels:raise ValueError('DEPENDENCY_MISSING: '+rid)
                        if rid not in rmap:
                            r=source_rels[rid];external=r.getAttribute('TargetMode')=='External'
                            dest=r.getAttribute('Target') if external else self.clone_part(source,s.resolve(sourcepart,r.getAttribute('Target')),cache,profile)
                            rmap[rid]=self.add_rel(rels,part,r.getAttribute('Type'),dest,external)
                        node.setAttributeNS(s.NS['r'],attr.name,rmap[rid])
            candidates=[n]+[child for child in n.getElementsByTagName('*') if child.namespaceURI==s.NS['p'] and child.localName in ('sp','graphicFrame','pic')]
            for bound_id,value in (bindings or {}).items():
                target=next((child for child in candidates if s.shape_id(child)==idmap.get(bound_id)),None)
                if target is None:continue
                if s.first(target,'a','tbl'):bind_table(target,value)
                elif target.getElementsByTagNameNS(CNS,'chart'):
                    chart=target.getElementsByTagNameNS(CNS,'chart')[0];rid=chart.getAttributeNS(s.NS['r'],'id')
                    targetrel=next(r for r in s.nodes(rels,'rel','Relationship') if r.getAttribute('Id')==rid)
                    bind_chart(self.parts,s.resolve(part,targetrel.getAttribute('Target')),value)
                else:
                    bodies=s.children(target,'p','txBody')
                    if not bodies:raise ValueError('INVALID_BINDING: expected native text shape')
                    replace_body(bodies[0],value)
            fit_node(n,sourcebox,rect,source,sourcepart)
            if profile:restyle(n,profile)
            tree.appendChild(n)
        return {'shape_ids':[s.shape_id(n) for n in selected],'id_map':idmap,'dependencies':list(cache.values())}
    def save_page(self,part,doc,rels):
        self.parts[part]=s.xml_bytes(doc);self.parts[s.rel_path(part)]=s.xml_bytes(rels)
        if part not in self.pages:self.pages.append(part)
    def write(self,path):
        doc=s.parse(self.parts['ppt/presentation.xml']);listing=s.first(doc,'p','sldIdLst')
        for n in list(listing.childNodes):listing.removeChild(n)
        for n in list(s.children(doc.documentElement)):
            if n.localName in ('custShowLst','extLst'):doc.documentElement.removeChild(n)
        rels=s.parse(self.parts[s.rel_path('ppt/presentation.xml')])
        for r in list(s.nodes(rels,'rel','Relationship')):
            if r.getAttribute('Type').endswith('/slide'):r.parentNode.removeChild(r)
        for i,part in enumerate(self.pages,1):
            rid=self.add_rel(rels,'ppt/presentation.xml',s.NS['r']+'/slide',part)
            n=element(doc,'p','sldId',{'id':255+i});n.setAttributeNS(s.NS['r'],'r:id',rid);listing.appendChild(n)
        self.parts['ppt/presentation.xml']=s.xml_bytes(doc);self.parts[s.rel_path('ppt/presentation.xml')]=s.xml_bytes(rels)
        # POTX input must be emitted as a presentation, not a template package.
        for n in s.nodes(self.ct,'ct','Override'):
            if n.getAttribute('PartName')=='/ppt/presentation.xml':n.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
        self.parts['[Content_Types].xml']=s.xml_bytes(self.ct)
        reachable={'[Content_Types].xml','_rels/.rels'}
        def visit(part):
            if part in reachable:return
            if part not in self.parts:raise ValueError('DEPENDENCY_MISSING: '+part)
            reachable.add(part);rp=s.rel_path(part)
            if rp in self.parts:
                reachable.add(rp)
                for r in s.relationships(self.parts,part).values():
                    if r.getAttribute('TargetMode')!='External':visit(s.resolve(part,r.getAttribute('Target')))
        for r in s.nodes(s.parse(self.parts['_rels/.rels']),'rel','Relationship'):
            if r.getAttribute('TargetMode')!='External':visit(s.resolve('',r.getAttribute('Target')))
        for n in list(s.nodes(self.ct,'ct','Override')):
            if n.getAttribute('PartName').lstrip('/') not in reachable:n.parentNode.removeChild(n)
        self.parts['[Content_Types].xml']=s.xml_bytes(self.ct)
        if 'docProps/app.xml' in self.parts:
            app=s.parse(self.parts['docProps/app.xml'])
            for n in app.getElementsByTagNameNS('*','Slides'):
                while n.firstChild:n.removeChild(n.firstChild)
                n.appendChild(app.createTextNode(str(len(self.pages))))
            self.parts['docProps/app.xml']=s.xml_bytes(app)
        s.write_package(path,{p:v for p,v in self.parts.items() if p in reachable},self.metadata)


def next_id(doc):return max([int(n.getAttribute('id')) for n in s.nodes(doc,'p','cNvPr')],default=0)+1


def text_shape(doc,text,rect,profile,size=28,color=None):
    sid=next_id(doc);r=rect;col=color or profile['colors']['text'];font=escape(profile['font'],{'"':'&quot;'})
    xml=f'<p:sp xmlns:p="{s.NS["p"]}" xmlns:a="{s.NS["a"]}"><p:nvSpPr><p:cNvPr id="{sid}" name="Heading {sid}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{round(r["x"]*s.EMU)}" y="{round(r["y"]*s.EMU)}"/><a:ext cx="{round(r["width"]*s.EMU)}" cy="{round(r["height"]*s.EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0"/><a:lstStyle/><a:p><a:r><a:rPr sz="{round(size*100)}"><a:solidFill><a:srgbClr val="{col}"/></a:solidFill><a:latin typeface="{font}"/><a:ea typeface="{font}"/></a:rPr><a:t>{escape(text)}</a:t></a:r></a:p></p:txBody></p:sp>'
    node=doc.importNode(s.parse(xml.encode()).documentElement,True);s.first(doc,'p','spTree').appendChild(node);return str(sid)


def native_shape(doc,text,rect,profile):
    sid=text_shape(doc,text,rect,profile,20)
    node=next(n for n in lib.top_shapes(doc) if s.shape_id(n)==sid)
    props=s.first(node,'p','spPr');fill=s.first(props,'a','noFill');props.removeChild(fill)
    line=s.first(props,'a','ln')
    surface=element(doc,'a','solidFill');surface.appendChild(element(doc,'a','srgbClr',{'val':profile['colors']['surface']}))
    props.insertBefore(surface,line)
    for child in list(s.children(line)):line.removeChild(child)
    ink=element(doc,'a','solidFill');ink.appendChild(element(doc,'a','srgbClr',{'val':profile['colors']['primary']}));line.appendChild(ink)
    return sid


def image_shape(package,part,doc,rels,source,rect):
    source=Path(source);ext=source.suffix.lower().lstrip('.')
    content_type={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','svg':'image/svg+xml'}.get(ext)
    if not content_type:raise ValueError('UNSUPPORTED_OBJECT: image format')
    media=package.unique('ppt/media/inserted.'+ext);package.parts[media]=source.read_bytes()
    if not any(n.getAttribute('Extension')==ext for n in s.nodes(package.ct,'ct','Default')):
        package.ct.documentElement.appendChild(element(package.ct,'ct','Default',{'Extension':ext,'ContentType':content_type}))
    rid=package.add_rel(rels,part,s.NS['r']+'/image',media);sid=next_id(doc);r=rect
    xml=f'<p:pic xmlns:p="{s.NS["p"]}" xmlns:a="{s.NS["a"]}" xmlns:r="{s.NS["r"]}"><p:nvPicPr><p:cNvPr id="{sid}" name="Original image {sid}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="{round(r["x"]*s.EMU)}" y="{round(r["y"]*s.EMU)}"/><a:ext cx="{round(r["width"]*s.EMU)}" cy="{round(r["height"]*s.EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    s.first(doc,'p','spTree').appendChild(doc.importNode(s.parse(xml.encode()).documentElement,True))
    return str(sid)


def connector(doc,start,end,start_id,end_id,profile,vertical=False):
    sid=next_id(doc);x1,y1=start;x2,y2=end;flipx=' flipH="1"' if x2<x1 else '';flipy=' flipV="1"' if y2<y1 else ''
    # idx 3=right, 1=left; vertical edges use bottom/top sites.
    si,ei=((2,0) if y2>=y1 else (0,2)) if vertical else (3,1) if x2>=x1 else (1,3)
    xml=f'<p:cxnSp xmlns:p="{s.NS["p"]}" xmlns:a="{s.NS["a"]}"><p:nvCxnSpPr><p:cNvPr id="{sid}" name="Step connection {sid}"/><p:cNvCxnSpPr><a:stCxn id="{start_id}" idx="{si}"/><a:endCxn id="{end_id}" idx="{ei}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm{flipx}{flipy}><a:off x="{round(min(x1,x2)*s.EMU)}" y="{round(min(y1,y2)*s.EMU)}"/><a:ext cx="{round(abs(x2-x1)*s.EMU)}" cy="{round(abs(y2-y1)*s.EMU)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="{profile["colors"]["primary"]}"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>'
    node=doc.importNode(s.parse(xml.encode()).documentElement,True);s.first(doc,'p','spTree').appendChild(node);return str(sid)
