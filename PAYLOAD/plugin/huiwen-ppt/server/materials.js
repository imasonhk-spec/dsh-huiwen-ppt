import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectDir, loadProject } from './projects.js';
import { readJson, writeJson, sha256Buf, nowIso, runCmd } from './util.js';
import { config } from './config.js';
import { withProjectLock } from './workflow.js';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'extract-text.py');
const TEXT = new Set(['.txt', '.md', '.markdown']);
const EXTRACT = new Set(['.docx','.docm','.pptx','.ppsx','.potx','.pptm','.xlsx','.xlsm','.pdf']);
const IMAGES = new Set(['png','jpg','jpeg','webp','gif','bmp','svg']);
export function isVisualReference(entry) { return IMAGES.has(entry.type); }
function materialRole(entry) {
  if (!isVisualReference(entry)) return entry;
  const { extraction_error, ...reference } = entry;
  return { ...reference, role: 'visual-reference', text_extracted: false, extraction_status: 'not-required' };
}
export async function listMaterials(id) { return (await readJson(path.join(projectDir(id), 'materials.json'), [])).map(materialRole); }
export async function listContentMaterials(id) { return (await listMaterials(id)).filter(m => m.role !== 'visual-reference'); }
export async function addMaterial(id, buf, filename) {
  return withProjectLock(id, async () => {
    await loadProject(id);
    const name = path.basename(String(filename || 'material.bin')), ext = path.extname(name).toLowerCase(), sha = sha256Buf(buf);
    const list = await listMaterials(id);
    const hit = list.find((m) => m.sha256 === sha && m.name === name);
    if (hit) return { entry: hit, deduplicated: true };
    const mid = 'mat-' + randomUUID(), file = 'sources/' + mid + ext, target = path.join(projectDir(id), file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf, { flag: 'wx' });
    const entry = materialRole({ id: mid, name, file, size: buf.length, sha256: sha, type: ext.slice(1), text_extracted: false, extraction_status: 'unsupported', added_at: nowIso() });
    if (entry.role !== 'visual-reference') try {
      let extracted;
      if (TEXT.has(ext)) { const text = new TextDecoder('utf-8', { fatal: true }).decode(buf); extracted = { ok: true, text, chars: text.length, truncated: false, blocks: text.split(/\n\s*\n/).map((text,i) => ({ locator: '段落 ' + (i+1), text })) }; }
      else if (EXTRACT.has(ext)) {
        const r = await runCmd(config().python, [SCRIPT, target, '0'], { timeoutMs: 60000 });
        if (r.code !== 0) throw new Error(r.stderr || '正文提取失败');
        extracted = JSON.parse(r.stdout);
      }
      if (extracted?.ok && extracted.text.trim()) {
        await fsp.writeFile(target + '.extract.txt', extracted.text);
        await writeJson(target + '.extract.json', extracted);
        Object.assign(entry, { text_extracted: true, extraction_status: extracted.truncated ? 'partial' : 'complete', text_chars: extracted.chars, blocks: extracted.blocks?.length || 0 });
      } else entry.extraction_error = '格式不支持或未提取到正文；扫描件需要 OCR';
    } catch (e) { entry.extraction_status = 'failed'; entry.extraction_error = e.message; }
    list.push(entry);
    try { await writeJson(path.join(projectDir(id), 'materials.json'), list); }
    catch (e) { await Promise.all([target,target+'.extract.txt',target+'.extract.json'].map((p)=>fsp.rm(p,{force:true}))); throw e; }
    return { entry, deduplicated: false };
  });
}
export async function removeMaterial(id, matId) {
  return withProjectLock(id, async () => {
    const list = await listMaterials(id), entry = list.find((m) => m.id === matId);
    if (!entry) return null;
    const remaining = list.filter((m) => m.id !== matId);
    await writeJson(path.join(projectDir(id), 'materials.json'), remaining);
    if (!remaining.some((m) => m.file === entry.file)) await Promise.all(['','.extract.txt','.extract.json'].map((suffix)=>fsp.rm(path.join(projectDir(id), entry.file + suffix),{force:true})));
    const sourceDir=path.dirname(path.join(projectDir(id),entry.file));
    for(const file of await fsp.readdir(sourceDir)) if(file.startsWith(path.basename(entry.file)+'.summary-')) await fsp.rm(path.join(sourceDir,file),{force:true});
    return entry;
  });
}
