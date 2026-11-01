"""Regression tests for real search, unchanged lifecycle and non-label reuse gates."""
import copy,json,tempfile,unittest,sys,shutil
from pathlib import Path
import studio as s
import component_library as lib
import visual_composition as v
import component_compose as compose
import component_qa as qa
from component_ooxml import Package

SKILL=Path(__file__).resolve().parent.parent
LIBRARY=SKILL/'assets/components'
SOURCE=SKILL/'assets/clean-business/reference.pptx'

class VisualTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def build(self,duplicate=False):
  p=Package(SOURCE);parts,_=s.load_package(SOURCE);slides,_=s.slide_parts(parts)
  records=[]
  for page in range(1,3 if duplicate else 2):
   part,doc,rels=p.blank_page()
   result=p.import_nodes(parts,slides[24],['35','36'],part,doc,rels,{'x':240,'y':210,'width':240,'height':180})
   p.save_page(part,doc,rels)
   records.append({'page':page,'source_file':str(SOURCE),'source_sha256':s.digest(SOURCE),'source_part':slides[24],'source_shape_ids':['35','36'],'id_map':result['id_map']})
  f=self.root/'output.pptx';p.write(f)
  plan={'slides':[{'composition_family':f'unique-family-{i}'} for i in range(len(records))]}
  reuse={'output_sha256':s.digest(f),'imports':records}
  return f,plan,reuse
 def test_catalog_covers_both_current_templates(self):
  data=s.read_json(LIBRARY/'visual-catalog.json')
  self.assertEqual(len(data['coverage']),55)
  self.assertEqual({r['template_id'] for r in data['coverage']},{'clean','illustrated'})
  for row in data['entries']:
   c=lib.get_component(LIBRARY,row['component_id'],row['component_version'])
   self.assertTrue(v.annotation(c,v.catalog(LIBRARY)))
 def test_robot_and_architecture_found_with_real_source(self):
  robots=v.search(LIBRARY,'机器人')
  self.assertTrue(any(c['visual_semantics'].get('description')=='机器人 智能体 辅助助手 无品牌 笔记本' for c in robots))
  self.assertTrue(any(c['granularity']=='semantic' for c in robots))
  self.assertTrue(v.search(LIBRARY,'智能体协作'))
  self.assertTrue(v.search(LIBRARY,'政策核验'))
  self.assertTrue(lib.search(LIBRARY,'机器人',scope='trial_candidates'))
 def test_formal_and_current_task_scope_not_bypassed(self):
  self.assertEqual(v.search(LIBRARY,'机器人',scope='formal'),[])
  self.assertEqual(v.search(LIBRARY,'机器人',scope='current_project',project_id='unrelated-new-task'),[])
 def test_retired_candidate_does_not_resurface(self):
  db=s.read_json(LIBRARY/'index.json');cid=v.search(LIBRARY,'机器人')[0]['component_id']
  for c in db['components']:
   if c['component_id']==cid:c['lifecycle']='retired'
  s.save_json(self.root/'index.json',db)
  s.save_json(self.root/'visual-catalog.json',s.read_json(LIBRARY/'visual-catalog.json'))
  shutil.copytree(LIBRARY/'sources',self.root/'sources')
  self.assertNotIn(cid,[c['component_id'] for c in v.search(self.root,'机器人')])
 def test_source_changed_semantics_are_ignored(self):
  c=v.search(LIBRARY,'机器人')[0];entries=v.catalog(LIBRARY)
  entries[(c['component_id'],c['component_version'])]['source_sha256']='0'*64
  self.assertEqual(v.annotation(c,entries),{})
 def test_same_family_is_blocked(self):
  report=v.ledger({'slides':[{'composition_family':'four-cards'},{'composition_family':'four-cards'}]})
  self.assertEqual(report['status'],'failed')
  self.assertEqual(report['conflicts'][0]['code'],'COMPOSITION_REPEATED')
 def test_missing_family_is_blocked(self):
  self.assertEqual(v.ledger({'slides':[{}]})['conflicts'][0]['code'],'COMPOSITION_FAMILY_REQUIRED')
 def test_invalid_plan_is_structured_failure(self):
  with self.assertRaises(ValueError):v.ledger(None)
  with self.assertRaises(ValueError):v.ledger({'slides':[]})
 def test_actual_import_passes(self):
  f,p,r=self.build();result=v.audit(f,p,reuse=r)
  self.assertEqual(result['errors'],[])
  self.assertEqual(result['pages'][0]['visible_imported_native_objects'],2)
 def test_plan_labels_alone_do_not_count_as_reuse(self):
  f,p,r=self.build();r['imports']=[];p['slides'][0]['layout_id']='clean-aihub-06 / adapted'
  self.assertIn('STRUCTURAL_REUSE_REQUIRED',[e['code'] for e in v.audit(f,p,reuse=r)['errors']])
 def test_geometry_duplicate_is_blocked_even_with_different_labels(self):
  f,p,r=self.build(True)
  self.assertIn('GEOMETRY_COMPOSITION_REPEATED',[e['code'] for e in v.audit(f,p,reuse=r)['errors']])
 def test_explicit_fixed_template_policy_can_allow_repeated_geometry(self):
  f,p,r=self.build(True);p['visual_policy']={'unique_compositions':False}
  self.assertEqual(v.audit(f,p,reuse=r)['errors'],[])
 def test_missing_output_and_stale_hash_are_blocked(self):
  f,p,r=self.build();r['imports'][0]['id_map']['35']='99999'
  self.assertIn('ACTUAL_REUSE_INVALID',[e['code'] for e in v.audit(f,p,reuse=r)['errors']])
  r['output_sha256']='0'*64
  self.assertIn('REUSE_REPORT_HASH_MISMATCH',[e['code'] for e in v.audit(f,p,reuse=r)['errors']])
 def test_source_hash_mismatch_is_blocked(self):
  f,p,r=self.build();r['imports'][0]['source_sha256']='0'*64
  self.assertIn('ACTUAL_REUSE_INVALID',[e['code'] for e in v.audit(f,p,reuse=r)['errors']])
 def integrated_plan(self,component_id):
  return {'schema_version':1,'project_id':'visual-integration','style_source':str(SOURCE),
          'visual_policy':{'unique_compositions':True},'slides':[{'slide_id':'one','title':'真实组合测试',
          'composition_family':'native-group','reuse_requirement':'structural','instances':[
          {'instance_id':'diagram','component_id':component_id,'trial_candidate':True,
           'allow_template_examples':True,'evidence_refs':['fixture-only'],
           'rect':{'x':150,'y':180,'width':800,'height':400}}]}]}
 def test_native_group_build_and_qa_resolve_exact_nested_source(self):
  p=self.integrated_plan('clean-ff42aafb535d1e88b6')
  result=compose.build(p,LIBRARY,self.root/'group.pptx')
  self.assertEqual(result['qa_status'],'pending')
  state=s.read_json(result['state']);inst=state['slides'][0]['instances'][0]
  self.assertIn('actual_source_ref',inst)
  self.assertGreater(len(inst['maps'][0]['id_map']),len(inst['actual_source_ref']['shape_ids']))
  self.assertEqual(state['visual_audit']['errors'],[])
  self.assertEqual(qa.check(result['output'],state=state)['structure'],'passed')
  # Previously saved state without the new exact-ref field still resolves groups.
  inst.pop('actual_source_ref')
  self.assertEqual(v.audit(result['output'],p,state=state)['errors'],[])
 def test_parameterized_build_has_real_source_for_every_node(self):
  p=self.integrated_plan('four-step-flow');inst=p['slides'][0]['instances'][0]
  inst['transform']={'node_count':3,'arrangement':'horizontal'}
  inst['bindings']={'steps':[{'title':f'步骤{i}','description':'依据材料'} for i in range(3)]}
  result=compose.build(p,LIBRARY,self.root/'parameterized.pptx')
  self.assertEqual(s.read_json(result['state'])['visual_audit']['errors'],[])
 def test_compiler_rejects_duplicate_compositions(self):
  p=self.integrated_plan('four-step-flow');p['slides'].append(copy.deepcopy(p['slides'][0]));p['slides'][1]['slide_id']='two'
  with self.assertRaisesRegex(ValueError,'COMPOSITION_CONFLICT'):compose.compile_plan(p,LIBRARY)
 def test_cached_build_cannot_bypass_invalid_reuse_evidence(self):
  p=self.integrated_plan('clean-ff42aafb535d1e88b6');dest=self.root/'cached.pptx'
  result=compose.build(p,LIBRARY,dest);state=s.read_json(result['state'])
  state['slides'][0]['instances'][0]['actual_source_ref']['source_sha256']='0'*64
  s.save_json(result['state'],state)
  self.assertEqual(compose.build(p,LIBRARY,dest)['qa_status'],'blocked')

if __name__=='__main__':unittest.main()
