/**
 * 汇文 PPT 后端 · 材料（server/materials.js，WF-02）
 * 对话附件 + 材料面板双通道：文件存 projects/<id>/sources/，登记 materials.json。
 * .txt/.md 提取纯文本供后续分析；其余登记元数据（内容分析随 WF-10 知识治理接入）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir } from './projects.js';
import { readJson, writeJson, sha256File, nowIso, runCmd } from './util.js';
import { config } from './config.js';

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown']);
/* OOXML 系：经 scripts/extract-text.py（纯标准库）提取正文，登记 .extract.txt 供大纲/填充引用 */
const OOXML_EXTS = new Set(['.docx', '.docm', '.pptx', '.ppsx', '.potx', '.pptm', '.xlsx', '.xlsm']);

const EXTRACT_TEXT_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'extract-text.py');

async function extractOoxmlText(target) {
  try {
    const r = await runCmd(config().python, [EXTRACT_TEXT_PY, target, '60000'], { timeoutMs: 60000 });
    const out = (r.stdout || '').trim();
    if (r.code === 0 && out) {
      try {
        const j = JSON.parse(out);
        if (j && j.ok && typeof j.text === 'string' && j.text.trim()) return j.text;
      } catch { /* 输出不合法按提取失败处理 */ }
    }
  } catch { /* 超时/进程失败：材料仍登记元数据，正文提取标记保持 false */ }
  return null;
}

export async function listMaterials(id) {
  return readJson(path.join(projectDir(id), 'materials.json'), []);
}

export async function addMaterial(id, buf, filename) {
  const name = path.basename(String(filename || 'material.bin'));
  const dir = path.join(projectDir(id), 'sources');
  await fsp.mkdir(dir, { recursive: true });
  const safe = name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_');
  const target = path.join(dir, safe);
  await fsp.writeFile(target, buf);
  const entry = {
    id: 'mat-' + Date.now().toString(36),
    name: name,
    file: path.join('sources', safe),
    size: buf.length,
    sha256: await sha256File(target),
    type: (path.extname(safe).slice(1) || 'bin').toLowerCase(),
    text_extracted: false,
    added_at: nowIso(),
  };
  if (TEXT_EXTS.has(path.extname(safe).toLowerCase())) {
    try {
      const txt = buf.toString('utf8');
      await fsp.writeFile(path.join(dir, safe + '.extract.txt'), txt);
      entry.text_extracted = true;
      entry.text_chars = txt.length;
    } catch { /* 非UTF-8文本跳过提取 */ }
  } else if (OOXML_EXTS.has(path.extname(safe).toLowerCase())) {
    const txt = await extractOoxmlText(target); // docx/pptx/xlsx 系正文提取（失败仅登记元数据，不阻断上传）
    if (txt) {
      await fsp.writeFile(path.join(dir, safe + '.extract.txt'), txt);
      entry.text_extracted = true;
      entry.text_chars = txt.length;
    }
  }
  const list = await listMaterials(id);
  // 同名同哈希幂等
  if (list.some((m) => m.sha256 === entry.sha256 && m.name === entry.name)) {
    await fsp.rm(target, { force: true }).catch(() => {});
    return { entry: list.find((m) => m.sha256 === entry.sha256), deduplicated: true };
  }
  list.push(entry);
  await writeJson(path.join(projectDir(id), 'materials.json'), list);
  return { entry, deduplicated: false };
}

export async function removeMaterial(id, matId) {
  const list = await listMaterials(id);
  const idx = list.findIndex((m) => m.id === matId);
  if (idx < 0) return null;
  const [entry] = list.splice(idx, 1);
  await writeJson(path.join(projectDir(id), 'materials.json'), list);
  await fsp.rm(path.join(projectDir(id), entry.file), { force: true }).catch(() => {});
  return entry;
}
