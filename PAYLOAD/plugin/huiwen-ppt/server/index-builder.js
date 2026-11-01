/**
 * 汇文 PPT 后端 · 资源索引与内置分支播种（server/index-builder.js）
 * WF-00：启动时把两个内置风格分支登记进 huiwen-data/library（幂等），
 * 物化模板学习规则（visual-rules/expression-rules）并按历史授权批准，
 * 然后从分支 catalog 构建 styles/layouts/assets 资源索引（含 index_revision）。
 * 画布演示边界取自真实 inspection.json（模板页 1/2/4/9 对象边界）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, subdir } from './config.js';
import { readJson, writeJson, sha256File, stableHash, nowIso } from './util.js';
import { registerTemplate, approveTemplate } from './studio.js';
import { listProjectCards } from './projects.js';

const BRANCHES = [
  {
    key: 'clean-business',
    family: 'green-clean-business',
    name: '绿色简洁商务',
    dir: 'assets/clean-business',
    source: 'reference.pptx',
    authorizedLabel: '用户(2026-10-08 历史授权)',
  },
  {
    key: 'style-library',
    family: 'green-office-illustrated',
    name: '绿色办公插画',
    dir: 'assets/style-library',
    source: 'reference.pptx',
    authorizedLabel: '用户(历史授权)',
  },
];

function branchDir(b) {
  return path.join(config().skillDir, b.dir);
}

function libraryDir() {
  return subdir('library');
}

/** 已登记模板目录（按源文件 SHA256 匹配） */
async function findTemplateBySha(sha) {
  const tdir = path.join(libraryDir(), 'templates');
  if (!fs.existsSync(tdir)) return null;
  for (const name of await fsp.readdir(tdir)) {
    const m = await readJson(path.join(tdir, name, 'manifest.json'), null);
    if (m && m.source_sha256 === sha) return path.join(tdir, name);
  }
  return null;
}

function ruleFilesFor(b, catalog) {
  const t = (catalog && catalog.tokens) || {};
  const colors = t.colors || {};
  const fontPx = t.font_px || {};
  const colorLine = Object.entries(colors).map(([k, v]) => `${k} ${v}`).join('、');
  const pxLine = Object.entries(fontPx).map(([k, v]) => `${k}${v}px`).join('/');
  const visual = [
    `# ${b.name} · 视觉规则（物化自分支 catalog，历史授权见分支 manifest.authorization）`,
    `- 画布 ${(t.canvas || [1280, 720]).join('×')}（96DPI）；字体 ${t.font || '微软雅黑'}（${pxLine || '以模板为准'}）`,
    `- 配色：${colorLine || '以模板为准'}`,
    t.safe_area ? `- 安全区 [${t.safe_area.join(', ')}]` : null,
    `- 画布对象能力以 inspection.json 为准：组合/旋转/全页图遮挡对象在画布锁定，交由原生应用处理`,
  ].filter(Boolean);
  const expression = [
    `# ${b.name} · 表达规则`,
    b.family === 'green-clean-business'
      ? `- 参考图构图包 clean-reference-01~08 优先；无可沿用参考图关系时使用 14 页通用版式（fallback=clean-generic-14）`
      : `- 15 种可编辑版式按关系检索；办公人物/立体文档插画用于场景与流程说明`,
    `- 关系→版式映射与必要字段见 catalog.json layouts；素材需登记来源与适用范围`,
    `- 参考图中的业务数字、能力、日期和承诺需单独核实，不得直接当作事实引用`,
  ];
  return {
    'visual-rules.md': visual.join('\n') + '\n',
    'expression-rules.md': expression.join('\n') + '\n',
  };
}

/** 播种两个内置分支（幂等）：register → 规则物化 → 历史授权批准 */
export async function ensureBuiltins() {
  const results = [];
  for (const b of BRANCHES) {
    const dir = branchDir(b);
    const src = path.join(dir, b.source);
    if (!fs.existsSync(src)) {
      results.push({ branch: b.key, skipped: '缺少源文件 ' + b.source });
      continue;
    }
    const sha = await sha256File(src);
    let tdir = await findTemplateBySha(sha);
    if (!tdir) {
      const reg = await registerTemplate(src, libraryDir(), b.name);
      tdir = reg.template;
    }
    const manifestPath = path.join(tdir, 'manifest.json');
    const manifest = await readJson(manifestPath, {});
    if (manifest.status !== 'approved') {
      for (const [fname, content] of Object.entries(ruleFilesFor(b, await readJson(path.join(dir, 'catalog.json'), {})))) {
        await fsp.writeFile(path.join(tdir, fname), content, 'utf8');
      }
      await approveTemplate(tdir, b.authorizedLabel, '分支 manifest.authorization 历史授权；规则物化自 catalog.json');
    }
    results.push({ branch: b.key, template: tdir, sha256: sha, approved: true });
  }
  return results;
}

/** 分支 catalog → 客户端 layouts 形状（与原型 mock-data 同构） */
async function layoutsFromBranch(b) {
  const dir = branchDir(b);
  const cat = await readJson(path.join(dir, 'catalog.json'), { layouts: [] });
  const native = await readJson(path.join(dir, 'layout-index.json'), { layouts: [] });
  const byId = new Map((cat.layouts || []).map((layout) => [layout.id, layout]));
  const out = [];
  for (const page of native.layouts || []) {
    const lay = byId.get(page.id) || {};
    const lid = page.id;
    let preview = null;
    let pack = 'generic';
    if (b.family === 'green-clean-business' && lid.startsWith('clean-reference-')) {
      const n = lid.slice(lid.lastIndexOf('-') + 1);
      preview = `clean-ref-${n}.png`;
      pack = 'reference_pack';
    } else if (page.slide) {
      preview = (b.family === 'green-clean-business' ? 'clean-slide-' : 'illu-slide-') +
        String(page.slide).padStart(2, '0') + '.png';
    }
    out.push({
      id: lid,
      name: lay.name || `第${page.slide}页`,
      family: b.family,
      relation: (lay.tags || ['版式'])[0],
      tags: lay.tags || [],
      composition: lay.composition || lay.name,
      required_fields: lay.required_fields || [],
      asset_ids: lay.asset_ids || [],
      template_slide: page.slide,
      source_pages: lay.source_pages || [page.slide],
      origin: lay.origin ?? null,
      preview,
      pack,
      approval: pack === 'reference_pack' ? 'approved' : 'approved',
      editability: b.family === 'green-clean-business' ? ['text', 'shape', 'connector'] : ['text', 'shape'],
      source_template_sha: native.sha256,
    });
  }
  return out;
}

export async function builtinLayouts() {
  return [...await layoutsFromBranch(BRANCHES[0]), ...await layoutsFromBranch(BRANCHES[1])];
}

/** 素材（图标 + 人物），与原型同构 */
async function assetsFromBranch(b) {
  const dir = branchDir(b);
  if (b.family !== 'green-clean-business') return [];
  const ICON_NAMES = { building: '楼宇', chart: '图表', check: '对勾', clock: '时钟', database: '数据库', document: '文档', layers: '图层', message: '消息', network: '网络', person: '人物', search: '检索', tool: '工具' };
  const out = [];
  for (const ic of Object.keys(ICON_NAMES)) {
    if (!fs.existsSync(path.join(dir, 'icons', ic + '.svg'))) continue;
    out.push({
      id: `clean-${ic}`, name: `线性图标·${ICON_NAMES[ic]}`, type: 'icon',
      family: b.family, file: `icon-${ic}.svg`,
      tags: ['线性', '图标', ICON_NAMES[ic]], transparent: true,
      usage: '主体页功能图标，绿色线描风格统一',
    });
  }
  const PEOPLE = { 'people-handshake': '握手协作', 'people-laptop': '办公操作', 'people-thinking': '思考分析' };
  for (const [pid, pname] of Object.entries(PEOPLE)) {
    if (!fs.existsSync(path.join(dir, 'images', pid + '.png'))) continue;
    out.push({
      id: `clean-${pid}`, name: `线描商务人物·${pname}`, type: 'people',
      family: b.family, file: `${pid}.png`,
      tags: ['人物', '线描', pname], transparent: true,
      usage: '封面或场景重点页配套使用',
    });
  }
  return out;
}

/** 画布演示边界：clean-business inspection.json 真实对象边界（页 1/2/4/9） */
async function canvasFromInspection() {
  const dir = branchDir(BRANCHES[0]);
  const insp = await readJson(path.join(dir, 'inspection.json'), null);
  const canvas = {};
  if (!insp) return canvas;
  for (const want of [1, 2, 4, 9]) {
    const s = (insp.slides || [])[want - 1];
    if (!s) continue;
    const items = [];
    for (const e of s.elements || []) {
      if (e.hidden) continue;
      const p = e.position;
      if (!p || p.width < 4 || p.height < 4) continue;
      items.push({
        shape_id: e.shape_id,
        name: e.name || `对象${e.shape_id}`,
        kind: e.kind,
        text: (e.text || '').slice(0, 80),
        x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
        w: Math.round(p.width * 10) / 10, h: Math.round(p.height * 10) / 10,
        editable_text: Boolean(e.editable_text),
        editable_geometry: Boolean(e.editable_geometry),
        locked: Boolean(e.grouped || e.rotated_or_flipped),
      });
    }
    canvas[String(want)] = items;
  }
  return canvas;
}

function styleEntries(catByFamily) {
  return [
    {
      id: 'green-clean-business', name: '绿色简洁商务',
      font: '微软雅黑', canvas: [1280, 720],
      colors: catByFamily['green-clean-business']?.tokens?.colors || {},
      desc: '适合方案关系、协作机制、数据、实施条件和依据说明。8 页参考图高保真构图包优先，14 页通用版式兜底。',
      layouts_count: 0, status: 'approved',
      representative: ['clean-ref-01.png', 'clean-ref-03.png', 'clean-slide-04.png'],
    },
    {
      id: 'green-office-illustrated', name: '绿色办公插画',
      font: '微软雅黑', canvas: [1280, 720],
      colors: catByFamily['green-office-illustrated']?.tokens?.colors || {},
      desc: '适合任务场景、业务角色、操作体验和流程说明。办公人物、立体文档、浅绿背景与绿色标题条。',
      layouts_count: 0, status: 'approved',
      representative: ['illu-slide-01.png', 'illu-slide-05.png', 'illu-slide-08.png'],
    },
  ];
}

let INDEX_CACHE = null;

/** 构建/重建资源索引（styles/layouts/assets/canvas/projects 摘要） */
export async function buildIndex(force = false) {
  if (INDEX_CACHE && !force) return { ...INDEX_CACHE, projects: await listProjectCards() };
  const cats = {};
  for (const b of BRANCHES) {
    cats[b.family] = await readJson(path.join(branchDir(b), 'catalog.json'), {});
  }
  const layouts = await builtinLayouts();
  const approved = [];
  const troot = path.join(libraryDir(), 'templates');
  for (const id of await fsp.readdir(troot)) {
    const manifest = await readJson(path.join(troot,id,'manifest.json'),null);
    if (manifest?.status !== 'approved') continue;
    const source = path.join(troot,id,'reference.pptx');
    if (!fs.existsSync(source) || await sha256File(source)!==manifest.source_sha256) continue;
    const inspection = await readJson(path.join(troot,id,'inspection.json'),null);
    if (inspection) approved.push({id,manifest,inspection});
  }
  for (const lay of layouts) {
    const template = approved.find((t)=>t.manifest.name === BRANCHES.find((b)=>b.family===lay.family)?.name);
    lay.template_id = template?.id;
    lay.source_template_sha = template?.manifest.source_sha256;
    if (template && template.manifest.source_sha256 !== lay.source_template_sha) lay.approval = 'invalid';
  }
  const extras = approved.filter((t)=>!BRANCHES.some((b)=>b.name===t.manifest.name));
  for (const t of extras) for (const slide of t.inspection.slides) {
    if ((slide.elements || []).filter((e)=>e.editable_text && e.kind==='sp').length<2) continue;
    layouts.push({ id:t.id+'-slide-'+slide.number, name:t.manifest.name+' · 第'+slide.number+'页',family:t.id,
      template_id:t.id,source_template_sha:t.manifest.source_sha256,template_slide:slide.number,relation:'内容页',
      tags:['自定义'],pack:'custom',approval:'approved',editability:['text','shape'],preview:null,required_fields:['title','key_points'],asset_ids:[],composition:'已批准原生模板版式',source_pages:[slide.number] });
  }
  const assets = await assetsFromBranch(BRANCHES[0]);
  const canvas = await canvasFromInspection();
  const styles = styleEntries(cats);
  for (const t of extras) styles.push({id:t.id,name:t.manifest.name,status:'approved',font:'模板字体',colors:{},canvas:[1280,720],representative:[],desc:'已批准模板'});
  for (const st of styles) {
    st.layouts_count = layouts.filter((l) => l.family === st.id).length;
  }
  const projects = await listProjectCards();
  const indexRevision = stableHash({
    clean: await sha256File(path.join(branchDir(BRANCHES[0]), 'catalog.json')),
    illus: await sha256File(path.join(branchDir(BRANCHES[1]), 'catalog.json')),
    layouts: layouts.map((l)=>[l.id,l.template_slide,l.source_template_sha,l.approval]),
  });
  const index = {
    index_revision: indexRevision,
    generated_at: nowIso(),
    styles, layouts, assets, canvas, projects,
    selection_policy: {
      'green-clean-business': {
        primary_layouts: layouts.filter((l) => l.family === 'green-clean-business' && l.pack === 'reference_pack').map((l) => l.id),
        fallback_layout_family: 'clean-generic-14',
      },
    },
  };
  await writeJson(path.join(subdir('library'), 'index.json'), index);
  INDEX_CACHE = index;
  return index;
}

export function cachedIndex() {
  return INDEX_CACHE;
}

export function invalidateIndex() {
  INDEX_CACHE = null;
}
