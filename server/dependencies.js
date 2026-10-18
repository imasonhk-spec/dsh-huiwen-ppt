import path from 'node:path';
import { projectDir } from './projects.js';
import { readJson, stableHash } from './util.js';
import { isVisualReference } from './materials.js';
function business(value) {
  if (Array.isArray(value)) return value.map(business);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['approvals','updated_at','created_at','selected_at','added_at','revisions','input_fingerprint'].includes(k)).map(([k,v]) => [k,business(v)]));
}
export async function inputFingerprint(id) {
  const dir = projectDir(id);
  return stableHash(await Promise.all(['brief.json','materials.json'].map(async (f) => {
    const value=await readJson(path.join(dir,f),null);
    return business(f==='materials.json' && value ? value.filter(m=>!isVisualReference(m)) : value);
  })));
}
export async function planFingerprint(id) {
  const dir = projectDir(id);
  return stableHash([await inputFingerprint(id), ...await Promise.all(['outline.json','style-selection.json','layout-preferences.json'].map(async (f) => business(await readJson(path.join(dir,f),null))))]);
}
