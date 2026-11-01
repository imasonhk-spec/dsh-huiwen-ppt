#!/usr/bin/env python3
"""Huiwen component commands. JSON input/output; no model or server dependency."""
import argparse
import json
import sys
import zipfile
from pathlib import Path
import studio as s
import component_library as lib
import component_compose as compose
import component_ooxml as ox
import component_qa as qa
import visual_composition as visual


def execute(request):
    if not isinstance(request,dict):raise ValueError('INVALID_REQUEST: object required')
    command=request.get('command');root=request.get('library')
    if command=='capabilities':
        return {'schema_version':1,'commands':['index','search','search-visual','composition-ledger','audit-visual','get','style','compile','build','apply-revision','validate','record-use','promote','retire','restore','thumbnails'],
          'native':['text','shape','group','connector','image','table','category_chart'],
          'parameterizations':['repeat','process_chain','cards','hub'],
          'limits':['Semantic annotations/plans are supplied by the agent, not inferred from filenames.','Unsupported SmartArt/OLE require reconstruction or explicit whole/image fallback.','Visual and editing QA require actual evidence.','Chart data binding preserves chart type and series count.']}
    if command=='index':return lib.index_template(request['source'],root,request['template_id'],request['project_id'],request.get('annotations'))
    if command=='search':return lib.search(root,request.get('query',''),request.get('scope','formal'),request.get('project_id'),request.get('relation'),request.get('excluded_ids'))
    if command=='search-visual':return visual.search(root,request.get('query',''),request.get('scope','trial_candidates'),request.get('project_id'),request.get('relation'),request.get('excluded_ids'))
    if command=='composition-ledger':return visual.ledger(request.get('visual_plan',request.get('plan')))
    if command=='audit-visual':return visual.audit(request['source'],request.get('visual_plan',request.get('plan')),request.get('state'),request.get('reuse'))
    if command=='get':return lib.get_component(root,request['component_id'],request.get('component_version'))
    if command=='style':return ox.style_profile(request['source'])
    if command=='thumbnails':return lib.thumbnails(root,request['template_id'],request['render_dir'])
    if command=='compile':return compose.compile_plan(request['plan'],root,retained_source=request.get('source'),previous_state=request.get('state'),expected_sha256=request.get('expected_sha256'))
    if command=='build':return compose.build(request['plan'],root,request['output'],request.get('source'),request.get('state'),request.get('expected_sha256'))
    if command=='apply-revision':return compose.apply_revision(request['source'],request['state'],request['operations'],root,request['output'],request['expected_sha256'])
    if command=='validate':return qa.check(request['source'],request.get('state'),request.get('engine'),request.get('render_dir'),request.get('review'))
    if command=='record-use':return lib.record_use(root,request['component_id'],request['component_version'],request['task_id'],request['proof'])
    if command=='promote':return lib.promote(root,request['component_id'],request['component_version'],request['confirmed_by'],request['note'],request['proof'])
    if command=='retire':return lib.retire(root,request['component_id'],request['component_version'],request['reason'])
    if command=='restore':return lib.restore(root,request['component_id'],request['component_version'])
    raise ValueError('INVALID_COMMAND')


def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request',help='Path to JSON request. Use - for stdin.');parser.add_argument('--result',help='Write JSON result to file');parser.add_argument('--capabilities',action='store_true')
    args=parser.parse_args()
    try:
        request={'command':'capabilities'} if args.capabilities else json.load(sys.stdin) if args.request=='-' else s.read_json(args.request)
        result={'ok':True,'result':execute(request)}
        if args.result:s.save_json(args.result,result);print(json.dumps({'ok':True,'result_file':str(Path(args.result).resolve())},ensure_ascii=False))
        else:print(json.dumps(result,ensure_ascii=False,indent=2))
    except (ValueError,KeyError,TypeError,OSError,zipfile.BadZipFile) as error:
        result={'ok':False,'error':{'code':str(error).split(':',1)[0] if isinstance(error,ValueError) else 'INVALID_REQUEST','message':str(error)}}
        if args.result:s.save_json(args.result,result)
        print(json.dumps(result,ensure_ascii=False),file=sys.stderr);return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
