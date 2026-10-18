/**
 * 汇文 PPT 后端 · LibreOffice 渲染适配器（server/render.js）
 * 职责：PPTX → PDF → PNG（1280×720 @96DPI），产出渲染报告。
 * WPS/PowerPoint 在本 Linux 服务器不可用（COM 渲染仅限 Windows），
 * 渲染报告如实标记 engine=libreoffice；WPS 验收保持用户人工流程。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, subdir } from './config.js';
import { runCmd, sha256File, nowIso } from './util.js';
import { renderWindows } from './windows-render.js';

let LO_VERSION = null;
let LO_PROFILE = null;

/** 探测 LibreOffice 版本（进程内缓存） */
export async function libreOfficeVersion() {
  if (LO_VERSION) return LO_VERSION;
  const r = await runCmd('soffice', ['--version'], { timeoutMs: 20000 });
  const m = (r.stdout || '').match(/LibreOffice\s+([\d.]+)/);
  LO_VERSION = m ? m[1] : (r.code === 0 ? 'unknown' : null);
  return LO_VERSION;
}

function loProfileDir() {
  if (!LO_PROFILE) {
    LO_PROFILE = subdir('cache', 'lo-profile');
  }
  return LO_PROFILE;
}

/**
 * 渲染 PPTX 为逐页 PNG。
 * @returns 渲染报告 { engine, engine_version, source_sha256, pages, files, warnings, visual_review, duration_ms, created_at }
 */
export async function renderPptxToPngs(pptxPath, outDir, opts = {}) {
  const engine=opts.engine || config().render.engine;
  if(['wps','powerpoint'].includes(engine)) return renderWindows(pptxPath,outDir,{...opts,engine});
  if(engine!=='libreoffice') throw Object.assign(new Error('未知渲染引擎：'+engine),{code:'ENGINE_UNAVAILABLE'});
  const started = Date.now();
  const cfg = config().render;
  const width = opts.width || cfg.width;
  const height = opts.height || cfg.height;
  const timeoutMs = opts.timeoutMs || cfg.timeoutMs;
  await fsp.mkdir(outDir, { recursive: true });
  const tmpDir = await fsp.mkdtemp(path.join(subdir('cache'),'tmp-render-'));

  try {
  const version = await libreOfficeVersion();
  if (!version) {
    const e = new Error('LibreOffice 不可用，无法渲染预览');
    e.code = 'ENGINE_UNAVAILABLE';
    e.next_actions = ['install_libreoffice', 'export_without_preview'];
    throw e;
  }

  // 1) PPTX → PDF（独立 UserInstallation，避免 headless 首跑初始化失败与并发锁）
  const envUrl = pathToFileURL(path.join(tmpDir,'lo-profile')).href;
  const pdfOut = tmpDir;
  const conv = await runCmd('soffice',
    ['-env:UserInstallation=' + envUrl, '--headless', '--convert-to', 'pdf', '--outdir', pdfOut, String(pptxPath)],
    { timeoutMs });
  const base = path.basename(String(pptxPath)).replace(/\.[^.]+$/, '');
  const pdfPath = path.join(pdfOut, base + '.pdf');
  if (conv.code !== 0 || !fs.existsSync(pdfPath)) {
    const e = new Error('LibreOffice 转换 PDF 失败：' + ((conv.stderr || conv.stdout || '').trim().slice(-500) || '未产生输出文件'));
    e.code = 'RENDER_FAILED';
    e.recoverable = true;
    e.next_actions = ['retry_render', 'export_without_preview'];
    throw e;
  }

  // 2) PDF → PNG（scale-to 固定画布尺寸，与 96DPI 逻辑坐标一致）
  const prefix = path.join(outDir, 'slide');
  const ppm = await runCmd('pdftoppm',
    ['-png', '-r', String(cfg.dpi || 96), '-scale-to-x', String(width), '-scale-to-y', String(height), pdfPath, prefix],
    { timeoutMs });
  if (ppm.code !== 0) {
    const e = new Error('pdftoppm 栅格化失败：' + (ppm.stderr || '').trim().slice(-300));
    e.code = 'RENDER_FAILED';
    e.next_actions = ['retry_render'];
    throw e;
  }

  const files = (await fsp.readdir(outDir))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => ({ slide: Number(f.match(/\d+/)[0]), file: f }));
  if (!files.length) {
    const e = new Error('渲染未产出任何页面 PNG');
    e.code = 'RENDER_FAILED';
    e.next_actions = ['retry_render', 'export_without_preview'];
    throw e;
  }

  const warnings = [
    { type: 'font_substitution', note: '服务器无微软雅黑，预览由 Noto Sans CJK/文泉驿替代渲染；最终视觉验收以 WPS 打开导出文件为准' },
  ];
  return {
    engine: 'libreoffice',
    engine_version: version,
    source_sha256: await sha256File(pptxPath),
    pages: files.length,
    files,
    warnings,
    visual_review: 'pending',
    duration_ms: Date.now() - started,
    created_at: nowIso(),
  };
  } finally { await fsp.rm(tmpDir, {recursive:true,force:true}).catch(()=>{}); }
}
