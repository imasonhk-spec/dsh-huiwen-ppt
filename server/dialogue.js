/**
 * 汇文 PPT 后端 · 对话编排（server/dialogue.js，WF-02/WF-03）
 * 主路：真模型（本机 Ollama；模型选择框按项目记忆）；
 * 兜底：剧本 + 规则引擎（模型不可用/超时/输出不合规时降级，方案 §5.3）。
 * 返回客户端消息卡片：{ role:'ai', kind:'text'|'outline'|'style'|'pages'|'result'|'export'|'archived'|'materials', text, payload }
 * 对话流持久化：projects/<id>/conversation.jsonl。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { projectDir, loadProject, updateProjectMeta } from './projects.js';
import { appendJsonl, readJsonl, nowIso, writeJson } from './util.js';
import { resolveModel, chat } from './llm.js';
import { loadBrief, saveBriefDraft, briefSummary, confirmBrief } from './brief.js';
import { loadOutline, saveOutlineDraft, applyOutlineChanges, confirmOutline, outlineCardPayload } from './outline.js';
import { listMaterials } from './materials.js';
import { buildIndex, invalidateIndex } from './index-builder.js';

const HISTORY_MAX = 24;

/* 0.3.3（P1 关键）：确认大纲即确认需求摘要——对话链过 WF-02 门禁（此前客户端从未调 /brief/confirm，
   导致真实生成永远被「需求摘要未确认」拦截）。缺标题等不满足确认条件时保持未确认，由生成门禁如实报错。 */
export async function ensureBriefApproved(projectId, confirmedBy = '用户', note = '随大纲确认（对话链）') {
  const brief = await loadBrief(projectId);
  if (brief && brief.approvals && brief.approvals.requirements) return false;
  try {
    await confirmBrief(projectId, confirmedBy, note);
    return true;
  } catch { return false; }
}

/* ── 剧本兜底（与客户端原剧本同源的精简版） ── */


/* ── LLM 提示词 ── */

/* 材料正文摘要（0.3.3）：读取已提取的 .extract.txt，供大纲/访谈提示词引用——只读真实材料，不虚构 */
async function materialDigest(projectId, perLimit = 1200, totalLimit = 6000) {
  try {
    const mats = await listMaterials(projectId);
    const out = [];
    let used = 0;
    for (const m of mats) {
      if (!m.text_extracted || used >= totalLimit) continue;
      try {
        const txt = await fsp.readFile(path.join(projectDir(projectId), m.file + '.extract.txt'), 'utf8');
        const head = txt.replace(/\s+/g, ' ').trim().slice(0, perLimit);
        if (!head) continue;
        out.push({ name: m.name, digest: head });
        used += head.length;
      } catch { /* 提取文件缺失跳过 */ }
    }
    return out;
  } catch { return []; }
}

function interviewSystem(brief, stage, materials, digest) {
  const midFlow = !['idle', 'material'].includes(stage);
  return [
    '你是汇文 PPT 制作助手。核心理念：正式生成前充分理解用户的真实需求与最终目标——一次只问一个问题，根据回答继续追问，直到你有 95% 的把握。',
    '当前阶段：' + stage + (midFlow ? '（制作中途：已有大纲/风格/版本，不要发起新一轮连环追问）' : '（需求收集期）') + '。',
    '已收集的需求摘要：' + JSON.stringify(briefSummary(brief) || {}),
    '已有材料：' + JSON.stringify((materials || []).map((m) => m.name)),
    ...(digest && digest.length
      ? ['材料正文摘要（澄清问题与提取信息时优先引用材料事实，材料已覆盖的不要重复问用户）：' + JSON.stringify(digest.map((d) => ({ name: d.name, digest: d.digest.slice(0, 300) })))]
      : []),
    '规则：',
    '1. 每次回复只问一个最关键的问题（目标受众、使用场景、核心观点、内容与数据、页数或时长、材料范围、交付要求）；已明确的信息绝不重复问。',
    '2. 从用户最新消息中提取已经能确定的字段，填入 brief_updates；用户中途变更需求（受众/页数/主题/材料范围）时，在 reply 中明确确认变更。不要虚构事实。',
    '3. confidence 是你对「已充分理解用户真实需求与最终目标」的把握自评，0 到 1 的小数。',
    '4. confidence < 0.95：reply 是一个追问（只问一个）。confidence ≥ 0.95：reply 说明你已基本掌握需求、即将生成大纲。',
    ...(midFlow
      ? ['5. 中途发言优先按需求变更或提问处理；此阶段即使 confidence ≥ 0.95 也不要主动生成大纲——由用户决定（可以提示「随时可重新出大纲或直接生成」）。']
      : []),
    '输出必须是 JSON 对象：{"reply": "给用户的话（中文，简洁自然，最多一个问题）", "brief_updates": {"title": "标题（能确定时给）", "audience": "受众", "scenario": "场合", "key_message": "核心观点", "page_count": 10, "material_policy": "仅使用提供的材料 或 允许检索补充", "style_preference": "用户提到的风格/页数偏好（原文摘要）", "duration": "时长"}, "confidence": 0.85}。',
  ].join('\n');
}

function outlineSystem(brief, relations, digest) {
  return [
    '你是汇文 PPT 大纲规划师。根据需求摘要产出逐页大纲。',
    '需求摘要：' + JSON.stringify(briefSummary(brief) || {}),
    ...(digest && digest.length
      ? ['材料正文摘要（key_points/evidence 必须优先取自材料原文，不得虚构数字与事实；材料未覆盖的页面按需求摘要规划）：' + JSON.stringify(digest)]
      : []),
    '可用版式关系词（relation 必须从以下选择）：' + JSON.stringify(relations),
    '规则：',
    '1. 每页给出 title（≤20字）、purpose（一句话页面目的）、key_points（2-4 条关键信息，不虚构数字）、evidence（来源说明或空）、relation（从关系词表选择）。',
    '2. 首页为封面，末页为收尾；总页数遵守需求里的页数（未指明则 8-10 页）。',
    '3. 输出必须是 JSON 对象：{"pages": [...], "notes": "给用户的大纲说明（1-2 句）"}。',
  ].join('\n');
}

function outlineTurnSystem(outline) {
  return [
    '你是汇文 PPT 大纲助手。当前大纲：' + JSON.stringify((outline.pages || []).map((p) => ({ n: p.n, title: p.title, relation: p.relation }))),
    '用户在大纲确认阶段发言。判断意图：',
    '- confirm：确认大纲（如"确认/可以/就这样/OK"）',
    '- adjust：调整大纲（如"加一页团队介绍""把数据页提前""删掉风险页"）',
    '- chat：其他问题或闲聊',
    '调整用 changes 数组表达：{"op":"add","after":页号,"title":"..."} / {"op":"remove","index":页号} / {"op":"move","from":页号,"to":页号} / {"op":"update","index":页号,"title":"...","relation":"..."}。',
    '输出必须是 JSON 对象：{"type": "confirm|adjust|chat", "reply": "给用户的话", "changes": []}。',
  ].join('\n');
}

function parseJsonLoose(text) {
  if (!text) return null;
  const t = text.replace(/```json/gi, '```').split('```').map((s) => s.trim()).filter(Boolean);
  const candidates = [text, ...t];
  for (const c of candidates) {
    const m = c.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch { /* 尝试下一个 */ }
  }
  return null;
}

async function llmJson(model, system, messages, opts) {
  const content = await chat({
    model, // 完整模型对象：按 channel 分发（ollama 原生 / DSH OpenAI-compatible）
    system,
    messages,
    json: true,
    timeoutMs: (opts && opts.timeoutMs) || 240000,
  });
  const parsed = parseJsonLoose(content);
  if (!parsed) {
    const e = new Error('模型输出不是合法 JSON');
    e.code = 'LLM_BAD_OUTPUT';
    throw e;
  }
  return parsed;
}

/* ── 消息构造 ── */

const aiText = (text) => ({ role: 'ai', kind: 'text', text });
const aiCard = (kind, payload) => ({ role: 'ai', kind, payload: payload || {} });

export async function persist(projectId, entries) {
  for (const en of entries) {
    await appendJsonl(path.join(projectDir(projectId), 'conversation.jsonl'), { ...en, ts: nowIso() });
  }
}

async function history(projectId) {
  const all = await readJsonl(path.join(projectDir(projectId), 'conversation.jsonl'));
  return all.slice(-HISTORY_MAX).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text || '[卡片消息]' }));
}

async function generateOutlineMessages(projectId, model, brief, ack) {
  const index = await buildIndex();
  const relations = [...new Set(index.layouts.map((l) => l.relation))];
  const digest = await materialDigest(projectId); // 材料正文进大纲提示词（0.3.3）
  /* 大纲生成为重任务（大提示词 + 长 JSON 输出）：单独给足超时，一般对话不受影响 */
  const parsed = await llmJson(model, outlineSystem(brief, relations, digest), [
    { role: 'user', content: '请基于以上需求摘要生成逐页大纲。' },
  ], { timeoutMs: 600000 });
  const pages = Array.isArray(parsed.pages) && parsed.pages.length ? parsed.pages : [];
  if (!pages.length) {
    const e = new Error('模型未产出有效大纲页');
    e.code = 'LLM_BAD_OUTPUT';
    throw e;
  }
  const outline = await saveOutlineDraft(projectId, pages, { source: 'llm:' + model.tag });
  await updateProjectMeta(projectId, { stage: 'outline', next_action: '确认或调整大纲' });
  return {
    stage: 'outline',
    messages: [
      aiText(ack || '需求已经清楚了，我拟了一份大纲：'),
      aiText('大纲说明：' + (parsed.notes || '共 ' + pages.length + ' 页。确认或告诉我怎么调整。')),
      aiCard('outline', { outline: outlineCardPayload(outline) }),
    ],
  };
}

/* ── 主入口 ── */

export async function handleMessage(projectId, text, modelId, confirmedBy) {
  const { meta } = await loadProject(projectId);
  let stage = meta.stage || 'idle';
  /* 0.3.3（P2）：归档只读项目的对话继续 = 自动真重开（解除只读 + 计数 + 刷新索引），再按正常阶段编排 */
  let reopened = false;
  if (meta.status === 'archived') {
    await updateProjectMeta(projectId, { status: 'active', reopen_count: (meta.reopen_count || 0) + 1, next_action: '继续制作或导出' });
    invalidateIndex();
    reopened = true;
    if (stage === 'archived') stage = 'done';
  }
  const brief = await loadBrief(projectId);
  const materials = await listMaterials(projectId);
  let model = null;
  try {
    model = await resolveModel(modelId || meta.dialogue_model);
  } catch { model = null; }
  await persist(projectId, [{ role: 'user', kind: 'text', text, stage, model: model ? model.tag : null }]);
  const hist = await history(projectId);
  const histNoLast = hist.slice(0, -1); // 最新一条已作为现场消息传入

  /* 0.3.4.3：推翻重置是纯数据操作，不依赖大模型——任何模型状态下都能执行 */
  let result = RESET_RE.test(text) ? await resetProjectFlow(projectId) : null;

  /* 0.3.4.3：正式业务——材料分析与内容生成必须走大模型；模型不可用/调用失败时如实报错，不再降级本地剧本 */
  if (!result) {
    let modelError = null;
    if (!model || !model.online) {
      modelError = model
        ? '大模型「' + model.label + '」当前不可用' + (model.reason ? '（' + model.reason + '）' : '')
        : '未配置可用的大模型';
    } else {
      try {
        result = await realTurn(projectId, stage, model, text, histNoLast, brief, materials, confirmedBy);
      } catch (e) {
        modelError = '大模型调用失败（' + (e && e.message ? e.message : e) + '）';
        console.error('[huiwen-ppt] LLM 回合失败：', e.message);
      }
    }
    if (!result) {
      result = {
        stage,
        messages: [aiText('⚠️ ' + modelError + '。正式生成需要大模型分析材料与内容——请检查模型服务（Ollama / DSH 同步模型）后重试；你刚才的话已记录，模型恢复后直接继续即可。')],
      };
    }
  }
  if (reopened) result.messages.unshift(aiText('已为你重新打开项目（解除归档只读）✅。继续处理你刚才的指令：'));

  await persist(projectId, result.messages.map((m) => ({ role: 'ai', kind: m.kind, text: m.text || '', stage: result.stage })));
  if (model) await updateProjectMeta(projectId, { dialogue_model: model.id });
  return { ...result, model: model ? { id: model.id, label: model.label, tag: model.tag, online: model.online } : null, fallback: false };
}

/** 确定性信号提取（LLM 输出不稳时的兜底，只填缺，不虚构） */
export function extractBriefSignals(text) {
  const t = String(text || '');
  const updates = {};
  const mPage = t.match(/(\d{1,2})\s*页/);
  if (mPage) updates.page_count = parseInt(mPage[1], 10);
  /* 0.3.4.1：早期说的风格偏好记入 brief（风格确认动作只在大纲确认后发生，信息先不丢） */
  if (/插画|活泼|轻松/.test(t)) updates.style_preference = 'green-office-illustrated（插画活泼）';
  else if (/简洁|商务|绿色|简约/.test(t)) updates.style_preference = 'green-clean-business（简洁商务）';
  if (/只(使用|用)|仅(使用|用)|只用我|就用我/.test(t) && /材料|资料|提供|文件/.test(t)) updates.material_policy = '仅使用提供的材料';
  else if (/可以(联网|检索|搜索)|联网(搜索|检索)?补充|公开资料/.test(t)) updates.material_policy = '允许检索补充';
  /* 0.3.4：受众提取兼容自然后缀（给管理层看/给投资人汇报/给公司领导们） */
  const mAud = t.match(/给([^，。；,;、\s]{1,14})/);
  if (mAud) {
    const a = mAud[1].replace(/(看|用|审阅|阅读|汇报|演示|们|的)+$/, '').trim();
    if (/(领导|管理层|客户|同事|评审|部门|高管|老师|投资人|委员会|员工|股东|合作伙伴|专家|政府)/.test(a) && a.length >= 2) {
      updates.audience = a.replace(/^(面向|针对|我们)?的?/, '');
    }
  }
  /* 0.3.4：场合提取——组合词优先（评审会/发布会等不被"季度"截胡）；以"会"结尾不再补"汇报" */
  const mScFull = t.match(/(季度|月度|年度|周|项目)?(周会|评审会|汇报会|启动会|结项|发布会|路演|宣讲)(汇报|总结|复盘)?/);
  const mSc = mScFull || t.match(/(季度|月度|年度)(汇报|总结|复盘)?/);
  if (mSc) updates.scenario = (/(会|汇报|总结|复盘)$/.test(mSc[0]) ? mSc[0] : mSc[0] + '汇报');
  const mDur = t.match(/(\d{1,2})\s*分钟/);
  if (mDur) updates.duration = mDur[1] + '分钟';
  if (!updates.title) {
    const clause = t.split(/[，。；,;!\n]/)[0].replace(/^(帮我|请|麻烦|我想|我要|做一份|制作|做下|做一个|做一个|需要)+/g, '').replace(/(的)?(PPT|ppt|pptx)$/i, '').trim();
    if (clause.length >= 4) updates.title = clause.slice(0, 40);
  }
  return updates;
}

function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/* ── 0.3.4：推翻重来（无固定流程的终极自由——任何阶段可推翻全部重来） ── */

const RESET_RE = /推翻|推倒重来|换个?主题|重新开始|从零开始|全部重来|重来一[次遍]|重来吧|重新做一[份个张]|不做这个了|全部清空/;

/* 重置项目：清 需求/大纲/计划/风格/材料/版本/渲染/巡检报告；保留 对话历史/导出记录；回 idle。
   （纯函数：返回消息，不落盘对话——由 handleMessage 或 resetProject 包装层持久化） */
export async function resetProjectFlow(projectId) {
  const dir = projectDir(projectId);
  let matCount = 0;
  try {
    const mats = await listMaterials(projectId);
    matCount = (mats || []).length;
  } catch { /* 材料注册表缺失按 0 处理 */ }
  const rm = (p) => fsp.rm(path.join(dir, p), { recursive: true, force: true }).catch(() => {});
  await Promise.all([
    'brief.json', 'outline.json', 'plan.json', 'style-selection.json', 'build-plan.json',
    'materials.json', 'state.json', 'sources', 'versions', 'renders',
  ].map(rm));
  try {
    for (const f of await fsp.readdir(dir)) {
      if (/^inspection-.*\.json$|^report-.*\.json$/.test(f)) await rm(f);
    }
  } catch { /* 目录读取失败跳过 */ }
  await writeJson(path.join(dir, 'annotations.json'), []);
  await updateProjectMeta(projectId, {
    stage: 'idle', status: 'active', version: null, page_count: 0, plan_pages: 0,
    source_name: null, source_sha256: null, style_selection: null,
    checks: { structural: 'pending', render: 'pending', visual_review: 'pending', editability: 'pending', user_acceptance: 'pending' },
    next_action: '重新收集需求（一次一问）',
    title: '未命名汇报',
  });
  invalidateIndex();
  return {
    stage: 'idle',
    messages: [aiText('已推翻重来 🔄\n已清空：需求摘要、大纲、风格、材料（' + matCount + ' 份）、版本与渲染；已保留：对话历史、导出记录。\n这次想做什么主题的 PPT？先用一句话告诉我主题即可——我会在正式生成前一次一个问题问清需求。')],
  };
}

/** API 重置（POST /projects/:id/reset）：重置并把提示落进对话历史 */
export async function resetProject(projectId) {
  const r = await resetProjectFlow(projectId);
  await persist(projectId, r.messages.map((m) => ({ role: 'ai', kind: m.kind, text: m.text || '', stage: r.stage })));
  return r;
}

async function realTurn(projectId, stage, model, text, hist, brief, materials, confirmedBy) {
  /* 0.3.4：推翻重来——任何阶段，识别即重置 */
  if (RESET_RE.test(text)) return resetProjectFlow(projectId);

  if (stage === 'idle' || stage === 'material') {
    const det = extractBriefSignals(text);
    let llmUpdates = {};
    let replyText = null;
    let confidence = null;
    try {
      const digest = await materialDigest(projectId, 600, 2000); // 访谈轮轻量注入材料摘要
      const parsed = await llmJson(model, interviewSystem(brief, stage, materials, digest), [
        ...hist,
        { role: 'user', content: text },
      ]);
      replyText = typeof parsed.reply === 'string' ? parsed.reply : null;
      llmUpdates = pruneEmpty(parsed.brief_updates);
      confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : (parsed.ready_for_outline ? 0.95 : null);
    } catch (e) {
      // LLM 失败：确定性提取继续，reply 用剧本话术
      replyText = null;
    }
    const updates = { ...det, ...llmUpdates }; // LLM 同字段优先
    const merged = await saveBriefDraft(projectId, updates);
    if (!merged.title) merged.title = det.title || '未命名汇报';
    await updateProjectMeta(projectId, { stage: 'material', title: merged.title });
    /* 0.3.4 核心理念：置信度 ≥ 95% 才推进（自动出大纲）；不足则继续一次一问 */
    if (confidence !== null && confidence >= 0.95) {
      return generateOutlineMessages(projectId, model, merged, replyText || '我对需求已有 95% 的把握，先按理解拟一份大纲：');
    }
    return { stage: 'material', messages: [aiText(replyText || '收到，已记录你的信息。请继续补充：还差什么关键信息？')] };
  }

  if (stage === 'outline') {
    const outline = await loadOutline(projectId);
    const parsed = await llmJson(model, outlineTurnSystem(outline), [
      ...hist,
      { role: 'user', content: text },
    ]);
    if (parsed.type === 'confirm') {
      await ensureBriefApproved(projectId, confirmedBy || '用户', '对话确认大纲：' + text.slice(0, 60)); // 0.3.3：随大纲确认过 WF-02 门禁
      await confirmOutline(projectId, confirmedBy || '用户', '对话确认：' + text.slice(0, 80));
      await updateProjectMeta(projectId, { stage: 'style', next_action: '选择风格与页数' });
      return {
        stage: 'style',
        messages: [
          aiText(String(parsed.reply || '大纲确认 ✅。接下来选风格与页数。')),
          aiCard('style', {}),
        ],
      };
    }
    if (parsed.type === 'adjust' && Array.isArray(parsed.changes) && parsed.changes.length) {
      const r = await applyOutlineChanges(projectId, parsed.changes);
      return {
        stage: 'outline',
        messages: [
          aiText(String(parsed.reply || '已按你的要求调整大纲：')),
          aiCard('outline', { outline: outlineCardPayload(r.outline) }),
        ],
      };
    }
    /* chat 分支：顺带吸收确定性需求信号（中途变更需求），LLM 自由应答 */
    const det = pruneEmpty(extractBriefSignals(text));
    if (Object.keys(det).length) await saveBriefDraft(projectId, det);
    return { stage: 'outline', messages: [aiText(String(parsed.reply || '可以告诉我怎么调整大纲，或回复「确认」进入风格选择。'))] };
  }

  /* 0.3.4：制作中途（style/pages/done）的普通消息 = 需求变更或提问——访谈协议处理，不再 canned 提示 */
  if (stage === 'style' || stage === 'pages' || stage === 'done') {
    const det = pruneEmpty(extractBriefSignals(text));
    let llmUpdates = {};
    let replyText = null;
    try {
      const digest = await materialDigest(projectId, 600, 2000);
      const parsed = await llmJson(model, interviewSystem(brief, stage, materials, digest), [
        ...hist,
        { role: 'user', content: text },
      ]);
      replyText = typeof parsed.reply === 'string' ? parsed.reply : null;
      llmUpdates = pruneEmpty(parsed.brief_updates);
    } catch (e) {
      replyText = null;
    }
    const updates = { ...det, ...llmUpdates };
    if (Object.keys(updates).length) {
      const merged = await saveBriefDraft(projectId, updates);
      if (merged.title && merged.title !== '未命名汇报') await updateProjectMeta(projectId, { title: merged.title });
      return { stage, messages: [aiText(replyText || '已更新需求 ✅。随时可重新出大纲、直接生成，或继续说修改指令。')] };
    }
    const hint = {
      style: '在上方风格卡里选风格与页数；也可以直接对话调整需求、出大纲、直接生成，或推翻重来 🔄',
      pages: '逐页版式可「换一换」；也可以直接对话调整需求、重新出大纲，或推翻重来 🔄',
      done: '生成已完成。可以说修改指令、调整需求重新生成，或推翻重来 🔄',
    }[stage];
    return { stage, messages: [aiText(replyText || hint)] };
  }
  if (stage === 'generating') {
    return { stage: 'generating', messages: [aiText('正在生成中，请稍候 ⏳ 完成后我会把结果发到这里。也可以直接说「推翻重来」重新开始 🔄')] };
  }
  if (stage === 'archived') {
    /* 0.3.3：归档态收到消息 = 真重开（镜像 /reopen 路由：解除只读 + 计数 + 刷新索引） */
    const { meta } = await loadProject(projectId);
    if (meta.status === 'archived') {
      await updateProjectMeta(projectId, { status: 'active', stage: 'done', reopen_count: (meta.reopen_count || 0) + 1, next_action: '继续制作或导出' });
    } else {
      await updateProjectMeta(projectId, { stage: 'done' });
    }
    invalidateIndex();
    return { stage: 'done', messages: [aiText('已为你重新打开项目（解除归档只读）✅。现在可以说修改指令（如「把第 2 页标题改成 XXX」），或点「导出 PPTX 并归档」。')] };
  }
  return { stage, messages: [aiText('收到。')] };
}

async function currentTitle(projectId) {
  const { meta } = await loadProject(projectId);
  return meta.title;
}

/* ── 剧本兜底 ── */


/** 直接生成大纲（brief 确认后 / 大纲生成按钮） */
export async function generateOutlineForProject(projectId, modelId, ack) {
  const { meta } = await loadProject(projectId);
  const model = await resolveModel(modelId || meta.dialogue_model);
  const brief = await loadBrief(projectId);
  const out = await generateOutlineMessages(projectId, model, brief, ack);
  await persist(projectId, out.messages.map((m) => ({ role: 'ai', kind: m.kind, text: m.text || '', stage: out.stage })));
  if (model) await updateProjectMeta(projectId, { dialogue_model: model.id });
  return { ...out, model: { id: model.id, label: model.label, tag: model.tag, online: model.online } };
}

/** 恢复对话（进入 studio / 重新打开项目时） */
export async function getConversation(projectId) {
  const { meta } = await loadProject(projectId);
  const items = await readJsonl(path.join(projectDir(projectId), 'conversation.jsonl'));
  return {
    stage: meta.stage || 'idle',
    title: meta.title,
    brief: briefSummary(await loadBrief(projectId)),
    messages: items.map((m, i) => ({ id: 'c' + i, role: m.role, kind: m.kind || 'text', text: m.text || '', payload: m.payload || {}, stage: m.stage })),
  };
}
