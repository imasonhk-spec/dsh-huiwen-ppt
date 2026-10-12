/**
 * 汇文 PPT（@local/huiwen-ppt）—— Client 半（浏览器动态插件）· UI 原型
 *
 * 契约（与政策解读 / 会议助手一致）：
 * - 无构建步骤、无 JSX、无 npm 导入（工厂内只 require('react')）；全部 React.createElement（别名 h）。
 * - 骨架固定：window.__ModuleLoader__.load({ id, factory })；apply 内注册 locale 字典与两个 slot。
 * - 能力包契约（CAPABILITY-PACK-API v1.0）：main key 与 sidebar.panellist id 一律 `cap:<id>` 前缀；
 *   另注册 `cappacks:open-<id>` 打开事件桥（工作台首页「打开」/ 子菜单派发）。
 * - 样式：组件根内一个 <style>（hp-* 前缀类，随组件卸载移除）+ 关键动态值内联；
 *   颜色走 DSH 设计令牌 --dsw-alias-*（body[data-ds-dark-theme] 自动深浅切换，令牌缺失回退浅色），
 *   品牌绿走 --hp-* 自定义属性；正文阅读字号跟随 --dsh-content-font-size。
 * - 无 alert()、无定时器（生成/渲染进度用 CSS 动画 + onAnimationEnd 推进）；
 *   外链一律 target="_blank" rel="noopener noreferrer"。
 * - 本版本为纯前端 UI 原型：数据来自 /api/huiwen-ppt/assets/mock-data.json
 *   （由 huiwen-ppt skill 的真实模板目录、版式与对象边界提取）；
 *   对话为 mock 剧本（预留真模型接口），生成/渲染/导出/应用修订均为模拟反馈，不读写任何真实 PPT 文件。
 * - 三视图（一级导航 归档项目 / 模板库 / 对话制作）：项目首页（已完成/已归档 + 搜索/时间段筛选）
 *   + 模板库（v0.3.0 起回到一级导航，位于「归档项目」与「对话制作」之间）+ 对话制作页（左对话右演化工作区）。
 * - 视图全部常挂载，用 style.display 切换（不条件卸载，对话与画布状态不丢失）。
 */
window.__ModuleLoader__.load({
  id: '@local/huiwen-ppt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useMemo, useRef, useEffect, useCallback } = React;

    const NS = 'huiwenPpt';
    const PANEL_ID = 'cap:huiwen-ppt';
    const OPEN_EVENT = 'cappacks:open-huiwen-ppt';
    const SIDEBAR_EVENT = 'hp:huiwen-ppt-sidebar';
    const VERSION = 'v0.3.5';
    const API = '/api/huiwen-ppt';
    const img = (name) => API + '/assets/previews/' + name;

    /* ════════ 语义令牌（DSH 设计令牌 + 浅色回退；品牌绿为 --hp-* 自定义属性） ════════ */
    const TK = {
      bg: 'var(--dsw-alias-bg-module-platform, #f1f5f9)',
      surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      surface2: 'var(--dsw-alias-bg-layer-2, #f8fafc)',
      border: 'var(--dsw-alias-border-l1, #e2e8f0)',
      border2: 'var(--dsw-alias-border-l2, #cbd5e1)',
      text1: 'var(--dsw-alias-label-primary, #0f172a)',
      text2: 'var(--dsw-alias-label-secondary, #475569)',
      text3: 'var(--dsw-alias-label-tertiary, #94a3b8)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #f1f5f9)',
    };

    /* ════════ 通用常量 ════════ */
    const RELATIONS = ['封面', '需求', '总览', '流程', '架构', '生态', '对比', '数据', '案例', '计划', '表格', '治理', '素材', '收尾'];
    const CHECK_LABELS = { structural: '结构', render: '渲染', visual_review: '视觉检查', editability: '编辑抽查', user_acceptance: '用户验收' };
    const FAMILY_NAME = { 'green-clean-business': '绿色简洁商务', 'green-office-illustrated': '绿色办公插画' };
    const APPROVAL_LABEL = { approved: '已批准', pending: '待确认', reference: '仅供参考' };
    const SLIDE_PAGES = [
      { n: 1, label: '封面', preview: 'clean-slide-01.png', layout: 'clean-cover', status: 'rendered' },
      { n: 2, label: '需求与服务映射', preview: 'clean-slide-02.png', layout: 'clean-needs', status: 'rendered' },
      { n: 4, label: '四步流程与交接', preview: 'clean-slide-04.png', layout: 'clean-flow', status: 'pending_review' },
      { n: 9, label: '案例机制与证据', preview: 'clean-slide-09.png', layout: 'clean-case', status: 'rendered' },
    ];

    /* ════════ locale 字典（面板标签等少量键；界面正文为中文原型文案） ════════ */
    const ZH = { panel: '汇文 PPT' };
    const EN = { panel: 'Huiwen PPT' };

    /* ════════ hp-* 样式表（组件根内一个 <style>，随卸载移除） ════════ */
    const CSS_TEXT = [
      '.hp-root, .hp-root * { box-sizing: border-box; }',
      '.hp-root button, .hp-root input, .hp-root select, .hp-root textarea { font-family: inherit; }',
      '.hp-root {',
      '  --hp-accent: #086440; --hp-accent-strong: #075735; --hp-accent-ink: #ffffff;',
      '  --hp-accent-soft: #EDF5F1; --hp-accent-soft-border: #BBD7C9; --hp-accent-ring: rgba(8,100,64,.16);',
      '  --hp-amber: #EDA500; --hp-amber-soft: #FFF7E3; --hp-amber-border: #F0D9A0; --hp-amber-text: #8A6100;',
      '  --hp-danger: #C2410C; --hp-lock: #94A3B8;',
      '  display: flex; height: 100%; min-height: 0; overflow: hidden; position: relative;',
      '  background: var(--dsw-alias-bg-module-platform, #f1f5f9);',
      '  color: var(--dsw-alias-label-primary, #0f172a);',
      '  font-size: var(--dsh-content-font-size, 14px);',
      '  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
      '}',
      'body[data-ds-dark-theme] .hp-root {',
      '  --hp-accent: #34B27C; --hp-accent-strong: #4CC790; --hp-accent-ink: #06281A;',
      '  --hp-accent-soft: rgba(52,178,124,.14); --hp-accent-soft-border: rgba(52,178,124,.38); --hp-accent-ring: rgba(52,178,124,.22);',
      '  --hp-amber: #F2B736; --hp-amber-soft: rgba(242,183,54,.14); --hp-amber-border: rgba(242,183,54,.4); --hp-amber-text: #F2C766;',
      '  --hp-lock: #64748B;',
      '}',
      /* ── 左侧导航 ── */
      '.hp-nav { width: 216px; flex: none; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fff); border-right: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-brand { padding: 18px 16px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-navlist { flex: 1; overflow: auto; padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; }',
      '.hp-navitem { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 8px 12px; border: none; border-radius: 10px; background: transparent; cursor: pointer; text-align: left; font-size: 14px; color: var(--dsw-alias-label-secondary, #475569); }',
      '.hp-navitem:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-navitem.on { background: var(--hp-accent-soft); color: var(--hp-accent); font-weight: 600; }',
      '.hp-navitem .ic { width: 20px; text-align: center; flex: none; }',
      '.hp-navfoot { padding: 12px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      /* ── 导航二级目录：对话制作 → 新建对话 + 历史对话 ── */
      '.hp-navblock { display: flex; flex-direction: column; }',
      '.hp-navcaret { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary, #94a3b8); transition: transform .15s ease; }',
      '.hp-navcaret.open { transform: rotate(180deg); }',
      '.hp-navsub { display: flex; flex-direction: column; gap: 3px; margin: 2px 0 6px 14px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-navnew { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 32px; padding: 5px 10px; border: 1px solid var(--hp-accent-soft-border, #bbd7c9); border-radius: 9px; background: var(--hp-accent-soft); color: var(--hp-accent); font-family: inherit; font-size: 12.5px; font-weight: 600; text-align: left; cursor: pointer; }',
      '.hp-navnew:hover { filter: brightness(.97); }',
      '.hp-navseclabel { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 7px 8px 1px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      '.hp-navconvs { display: flex; flex-direction: column; gap: 2px; max-height: 44vh; overflow-y: auto; }',
      '.hp-navconv { display: flex; align-items: center; gap: 2px; border-radius: 8px; }',
      '.hp-navconv:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-navconv.on { background: var(--hp-accent-soft); }',
      '.hp-navconv-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #475569); font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }',
      '.hp-navconv.on .hp-navconv-main { color: var(--hp-accent); font-weight: 600; }',
      '.hp-navconv-main .ttl { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.hp-navconv-main .meta { display: block; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      '.hp-navconv-more { flex: none; width: 24px; height: 24px; margin-right: 3px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #94a3b8); font-family: inherit; font-size: 14px; line-height: 1; cursor: pointer; }',
      '.hp-navconv-more:hover, .hp-navconv-more.on { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f172a); }',
      '.hp-navconv-item { display: flex; flex-direction: column; }',
      '.hp-navconv-menu { display: flex; flex-direction: column; gap: 1px; margin: 2px 0 4px 4px; padding: 4px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); box-shadow: 0 6px 16px rgba(16,28,48,.08); }',
      '.hp-navconv-menu button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #475569); font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }',
      '.hp-navconv-menu button:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-navconv-menu button.danger { color: #dc2626; }',
      '.hp-navconv-menu button.danger:hover { background: rgba(220,38,38,.08); }',
      '.hp-navsub-empty { padding: 4px 8px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      /* ── 主区 ── */
      '.hp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }',
      '.hp-scroll { flex: 1; overflow: auto; padding: 22px 26px 40px; }',
      '.hp-h1 { margin: 0; font-size: 20px; font-weight: 700; }',
      '.hp-sub { margin: 4px 0 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      '.hp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      /* ── 按钮 / 徽章 / 卡片 ── */
      '.hp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 0 16px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f172a); cursor: pointer; font-size: 13px; white-space: nowrap; }',
      '.hp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-btn.pri { background: var(--hp-accent); border-color: var(--hp-accent); color: var(--hp-accent-ink); font-weight: 600; }',
      '.hp-btn.pri:hover { background: var(--hp-accent-strong); }',
      '.hp-btn.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #475569); }',
      '.hp-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-btn.sm { min-height: 32px; padding: 0 10px; font-size: 12px; border-radius: 8px; }',
      '.hp-btn:disabled { opacity: .45; cursor: not-allowed; }',
      '.hp-btn:disabled:hover { background: var(--dsw-alias-bg-layer-1, #fff); }',
      '.hp-btn.pri:disabled:hover { background: var(--hp-accent); }',
      '.hp-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2, #f8fafc); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); color: var(--dsw-alias-label-secondary, #475569); white-space: nowrap; }',
      '.hp-badge { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }',
      '.hp-badge.ok { background: var(--hp-accent-soft); color: var(--hp-accent); border: 1px solid var(--hp-accent-soft-border); }',
      '.hp-badge.pend { background: var(--hp-amber-soft); color: var(--hp-amber-text); border: 1px solid var(--hp-amber-border); }',
      '.hp-badge.lock { background: var(--dsw-alias-bg-layer-2, #f8fafc); color: var(--hp-lock); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-card { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 14px; }',
      /* ── 输入 ── */
      '.hp-label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); margin: 0 0 6px; }',
      '.hp-input, .hp-select, .hp-textarea { width: 100%; border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f172a); padding: 8px 10px; font-size: 13px; outline: none; }',
      '.hp-input:focus, .hp-select:focus, .hp-textarea:focus { border-color: var(--hp-accent); box-shadow: 0 0 0 3px var(--hp-accent-ring); }',
      '.hp-archfilter { position: sticky; top: 0; z-index: 2; }',
      '.hp-archfilter input[type="search"]::-webkit-search-cancel-button { cursor: pointer; }',
      '.hp-archfilter-ic { flex: none; font-size: 13px; opacity: .7; }',
      '.hp-archfilter-field { display: inline-flex; align-items: center; gap: 6px; flex: none; }',
      '.hp-archfilter-lbl { font-size: 12px; color: var(--dsw-alias-label-tertiary, #94a3b8); white-space: nowrap; }',
      '@media (max-width: 760px) { .hp-archfilter-field { flex: 1 1 100%; } .hp-archfilter-field .hp-input { flex: 1 1 auto; min-width: 0; width: auto; } }',
      '.hp-textarea { resize: vertical; min-height: 72px; }',
      /* ── 模板库 ── */
      '.hp-tgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(252px, 1fr)); gap: 16px; }',
      '.hp-tcard { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 14px; overflow: hidden; cursor: pointer; transition: box-shadow .15s, border-color .15s; }',
      '.hp-tcard:hover { border-color: var(--hp-accent-soft-border); box-shadow: 0 6px 20px rgba(15,23,42,.09); }',
      '.hp-tprev { position: relative; aspect-ratio: 16 / 9; background: var(--hp-accent-soft); overflow: hidden; }',
      '.hp-tprev img { width: 100%; height: 100%; object-fit: cover; display: block; }',
      '.hp-tprev .corner { position: absolute; left: 8px; top: 8px; }',
      '.hp-tbody { padding: 10px 12px 12px; }',
      '.hp-tid { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      /* ── 抽屉 / 模态 ── */
      '.hp-mask { position: fixed; inset: 0; background: rgba(15,23,42,.32); z-index: 60; }',
      '.hp-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 620px; max-width: 94vw; background: var(--dsw-alias-bg-layer-1, #fff); z-index: 61; box-shadow: -12px 0 40px rgba(15,23,42,.18); display: flex; flex-direction: column; }',
      '.hp-dhead { padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }',
      '.hp-dbody { flex: 1; overflow: auto; padding: 18px 20px 28px; }',
      '.hp-dfoot { padding: 12px 20px; border-top: 1px solid var(--dsw-alias-border-l1, #e2e8f0); display: flex; gap: 10px; justify-content: flex-end; }',
      '.hp-modal { position: fixed; inset: 0; z-index: 70; background: rgba(15,23,42,.38); display: flex; align-items: center; justify-content: center; padding: 24px; }',
      '.hp-mbox { width: 560px; max-width: 94vw; max-height: 88vh; background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(15,23,42,.28); }',
      /* ── 向导 ── */
      '.hp-wiz { display: flex; gap: 26px; align-items: flex-start; }',
      '.hp-steps { width: 208px; flex: none; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; }',
      '.hp-step { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 13px; }',
      '.hp-step .n { width: 22px; height: 22px; flex: none; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2, #cbd5e1); display: flex; align-items: center; justify-content: center; font-size: 11px; }',
      '.hp-step.on { color: var(--hp-accent); background: var(--hp-accent-soft); font-weight: 600; }',
      '.hp-step.on .n { background: var(--hp-accent); border-color: var(--hp-accent); color: var(--hp-accent-ink); }',
      '.hp-step.done { color: var(--dsw-alias-label-secondary, #475569); }',
      '.hp-step.done .n { background: var(--hp-accent-soft); border-color: var(--hp-accent-soft-border); color: var(--hp-accent); }',
      '.hp-wizbody { flex: 1; min-width: 0; }',
      '.hp-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); overflow: hidden; }',
      '.hp-progress > i { display: block; height: 100%; border-radius: 3px; background: var(--hp-accent); animation: hpFill 2.2s ease-out forwards; }',
      '@keyframes hpFill { from { width: 3%; } to { width: 100%; } }',
      /* ── 画布 ── */
      '.hp-cv { display: flex; flex-direction: column; height: 100%; overflow: hidden; }',
      '.hp-cv-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-1, #fff); flex-wrap: wrap; }',
      '.hp-cv-sep { width: 1px; height: 22px; background: var(--dsw-alias-border-l1, #e2e8f0); flex: none; }',
      '.hp-cv-body { flex: 1; display: flex; min-height: 0; }',
      '.hp-cv-left { width: 138px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-1, #fff); overflow: auto; padding: 10px 8px; display: flex; flex-direction: column; gap: 10px; }',
      '.hp-cv-thumb { border: 2px solid transparent; border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-layer-2, #f8fafc); padding: 0; text-align: left; }',
      '.hp-cv-thumb.on { border-color: var(--hp-accent); }',
      '.hp-cv-thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; }',
      '.hp-cv-outer { flex: 1; min-width: 0; overflow: auto; background: var(--dsw-alias-bg-module-platform, #eceff3); display: flex; align-items: flex-start; justify-content: center; padding: 30px 34px; }',
      '.hp-stage { position: relative; width: 1280px; height: 720px; background: #fff; box-shadow: 0 8px 32px rgba(15,23,42,.18); flex: none; transform-origin: top left; }',
      '.hp-stage > img.bg { position: absolute; inset: 0; width: 1280px; height: 720px; user-select: none; -webkit-user-drag: none; pointer-events: none; }',
      '.hp-obj { position: absolute; border: 1.5px solid rgba(8,100,64,0); border-radius: 2px; cursor: pointer; padding: 0; background: transparent; }',
      '.hp-obj:hover { border-color: rgba(8,100,64,.5); }',
      '.hp-obj.on { border-color: var(--hp-accent); box-shadow: 0 0 0 3px var(--hp-accent-ring); }',
      '.hp-obj.lock { border: 1.5px dashed rgba(100,116,139,.6); cursor: not-allowed; }',
      '.hp-obj .tag { position: absolute; top: -21px; left: -2px; font-size: 10px; line-height: 16px; background: var(--hp-accent); color: #fff; padding: 0 6px; border-radius: 4px; white-space: nowrap; display: none; pointer-events: none; }',
      '.hp-obj.on .tag { display: block; }',
      '.hp-cv-right { width: 300px; flex: none; border-left: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-1, #fff); display: flex; flex-direction: column; min-height: 0; }',
      '.hp-cv-tabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-cv-tab { flex: 1; min-height: 40px; border: none; background: transparent; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-tertiary, #94a3b8); border-bottom: 2px solid transparent; }',
      '.hp-cv-tab.on { color: var(--hp-accent); border-bottom-color: var(--hp-accent); font-weight: 600; }',
      '.hp-cv-panel { flex: 1; overflow: auto; padding: 14px; }',
      '.hp-statusbar { display: flex; align-items: center; gap: 14px; min-height: 36px; padding: 4px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #e2e8f0); background: var(--dsw-alias-bg-layer-1, #fff); font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); flex-wrap: wrap; }',
      '.hp-queue { position: absolute; left: 150px; bottom: 46px; width: 420px; max-width: 60vw; max-height: 260px; overflow: auto; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l2, #cbd5e1); border-radius: 12px; box-shadow: 0 12px 36px rgba(15,23,42,.2); z-index: 40; }',
      /* ── 提示条 / 空态 / Toast ── */
      '.hp-note { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 1.6; background: var(--hp-accent-soft); border: 1px solid var(--hp-accent-soft-border); color: var(--dsw-alias-label-secondary, #475569); }',
      '.hp-note.warn { background: var(--hp-amber-soft); border-color: var(--hp-amber-border); }',
      '.hp-empty { padding: 48px 20px; text-align: center; color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 13px; }',
      '.hp-toast { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; gap: 10px; max-width: 72vw; padding: 10px 18px; border-radius: 10px; background: #0f172a; color: #fff; font-size: 13px; box-shadow: 0 10px 28px rgba(0,0,0,.28); animation: hpToast 3s ease forwards; }',
      '@keyframes hpToast { 0% { opacity: 0; transform: translate(-50%, 8px); } 8% { opacity: 1; transform: translate(-50%, 0); } 84% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, 6px); } }',
      /* ── 表格 / 定义列表 ── */
      '.hp-kv { display: grid; grid-template-columns: 96px 1fr; gap: 8px 14px; font-size: 13px; }',
      '.hp-kv dt { color: var(--dsw-alias-label-tertiary, #94a3b8); margin: 0; }',
      '.hp-kv dd { margin: 0; color: var(--dsw-alias-label-primary, #0f172a); word-break: break-all; }',
      '.hp-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.hp-table th, .hp-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-table th { color: var(--dsw-alias-label-tertiary, #94a3b8); font-weight: 500; }',
      '.hp-mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11px; }',
      '.hp-json { background: var(--dsw-alias-bg-layer-2, #f8fafc); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 10px; padding: 12px 14px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; line-height: 1.7; overflow: auto; white-space: pre; color: var(--dsw-alias-label-secondary, #475569); }',
      /* 模板预览图保留模板自身绿色视觉体系，不随深色主题反色 */
      '.hp-tprev, .hp-cv-thumb, .hp-stage { color-scheme: light; }',
      /* ── 对话制作页（左对话 + 右演化工作区） ── */
      '.hp-cs { display: flex; height: 100%; min-height: 0; overflow: hidden; }',
      '.hp-chat { width: 50%; flex: none; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fff); border-right: 1px solid var(--dsw-alias-border-l1, #e2e8f0); min-height: 0; }',
      '.hp-chat-head { padding: 11px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px; }',
      '.hp-msgs { flex: 1; overflow: auto; padding: 16px 14px 20px; display: flex; flex-direction: column; gap: 12px; }',
      '.hp-msg { display: flex; gap: 8px; align-items: flex-start; }',
      '.hp-msg.user { flex-direction: row-reverse; }',
      '.hp-avatar { width: 28px; height: 28px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 14px; background: var(--hp-accent-soft); border: 1px solid var(--hp-accent-soft-border); }',
      '.hp-msg.user .hp-avatar { background: var(--dsw-alias-bg-layer-2, #f8fafc); border-color: var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-bubble { max-width: 88%; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.65; background: var(--dsw-alias-bg-layer-2, #f8fafc); border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '.hp-msg.user .hp-bubble { background: var(--hp-accent-soft); border-color: var(--hp-accent-soft-border); }',
      '.hp-bubble.wide { max-width: 98%; width: 98%; }',
      '.hp-chat-input { border-top: 1px solid var(--dsw-alias-border-l1, #e2e8f0); padding: 10px 12px 12px; }',
      /* 输入区：知识库/会议助手/政策解读同款（政策解读 PA-COMPOSER-20261005 原文样式：
         圆角卡片 + 无边框输入区 + 工具条圆钮 + 圆形渐变发送） */
      '.hp-composer { box-sizing: border-box; display: block; position: relative; background: var(--dsw-alias-bg-layer-1, #fff); border: 0; border-radius: 22px; box-shadow: 0 0 0 .5px var(--dsw-alias-border-l1, #e6eaf1), 0 6px 18px rgba(21,42,76,.05); padding: 2px 0 0; transition: box-shadow .15s ease; }',
      '.hp-composer:hover { box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2, #dfe5ee), 0 8px 22px rgba(21,42,76,.07); }',
      '.hp-composer:focus-within { box-shadow: 0 0 0 .5px var(--hp-accent-soft-border, #bbd7c9), 0 6px 18px rgba(21,42,76,.06); }',
      /* 拖拽落点（hpDrop-20261012）：本插件自己的强调色虚线 + 胶囊提示（形状与政策解读一致，配色用汇文绿） */
      '.hp-composer.hp-drop { outline: 2px dashed var(--hp-accent, #086440); outline-offset: 2px; background: var(--hp-accent-soft, #EDF5F1); }',
      '.hp-compose-pill { display: inline-flex; align-items: center; gap: 6px; margin: 10px 0 0 14px; padding: 3px 10px; border-radius: 999px; background: var(--hp-accent-soft, #EDF5F1); color: var(--hp-accent-strong, #075735); font-size: 12px; border: 1px solid var(--hp-accent-soft-border, #BBD7C9); }',
      '.hp-compose-input { display: block; box-sizing: border-box; width: 100%; min-height: 54px; max-height: 200px; margin: 0; padding: 6px 14px 0 14px; border: 0; border-radius: 0; background: transparent; color: var(--dsw-alias-label-primary, #0f172a); font-family: inherit; font-size: 14px; line-height: 24px; resize: none; outline: none; }',
      '.hp-compose-input:focus, .hp-compose-input:focus-visible { outline: none !important; box-shadow: none !important; border: 0; }',
      '.hp-compose-input::placeholder { color: #9ca3af; }',
      '.hp-compose-bar { display: flex; align-items: center; gap: 8px; padding: 2px 10px 8px 12px; }',
      '.hp-compose-gap { flex: 1 1 auto; min-width: 8px; }',
      '.hp-compose-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; min-width: 28px; padding: 0; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #5f6b7e); font-size: 15px; line-height: 1; cursor: pointer; }',
      '.hp-compose-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eef2f8); color: var(--dsw-alias-label-primary, #2a3342); }',
      '.hp-compose-model { flex: 0 1 auto; min-width: 0; max-width: 210px; height: 28px; padding: 0 4px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #5f6b7e); font-family: inherit; font-size: 12px; cursor: pointer; }',
      '.hp-compose-model:hover { background: var(--dsw-alias-interactive-bg-hover, #eef2f8); color: var(--dsw-alias-label-primary, #2a3342); }',
      '.hp-compose-send { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; min-width: 34px; padding: 0; border: 0; border-radius: 999px; background: linear-gradient(135deg, var(--hp-accent, #2563eb), var(--hp-accent-strong, #1d4ed8)); color: #fff; font-size: 15px; line-height: 1; cursor: pointer; }',
      '.hp-compose-send:disabled { opacity: .45; cursor: not-allowed; }',
      '.hp-compose-atwrap { position: relative; display: inline-flex; }',
      '.hp-atbox { position: absolute; left: 0; bottom: 40px; z-index: 60; min-width: 220px; max-width: 300px; max-height: 240px; overflow: auto; padding: 6px; border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 10px 26px rgba(16,28,48,.16); }',
      '.hp-atitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #1f2937); font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }',
      '.hp-atitem:hover { background: var(--dsw-alias-interactive-bg-hover, #eef2f8); }',
      '.hp-atitem em { margin-left: auto; color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 11px; font-style: normal; }',
      '.hp-atempty { padding: 10px; color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 12px; }',
      '.hp-sugg { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }',
      '.hp-suggbtn { min-height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--hp-accent-soft-border); background: var(--hp-accent-soft); color: var(--hp-accent); font-size: 12px; cursor: pointer; }',
      '.hp-suggbtn:hover { background: var(--hp-accent); color: var(--hp-accent-ink); }',
      '.hp-typing { display: inline-flex; gap: 4px; padding: 4px 2px; }',
      '.hp-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #94a3b8); animation: hpBlink 1.05s ease-in-out infinite; }',
      '.hp-typing i:nth-child(2) { animation-delay: .18s; }',
      '.hp-typing i:nth-child(3) { animation-delay: .36s; }',
      '@keyframes hpBlink { 0%,100% { opacity: .25; transform: translateY(0); } 45% { opacity: 1; transform: translateY(-3px); } }',
      '@keyframes hpTypeHold { from { opacity: .99; } to { opacity: 1; } }',
      '.hp-stage-pane { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 22px 26px 34px; }',
      '.hp-stage-pane.tight { overflow: hidden; padding: 0; }',
      /* 大纲 / 选择卡 / 生成进度 / 材料 */
      '.hp-ol-item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 9px; }',
      '.hp-ol-item:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '.hp-ol-n { width: 22px; height: 22px; flex: none; border-radius: 50%; background: var(--hp-accent-soft); border: 1px solid var(--hp-accent-soft-border); color: var(--hp-accent); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }',
      '.hp-pick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; }',
      '.hp-pick { border: 2px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 10px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-layer-1, #fff); text-align: left; padding: 0; }',
      '.hp-pick:hover { border-color: var(--hp-accent-soft-border); }',
      '.hp-pick.on { border-color: var(--hp-accent); box-shadow: 0 0 0 3px var(--hp-accent-ring); }',
      '.hp-pick img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; display: block; }',
      '.hp-pick .pb { padding: 7px 9px; font-size: 12px; }',
      '.hp-gen-step { display: flex; align-items: center; gap: 10px; padding: 9px 2px; }',
      '.hp-gen-ic { width: 20px; height: 20px; flex: none; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l2, #cbd5e1); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--dsw-alias-label-tertiary, #94a3b8); }',
      '.hp-gen-ic.run { border-color: var(--hp-accent); color: var(--hp-accent); }',
      '.hp-gen-ic.ok { background: var(--hp-accent); border-color: var(--hp-accent); color: var(--hp-accent-ink); }',
      '.hp-mat { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, #e2e8f0); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); }',
      '.hp-mat .fileic { width: 32px; height: 32px; flex: none; border-radius: 8px; background: var(--hp-accent-soft); display: flex; align-items: center; justify-content: center; font-size: 15px; }',
      '.hp-progress.fast > i { animation-duration: 1.3s; }',
      /* 对话栏宽度拖拽 + 自定义风格 */
      '.hp-chat { position: relative; }',
      '.hp-chat-resize { position: absolute; top: 0; bottom: 0; right: -5px; width: 10px; cursor: col-resize; z-index: 30; touch-action: none; }',
      '.hp-chat-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 2px; background: transparent; }',
      '.hp-chat-resize:hover::after, .hp-chat-resize.on::after { background: var(--hp-accent); }',
      '.hp-cs.dragging { user-select: none; cursor: col-resize; }',
      '.hp-swatch { width: 22px; height: 22px; border-radius: 6px; border: 1px solid rgba(15,23,42,.14); display: inline-block; }',
      '.hp-customprev { width: 100%; aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; font-size: 28px; color: #fff; }',
      /* ── 移动端：顶栏 + ☰ 汉堡 + off-canvas 导航抽屉（政策解读 pa-module-* 同款约定） ── */
      '.hp-topbar { display: none; }',
      '.hp-navscrim { display: none; }',
      '@media (max-width: 760px) {',
      '  .hp-root { flex-direction: column; }',
      '  .hp-topbar { display: flex; align-items: center; gap: 10px; flex: none; min-height: 48px; padding: 0 12px; position: relative; z-index: 41; background: var(--dsw-alias-bg-layer-1, #fff); border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '  .hp-navtoggle { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: none; padding: 0; border: 1px solid var(--dsw-alias-border-l2, #cbd5e1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f172a); font-size: 15px; line-height: 1; cursor: pointer; }',
      '  .hp-navtoggle:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f5f9); }',
      '  .hp-topbar-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '  .hp-nav { position: fixed; left: 0; top: 0; bottom: 0; z-index: 40; width: min(240px, 84vw); max-width: none; box-shadow: 8px 0 24px rgba(16,28,48,.18); transform: translateX(-110%); transition: transform .16s ease; }',
      '  .hp-nav.open { transform: translateX(0); }',
      '  .hp-navscrim { display: block; position: fixed; inset: 0; z-index: 39; padding: 0; border: 0; background: rgba(16,28,48,.3); cursor: pointer; }',
      '  .hp-cs { flex-direction: column; }',
      '  .hp-chat { width: 100% !important; flex: 1 1 auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e8f0); }',
      '  .hp-chat-resize { display: none; }',
      '  .hp-stage-pane { flex: 0 0 auto; max-height: 46vh; }',
      '  .hp-scroll { padding: 16px 14px 32px; }',
      '  .hp-chat-head { padding: 9px 12px; }',
      '  .hp-cv-left { width: 104px; }',
      '  .hp-cv-right { width: 240px; }',
      '  .hp-cv-outer { padding: 16px; }',
      '}',
    ].join('\n');

    /* ════════ 通用小组件 ════════ */
    function Btn({ kind, sm, disabled, onClick, title, style, children }) {
      return h('button', {
        className: 'hp-btn' + (kind ? ' ' + kind : '') + (sm ? ' sm' : ''),
        disabled: !!disabled, onClick, title, style, type: 'button',
      }, children);
    }
    function Chip({ children, style }) { return h('span', { className: 'hp-chip', style }, children); }
    function Badge({ tone, children }) { return h('span', { className: 'hp-badge ' + (tone || 'lock') }, children); }
    function ApprovalBadge({ value }) {
      const tone = value === 'approved' ? 'ok' : value === 'pending' ? 'pend' : 'lock';
      return h(Badge, { tone }, (APPROVAL_LABEL[value] || value));
    }
    function SectionHead({ title, sub, right }) {
      return h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 14 } },
        h('div', null,
          h('h2', { className: 'hp-h1', style: { fontSize: 16 } }, title),
          sub ? h('p', { className: 'hp-sub' }, sub) : null),
        right || null);
    }
    function EmptyHint({ icon, text }) {
      return h('div', { className: 'hp-empty' }, h('div', { style: { fontSize: 28, marginBottom: 8 } }, icon || '🗂️'), h('div', null, text));
    }
    function CheckDot({ label, value }) {
      const ok = value === 'pass';
      const pend = value === 'pending';
      const color = ok ? 'var(--hp-accent)' : pend ? 'var(--hp-amber)' : 'var(--hp-lock)';
      const mark = ok ? '✓' : pend ? '◔' : '—';
      return h('span', { className: 'hp-row', style: { gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#94a3b8)', flexWrap: 'nowrap' }, title: label + '：' + (ok ? '通过' : pend ? '待处理' : '未验证') },
        h('span', { style: { color, fontWeight: 700 } }, mark), label);
    }
    function Modal({ title, sub, onClose, children, footer, width }) {
      return h('div', { className: 'hp-modal', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'hp-mbox', style: width ? { width } : null, role: 'dialog', 'aria-label': title },
          h('div', { className: 'hp-dhead' },
            h('div', null,
              h('div', { style: { fontSize: 15, fontWeight: 700 } }, title),
              sub ? h('p', { className: 'hp-sub', style: { marginTop: 2 } }, sub) : null),
            h(Btn, { kind: 'ghost', sm: true, onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'hp-dbody' }, children),
          footer ? h('div', { className: 'hp-dfoot' }, footer) : null));
    }
    function Drawer({ title, sub, onClose, children, footer }) {
      return h(React.Fragment, null,
        h('div', { className: 'hp-mask', onClick: onClose }),
        h('aside', { className: 'hp-drawer', role: 'dialog', 'aria-label': title },
          h('div', { className: 'hp-dhead' },
            h('div', null,
              h('div', { style: { fontSize: 15, fontWeight: 700 } }, title),
              sub ? h('p', { className: 'hp-sub', style: { marginTop: 2 } }, sub) : null),
            h(Btn, { kind: 'ghost', sm: true, onClick: onClose, title: '关闭' }, '✕')),
          h('div', { className: 'hp-dbody' }, children),
          footer ? h('div', { className: 'hp-dfoot' }, footer) : null));
    }
    function Toast({ toast, onDone }) {
      if (!toast) return null;
      return h('div', { className: 'hp-toast', key: toast.key, onAnimationEnd: onDone, role: 'status' },
        h('span', { style: { color: '#4ade80' } }, '✓'), h('span', null, toast.msg));
    }

    /* ════════ 视图一：项目首页（进行中 / 已归档 分区） ════════ */
    function ProjectHome({ data, projects, onNav, onToast, backend, onReloadProjects, onNewConversation }) {
      const importRef = useRef(null);
      const [importing, setImporting] = useState(false);
      const [verDrawer, setVerDrawer] = useState(null); // { project, loading, data, error }
      const isReal = !!(backend && backend.mode === 'real');
      const styleName = (id) => FAMILY_NAME[id] || id || '未指定';
      /* 本页 = 归档项目：只列已完成/已归档（进行中统一在「对话制作 → 历史对话」） */
      const archived = projects.filter((p) => isArchivedCard(p));

      /* ════════ v0.3.2 归档项目：关键词搜索 + 「从…到…」时间段筛选（日期级，按天，含边界） ════════
       * 起止为日期（'YYYY-MM-DD'，type=date）；卡片 updated（'YYYY-MM-DD HH:mm' / ISO）只取日期部分。
       * 起止都含当天整天：从 D1 到 D2 ≡ D1 00:00 ~ D2 23:59。快捷区间会把实际起止日期回填进「从 / 到」；
       * 日期无法解析的项目只在「全部时间」可见。 */
      const [archQ, setArchQ] = useState('');
      const [archRange, setArchRange] = useState('all'); // all | today | 7d | 30d | 90d | custom
      const [archFrom, setArchFrom] = useState(''); // 'YYYY-MM-DD' | ''
      const [archTo, setArchTo] = useState('');
      const archP2 = (n) => String(n).padStart(2, '0');
      const archYmd = (d) => d.getFullYear() + '-' + archP2(d.getMonth() + 1) + '-' + archP2(d.getDate());
      /* 任意时间串（'YYYY-MM-DD HH:mm' / ISO / Date）→ 'YYYY-MM-DD'；不可解析返回 null。
       * 只按日期比较，避免跨时区/时分带来的歧义。 */
      const archDay = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : archYmd(v);
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
      };
      /* 快捷区间 → 起止 Date（含边界）；all / custom 无预设 */
      const archPresetBounds = (key) => {
        if (key === 'all' || key === 'custom') return null;
        const t0 = new Date(); t0.setHours(0, 0, 0, 0);
        const days = key === 'today' ? 1 : key === '7d' ? 7 : key === '30d' ? 30 : key === '90d' ? 90 : 0;
        if (!days) return null;
        const start = new Date(t0); start.setDate(start.getDate() - (days - 1));
        return { from: start, to: t0 };
      };
      const archFromDay = archDay(archFrom);
      const archToDay = archDay(archTo);
      const archFiltered = archived.filter((p) => {
        const kw = archQ.trim().toLowerCase();
        if (kw) {
          const hay = [p.title, p.file, p.version, styleName(p.style), p.engine, p.sha256]
            .filter((x) => typeof x === 'string').join(' ').toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        if (!archFromDay && !archToDay) return true;
        const pd = archDay(p.updated);
        if (!pd) return false; // 日期不可解析 → 仅「全部时间」可见
        if (archFromDay && pd < archFromDay) return false; // ISO 日期串可直接字典序比较
        if (archToDay && pd > archToDay) return false;
        return true;
      });
      const archFilterOn = !!archQ.trim() || archRange !== 'all' || archFrom !== '' || archTo !== '';
      const resetArchFilter = () => { setArchQ(''); setArchRange('all'); setArchFrom(''); setArchTo(''); };

      /* WF-01：导入 PPTX（真实后端：二进制上传 → 建项目 → 刷新列表） */
      const doImport = async (f) => {
        if (!f) return;
        if (!isReal) { onToast('后端未连接：材料上传需要后端解析，请通过 DSH 正常打开本应用'); return; }
        setImporting(true);
        onToast('正在导入「' + f.name + '」…');
        try {
          const res = await fetch(API + '/api/projects/import?filename=' + encodeURIComponent(f.name) + '&title=' + encodeURIComponent(f.name.replace(/\.[^.]+$/, '')), {
            method: 'POST', body: f, credentials: 'same-origin',
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          onToast('已导入「' + j.project.title + '」· ' + j.project.page_count + ' 页 · 项目 ' + j.project.id);
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          onToast('导入失败：' + (e && e.message ? e.message : e));
        } finally {
          setImporting(false);
        }
      };

      /* WF-01：版本列表（真实后端：versions 扫描 + SHA256） */
      const openVersions = async (p) => {
        if (!isReal) { onToast('后端未连接：版本列表需要后端数据'); return; }
        setVerDrawer({ project: p, loading: true, data: null, error: null });
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(p.id) + '/versions', { credentials: 'same-origin' });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setVerDrawer({ project: p, loading: false, data: j, error: null });
        } catch (e) {
          setVerDrawer({ project: p, loading: false, data: null, error: String(e && e.message ? e.message : e) });
        }
      };

      /* WF-07：版本回滚（真实后端：旧内容登记为新修订 + 重渲染，版本链不断） */
      const rollbackVersion = async (v) => {
        const label = 'v' + String(v.file).split('revision-')[1].replace('.pptx', '').padStart(4, '0');
        if (!isReal || verDrawer.project.id.indexOf('project-chat-') === 0) { onToast('后端未连接或项目不存在：不支持回滚'); return; }
        onToast('回滚中：' + label + ' → 生成新修订…');
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(verDrawer.project.id) + '/rollback', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }), credentials: 'same-origin',
          }).then((r) => r.json());
          if (!res.ok) throw new Error(res.message || '回滚失败');
          onToast('已回滚：新修订 ' + res.version + '（内容 = ' + label + '），渲染样张已更新');
          await openVersions(verDrawer.project);
          if (onReloadProjects) onReloadProjects();
        } catch (e) { onToast('回滚失败：' + (e && e.message ? e.message : e)); }
      };

      /* WF-08/WF-01：重新打开（真实后端：解除归档只读） */
      const reopen = async (p) => {
        const fake = String(p.id || '').indexOf('project-chat-') === 0; // 演示剧本伪造卡：服务端无此项目
        if (!isReal || fake) {
          onNav('studio');
          onToast(fake
            ? '该卡片无服务端数据（项目不存在），已回到对话制作；请从「新对话」重新开始'
            : '已重新打开「' + p.title + '」（本地恢复对话视图）');
          return;
        }
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(p.id) + '/reopen', { method: 'POST', credentials: 'same-origin' });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          onToast('已重新打开「' + p.title + '」，恢复为可编辑工作版本');
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          onToast('重新打开失败：' + (e && e.message ? e.message : e));
          if (onReloadProjects) onReloadProjects(); // 失败时同步列表，消除幽灵卡片
        }
      };

      /* 未完成审批（真实聚合：项目验收状态；模板/知识审批随 WF-10 接入） */
      const pendingApprovals = isReal
        ? projects.filter((p) => p.status !== 'archived' && p.checks && (p.checks.visual_review === 'pending' || p.checks.user_acceptance === 'pending'))
            .slice(0, 4)
            .map((p) => ({
              t: p.checks.visual_review === 'pending' ? '样张视觉确认' : '用户验收确认',
              d: p.title + ' · ' + p.version + ' 待确认',
              tone: 'pend', project: p,
            }))
        : null;

      const projCard = (p, isArchived) => h('div', { key: p.id, className: 'hp-card', style: { padding: '16px 18px', opacity: isArchived ? 0.86 : 1 } },
        h('div', { className: 'hp-row', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'hp-row', style: { gap: 8, marginBottom: 6 } },
              h('span', { className: 'hp-pjt', style: { fontSize: 15, fontWeight: 700 } }, p.title),
              isArchived
                ? h(Badge, { tone: 'ok' }, '📦 已归档 · 已导出')
                : h(Badge, { tone: p.status === 'rendered_pending_review' ? 'pend' : p.status === 'imported' ? 'lock' : 'pend' }, p.status_label),
              h('span', { className: 'hp-tid' }, p.version)),
            h('div', { className: 'hp-row', style: { gap: 14, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#94a3b8)', marginBottom: 10 } },
              h('span', { className: 'hp-mono' }, p.file),
              p.pages ? h('span', null, p.pages + ' 页') : null,
              h('span', { className: 'hp-mono' }, 'SHA256 ' + p.sha256),
              p.style ? h('span', null, '风格：' + styleName(p.style)) : null,
              h('span', null, '引擎：' + p.engine),
              h('span', null, p.updated)),
            h('div', { className: 'hp-row', style: { gap: 12 } },
              Object.keys(CHECK_LABELS).map((k) => h(CheckDot, { key: k, label: CHECK_LABELS[k], value: p.checks[k] })))),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' } },
            isArchived
              ? h(Btn, { kind: 'pri', sm: true, onClick: () => reopen(p) }, '↩ 重新打开')
              : h(Btn, { kind: 'pri', sm: true, onClick: () => onNav('studio') }, p.next_action || '继续对话'),
            h(Btn, { sm: true, onClick: () => openVersions(p) }, '版本列表'))));

      return h('div', { className: 'hp-scroll' },
        h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 18 } },
          h('div', null,
            h('h1', { className: 'hp-h1' }, '归档项目'),
            h('p', { className: 'hp-sub' }, '已完成的 PPT 项目归档于此：导出 PPTX 自动闭环归档，可随时重新打开继续修订')),
          h('div', { className: 'hp-row' },
            h(Btn, { kind: 'pri', onClick: () => (onNewConversation ? onNewConversation() : onNav('studio')) }, '✨ 新对话'),
            h(Btn, { disabled: importing, onClick: () => importRef.current && importRef.current.click() }, importing ? '正在导入…' : '📥 导入已有 PPTX'),
            h('input', { ref: importRef, type: 'file', accept: '.pptx', style: { display: 'none' }, onChange: (e) => {
              const f = e.target.files && e.target.files[0];
              e.target.value = '';
              doImport(f);
            }, 'aria-hidden': true, tabIndex: -1 }))),

        h(SectionHead, { title: '已完成 / 已归档', sub: '导出 PPTX 后自动归档 · ' + (archFilterOn ? archFiltered.length + ' / ' + archived.length + ' 个' : archived.length + ' 个') }),

        /* ════════ v0.3.2 筛选栏：关键词搜索 + 「从 … 到 …」时间段（日期级 + 快捷区间） ════════ */
        h('div', { className: 'hp-card hp-archfilter', style: { padding: '12px 14px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 } },
          h('span', { className: 'hp-archfilter-ic', 'aria-hidden': true }, '🔍'),
          h('input', {
            className: 'hp-input', type: 'search', value: archQ, 'aria-label': '搜索归档项目',
            placeholder: '搜索标题 / 文件名 / 版本 / 风格',
            style: { width: 220, flex: 'none' },
            onChange: (e) => setArchQ(e.target.value),
          }),
          h('label', { className: 'hp-archfilter-field' },
            h('span', { className: 'hp-archfilter-lbl' }, '时间段'),
            h('select', {
              className: 'hp-select', value: archRange, 'aria-label': '时间段筛选',
              style: { width: 132, flex: 'none' },
              onChange: (e) => {
                const key = e.target.value;
                setArchRange(key);
                const b = archPresetBounds(key);
                if (b) { setArchFrom(archYmd(b.from)); setArchTo(archYmd(b.to)); }
                else if (key === 'all') { setArchFrom(''); setArchTo(''); }
              },
            },
              [['all', '全部时间'], ['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['90d', '近 90 天'], ['custom', '自定义区间']]
                .map(([v, t]) => h('option', { key: v, value: v }, t)))),
          /* 「从 … 到 …」常显：快捷区间回填实际起止日期，任一端手改即转「自定义区间」 */
          h('label', { className: 'hp-archfilter-field' },
            h('span', { className: 'hp-archfilter-lbl' }, '从'),
            h('input', {
              className: 'hp-input', type: 'date', value: archFrom, 'aria-label': '起始日期',
              title: '起始日期（含当天）',
              style: { width: 148 },
              onChange: (e) => { setArchRange('custom'); setArchFrom(e.target.value); },
            })),
          h('label', { className: 'hp-archfilter-field' },
            h('span', { className: 'hp-archfilter-lbl' }, '到'),
            h('input', {
              className: 'hp-input', type: 'date', value: archTo, 'aria-label': '结束日期',
              title: '结束日期（含当天）',
              style: { width: 148 },
              onChange: (e) => { setArchRange('custom'); setArchTo(e.target.value); },
            })),
          archFilterOn ? h(Btn, { sm: true, onClick: resetArchFilter }, '重置') : null,
          h('span', { className: 'hp-archfilter-count', style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#94a3b8)', whiteSpace: 'nowrap' } },
            archFilterOn ? '匹配 ' + archFiltered.length + ' / ' + archived.length + ' 个' : '共 ' + archived.length + ' 个')),

        archFiltered.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 } }, archFiltered.map((p) => projCard(p, true)))
          : h('div', { className: 'hp-card', style: { marginBottom: 24 } },
              h(EmptyHint, {
                icon: archived.length ? '🔍' : '📦',
                text: archived.length
                  ? '没有符合筛选条件的归档项目：换个关键词，或调整「从 / 到」时间段，或点「重置」看全部'
                  : '还没有归档项目：对话制作并导出 PPTX 后，项目会自动归档到这里；未完成的对话请到「对话制作 → 历史对话」',
              })),

        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } },
          h('div', { className: 'hp-card', style: { padding: '16px 18px' } },
            h(SectionHead, { title: '最近批注', sub: '画布批注会携带版本与 SHA256，供对话侧生成修改计划' }),
              isReal
                ? h(EmptyHint, { icon: '🖊️', text: '生成并打开画布后，批注会出现在这里（WF-07 接入）' })
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                    [
                      { slide: 4, type: '框选', text: '第三步「交接」节点建议与右侧输出对齐', ver: 'v0003', sha: 'a3f8c2e1…9d04' },
                      { slide: 2, type: '文字', text: '现状描述里的客户名称需要脱敏', ver: 'v0003', sha: 'a3f8c2e1…9d04' },
                      { slide: 9, type: '箭头', text: '证据链箭头颜色建议与连接线统一', ver: 'v0002', sha: '77be01cd…41aa' },
                    ].map((a, i) => h('div', { key: i, className: 'hp-row', style: { alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f8fafc)' } },
                      h('span', { className: 'hp-chip' }, a.type),
                      h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: 13 } }, '第 ' + a.slide + ' 页 · ' + a.text),
                        h('div', { className: 'hp-tid', style: { marginTop: 2 } }, a.ver + ' · SHA256 ' + a.sha)))))),
          h('div', { className: 'hp-card', style: { padding: '16px 18px' } },
            h(SectionHead, { title: '未完成审批', sub: '视觉规则、业务知识、样张确认分别记录' }),
            pendingApprovals
              ? (pendingApprovals.length
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                      pendingApprovals.map((a, i) => h('div', { key: i, className: 'hp-row', style: { justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f8fafc)' } },
                        h('div', null,
                          h('div', { style: { fontSize: 13, fontWeight: 600 } }, a.t),
                          h('div', { className: 'hp-sub', style: { fontSize: 12 } }, a.d)),
                        h(Btn, { sm: true, onClick: () => onNav('studio') }, '去处理'))))
                  : h(EmptyHint, { icon: '✅', text: '当前没有待处理的审批事项' }))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  [
                    { t: '样张视觉确认', d: '企业服务平台建设方案汇报 · 封面/流程页/数据页样张待确认', tone: 'pend' },
                    { t: '模板视觉规则批准', d: '绿色简洁商务 · 8 页参考图构图包规则待复核', tone: 'pend' },
                    { t: '业务知识确认', d: '3 条候选事实（来源：reference.pdf 第 3/8/15 页）待确认后入库', tone: 'lock' },
                  ].map((a, i) => h('div', { key: i, className: 'hp-row', style: { justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f8fafc)' } },
                    h('div', null,
                      h('div', { style: { fontSize: 13, fontWeight: 600 } }, a.t),
                      h('div', { className: 'hp-sub', style: { fontSize: 12 } }, a.d)),
                    h(Btn, { sm: true, onClick: () => onToast('审批：' + a.t + '（在项目对话中处理）') }, '去处理')))))),

        verDrawer ? h(Drawer, {
          title: '版本列表', sub: verDrawer.project.title + ' · 当前 ' + verDrawer.project.version,
          onClose: () => setVerDrawer(null),
        },
          verDrawer.loading ? h(EmptyHint, { icon: '⏳', text: '正在读取版本…' })
            : verDrawer.error ? h(EmptyHint, { icon: '⚠️', text: '读取失败：' + verDrawer.error })
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('div', { className: 'hp-row', style: { gap: 8, fontSize: 12 } },
                  h(Chip, null, '当前：' + (verDrawer.data.current || '—')),
                  h('span', { className: 'hp-mono' }, 'SHA256 ' + (verDrawer.data.current_sha256 || '').slice(0, 16) + '…')),
                (verDrawer.data.versions || []).slice().reverse().map((v, i) => h('div', { key: v.file, className: 'hp-row', style: { justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: v.file === verDrawer.data.current ? 'var(--dsw-alias-bg-layer-2,#f8fafc)' : 'transparent', border: '1px solid var(--dsw-alias-border-l1,#e2e8f0)' } },
                  h('div', null,
                    h('div', { style: { fontSize: 13, fontWeight: v.file === verDrawer.data.current ? 700 : 500 } }, v.file + (v.file === verDrawer.data.current ? '（当前）' : '')),
                    h('div', { className: 'hp-tid' }, 'SHA256 ' + v.sha256.slice(0, 16) + '… · ' + v.mtime.slice(0, 16).replace('T', ' '))),
                  h(Btn, { sm: true, disabled: v.file === verDrawer.data.current, onClick: () => rollbackVersion(v) }, v.file === verDrawer.data.current ? '当前版本' : '回滚到此'))))) : null);
    }

    /* ════════ 视图二：模板库 ════════ */
    function TemplateLibrary({ data, onNav, onToast }) {
      const [kw, setKw] = useState('');
      const [family, setFamily] = useState('all');
      const [relation, setRelation] = useState('all');
      const [approval, setApproval] = useState('all');
      const [packFirst, setPackFirst] = useState(true);
      const [detail, setDetail] = useState(null);
      const [compare, setCompare] = useState([]);
      const [showCompare, setShowCompare] = useState(false);
      const [added, setAdded] = useState({});
      /* WF-10 模板包管理 */
      const [showFolders, setShowFolders] = useState(false);
      const [folders, setFolders] = useState([]);
      const [projects, setProjects] = useState([]);
      const [learnPid, setLearnPid] = useState('');
      const [folderBusy, setFolderBusy] = useState(false);
      const [candOpen, setCandOpen] = useState(null); // folderId -> candidates
      const loadFolders = async () => {
        try {
          const [rf, rp] = await Promise.all([
            fetch(API + '/api/template-folders', { credentials: 'same-origin' }).then((r) => r.json()),
            fetch(API + '/api/projects', { credentials: 'same-origin' }).then((r) => r.json()),
          ]);
          setFolders((rf.templates || []).slice().reverse());
          setProjects(rp.projects || []);
        } catch (e) { onToast('加载模板包失败：' + (e && e.message ? e.message : e)); }
      };
      const learnProject = async () => {
        if (!learnPid) { onToast('先选择要学习的项目'); return; }
        setFolderBusy(true);
        try {
          const r = await fetch(API + '/api/template-folders/learn', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: learnPid }), credentials: 'same-origin',
          }).then((x) => x.json());
          if (!r.ok) throw new Error(r.message || '学习失败');
          onToast('学习完成：「' + r.name + '」已入库（草稿），规则草稿已生成，待审批');
          await loadFolders();
        } catch (e) { onToast('学习失败：' + (e && e.message ? e.message : e)); }
        setFolderBusy(false);
      };
      const approveFolder = async (f) => {
        setFolderBusy(true);
        try {
          const r = await fetch(API + '/api/template-folders/' + encodeURIComponent(f.id) + '/approve', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed_by: '用户', note: '模板包规则复核通过' }), credentials: 'same-origin',
          }).then((x) => x.json());
          if (!r.ok) throw new Error(r.message || '审批失败');
          onToast('「' + f.name + '」已批准 ✅ 可在对话制作中选择');
          await loadFolders();
        } catch (e) { onToast('审批失败：' + (e && e.message ? e.message : e)); }
        setFolderBusy(false);
      };
      const openCandidates = async (f) => {
        if (candOpen === f.id) { setCandOpen(null); return; }
        setCandOpen(f.id);
        try {
          const r = await fetch(API + '/api/template-folders/' + encodeURIComponent(f.id) + '/knowledge-candidates', { credentials: 'same-origin' }).then((x) => x.json());
          setCandOpen({ id: f.id, list: r.candidates || [] });
        } catch (e) { onToast('候选加载失败'); setCandOpen(null); }
      };
      const confirmCand = async (folderId, c) => {
        try {
          const r = await fetch(API + '/api/template-folders/' + encodeURIComponent(folderId) + '/knowledge/confirm', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate_id: c.id, confirmed_by: '用户' }), credentials: 'same-origin',
          }).then((x) => x.json());
          if (!r.ok) throw new Error(r.message || '确认失败');
          onToast('知识已入库（第 ' + c.slide + ' 页）');
          setCandOpen((prev) => prev && prev.id === folderId
            ? { id: folderId, list: prev.list.map((x) => x.id === c.id ? { ...x, status: 'confirmed' } : x) } : prev);
          loadFolders();
        } catch (e) { onToast('确认失败：' + (e && e.message ? e.message : e)); }
      };

      const relations = useMemo(() => {
        const set = new Set(data.layouts.map((l) => l.relation));
        return ['all', ...Array.from(set)];
      }, [data]);

      const list = useMemo(() => {
        let arr = data.layouts.slice();
        if (family !== 'all') arr = arr.filter((l) => l.family === family);
        if (relation !== 'all') arr = arr.filter((l) => l.relation === relation || (l.tags || []).includes(relation));
        if (approval !== 'all') arr = arr.filter((l) => l.approval === approval);
        if (kw.trim()) {
          const q = kw.trim().toLowerCase();
          arr = arr.filter((l) => (l.id + ' ' + l.name + ' ' + (l.composition || '') + ' ' + (l.tags || []).join(' ')).toLowerCase().includes(q));
        }
        if (packFirst) arr.sort((a, b) => (b.pack === 'reference_pack') - (a.pack === 'reference_pack'));
        return arr;
      }, [data, kw, family, relation, approval, packFirst]);

      const addToProject = (lay) => {
        setAdded((prev) => {
          const n = (prev.count || 0) + 1;
          onToast('已选用「' + lay.name + '」版式偏好（第 ' + n + ' 次参考），逐页版式确认时按需应用');
          return { ...prev, count: n, [lay.id]: (prev[lay.id] || 0) + 1 };
        });
      };
      const toggleCompare = (lay) => {
        setCompare((prev) => {
          if (prev.find((x) => x.id === lay.id)) return prev.filter((x) => x.id !== lay.id);
          if (prev.length >= 2) { onToast('最多同时比较 2 个版式'); return prev; }
          return [...prev, lay];
        });
      };

      const card = (lay) => h('div', { key: lay.id, className: 'hp-tcard', onClick: () => setDetail(lay) },
        h('div', { className: 'hp-tprev' },
          lay.preview ? h('img', { src: img(lay.preview), alt: lay.name, loading: 'lazy' }) : null,
          h('span', { className: 'corner' }, lay.pack === 'reference_pack' ? h(Badge, { tone: 'ok' }, '参考图构图包') : null)),
        h('div', { className: 'hp-tbody' },
          h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
            h('span', { className: 'hp-tid' }, lay.id),
            h(ApprovalBadge, { value: lay.approval })),
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, lay.name),
          h('div', { className: 'hp-row', style: { gap: 6, marginBottom: 8 } },
            h(Chip, null, lay.relation),
            h(Chip, null, FAMILY_NAME[lay.family]),
            lay.required_fields.length ? h(Chip, null, '必填 ' + lay.required_fields.length + ' 项') : null),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#94a3b8)', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lay.composition),
          h('div', { className: 'hp-row', style: { gap: 6 } },
            h(Btn, { sm: true, onClick: (e) => { e.stopPropagation(); setDetail(lay); } }, '查看详情'),
            h(Btn, { kind: 'pri', sm: true, onClick: (e) => { e.stopPropagation(); addToProject(lay); } }, added[lay.id] ? '再加入 · 已加 ' + added[lay.id] + ' 次' : '加入项目'),
            h(Btn, { kind: 'ghost', sm: true, onClick: (e) => { e.stopPropagation(); toggleCompare(lay); } }, compare.find((x) => x.id === lay.id) ? '移出比较' : '比较'))));

      return h('div', { className: 'hp-scroll' },
        h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 14 } },
          h('div', null,
            h('h1', { className: 'hp-h1' }, '模板库'),
            h('p', { className: 'hp-sub' }, '模板库是生产入口：绿色简洁商务优先 8 页参考图构图包，14 页通用版式兜底')),
          h('div', { className: 'hp-row' },
            added.count ? h(Chip, null, '已加入项目 ' + added.count + ' 页') : null,
            h(Btn, { onClick: () => { setShowFolders(true); loadFolders(); } }, '🗂 模板包管理'),
            h(Btn, { kind: 'pri', onClick: () => onNav('studio') }, '✨ 新对话'))),

        h('div', { className: 'hp-card', style: { padding: '12px 14px', marginBottom: 16 } },
          h('div', { className: 'hp-row', style: { gap: 10 } },
            h('input', { className: 'hp-input', style: { width: 240 }, placeholder: '搜索版式 ID / 名称 / 标签…', value: kw, onChange: (e) => setKw(e.target.value) }),
            h('select', { className: 'hp-select', style: { width: 150 }, value: family, onChange: (e) => setFamily(e.target.value) },
              h('option', { value: 'all' }, '全部风格分支'),
              h('option', { value: 'green-clean-business' }, '绿色简洁商务'),
              h('option', { value: 'green-office-illustrated' }, '绿色办公插画')),
            h('select', { className: 'hp-select', style: { width: 130 }, value: relation, onChange: (e) => setRelation(e.target.value) },
              relations.map((r) => h('option', { key: r, value: r }, r === 'all' ? '全部版式关系' : r))),
            h('select', { className: 'hp-select', style: { width: 120 }, value: approval, onChange: (e) => setApproval(e.target.value) },
              h('option', { value: 'all' }, '全部状态'),
              h('option', { value: 'approved' }, '已批准'),
              h('option', { value: 'pending' }, '待确认')),
            h('label', { className: 'hp-row', style: { gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#475569)', cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: packFirst, onChange: (e) => setPackFirst(e.target.checked) }),
              '参考图构图包优先'),
            h('span', { className: 'hp-tid' }, list.length + ' 个版式'))),

        list.length ? h('div', { className: 'hp-tgrid' }, list.map(card)) : h(EmptyHint, { icon: '🔍', text: '没有匹配的版式，请调整筛选条件' }),

        detail ? h(Drawer, {
          title: detail.name, sub: detail.id + ' · ' + FAMILY_NAME[detail.family],
          onClose: () => setDetail(null),
          footer: [
            h(Btn, { key: 'cmp', onClick: () => toggleCompare(detail) }, compare.find((x) => x.id === detail.id) ? '移出比较' : '加入比较'),
            h(Btn, { key: 'add', kind: 'pri', onClick: () => addToProject(detail) }, '加入项目'),
          ],
        },
          detail.preview ? h('div', { style: { borderRadius: 12, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1,#e2e8f0)', marginBottom: 16 } },
            h('img', { src: img(detail.preview), alt: detail.name, style: { width: '100%', display: 'block' } })) : null,
          h('dl', { className: 'hp-kv', style: { marginBottom: 16 } },
            h('dt', null, '版式关系'), h('dd', null, detail.composition),
            h('dt', null, '来源'), h('dd', null, detail.origin === 'reference_fidelity_reconstruction' ? '参考图高保真构图' : '通用参考版式', ' · 源页 ', detail.source_pages.join('、') || '—'),
            h('dt', null, '批准状态'), h('dd', null, h(ApprovalBadge, { value: detail.approval })),
            h('dt', null, '可编辑对象'), h('dd', null, (detail.editability || []).join(' / ')),
            h('dt', null, '模板页'), h('dd', null, detail.template_slide ? '第 ' + detail.template_slide + ' 页' : '—')),
          h('div', { style: { marginBottom: 16 } },
            h('div', { className: 'hp-label' }, '必填字段（' + detail.required_fields.length + '）'),
            h('div', { className: 'hp-row', style: { gap: 6 } }, detail.required_fields.map((f) => h(Chip, { key: f }, f)))),
          detail.asset_ids.length ? h('div', { style: { marginBottom: 16 } },
            h('div', { className: 'hp-label' }, '配套素材'),
            h('div', { className: 'hp-row', style: { gap: 6 } }, detail.asset_ids.map((a) => h(Chip, { key: a }, a)))) : null,
          h('div', { className: 'hp-note' },
            h('span', null, 'ⓘ'),
            h('span', null, '同一模板页可多次加入项目，每次加入生成独立页面配置；视觉规则与业务知识分别批准，未经确认的抽取内容仅为候选事实。'))) : null,

        compare.length ? h('div', { style: { position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 55 } },
          h('div', { className: 'hp-card', style: { padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 10px 30px rgba(15,23,42,.18)' } },
            h('span', { style: { fontSize: 13 } }, '比较：' + compare.map((c) => c.name).join(' vs ')),
            h(Btn, { sm: true, kind: 'pri', disabled: compare.length < 2, onClick: () => setShowCompare(true) }, compare.length < 2 ? '再选 1 个' : '查看对比'),
            h(Btn, { sm: true, kind: 'ghost', onClick: () => setCompare([]) }, '清空'))) : null,

        showCompare && compare.length === 2 ? h(CompareModal, { items: compare, onClose: () => setShowCompare(false) }) : null,

        /* WF-10 模板包管理抽屉：学习 → 审批 → 知识确认 */
        showFolders ? h(Drawer, {
          title: '模板包管理', sub: '学习上传的模板 → 规则草稿 → 审批入正式库 → 知识确认',
          onClose: () => setShowFolders(false),
        },
          h('div', { className: 'hp-card', style: { padding: '12px 14px', marginBottom: 14 } },
            h('div', { className: 'hp-label' }, '从项目学习（项目须已上传自定义模板）'),
            h('div', { className: 'hp-row', style: { gap: 8 } },
              h('select', { className: 'hp-select', style: { flex: 1 }, value: learnPid, onChange: (e) => setLearnPid(e.target.value) },
                h('option', { value: '' }, '选择项目…'),
                projects.map((p) => h('option', { key: p.id, value: p.id }, p.title + '（' + (p.version || '未生成') + '）'))),
              h(Btn, { kind: 'pri', disabled: folderBusy || !learnPid, onClick: learnProject }, '学习入库')),
            h('div', { className: 'hp-note', style: { marginTop: 8 } },
              h('span', null, 'ⓘ'),
              h('span', null, '学习会解析模板结构、生成视觉/表达规则草稿与逐页知识候选；未审批前仅在对话制作的「自定义模板」分支可用。'))),
          !folders.length ? h(EmptyHint, { icon: '🗂', text: '还没有学习过的模板包' }) :
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              folders.map((f) => h('div', { key: f.id, className: 'hp-card', style: { padding: '12px 14px' } },
                h('div', { className: 'hp-row', style: { justifyContent: 'space-between' } },
                  h('div', null,
                    h('div', { style: { fontWeight: 700, fontSize: 13 } }, f.name),
                    h('div', { className: 'hp-tid', style: { marginTop: 2 } }, f.id + ' · ' + f.slide_count + ' 页 · 规则草稿' + (f.rules_ready ? '已生成' : '缺失'))),
                  h(ApprovalBadge, { value: f.status === 'approved' ? 'approved' : 'pending' })),
                h('div', { className: 'hp-row', style: { gap: 6, marginTop: 8 } },
                  f.status !== 'approved' ? h(Btn, { kind: 'pri', sm: true, disabled: folderBusy || !f.rules_ready, onClick: () => approveFolder(f) }, '批准模板') : h(Chip, null, '已批准 · 可用于对话制作'),
                  h(Btn, { sm: true, onClick: () => openCandidates(f) }, '知识候选 ' + f.confirmed + '/' + f.candidates)),
                candOpen && candOpen.id === f.id ? h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1,#e2e8f0)' } },
                  !candOpen.list.length ? h('div', { className: 'hp-sub', style: { fontSize: 12 } }, '无候选') :
                    candOpen.list.filter((c) => c.text && c.text.trim()).map((c) => h('div', { key: c.id, style: { marginBottom: 8 } },
                      h('div', { className: 'hp-row', style: { justifyContent: 'space-between' } },
                        h('span', { className: 'hp-tid' }, '第 ' + c.slide + ' 页'),
                        c.status === 'confirmed' ? h(Chip, null, '已入库') : h(Btn, { sm: true, onClick: () => confirmCand(f.id, c) }, '确认入库')),
                      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#475569)', marginTop: 2, maxHeight: 64, overflow: 'hidden' } }, c.text.slice(0, 120) + (c.text.length > 120 ? '…' : ''))))) : null)))) : null);
    }

    function CompareModal({ items, onClose }) {
      return h(Modal, { title: '版式对比', sub: items[0].id + ' vs ' + items[1].id, onClose, width: 960 },
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } },
          items.map((lay) => h('div', { key: lay.id },
            h('div', { style: { borderRadius: 10, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1,#e2e8f0)', marginBottom: 10 } },
              lay.preview ? h('img', { src: img(lay.preview), alt: lay.name, style: { width: '100%', display: 'block' } }) : null),
            h('div', { style: { fontWeight: 700, marginBottom: 4 } }, lay.name),
            h('div', { className: 'hp-tid', style: { marginBottom: 8 } }, lay.id),
            h('dl', { className: 'hp-kv', style: { gridTemplateColumns: '76px 1fr', fontSize: 12 } },
              h('dt', null, '关系'), h('dd', null, lay.composition),
              h('dt', null, '必填'), h('dd', null, lay.required_fields.join('、')),
              h('dt', null, '状态'), h('dd', null, h(ApprovalBadge, { value: lay.approval })))))));
    }

    /* ════════ 视图二：对话制作页（左对话 + 右演化工作区；合并原向导与画布） ════════ */

    /* ── mock 剧本常量（演示场景：项目汇报；预留真模型接口位置） ── */
    const STUDIO_STEPS = ['需求', '材料', '大纲', '风格', '版式', '生成', '导出'];
    const STAGE_IDX = { idle: 0, material: 1, outline: 2, style: 3, pages: 4, generating: 5, done: 6, archived: 6 };
    const GEN_STEPS = ['解析材料与大纲', '匹配版式并填充内容', '结构检查与渲染', '视觉检查与编辑抽查'];
    const FAMILY_PREVIEW = { 'green-clean-business': 'clean-slide-03.png', 'green-office-illustrated': 'illu-slide-01.png' };

    /* 场景大纲库：按关键词命中，未命中走通用 */
    const SCENARIOS = [
      {
        key: 'report', match: /汇报|进度|项目/, topic: '智慧园区管理平台项目进度汇报',
        outline: [
          { title: '封面：项目名与汇报人', rel: '封面' },
          { title: '项目背景与目标', rel: '需求' },
          { title: '整体进度总览', rel: '总览' },
          { title: '里程碑与关键交付', rel: '流程' },
          { title: '数据看板：进度与质量', rel: '数据' },
          { title: '风险与问题', rel: '对比' },
          { title: '下一阶段计划', rel: '计划' },
          { title: '致谢与 Q&A', rel: '收尾' },
        ],
      },
      {
        key: 'summary', match: /总结|年度|年终/, topic: '年度工作总结',
        outline: [
          { title: '封面：年度主题', rel: '封面' },
          { title: '年度目标回顾', rel: '需求' },
          { title: '关键成果总览', rel: '总览' },
          { title: '重点工作推进过程', rel: '流程' },
          { title: '数据亮点', rel: '数据' },
          { title: '问题与不足', rel: '对比' },
          { title: '明年规划', rel: '计划' },
          { title: '结尾', rel: '收尾' },
        ],
      },
      {
        key: 'product', match: /产品|发布|介绍/, topic: '新产品介绍',
        outline: [
          { title: '封面：产品名与定位语', rel: '封面' },
          { title: '痛点与机会', rel: '需求' },
          { title: '产品定位与全貌', rel: '总览' },
          { title: '核心功能流程', rel: '流程' },
          { title: '关键指标与效果', rel: '数据' },
          { title: '竞品对比', rel: '对比' },
          { title: '发布路线图', rel: '计划' },
          { title: '结尾', rel: '收尾' },
        ],
      },
    ];
    const GENERIC_OUTLINE = [
      { title: '封面：主题与汇报人', rel: '封面' },
      { title: '背景与目标', rel: '需求' },
      { title: '整体概览', rel: '总览' },
      { title: '核心内容展开', rel: '流程' },
      { title: '数据与成效', rel: '数据' },
      { title: '对比与分析', rel: '对比' },
      { title: '后续计划', rel: '计划' },
      { title: '结尾', rel: '收尾' },
    ];
    /* 页数扩充池（8 → 12/16 页时按顺序补页） */
    const EXTRA_PAGES = [
      { title: '整体架构', rel: '架构' }, { title: '典型案例', rel: '案例' },
      { title: '明细表格', rel: '表格' }, { title: '治理与保障', rel: '治理' },
      { title: '协作生态', rel: '生态' }, { title: '素材页', rel: '素材' },
      { title: '数据对比', rel: '指标' }, { title: '方案比选', rel: '方案' },
    ];
    const MAT_ICONS = { docx: '📝', doc: '📝', pdf: '📕', pptx: '📊', ppt: '📊', xlsx: '📈', xls: '📈', txt: '📄', md: '📄' };

    function ConversationStudio({ data, onNav, onToast, onProjectArchived, onReloadProjects, historyMode, activeConv, activeConvId, onConvSync, onRequestNewConversation, backend }) {
      /* 真实后端连通即真实模式：对话/材料/大纲/生成/导出/修订全走服务端；后端不可达降级演示剧本兜底。
         historyMode=true 表示「历史对话」列表来自真实后端项目（与 isReal 同源，保留兼容）。 */
      const isReal = !!(backend && backend.mode === 'real');
      const L = (id) => data.layouts.find((x) => x.id === id) || null;
      const poolOf = (rel, family) => {
        const pool = data.layouts.filter((x) => x.relation === rel);
        if (!pool.length) return data.layouts.slice(0, 1);
        return pool.slice().sort((a, b) => ((b.family === family) - (a.family === family)));
      };
      /* 风格显示名：内置分支查表，自定义导入风格用模板名 */
      const famDisplay = (c, famId) => {
        const f = famId || c.family;
        return c.customStyle && c.customStyle.id === f ? c.customStyle.name : (FAMILY_NAME[f] || f);
      };

      const [msgs, setMsgs] = useState(() => [
        { id: 'm0', role: 'ai', kind: 'text', text: '你好，我是汇文 PPT 助手 🎬。正式生成前我会一次只问一个问题，直到有 95% 把握真正理解你的需求；顺序完全由你定：随时传材料（📎）、出大纲、换风格页数、直接生成，做到一半想推翻重来也随时可以 🔄。' },
      ]);
      const [stage, setStage] = useState('idle');
      const [typing, setTyping] = useState(false);
      const [input, setInput] = useState('');
      const [ctx, setCtx] = useState({ topic: '', scenario: null, materials: [], outline: [], family: 'green-clean-business', count: 8, pageLayouts: [], version: 'v0001', sha: '9f2c7ad4…b810' });
      const [genStep, setGenStep] = useState(-1);
      const [sel, setSel] = useState({ family: 'green-clean-business', count: 8 });
      /* null = 默认与右侧工作台 1:1（CSS width:50%）；拖拽后为固定 px */
      const [chatW, setChatW] = useState(null);
      const [dragging, setDragging] = useState(false);
      const dragWRef = useRef(null);
      const chatRef = useRef(null);
      const taRef = useRef(null);
      const atRef = useRef(null);
      const [atOpen, setAtOpen] = useState(false);
      const [dropHover, setDropHover] = useState(false); /* hpDrop-20261012：附件拖拽落点态 */
      const dropDepth = useRef(0);
      const tplRef = useRef(null);
      const pendingRef = useRef([]);
      const idSeq = useRef(1);
      const endRef = useRef(null);
      const fileRef = useRef(null);
      const canvasApiRef = useRef(null);

      const nid = () => 'm' + (idSeq.current++);
      useEffect(() => { if (endRef.current) endRef.current.scrollIntoView({ block: 'end' }); }, [msgs, typing]);

      /* ── 真实模式：后端项目与模型选择（WF-02；模型选择框数据源 /api/models） ── */
      const [projectId, setProjectId] = useState(null);
      const [models, setModels] = useState([]);
      const [modelId, setModelId] = useState('');
      const [busy, setBusy] = useState(false); // 等待后端回合（typing 气泡保持）
      useEffect(() => {
        let alive = true;
        fetch(API + '/api/models', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((j) => {
            if (!alive || !j.ok) return;
            setModels(j.models || []);
            setModelId((cur) => cur || j.default || ((j.models || [])[0] || {}).id || '');
          })
          .catch(() => {});
        return () => { alive = false; };
      }, []);
      const DEFAULT_CTX = { topic: '', scenario: null, materials: [], outline: [], family: 'green-clean-business', count: 8, pageLayouts: [], version: 'v0001', sha: '9f2c7ad4…b810' };
      const WELCOME_TEXT = '你好，我是汇文 PPT 助手 🎬。正式生成前我会一次只问一个问题，直到有 95% 把握真正理解你的需求；顺序完全由你定：随时传材料（📎）、出大纲、换风格页数、直接生成，做到一半想推翻重来也随时可以 🔄。';
      const welcomeMsg = () => ({ id: 'm0', role: 'ai', kind: 'text', text: WELCOME_TEXT });
      const resetLocal = () => {
        setMsgs([welcomeMsg()]);
        setStage('idle'); setCtx(DEFAULT_CTX); setGenStep(-1); setSel({ family: 'green-clean-business', count: 8 });
      };
      /* 新对话：真实模式先建后端项目壳（方案 WF-02），失败保持本地 */
      const startNewConversation = async () => {
        if (!isReal) { resetLocal(); return; }
        try {
          const res = await fetch(API + '/api/projects/new', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setProjectId(j.project.id);
          resetLocal();
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          onToast('新建项目失败：' + (e && e.message ? e.message : e));
        }
      };

      /* ── 历史对话：侧栏二级目录打开（fresh=新建；real=真实后端项目；否则本地会话快照） ── */
      const stageFromBackend = (s) => {
        if (s === 'archived') return 'archived';
        if (s === 'imported' || s === 'done' || s === 'pending_review' || s === 'render_failed') return 'done';
        if (s === 'generating') return 'pages';
        return STAGE_IDX[s] != null ? s : 'idle';
      };
      /* 本地会话快照还原（会话内新建的对话，状态整段保留） */
      const restoreSnapshot = (rec) => {
        let snap = null;
        try { snap = JSON.parse(JSON.stringify({ msgs: (rec && rec.msgs) || [], ctx: (rec && rec.ctx) || null, stage: (rec && rec.stage) || 'idle' })); } catch (e) { snap = null; }
        if (!snap) return;
        const list = (snap.msgs || []).filter((m) => m && m.id && m.role);
        setMsgs(list.length ? list : [welcomeMsg()]);
        idSeq.current = list.length + 1;
        const nextCtx = { ...DEFAULT_CTX, ...(snap.ctx || {}) };
        setCtx(nextCtx);
        setSel({ family: nextCtx.family || 'green-clean-business', count: nextCtx.count || 8 });
        setStage(STAGE_IDX[snap.stage] != null ? snap.stage : 'idle');
        setGenStep(-1); setInput(''); setTyping(false); setBusy(false); setAtOpen(false); pendingRef.current = [];
      };
      /* 真实后端项目：读取 conversation.jsonl 还原对话内容 */
      const loadRealConversation = async (id, title) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(id) + '/conversation', { credentials: 'same-origin' });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          const list = (j.messages || [])
            .map((m, i) => {
              const kind = m.kind || 'text';
              const payload = m.payload || {};
              /* conversation.jsonl 未持久化 outline 卡片载荷：缺载荷的卡片降级为文本气泡，避免渲染崩溃 */
              const safeKind = kind === 'outline' && !Array.isArray(payload.outline) ? 'text' : kind;
              return { id: m.id || ('c' + i), role: m.role === 'user' ? 'user' : 'ai', kind: safeKind, text: m.text || '', payload };
            })
            .filter((m) => (m.kind === 'text' ? !!m.text.trim() : true));
          setMsgs(list.length ? list : [welcomeMsg()]);
          idSeq.current = list.length + 2;
          setCtx({ ...DEFAULT_CTX, topic: j.title || title || '' });
          setSel({ family: 'green-clean-business', count: 8 });
          setStage(stageFromBackend(j.stage));
          setProjectId(id);
          setGenStep(-1); setInput(''); setTyping(false); setAtOpen(false); pendingRef.current = [];
          onToast('已打开历史对话「' + (j.title || title || id) + '」· ' + list.length + ' 条消息');
        } catch (e) {
          onToast('打开历史对话失败：' + (e && e.message ? e.message : e));
        } finally { setBusy(false); }
      };
      /* 打开动作只在 nonce 变化时触发（同一对话重复点击不重载） */
      const lastConvNonce = useRef(null);
      useEffect(() => {
        if (!activeConv || activeConv.nonce === lastConvNonce.current) return;
        lastConvNonce.current = activeConv.nonce;
        if (activeConv.fresh) { resetLocal(); setProjectId(activeConv.real && activeConv.id ? activeConv.id : null); return; }
        if (activeConv.real) { loadRealConversation(activeConv.id, activeConv.title); return; }
        if (activeConv.record) restoreSnapshot(activeConv.record);
      }, [activeConv]);
      /* 本地会话：把当前对话状态回写给侧栏历史列表（真实项目不登记） */
      useEffect(() => {
        if (!onConvSync || !activeConvId) return;
        onConvSync(activeConvId, { msgs, stage, ctx, title: ctx.topic || '' });
      }, [activeConvId, msgs.length, stage, ctx.topic]);

      /* ── 消息机制（无定时器：typing 动画结束即投递 AI 消息） ── */
      const pushAi = (items) => { pendingRef.current = items; setTyping(true); };
      const flushAi = () => {
        const items = pendingRef.current || [];
        pendingRef.current = [];
        setTyping(false);
        if (items.length) setMsgs((prev) => [...prev, ...items]);
      };
      const say = (text, extra) => ({ id: nid(), role: 'ai', kind: 'text', text, ...(extra || {}) });

      /* ── 剧本推进 ── */
      const detectScenario = (text) => SCENARIOS.find((s) => s.match.test(text)) || null;
      const outlineFor = (sc) => (sc ? sc.outline : GENERIC_OUTLINE).map((o, i) => ({ n: i + 1, title: o.title, rel: o.rel }));

      const startOutline = (ctxNow, ackText) => {
        const outline = outlineFor(ctxNow.scenario);
        const ctxNext = { ...ctxNow, outline };
        setCtx(ctxNext); setStage('outline');
        const items = [];
        if (ackText) items.push(say(ackText));
        items.push(say('基于你的需求，我拟了一份 ' + outline.length + ' 页的大纲，右侧可以预览整体结构。确认或告诉我怎么调整：'));
        items.push({ id: nid(), role: 'ai', kind: 'outline', payload: { outline } });
        pushAi(items);
      };

      const buildPages = (ctxNow, family, count) => {
        let pages = ctxNow.outline.map((o) => ({ n: o.n, title: o.title, rel: o.rel, alt: 0 }));
        const extra = EXTRA_PAGES.slice();
        while (pages.length < count) {
          const e = extra.shift();
          if (!e) break;
          pages.splice(pages.length - 1, 0, { n: 0, title: e.title, rel: e.rel, alt: 0 });
        }
        pages = pages.slice(0, count).map((p, i) => ({ ...p, n: i + 1 }));
        return pages.map((p) => ({ ...p, layoutId: poolOf(p.rel, family)[0].id }));
      };

      const proceedStyle = () => {
        setStage('style');
        pushAi([
          say('大纲确认 ✅。接下来选风格与页数：项目汇报类场合我推荐「绿色简洁商务」（更正式），也为你备了「绿色办公插画」作对比。'),
          { id: nid(), role: 'ai', kind: 'style', payload: {} },
        ]);
      };
      const proceedPages = (family, count) => {
        if (isReal && projectId) { confirmStyleReal(family, count); return; }
        const pageLayouts = buildPages(ctx, family, count);
        setCtx((c) => ({ ...c, family, count, pageLayouts }));
        setStage('pages');
        pushAi([
          say('已按「' + famDisplay(ctx, family) + ' · ' + count + ' 页」为每一页匹配了版式（模板库真实版式，参考图构图包优先）。逐页看看，不满意的可以「换一换」：'),
          { id: nid(), role: 'ai', kind: 'pages', payload: { pageLayouts } },
        ]);
      };
      const startGenerate = () => {
        if (isReal && projectId) { startGenerateReal(); return; }
        setStage('generating'); setGenStep(0);
        pushAi([say('收到，开始生成 🚀 共 4 个阶段，右侧有实时进度。')]);
      };
      /* ── WF-07 对话通道：真实修订（解析指令 → studio patch → 新版本渲染） ── */
      const reviseReal = async (text) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/revise', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instruction: text, model_id: modelId || null }), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setBusy(false);
          if (!j.applied) { pushAi([say(j.reply || '没对应到具体对象，试试「把第 2 页标题改成 XXX」，或在右侧形状列表直接编辑。')]); return; }
          setCtx((c) => ({
            ...c,
            version: j.version,
            sha: (j.sha256 || '').slice(0, 8) + '…' + (j.sha256 || '').slice(-4),
            shaFull: j.sha256 || '',
            realEngine: true,
            renders: (j.report && j.report.render_pngs) || [],
            pending: [],
          }));
          pushAi([
            say('已按你的指令修订 ✍️（' + (j.via === 'llm' ? '真模型解析' : '本地规则解析') + '）并生成新版本 ' + j.version + '，右侧样张已刷新。'),
            { id: nid(), role: 'ai', kind: 'result', payload: { real: true, version: j.version, pages: j.slide_count } },
          ]);
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          setBusy(false);
          pushAi([say('修订失败：' + (e && e.message ? e.message : e) + (String(e && e.message).indexOf('乐观锁') >= 0 ? '（画布数据已过期，请刷新页面后重试）' : ''))]);
        }
      };

      /* ── WF-07 画布通道：形状编辑队列 + 应用（SHA256 乐观锁） ── */
      const [canvasPage, setCanvasPage] = useState(1);
      const [canvasShapes, setCanvasShapes] = useState(null); // {version, page, slide_count, shapes}
      const [pending, setPending] = useState([]); // {slide, shape_id, name, text}
      const loadShapes = async (page) => {
        setCanvasPage(page);
        setCanvasShapes(null);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/shapes?page=' + page, { credentials: 'same-origin' });
          const j = await res.json();
          if (res.ok && j.ok) setCanvasShapes(j);
          else setCanvasShapes({ error: j.message || ('HTTP ' + res.status) });
        } catch (e) { setCanvasShapes({ error: String(e && e.message ? e.message : e) }); }
      };
      const queueEdit = (shape, text) => {
        setPending((q) => [...q.filter((x) => !(x.slide === canvasPage && x.shape_id === shape.shape_id)), { slide: canvasPage, shape_id: shape.shape_id, name: shape.name, text }]);
        onToast('已加入修订队列（' + canvasPage + ' 页 · ' + shape.name + '）');
      };
      const applyPending = async () => {
        if (!pending.length) { onToast('修订队列为空'); return; }
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/patch', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operations: pending.map((p) => ({ slide: p.slide, shape_id: p.shape_id, op: 'set-text', text: p.text })), source: 'canvas', note: '画布队列应用 ' + pending.length + ' 项' }),
            credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setBusy(false);
          setPending([]);
          setCtx((c) => ({
            ...c,
            version: j.version,
            sha: (j.sha256 || '').slice(0, 8) + '…' + (j.sha256 || '').slice(-4),
            shaFull: j.sha256 || '',
            renders: (j.report && j.report.render_pngs) || [],
          }));
          onToast('已应用修订，新版本 ' + j.version);
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          setBusy(false);
          onToast('应用失败：' + (e && e.message ? e.message : e));
        }
      };

      /* ── WF-06：真实生成（构建/渲染/巡检任务链 + 进度轮询） ── */
      const jobTimerRef = useRef(null);
      useEffect(() => () => { if (jobTimerRef.current) clearTimeout(jobTimerRef.current); }, []);
      const finishGenerateReal = (res) => {
        setBusy(false);
        setStage('done'); setGenStep(GEN_STEPS.length);
        setCtx((c) => ({
          ...c,
          version: res.version,
          sha: (res.sha256 || '').slice(0, 8) + '…' + (res.sha256 || '').slice(-4),
          realEngine: true,
          renders: (res.report && res.report.render_pngs) || [],
          editablePages: res.editable_pages,
        }));
        pushAi([
          say('生成完成 ✅ 真实版本 ' + res.version + '（' + res.slide_count + ' 页，SHA256 ' + (res.sha256 || '').slice(0, 12) + '…）。结构检查与 LibreOffice 渲染全部通过；服务器预览以 Noto Sans CJK 替代微软雅黑渲染，最终视觉验收以 WPS 打开导出文件为准。右侧是渲染样张。'),
          { id: nid(), role: 'ai', kind: 'result', payload: { real: true, version: res.version, pages: res.slide_count } },
          { id: nid(), role: 'ai', kind: 'export', payload: {} },
        ]);
        if (onReloadProjects) onReloadProjects();
      };
      const startGenerateReal = async () => {
        setBusy(true);
        try {
          const r0 = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/generate', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}), credentials: 'same-origin',
          });
          const j0 = await r0.json();
          if (!r0.ok || !j0.ok) throw new Error((j0 && j0.message) || ('HTTP ' + r0.status));
          setStage('generating'); setGenStep(0);
          pushAi([say('收到，开始生成 🚀 真实构建已启动（studio 引擎 + LibreOffice 渲染），右侧有实时进度。')]);
          let ticks = 0;
          const tick = async () => {
            try {
              const r = await fetch(API + '/api/jobs/' + encodeURIComponent(j0.job_id), { credentials: 'same-origin' });
              const j = await r.json();
              if (!r.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + r.status));
              const job = j.job;
              if (typeof job.step === 'number') setGenStep(Math.min(GEN_STEPS.length, job.step + 1));
              if (job.status === 'done') { finishGenerateReal(job.result); return; }
              if (job.status === 'failed' || job.status === 'cancelled') {
                setBusy(false);
                setStage('pages'); setGenStep(-1);
                pushAi([say('生成未完成：' + ((job.error && job.error.message) || job.status) + '。可调整版式计划后重试「✨ 确认生成」。')]);
                return;
              }
              if (++ticks > 150) { setBusy(false); pushAi([say('生成超时，请稍后在项目首页查看状态。')]); return; }
              jobTimerRef.current = setTimeout(tick, 2500);
            } catch (e) {
              setBusy(false);
              pushAi([say('进度查询失败：' + (e && e.message ? e.message : e))]);
            }
          };
          jobTimerRef.current = setTimeout(tick, 2000);
        } catch (e) {
          setBusy(false);
          pushAi([say('生成任务启动失败：' + (e && e.message ? e.message : e))]);
        }
      };
      const finishGenerate = () => {
        setStage('done'); setGenStep(GEN_STEPS.length);
        pushAi([
          say('生成完成 ✅ 画布已在右侧就绪：可以点击对象拖拽/改文字，也可以直接在这里对我说修改指令（比如「把第 2 页标题改成 XXX」）。'),
          { id: nid(), role: 'ai', kind: 'result', payload: {} },
          { id: nid(), role: 'ai', kind: 'export', payload: {} },
        ]);
      };
      /* WF-08 真实导出：复制当前版本到工作区 exports/ 并闭环归档 */
      const exportReal = async () => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/export', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '对话页导出' }), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setBusy(false);
          setStage('archived');
          setCtx((c) => ({ ...c, downloadUrl: API + '/api/projects/' + encodeURIComponent(projectId) + '/download', exportName: j.download_name, exportSha: j.sha256 }));
          onToast('已导出 ' + j.download_name + '，项目已归档');
          pushAi([
            say('✅ 已导出「' + j.download_name + '」（SHA256 ' + (j.sha256 || '').slice(0, 12) + '…），项目已闭环归档 📦。用 WPS 打开做最终视觉验收；去项目首页「已归档」区可随时重新打开。'),
            { id: nid(), role: 'ai', kind: 'archived', payload: { real: true } },
          ]);
          if (onReloadProjects) onReloadProjects();
        } catch (e) {
          setBusy(false);
          pushAi([say('导出失败：' + (e && e.message ? e.message : e))]);
        }
      };
      const archiveProject = () => {
        if (isReal && projectId) { exportReal(); return; }
        if (isReal) archiveReal();
        /* 0.3.4.3：正式业务系统——后端未连接不伪造导出闭环 */
        onToast('后端未连接：导出与归档需要真实后端执行，请通过 DSH 正常打开本应用');
        pushAi([say('⚠️ 后端服务未连接，无法执行导出归档。请通过 DSH 正常打开本应用后重试。')]);
      };

      /* ── 用户输入分发 ── */
      const sendUser = (raw) => {
        const text = String(raw || '').trim();
        if (!text) return;
        setMsgs((prev) => [...prev, { id: nid(), role: 'user', kind: 'text', text }]);
        setInput('');
        respond(text);
      };

      /* ═══ 意图优先分发（自由流程核心）：阶段只是进度提示，不再做闸门 ═══ */

      /* 意图识别（纯函数）：任意阶段可触发任意动作；返回 {kind, ...} */
      const detectIntent = (text, env) => {
        const t = String(text || '').trim();
        const st = env.stage;
        const hasOutline = (env.ctx.outline || []).length > 0;
        /* 0.3.4：推翻重来——优先级最高，任何阶段触发（与后端 RESET_RE 同源） */
        if (/推翻|推倒重来|换个?主题|重新开始|从零开始|全部重来|重来一[次遍]|重来吧|重新做一[份个张]|不做这个了|全部清空/.test(t)) {
          return { kind: 'reset', raw: t };
        }
        const mPage = t.match(/第\s*(\d+)\s*页/);
        const mText = t.match(/(?:改成|改为|换成|调整为)\s*[「"'“]?(.+?)[」"'”]?\s*$/);
        if (mPage && mText) return { kind: 'revise', page: parseInt(mPage[1], 10), text: mText[1], raw: t };
        /* 确认：仅当存在待确认大纲（outline 阶段）时才吃掉，否则落入后续意图 */
        if (st === 'outline' && hasOutline && (
          /^(确认|可以|没问题|好的|行|OK|ok|就这样)[了的。！!?]?$/.test(t)
          || /(确认|敲定|定了).{0,3}大纲|大纲.{0,4}(确认|可以|没问题|敲定|定了)/.test(t)
        )) return { kind: 'confirm' };
        if (/导出|下载|归档/.test(t)) return { kind: 'export' };
        /* 直接生成：需明确生成意愿（直接生成/生成PPT/立刻做PPT…）；单纯「帮我做XX PPT」仍按需求登记走对话 */
        if (/直接生成|开始生成|正式生成|完整生成|就这么做|做出来/.test(t)
          || (/P\s*P\s*T/i.test(t) && /(直接|现在|立刻|马上|一键|生成)/.test(t))) return { kind: 'generate' };
        if (/大纲/.test(t) && /(出|拟|重新|列|看|生成|调整|改|换)/.test(t)) return { kind: 'outline' };
        const mCount = t.match(/(\d{1,2})\s*页/);
        /* 0.3.4.1：页数/风格词仅在大纲已确认后的阶段（style/pages/done）才构成风格确认意图；
           更早阶段说的「大概14页」是需求信息 → 走对话，服务端记入 brief 并继续一次一问（不再误触 WF-03） */
        if (['style', 'pages', 'done'].includes(st) && (mCount || (/(风格|模板|配色)/.test(t) && /(换|改|用|选|来)/.test(t)))) {
          return { kind: 'style', count: mCount ? parseInt(mCount[1], 10) : null, text: t };
        }
        return { kind: 'chat' };
      };

      /* 真实接口小工具：POST JSON（不带本地状态副作用） */
      const postJson = (p, body) => fetch(API + p, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}), credentials: 'same-origin',
      }).then((r) => r.json()).catch(() => ({}));

      /* 吸收一回合服务端返回：推进 stage / 同步大纲 / 消息进对话流；返回本轮出现的大纲（若有） */
      const absorbTurn = (j) => {
        if (!j || !j.ok) return null;
        if (j.stage) setStage(j.stage);
        let outline = null;
        (j.messages || []).forEach((m) => { if (m.kind === 'outline' && m.payload && Array.isArray(m.payload.outline)) outline = m.payload.outline; });
        if (outline) setCtx((c) => ({ ...c, outline }));
        pushAi((j.messages || []).map((m) => ({ id: nid(), role: 'ai', kind: m.kind || 'text', text: m.text || '', payload: m.payload || {} })));
        return outline;
      };

      /* 真实模式：直接生成前的自动补链（需求 → 大纲 → 确认 → 风格/计划），全部真实接口 */
      const ensureReadyForGenerate = async (rawText) => {
        let st = stage;
        let haveOutline = (ctx.outline || []).length > 0;
        /* ① idle/material：先把需求同步给服务端（服务端提取 brief；信息足够时可能直接给出大纲） */
        if (st === 'idle' || st === 'material') {
          const j = await respondReal(rawText || ctx.topic || '请基于已有信息直接制作 PPT');
          st = (j && j.stage) || st;
          if ((j && j.messages || []).some((m) => m.kind === 'outline')) haveOutline = true;
        }
        /* ② 尚无大纲 → 生成（跳过访谈直接出结构） */
        if (!haveOutline || st === 'idle' || st === 'material') {
          const j = await postJson('/api/projects/' + encodeURIComponent(projectId) + '/outline/generate', {});
          if (!j || !j.ok) throw new Error((j && j.message) || '大纲生成失败');
          if (absorbTurn(j)) haveOutline = true;
          st = j.stage || 'outline';
        }
        /* ③ 大纲未确认 → 确认（门禁） */
        if (st === 'outline') {
          const j = await postJson('/api/projects/' + encodeURIComponent(projectId) + '/outline/confirm', {});
          if (!j || !j.ok) throw new Error((j && j.message) || '大纲确认失败');
          setStage('style'); st = 'style';
        }
        /* ④ 风格与执行计划未定 → 用当前选择（默认 绿色简洁商务 8 页） */
        if (st === 'style') {
          await confirmStyleReal(sel.family || 'green-clean-business', sel.count || 8);
          st = 'pages';
        }
        return st === 'pages' || st === 'done';
      };

      /* ── 各意图动作实现 ── */

      /* 修改指令：真实走 /revise；演示写入画布待应用队列 */
      const doRevise = (rawText, intent) => {
        if (isReal && projectId) {
          if (stage === 'done' || stage === 'archived') { reviseReal(rawText); return; }
          pushAi([say('还没有生成版本，暂时改不了页——先说「直接生成」出一版，或先「出大纲」。')]);
          return;
        }
        const api = canvasApiRef.current;
        const n = intent.page;
        const newText = intent.text;
        if (api && newText) {
          const titleish = (o) => o.name.indexOf('标题') >= 0 || o.name.indexOf('题') >= 0;
          const anyText = (o) => !!o.editable_text;
          let name = api.applyTextEdit(n, titleish, newText);
          if (!name) name = api.applyTextEdit(n, anyText, newText);
          if (name) {
            pushAi([say('已把第 ' + n + ' 页「' + name + '」的文字更新为「' + newText + '」✍️，修改已写入画布待应用队列。在右侧画布点「应用修订」即可生成新版本（当前 ' + api.getVersion() + '，队列 ' + api.getPendingOps() + ' 项）。')]);
          } else {
            pushAi([say('第 ' + n + ' 页没有找到可直接编辑的文字对象（可能是组合/图片）。可以在右侧画布里点选该对象查看属性，或换一页试试。')]);
          }
        } else {
          pushAi([say('画布还没就绪（需先生成完成）。')]);
        }
      };

      /* 导出：真实导出 PPTX（需已生成版本）；演示伪造闭环卡 */
      const doExport = () => {
        if (isReal && projectId) {
          if (stage === 'done' || stage === 'archived') { exportReal(); return; }
          pushAi([say('还没有可导出的版本——先说「直接生成」出一版，再导出。')]);
          return;
        }
        archiveProject();
      };

      /* 直接生成：真实自动补齐前置后启动 job；演示本地快进 */
      const doGenerate = async (rawText) => {
        if (!isReal) { demoFastForward(rawText); return; }
        if (!projectId) { pushAi([say('尚未创建项目，请点「🆕 新对话」开始。')]); return; }
        setBusy(true);
        try {
          pushAi([say('收到 🚀 我会自动补齐前置（需求 → 大纲 → 确认 → 风格与版式计划），然后开始生成…')]);
          const ready = await ensureReadyForGenerate(rawText);
          if (!ready) throw new Error('前置补齐未完成');
          await startGenerateReal(); // 内部自带 busy 管理与 job 轮询
        } catch (e) {
          setBusy(false);
          pushAi([say('生成未启动：' + (e && e.message ? e.message : e) + '。可重试，或先说「出大纲」看结构。')]);
        }
      };

      /* 出大纲：真实走 /outline/generate（信息不足先同步一回合）；演示本地大纲 */
      const doOutline = async (rawText) => {
        if (!isReal) {
          let ctxNow = ctx;
          if (stage === 'idle') {
            const sc = detectScenario(rawText || '');
            const topic = sc ? sc.topic : String(rawText || '未命名汇报').replace(/大纲|出一份|重新|帮我|请/g, '').trim() || '未命名汇报';
            ctxNow = { ...ctx, topic, scenario: sc };
            setCtx(ctxNow);
          }
          startOutline(ctxNow);
          return;
        }
        if (!projectId) { pushAi([say('尚未创建项目，请点「🆕 新对话」开始。')]); return; }
        setBusy(true);
        try {
          let st = stage;
          if (st === 'idle' || st === 'material') {
            const j = await respondReal(rawText || ctx.topic || '请基于已有信息拟大纲');
            st = (j && j.stage) || st;
          }
          if (st !== 'outline') {
            const j = await postJson('/api/projects/' + encodeURIComponent(projectId) + '/outline/generate', {});
            if (!j || !j.ok) throw new Error((j && j.message) || '大纲生成失败');
            absorbTurn(j);
          } else {
            pushAi([say('当前大纲已在对话里，可直接「确认」或继续说怎么调整。')]);
          }
        } catch (e) {
          pushAi([say('大纲生成失败：' + (e && e.message ? e.message : e))]);
        } finally {
          setBusy(false);
        }
      };

      /* 确认大纲：真实走 /outline/confirm；pages 阶段的确认视同开始生成 */
      const doConfirmOutline = () => {
        if (stage === 'pages') { doGenerate('确认生成'); return; }
        if (isReal && projectId) { confirmOutlineReal(); return; }
        proceedStyle();
      };

      /* 风格/页数：解析家族关键词后走既有链路（真实 confirmStyleReal / 演示 buildPages） */
      const doStyle = (intent) => {
        const count = intent.count || sel.count || ctx.count || 8;
        const t = intent.text || '';
        let family = sel.family || ctx.family || 'green-clean-business';
        if (ctx.customStyle && /自定义|我的模板|上传的模板/.test(t)) family = ctx.customStyle.id;
        else if (/插画|活泼|轻松/.test(t)) family = 'green-office-illustrated';
        else if (/简洁|商务|绿色/.test(t)) family = 'green-clean-business';
        setSel({ family, count });
        proceedPages(family, count);
      };

      /* 普通对话：真实走服务端编排；演示走剧本状态机（兜底保留） */
      const doChat = (text) => {
        if (isReal && projectId) { respondReal(text); return; }
        demoScriptedRespond(text);
      };

      /* 演示剧本（后端不可达时的兜底；保留原有阶段推进语义） */
      const demoScriptedRespond = (text) => {
        /* 0.3.4.3：正式业务系统——后端未连接时如实提示，不提供演示流程 */
        pushAi([say('⚠️ 后端服务未连接：正式业务系统不提供演示流程。请通过 DSH 正常打开本应用（后端随宿主自动启动）后重试。')]);
      };

      /* 演示：直接生成 = 本地快进（已有大纲沿用；无则按场景生成，再走生成动画） */
      const demoFastForward = (rawText) => {
        /* 0.3.4.3：正式业务系统——后端未连接时如实提示，不提供演示流程 */
        pushAi([say('⚠️ 后端服务未连接：正式业务系统不提供演示流程。请通过 DSH 正常打开本应用（后端随宿主自动启动）后重试。')]);
      };

      /* ── 用户输入分发：意图优先，阶段不再锁操作 ── */
      const respond = (text) => {
        if (busy) { pushAi([say('正在处理上一条，请稍等…')]); return; }
        const intent = detectIntent(text, { stage, ctx });
        switch (intent.kind) {
          case 'reset': doReset(text); return;
          case 'revise': doRevise(text, intent); return;
          case 'confirm': doConfirmOutline(); return;
          case 'export': doExport(); return;
          case 'generate': doGenerate(text); return;
          case 'outline': doOutline(text); return;
          case 'style': doStyle(intent); return;
          default: doChat(text); return;
        }
      };

      /* ── 0.3.4：推翻重来——真实模式 POST /reset（服务端清数据回 idle）；演示模式本地重置 ── */
      const doReset = async (rawText) => {
        if (isReal && projectId) {
          setBusy(true);
          try {
            const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/reset', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ note: String(rawText || '').slice(0, 80) }), credentials: 'same-origin',
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
            setBusy(false);
            setStage(j.stage || 'idle');
            setCtx((c) => ({ ...c, outline: [] }));
            setSel({ family: 'green-clean-business', count: 8 });
            pushAi((j.messages || []).map((m) => say(m.text || '已推翻重来 🔄 这次想做什么主题的 PPT？')));
            if (onReloadProjects) onReloadProjects();
          } catch (e) {
            setBusy(false);
            pushAi([say('重置失败：' + (e && e.message ? e.message : e) + '。可稍后重试，或新建一个对话重新开始。')]);
          }
          return;
        }
        /* 演示模式：本地重置 */
        setStage('idle');
        setCtx((c) => ({ ...c, outline: [], topic: '', scenario: null }));
        setSel({ family: 'green-clean-business', count: 8 });
        pushAi([say('⚠️ 后端服务未连接：重置需要后端执行（清空需求/大纲/材料/版本）。请通过 DSH 正常打开本应用后重试。')]);
      };

      /* ── 真实模式回合：POST 后端 → 卡片消息映射 → 阶段/上下文同步 ── */
      const respondReal = async (text) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/conversation/message', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, model_id: modelId || null }), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          setBusy(false);
          setStage(j.stage);
          const items = (j.messages || []).map((m) => ({ id: nid(), role: 'ai', kind: m.kind || 'text', text: m.text || '', payload: m.payload || {} }));
          if (j.fallback) items.unshift(say('（真模型暂不可用，已切换本地引擎模式兜底）'));
          const ocard = (j.messages || []).find((m) => m.kind === 'outline');
          if (ocard && ocard.payload && ocard.payload.outline) setCtx((c) => ({ ...c, outline: ocard.payload.outline }));
          if (j.stage === 'style') setCtx((c) => ({ ...c, outline: c.outline })); // 保持大纲供右侧预览
          pushAi(items);
          return j; // 供 ensureReadyForGenerate 等调用方读取服务端推进后的 stage
        } catch (e) {
          setBusy(false);
          pushAi([say('对话服务出错：' + (e && e.message ? e.message : e) + '。可以重试；若持续失败请稍后在项目首页重新打开。')]);
        }
      };

      /* 真实模式：大纲卡片确认 */
      const confirmOutlineReal = async () => {
        if (!isReal || !projectId) { proceedStyle(); return; }
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/outline/confirm', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          /* 0.3.3：随大纲确认需求摘要（对话链过 WF-02 生成门禁；服务端 ensureBriefApproved 同款逻辑，此处双保险） */
          await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/brief/confirm', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ note: '随大纲确认（对话页）' }), credentials: 'same-origin',
          }).catch(() => {});
          setBusy(false);
          setStage('style');
          pushAi([say('大纲确认 ✅。接下来选风格与页数。'), { id: nid(), role: 'ai', kind: 'style', payload: {} }]);
        } catch (e) {
          setBusy(false);
          onToast('确认失败：' + (e && e.message ? e.message : e));
        }
      };

      /* 真实模式：导出后归档（A6 之前先落后端状态） */
      const archiveReal = async () => {
        if (!isReal || !projectId) return;
        try {
          await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/archive', { method: 'POST', credentials: 'same-origin' });
        } catch { /* 归档失败提示但不阻断 */ }
        if (onReloadProjects) onReloadProjects();
      };

      /* ── WF-04：确认风格与页数（真实：后端持久化 + WF-05 生成执行计划） ── */
      const confirmStyleReal = async (family, count) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/style', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ family, count }), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          const r2 = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/plan', { method: 'POST', credentials: 'same-origin' });
          const j2 = await r2.json();
          if (!r2.ok || !j2.ok) throw new Error((j2 && j2.message) || ('HTTP ' + r2.status));
          setBusy(false);
          setStage('pages');
          setCtx((c) => ({ ...c, family, count, pageLayouts: j2.pageLayouts }));
          pushAi([
            say('已按「' + famDisplay(ctx, family) + ' · ' + count + ' 页」生成执行计划：每页版式都来自模板库' + (family === (ctx.customStyle && ctx.customStyle.id) ? '，自定义风格将基于你模板的母版生成' : '，参考图构图包优先') + '。逐页看看，不满意的可以「换一换」：'),
            { id: nid(), role: 'ai', kind: 'pages', payload: { pageLayouts: j2.pageLayouts } },
          ]);
        } catch (e) {
          setBusy(false);
          onToast('风格确认失败：' + (e && e.message ? e.message : e));
        }
      };

      /* ── WF-05：换一换（真实：后端 reroll 同关系版式池） ── */
      const rerollReal = async (n) => {
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/plan/reroll', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ n }), credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          if (j.pageLayouts) setCtx((c) => ({ ...c, pageLayouts: j.pageLayouts }));
        } catch (e) {
          onToast('换一换失败：' + (e && e.message ? e.message : e));
        }
      };

      /* ── WF-04：自定义模板真实解析（后端 extract_theme.py 读 OOXML 主题） ── */
      const importTemplateReal = async (file) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/style/template?filename=' + encodeURIComponent(file.name), {
            method: 'POST', body: file, credentials: 'same-origin',
          });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
          const c = j.custom;
          setBusy(false);
          const custom = { id: c.id, name: c.name, palette: c.palette, masters: c.masters, fonts: c.fonts_label, theme: c.theme_name };
          setCtx((cc) => ({ ...cc, customStyle: custom }));
          setSel((s) => ({ ...s, family: custom.id }));
          pushAi([say('已解析你的模板「' + file.name + '」🎨：主题「' + c.theme_name + '」，主色板 ' + c.palette.length + ' 色（' + c.palette.slice(0, 3).join(' ') + '…），母版 ' + c.masters + ' 页，字体 ' + custom.fonts + '。已加入风格选项并默认选中——页数选好后点「确认风格与页数」。')]);
        } catch (e) {
          setBusy(false);
          pushAi([say('模板解析失败：' + (e && e.message ? e.message : e) + '。可重试或改用内置风格。')]);
        }
      };

      /* ── 附件（真实：上传到后端材料库；mock：本地解析演示）──
         hpDrop-20261012：抽出单文件上传入口 uploadMaterial(f)，供附件按钮（onPickFile）与拖拽落放共用 */
      const uploadMaterial = async (f) => {
        setMsgs((prev) => [...prev, { id: nid(), role: 'user', kind: 'text', text: '📎 上传材料：' + f.name }]);
        if (isReal && projectId) {
          try {
            const res = await fetch(API + '/api/projects/' + encodeURIComponent(projectId) + '/materials?filename=' + encodeURIComponent(f.name), {
              method: 'POST', body: f, credentials: 'same-origin',
            });
            const j = await res.json();
            if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
            const ext = (f.name.split('.').pop() || '').toLowerCase();
            const mat = {
              id: j.entry.id, name: j.entry.name, ext,
              icon: MAT_ICONS[ext] || '📎',
              pages: j.entry.size > 1048576 ? (j.entry.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(j.entry.size / 1024)) + ' KB',
              summary: j.entry.text_extracted ? '已提取文本 ' + j.entry.text_chars + ' 字，可作大纲与字段引用' : '已登记到项目材料库（内容分析随知识治理接入）',
            };
            setCtx((c) => ({ ...c, materials: [...c.materials, mat] }));
            setMsgs((prev) => [...prev, { id: nid(), role: 'ai', kind: 'text', text: '已收到「' + f.name + '」✅ 材料清单见右侧。' + (j.deduplicated ? '（与已有材料相同，已去重）' : '') + (stage === 'material' ? '继续上传，或说「继续」开始拟大纲。' : '') }]);
          } catch (err) {
            setMsgs((prev) => [...prev, { id: nid(), role: 'ai', kind: 'text', text: '上传失败：' + (err && err.message ? err.message : err) }]);
          }
          return;
        }
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        const mat = {
          id: 'mat-' + Date.now(), name: f.name, ext,
          icon: MAT_ICONS[ext] || '📎',
          pages: ext === 'pptx' || ext === 'ppt' ? '约 18 页' : ext === 'pdf' ? '约 26 页' : ext === 'xlsx' || ext === 'xls' ? '3 个工作表' : '约 4200 字',
          summary: ext === 'xlsx' || ext === 'xls' ? '提取到进度与人力两张数据表，可作为数据页引用' : '提取到章节结构与关键段落，可作为大纲与字段引用',
        };
        const mats = [...ctx.materials, mat];
        setCtx({ ...ctx, materials: mats });
        setMsgs((prev) => [...prev,
          { id: nid(), role: 'ai', kind: 'text', text: '已收到并解析「' + f.name + '」✅（' + mat.pages + '）：' + mat.summary + '。材料清单见右侧。' + (stage === 'material' ? '继续上传，或说「继续」开始拟大纲。' : '') },
        ]);
      };
      const onPickFile = async (e) => {
        const fs = e.target.files; e.target.value = '';
        if (fs && fs.length) { for (const f of Array.prototype.slice.call(fs)) await uploadMaterial(f); }
      };
      const removeMat = (id) => setCtx((c) => ({ ...c, materials: c.materials.filter((m) => m.id !== id) }));

      /* ── 拖拽上传附件（hpDrop-20261012）：与知识库/会议助手/政策解读同款 ——
            只拦截含文件的拖拽（dataTransfer.types 含 'Files'），文本/富文本拖放保持默认行为；
            文件夹用 webkitGetAsEntry 递归收集，取不到条目（非 Chromium/权限受限）回退 dataTransfer.files ── */
      const hasFilesInDT = (e) => {
        const dt = e && e.dataTransfer;
        if (!dt || !dt.types) return false;
        try { return Array.prototype.indexOf.call(dt.types, 'Files') !== -1 } catch { return false }
      };
      const onChatDragEnter = (e) => {
        e.stopPropagation();
        if (!hasFilesInDT(e)) return;
        e.preventDefault();
        dropDepth.current += 1;
        setDropHover(true);
      };
      const onChatDragOver = (e) => {
        e.stopPropagation();
        if (!hasFilesInDT(e)) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy' } catch { /* ignore */ }
      };
      const onChatDragLeave = (e) => {
        e.stopPropagation();
        if (!hasFilesInDT(e)) return;
        dropDepth.current = Math.max(0, dropDepth.current - 1);
        if (dropDepth.current === 0) setDropHover(false);
      };
      async function hpCollectEntry(entry, out) {
        if (!entry) return;
        if (entry.isFile) {
          await new Promise((resolve) => {
            try { entry.file((f) => { if (f) out.push(f); resolve() }, () => resolve()) } catch { resolve() }
          });
          return;
        }
        if (!entry.isDirectory) return;
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve) => {
            try { reader.readEntries((rows) => resolve(Array.prototype.slice.call(rows || [])), () => resolve([])) } catch { resolve([]) }
          });
          if (!batch.length) return;
          for (const kid of batch) await hpCollectEntry(kid, out);
        }
      }
      const onChatDrop = (e) => {
        e.stopPropagation();
        if (!hasFilesInDT(e)) return;
        e.preventDefault();
        dropDepth.current = 0;
        setDropHover(false);
        const dt = e.dataTransfer;
        const entries = [];
        if (dt && dt.items) {
          const items = Array.prototype.slice.call(dt.items);
          for (const item of items) {
            try { const entry = item.webkitGetAsEntry && item.webkitGetAsEntry(); if (entry) entries.push(entry) } catch { /* ignore */ }
          }
        }
        /* 注意：items 在 await 之后失效，条目必须同步取完再异步递归 */
        void (async () => {
          const out = [];
          for (const entry of entries) await hpCollectEntry(entry, out);
          if (!out.length && dt && dt.files && dt.files.length) { for (const f of Array.prototype.slice.call(dt.files)) out.push(f); }
          if (out.length) { for (const f of out) await uploadMaterial(f); }
          else if (onToast) onToast('没有可用文件（文件夹为空或类型不支持）。');
        })();
      };

      /* ── 「@ 引用」可选来源：项目主题 / 已上传材料 / 自定义模板 / 当前大纲 ── */
      const atRefs = () => {
        const list = [];
        if (ctx.topic) list.push({ key: 'topic', label: ctx.topic, hint: '项目主题' });
        (ctx.materials || []).forEach((m) => list.push({ key: 'mat-' + m.id, label: m.name, hint: '材料' }));
        if (ctx.customStyle) list.push({ key: 'tpl', label: ctx.customStyle.name, hint: '模板' });
        if ((ctx.outline || []).length) list.push({ key: 'outline', label: '当前大纲（' + ctx.outline.length + ' 页）', hint: '大纲' });
        return list;
      };
      const pickRef = (label) => {
        setInput((v) => (v ? v.replace(/\s+$/, ' ') : '') + '@' + label + ' ');
        setAtOpen(false);
        if (taRef.current && taRef.current.focus) taRef.current.focus();
      };
      /* 打开「@」面板后点空白处收起（点在按钮/面板内不收起） */
      useEffect(() => {
        if (!atOpen) return undefined;
        const onDoc = (e) => {
          const box = atRef.current;
          if (box && e.target && !box.contains(e.target)) setAtOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [atOpen]);

      /* ── 对话栏宽度拖拽：默认 1:1，拖拽后固定 px（300px ~ 容器 80%） ── */
      const chatMaxW = () => {
        const box = chatRef.current && chatRef.current.parentElement;
        const w = (box && box.offsetWidth) || (typeof window !== 'undefined' ? window.innerWidth : 1200);
        return Math.max(360, Math.round(w * 0.8));
      };
      const onResizeDown = (e) => {
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
        const el = chatRef.current;
        const live = (el && el.offsetWidth) || chatW
          || Math.round((typeof window !== 'undefined' ? window.innerWidth : 1200) / 2);
        dragWRef.current = { sx: e.clientX, sw: live };
        setChatW(live);
        setDragging(true);
      };
      const onResizeMove = (e) => {
        const d = dragWRef.current;
        if (!d) return;
        setChatW(Math.max(300, Math.min(chatMaxW(), d.sw + (e.clientX - d.sx))));
      };
      const onResizeUp = () => { dragWRef.current = null; setDragging(false); };

      /* ── 模板导入：mock 解析出主色板/母版/字体，生成自定义风格 ── */
      const paletteFrom = (name) => {
        let h1 = 0;
        for (let i = 0; i < name.length; i++) h1 = (h1 * 31 + name.charCodeAt(i)) % 360;
        return ['hsl(' + h1 + ',52%,38%)', 'hsl(' + ((h1 + 42) % 360) + ',48%,55%)', 'hsl(' + ((h1 + 205) % 360) + ',32%,86%)'];
      };
      const importTemplate = (file) => {
        if (!file) return;
        if (isReal && projectId) { importTemplateReal(file); return; }
        /* 0.3.4.3：正式业务系统——后端未连接不伪造模板解析 */
        onToast('后端未连接：模板解析需要后端提取母版与色板，请通过 DSH 正常打开本应用');
      };
      const onPickTemplate = (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importTemplate(f);
        e.target.value = '';
      };

      /* ── 建议 chips ── */
      /* 动作按钮（自由流程）：随时可出大纲 / 确认 / 直接生成 / 导出，不依赖当前阶段顺序 */
      const actions = () => {
        const a = [];
        if (!ctx.outline.length) a.push({ k: 'outline', label: '📋 出大纲' });
        else if (stage === 'outline') a.push({ k: 'confirm', label: '✅ 确认大纲' });
        if (stage !== 'generating') a.push({ k: 'generate', label: '✨ 直接生成' });
        if (stage === 'done' || stage === 'archived' || ctx.downloadUrl) a.push({ k: 'export', label: '📥 导出 PPTX' });
        return a;
      };
      const runAction = (k) => {
        if (k === 'outline') doOutline('请基于已有信息出大纲');
        else if (k === 'confirm') doConfirmOutline();
        else if (k === 'generate') doGenerate('直接生成');
        else if (k === 'export') doExport();
      };
      /* 建议话术（点击仅填入输入框，由用户手动发送；与动作按钮互补） */
      const sugg = () => {
        if (stage === 'idle') return ['帮我做一份项目进度汇报', '帮我做年度总结', '做一份新产品介绍'];
        if (stage === 'material') return [ctx.materials.length ? '材料已上传，继续' : '暂时没有，直接开始'];
        if (stage === 'outline') return ['增加一页团队介绍', '风险页改成问题与对策'];
        if (stage === 'done') return ['把第 2 页标题改成「项目背景与目标」'];
        return [];
      };
      /* 快捷键标签：点击只把文案写入输入框，不直接发送；发送由用户手动点 ➤ 或回车触发 */
      const pendingFocusRef = useRef(false);
      const fillInput = (text) => {
        pendingFocusRef.current = true;
        setInput(text);
      };
      useEffect(() => {
        if (!pendingFocusRef.current) return;
        pendingFocusRef.current = false;
        const ta = taRef.current;
        if (!ta || typeof ta.focus !== 'function') return;
        try {
          ta.focus();
          const n = (ta.value || '').length;
          if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(n, n);
        } catch (e) { /* 聚焦失败不影响已填入的文案 */ }
      }, [input]);

      /* ═══ 对话流里的卡片渲染 ═══ */
      const cardOutline = (msg) => h('div', null,
        h('div', { style: { marginBottom: 8 } },
          ((msg.payload && Array.isArray(msg.payload.outline)) ? msg.payload.outline : []).map((o) => h('div', { key: o.n, className: 'hp-ol-item', style: { padding: '4px 6px' } },
            h('span', { className: 'hp-ol-n', style: { width: 20, height: 20, fontSize: 10 } }, o.n),
            h('div', null,
              h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, o.title),
              h('div', { className: 'hp-tid' }, o.rel))))),
        h('div', { className: 'hp-row', style: { gap: 8 } },
          h(Btn, { kind: 'pri', sm: true, disabled: stage !== 'outline', onClick: confirmOutlineReal }, '✓ 确认大纲'),
          h('span', { className: 'hp-sub', style: { fontSize: 11 } }, '或直接输入调整意见')));

      const cardStyle = () => h('div', null,
        h('div', { className: 'hp-pick-grid', style: { gridTemplateColumns: '1fr 1fr', marginBottom: 10 } },
          ['green-clean-business', 'green-office-illustrated'].map((fam) => h('button', {
            key: fam, type: 'button', className: 'hp-pick' + (sel.family === fam ? ' on' : ''),
            onClick: () => setSel({ ...sel, family: fam }),
          },
            h('img', { src: img(FAMILY_PREVIEW[fam]), alt: FAMILY_NAME[fam] }),
            h('div', { className: 'pb' },
              h('div', { style: { fontWeight: 600, fontSize: 12 } }, FAMILY_NAME[fam] + (fam === 'green-clean-business' ? ' 👑' : '')),
              h('div', { className: 'hp-tid' }, fam === 'green-clean-business' ? '推荐：正式汇报场合' : '更轻松：内部分享')))),
          ctx.customStyle ? h('button', {
            key: ctx.customStyle.id, type: 'button',
            className: 'hp-pick' + (sel.family === ctx.customStyle.id ? ' on' : ''),
            onClick: () => setSel({ ...sel, family: ctx.customStyle.id }),
          },
            h('div', { className: 'hp-customprev', style: { background: 'linear-gradient(135deg,' + ctx.customStyle.palette[0] + ',' + ctx.customStyle.palette[1] + ')' } }, '🎨'),
            h('div', { className: 'pb' },
              h('div', { style: { fontWeight: 600, fontSize: 12 } }, ctx.customStyle.name + ' ✦'),
              h('div', { className: 'hp-tid' }, '自定义 · 来自你的模板'))) : null),
        h('div', { className: 'hp-row', style: { gap: 8, marginBottom: 10 } },
          h(Btn, { sm: true, onClick: () => tplRef.current && tplRef.current.click() }, '📥 导入我的模板'),
          h('span', { className: 'hp-sub', style: { fontSize: 11 } }, ctx.customStyle ? '重新导入会替换当前自定义风格' : '.pptx/.potx，解析出你自己的风格')),
        h('div', { className: 'hp-row', style: { gap: 6, marginBottom: 10 } },
          h('span', { className: 'hp-sub', style: { fontSize: 12 } }, '页数：'),
          [8, 12, 16].map((c) => h('button', {
            key: c, type: 'button', className: 'hp-suggbtn' + (sel.count === c ? '' : ''),
            style: sel.count === c ? { background: 'var(--hp-accent)', color: 'var(--hp-accent-ink)' } : null,
            onClick: () => setSel({ ...sel, count: c }),
          }, c + ' 页'))),
        h(Btn, { kind: 'pri', sm: true, disabled: stage !== 'style', onClick: () => proceedPages(sel.family, sel.count) }, '✓ 确认风格与页数'));

      const cardPages = (msg) => h('div', null,
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 } },
          ctx.pageLayouts.map((p, i) => {
            const lay = L(p.layoutId);
            return h('div', { key: p.n, className: 'hp-card', style: { overflow: 'hidden' } },
              lay && lay.preview ? h('img', { src: img(lay.preview), alt: lay.name, style: { width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' } }) : null,
              h('div', { style: { padding: '6px 8px' } },
                h('div', { style: { fontSize: 11.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'P' + p.n + ' ' + p.title),
                h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginTop: 3 } },
                  h('span', { className: 'hp-tid' }, lay ? lay.id : p.layoutId),
                  h(Btn, { kind: 'ghost', sm: true, disabled: stage !== 'pages', onClick: () => {
                    if (isReal && projectId) { rerollReal(p.n); return; }
                    const pool = poolOf(p.rel, ctx.family);
                    const alt = (p.alt + 1) % pool.length;
                    const next = ctx.pageLayouts.map((q, qi) => (qi === i ? { ...q, alt, layoutId: pool[alt].id } : q));
                    setCtx({ ...ctx, pageLayouts: next });
                  } }, '换一换'))));
          })),
        h(Btn, { kind: 'pri', sm: true, disabled: stage !== 'pages', onClick: startGenerate }, '✨ 确认生成'));

      const cardResult = () => h('div', null,
        h('div', { className: 'hp-row', style: { gap: 8, marginBottom: 6 } },
          h('span', { style: { fontSize: 14, fontWeight: 700 } }, ctx.topic || '未命名汇报'),
          h(Badge, { tone: 'ok' }, '已生成')),
        h('dl', { className: 'hp-kv', style: { gridTemplateColumns: '64px 1fr', fontSize: 12 } },
          h('dt', null, '版本'), h('dd', null, ctx.version),
          h('dt', null, '页数'), h('dd', null, (ctx.pageLayouts.length || ctx.count) + ' 页'),
          h('dt', null, '风格'), h('dd', null, famDisplay(ctx)),
          h('dt', null, '引擎'), h('dd', null, ctx.realEngine ? 'studio 构建引擎 · LibreOffice 预览' : '生成后确认'),
          h('dt', null, 'SHA256'), h('dd', { className: 'hp-mono' }, ctx.sha)));

      const cardExport = () => h('div', null,
        h('div', { style: { fontSize: 12.5, marginBottom: 8 } }, '确认无误后导出 PPTX，导出即完成项目闭环归档：'),
        h('div', { className: 'hp-row', style: { gap: 8 } },
          h(Btn, { kind: 'pri', sm: true, disabled: stage !== 'done', onClick: archiveProject }, '⬇ 导出 PPTX 并归档'),
          stage === 'archived' ? h(Btn, { sm: true, onClick: () => onNav('home') }, '去项目首页查看 📦') : null));

      const cardArchived = () => h('div', null,
        h('div', { className: 'hp-note', style: { fontSize: 12 } },
          h('span', null, '📦'),
          h('span', null, (ctx.downloadUrl ? '已导出「' + ctx.exportName + '」并闭环归档：版本定格 ' + ctx.version + '。' : '项目已归档：版本定格 ' + ctx.version + '，五项检查全部通过。') + '项目首页只读保留，可随时重新打开。')),
        ctx.downloadUrl ? h('div', { className: 'hp-row', style: { gap: 8, marginTop: 8 } },
          h('a', {
            href: ctx.downloadUrl, download: ctx.exportName || 'deck.pptx',
            style: { textDecoration: 'none' },
          }, h(Btn, { kind: 'pri', sm: true }, '⬇ 下载 PPTX（用 WPS 打开验收）'))) : null);

      const renderMsg = (msg) => {
        const isUser = msg.role === 'user';
        const wide = msg.kind !== 'text';
        return h('div', { key: msg.id, className: 'hp-msg' + (isUser ? ' user' : '') },
          h('span', { className: 'hp-avatar' }, isUser ? '🧑' : '🎬'),
          h('div', { className: 'hp-bubble' + (wide ? ' wide' : '') },
            msg.kind === 'text' ? h('span', null, msg.text)
              : msg.kind === 'outline' ? cardOutline(msg)
              : msg.kind === 'style' ? cardStyle()
              : msg.kind === 'pages' ? cardPages(msg)
              : msg.kind === 'result' ? cardResult()
              : msg.kind === 'export' ? cardExport()
              : msg.kind === 'archived' ? cardArchived()
              : msg.kind === 'materials' ? h('div', { className: 'hp-sub', style: { fontSize: 12 } }, '📎 点输入框左侧回形针上传；右侧「材料」清单实时可见。')
              : null));
      };

      /* ═══ 右侧演化工作区 ═══ */
      const paneHead = (title, sub) => h('div', { style: { marginBottom: 16 } },
        h('h2', { className: 'hp-h1', style: { fontSize: 17 } }, title),
        sub ? h('p', { className: 'hp-sub' }, sub) : null);

      const paneWelcome = h('div', null,
        paneHead('对话制作工作台', '左侧聊需求，这里实时呈现每个阶段的产出'),
        h('div', { className: 'hp-card', style: { padding: '18px 20px', marginBottom: 16 } },
          h('div', { style: { fontSize: 32, marginBottom: 8 } }, '💬'),
          h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 6 } }, ctx.topic ? '当前主题：' + ctx.topic : '从一句话开始'),
          h('div', { className: 'hp-sub', style: { fontSize: 12.5, lineHeight: 1.8 } },
            '试试「帮我做一份项目进度汇报」——我会依次与你确认材料、大纲、风格、逐页版式，4-5 轮对话后生成 PPT；生成后画布在这里展开，修改可以手动也可以对话下达。')),
        h(SectionHead, { title: '材料清单', sub: ctx.materials.length ? ctx.materials.length + ' 份' : '对话中上传的附件会出现在这里' }),
        h('div', { className: 'hp-card', style: { padding: 14 } },
          ctx.materials.length
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ctx.materials.map((m) => h('div', { key: m.id, className: 'hp-mat' },
                  h('span', { className: 'fileic' }, m.icon),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: 13, fontWeight: 600 } }, m.name),
                    h('div', { className: 'hp-tid' }, m.pages + ' · ' + m.summary)),
                  h(Btn, { kind: 'ghost', sm: true, onClick: () => removeMat(m.id) }, '移除'))))
            : h(EmptyHint, { icon: '📎', text: '暂无材料；点左下角回形针上传，或跳过直接开始' })));

      const paneOutline = h('div', null,
        paneHead('大纲预览', ctx.topic || ''),
        h('div', { className: 'hp-card', style: { padding: 10 } },
          ctx.outline.map((o) => h('div', { key: o.n, className: 'hp-ol-item' },
            h('span', { className: 'hp-ol-n' }, o.n),
            h('div', null,
              h('div', { style: { fontSize: 14, fontWeight: 600 } }, o.title),
              h('div', { className: 'hp-tid' }, '版式关系：' + o.rel))))));

      const paneStyle = h('div', null,
        paneHead('风格对比', '两个内置分支 + 可导入你自己的模板生成自定义风格'),
        h('div', { style: { display: 'grid', gridTemplateColumns: ctx.customStyle ? '1fr 1fr 1fr' : '1fr 1fr', gap: 16 } },
          ['green-clean-business', 'green-office-illustrated'].map((fam) => h('div', { key: fam, className: 'hp-card', style: { overflow: 'hidden', border: sel.family === fam ? '2px solid var(--hp-accent)' : undefined } },
            h('img', { src: img(FAMILY_PREVIEW[fam]), alt: FAMILY_NAME[fam], style: { width: '100%', display: 'block' } }),
            h('div', { style: { padding: '10px 14px' } },
              h('div', { className: 'hp-row', style: { gap: 8, marginBottom: 4 } },
                h('b', null, FAMILY_NAME[fam]),
                fam === 'green-clean-business' ? h(Badge, { tone: 'ok' }, '推荐') : null),
              h('div', { className: 'hp-sub', style: { fontSize: 12 } },
                fam === 'green-clean-business' ? '22 个版式 · 绿色系简洁商务，适合正式汇报' : '15 个版式 · 插画元素丰富，适合内部分享')))),
          ctx.customStyle ? h('div', { key: ctx.customStyle.id, className: 'hp-card', style: { overflow: 'hidden', border: sel.family === ctx.customStyle.id ? '2px solid var(--hp-accent)' : undefined } },
            h('div', { className: 'hp-customprev', style: { background: 'linear-gradient(135deg,' + ctx.customStyle.palette[0] + ',' + ctx.customStyle.palette[1] + ')' } }, '🎨'),
            h('div', { style: { padding: '10px 14px' } },
              h('div', { className: 'hp-row', style: { gap: 8, marginBottom: 4 } },
                h('b', null, ctx.customStyle.name),
                h(Badge, { tone: 'pend' }, '自定义')),
              h('div', { className: 'hp-row', style: { gap: 5, margin: '6px 0' } },
                ctx.customStyle.palette.map((c) => h('span', { key: c, className: 'hp-swatch', style: { background: c }, title: c }))),
              h('div', { className: 'hp-sub', style: { fontSize: 12 } },
                '母版版式 ' + ctx.customStyle.masters + ' 页 · ' + ctx.customStyle.fonts))) : null),
        h('div', { className: 'hp-row', style: { gap: 10, marginTop: 14 } },
          h(Btn, { sm: true, onClick: () => tplRef.current && tplRef.current.click() }, '📥 导入我的模板（.pptx / .potx）'),
          h('span', { className: 'hp-sub', style: { fontSize: 12 } }, '不局限于内置两个分支：解析你模板的配色、母版与字体，生成专属风格')));

      const panePages = h('div', null,
        paneHead('逐页版式', ctx.pageLayouts.length + ' 页 · ' + famDisplay(ctx)),
        ctx.customStyle && ctx.family === ctx.customStyle.id ? h('div', { className: 'hp-note', style: { marginBottom: 12 } },
          h('span', null, '🎨'),
          h('span', null, '自定义风格将基于你模板的母版生成（演示：版式缩略图暂以通用版式占位）。')) : null,
        h('div', { className: 'hp-tgrid' },
          ctx.pageLayouts.map((p) => {
            const lay = L(p.layoutId);
            return h('div', { key: p.n, className: 'hp-tcard', style: { cursor: 'default' } },
              h('div', { className: 'hp-tprev' }, lay && lay.preview ? h('img', { src: img(lay.preview), alt: lay.name, loading: 'lazy' }) : null),
              h('div', { className: 'hp-tbody' },
                h('div', { style: { fontSize: 13, fontWeight: 600 } }, 'P' + p.n + ' ' + p.title),
                h('div', { className: 'hp-tid' }, lay ? lay.id + ' · ' + lay.relation : p.layoutId)));
          })));

      const paneGenerating = h('div', null,
        paneHead('正在生成', '构建与渲染进行中 · 完成自动出结果卡'),
        h('div', { className: 'hp-card', style: { padding: '18px 20px', maxWidth: 560 } },
          GEN_STEPS.map((label, i) => {
            const done = genStep > i;
            const run = genStep === i;
            return h('div', { key: label, className: 'hp-gen-step' },
              h('span', { className: 'hp-gen-ic' + (done ? ' ok' : run ? ' run' : '') }, done ? '✓' : i + 1),
              h('div', { style: { flex: 1 } },
                h('div', { style: { fontSize: 13, fontWeight: run || done ? 600 : 400, color: done || run ? undefined : 'var(--dsw-alias-label-tertiary,#94a3b8)' } }, label),
                run ? h('div', { className: 'hp-progress fast', style: { marginTop: 6 } },
                  h('i', { onAnimationEnd: () => setGenStep((s) => (s === i ? i + 1 : s)) })) : null));
          }),
          genStep >= GEN_STEPS.length ? h('div', { className: 'hp-note', style: { marginTop: 10 } },
            h('span', null, '✅'),
            h('span', null, '全部阶段完成，画布就绪。')) : null));

      /* 生成完成后无缝切画布 */
      useEffect(() => { if (stage === 'generating' && genStep >= GEN_STEPS.length) finishGenerate(); });

      const paneCanvas = h(CanvasView, {
        key: 'studio-canvas', data,
        project: { title: ctx.topic || '对话项目' },
        onToast, apiRef: canvasApiRef,
        initialVersion: ctx.version, initialSha: ctx.sha,
      });

      /* 真实画布（WF-07）：渲染样张 + 页导航 + 形状属性面板 + 修订队列（画布点选叠层待 inspection 提供坐标后升级） */
      const paneRenders = () => {
        const pngs = ctx.renders || [];
        const page = Math.min(canvasPage, pngs.length) || 1;
        const shapes = canvasShapes && canvasShapes.page === page ? canvasShapes : null;
        return h('div', null,
          paneHead('画布 · ' + (ctx.version || ''), '点击形状编辑文字 → 加入队列 → 应用生成新版本（SHA256 乐观锁）'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 } },
            h('div', null,
              pngs[page - 1] ? h('div', { className: 'hp-card', style: { overflow: 'hidden' } },
                h('img', {
                  src: API + '/api/huiwen-ppt/api/data-file/projects/' + encodeURIComponent(projectId) + '/' + pngs[page - 1],
                  alt: '第 ' + page + ' 页渲染', style: { width: '100%', display: 'block' },
                })) : null,
              h('div', { className: 'hp-row', style: { gap: 6, marginTop: 10, flexWrap: 'wrap' } },
                pngs.map((_, i) => h('button', {
                  key: i, type: 'button', className: 'hp-suggbtn',
                  style: page === i + 1 ? { background: 'var(--hp-accent)', color: 'var(--hp-accent-ink)' } : null,
                  onClick: () => loadShapes(i + 1),
                }, 'P' + (i + 1))))),
            h('div', null,
              h('div', { className: 'hp-card', style: { padding: '12px 14px' } },
                h('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 8 } }, '第 ' + page + ' 页 · 可编辑文字形状'),
                !shapes ? h('div', { className: 'hp-sub', style: { fontSize: 12 } }, page === canvasPage ? '加载中…' : '点击页码加载形状')
                  : shapes.error ? h('div', { className: 'hp-sub', style: { fontSize: 12 } }, shapes.error)
                  : !shapes.shapes.length ? h('div', { className: 'hp-sub', style: { fontSize: 12 } }, '本页没有可编辑文字对象（参考图版式）')
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      shapes.shapes.map((s) => h('div', { key: s.shape_id },
                        h('div', { className: 'hp-row', style: { justifyContent: 'space-between', fontSize: 11 } },
                          h('span', { className: 'hp-tid' }, '#' + s.shape_id + ' ' + s.name),
                          h('button', { type: 'button', className: 'hp-suggbtn', style: { fontSize: 10 }, title: '加入修订队列', onClick: () => queueEdit(s, s.text) }, '✎')),
                        h('textarea', {
                          className: 'hp-textarea', style: { minHeight: 34, fontSize: 12, marginTop: 4 },
                          defaultValue: s.text,
                          onBlur: (e) => { if (e.target.value !== s.text) queueEdit(s, e.target.value); },
                        })))),
                pending.length ? h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1,#e2e8f0)' } },
                  h('div', { style: { fontSize: 11, marginBottom: 6 } }, '修订队列（' + pending.length + ' 项）'),
                  pending.map((p, i) => h('div', { key: i, className: 'hp-tid', style: { marginBottom: 2 } }, 'P' + p.slide + ' #' + p.shape_id + ' ' + p.name)),
                  h(Btn, { kind: 'pri', sm: true, disabled: busy, onClick: applyPending, style: { marginTop: 6 } }, '⚡ 应用修订生成新版本'))
                  : null))));
      };

      const pane = stage === 'idle' || stage === 'material' ? paneWelcome
        : stage === 'outline' ? paneOutline
        : stage === 'style' ? paneStyle
        : stage === 'pages' ? panePages
        : stage === 'generating' ? paneGenerating
        : null;
      const isCanvasStage = stage === 'done' || stage === 'archived';

      /* ═══ 整体渲染 ═══ */
      const curIdx = STAGE_IDX[stage] || 0;
      return h('div', { className: 'hp-cs' + (dragging ? ' dragging' : '') },
        /* ── 左：对话栏（宽度可拖拽；整栏接收附件拖拽 hpDrop-20261012） ── */
        h('div', {
          ref: chatRef, className: 'hp-chat', style: chatW == null ? undefined : { width: chatW },
          onDragEnter: onChatDragEnter, onDragOver: onChatDragOver, onDragLeave: onChatDragLeave, onDrop: onChatDrop,
        },
          h('div', { className: 'hp-chat-head' },
            h('span', { style: { fontSize: 15 } }, '💬'),
            h('b', { style: { fontSize: 13 } }, '对话制作'),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', className: 'hp-suggbtn', style: { fontSize: 10, marginRight: 6 }, onClick: () => (onRequestNewConversation ? onRequestNewConversation() : startNewConversation()), title: '新建对话项目' }, '🆕 新对话'),
            h('div', { className: 'hp-row', style: { gap: 3 }, title: '进度提示：步骤可跳过、可乱序，不做强制' },
              STUDIO_STEPS.map((s, i) => h('span', {
                key: s, title: s,
                style: {
                  fontSize: 10, padding: '1px 6px', borderRadius: 999,
                  background: i < curIdx ? 'var(--hp-accent-soft)' : i === curIdx ? 'var(--hp-accent)' : 'var(--dsw-alias-bg-layer-2,#f8fafc)',
                  color: i === curIdx ? 'var(--hp-accent-ink)' : i < curIdx ? 'var(--hp-accent)' : 'var(--dsw-alias-label-tertiary,#94a3b8)',
                  border: '1px solid ' + (i === curIdx ? 'var(--hp-accent)' : i < curIdx ? 'var(--hp-accent-soft-border)' : 'var(--dsw-alias-border-l1,#e2e8f0)'),
                },
              }, s)))),
          h('div', { className: 'hp-msgs' },
            msgs.map(renderMsg),
            (typing || busy) ? h('div', { className: 'hp-msg' },
              h('span', { className: 'hp-avatar' }, '🎬'),
              h('div', { className: 'hp-bubble' },
                h('span', { className: 'hp-typing' }, h('i', null), h('i', null), h('i', null)))) : null,
            typing ? h('span', {
              style: { display: 'block', height: 1, animation: 'hpTypeHold 1.15s ease forwards' },
              onAnimationEnd: flushAi,
            }) : null,
            h('span', { ref: endRef })),
          h('div', { className: 'hp-chat-input' },
            /* 拖拽落点提示（hpDrop-20261012）：政策解读同款胶囊 */
            dropHover ? h('div', null, h('span', { className: 'hp-compose-pill' }, '松开以上传附件')) : null,
            /* 动作按钮（自由流程）：点击直接执行，不依赖阶段顺序 */
            actions().length ? h('div', { className: 'hp-sugg' },
              actions().map((a) => h('button', {
                key: a.k, type: 'button', className: 'hp-suggbtn',
                style: { borderColor: 'var(--hp-accent)', color: 'var(--hp-accent)', fontWeight: 600 },
                title: '点击直接执行（无需发送）',
                onClick: () => runAction(a.k),
              }, a.label))) : null,
            /* 建议话术：点击填入输入框，由你手动发送 */
            sugg().length ? h('div', { className: 'hp-sugg' },
              sugg().map((s) => h('button', {
                key: s, type: 'button', className: 'hp-suggbtn',
                title: '点击填入输入框（由你手动点 ➤ 发送）',
                onClick: () => fillInput(s),
              }, s))) : null,
            h('div', { className: 'hp-composer' + (dropHover ? ' hp-drop' : '') },
              h('textarea', {
                ref: taRef,
                className: 'hp-compose-input',
                'aria-label': '对话输入',
                placeholder: stage === 'idle' ? '直接说需求（如：帮我做项目进度汇报）——我会一次一个问题问清需求，直到 95% 把握再生成' : stage === 'done' || stage === 'archived' ? '修改指令、调整需求重新生成，或「推翻重来」/「导出」' : '出大纲 / 换风格 / 直接生成 / 推翻重来 / 导出，随时说；也可以直接聊',
                value: input,
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUser(input); } },
              }),
              /* 工具条结构 = 知识库/政策解读同款：左附件 + 模型选择 + 右圆形渐变发送 */
              h('div', { className: 'hp-compose-bar' },
                h('button', {
                  type: 'button', className: 'hp-compose-btn', title: '上传材料（后端解析正文）', 'aria-label': '上传材料',
                  onClick: () => fileRef.current && fileRef.current.click(),
                }, '+'),
                h('input', { ref: fileRef, type: 'file', style: { display: 'none' }, onChange: onPickFile, 'aria-hidden': true, tabIndex: -1 }),
                h('span', { className: 'hp-compose-atwrap', ref: atRef },
                  h('button', {
                    type: 'button', className: 'hp-compose-btn', title: '引用文件（@ 项目主题/材料/模板/大纲）', 'aria-label': '引用文件',
                    'aria-expanded': atOpen ? 'true' : 'false',
                    onClick: () => setAtOpen((v) => !v),
                  }, '@'),
                  atOpen ? h('div', { className: 'hp-atbox' },
                    atRefs().length
                      ? atRefs().map((r) => h('button', {
                        key: r.key, type: 'button', className: 'hp-atitem', onClick: () => pickRef(r.label),
                      }, h('span', null, '@' + r.label), h('em', null, r.hint)))
                      : h('div', { className: 'hp-atempty' }, '暂无可引用内容：先用 + 上传材料，或先聊出项目主题/大纲')) : null),
                h('span', { className: 'hp-compose-gap' }),
                models.length ? h('select', {
                  className: 'hp-compose-model',
                  value: modelId, onChange: (e) => setModelId(e.target.value),
                  title: '对话模型（真实模式按项目记忆；含 DSH 同步模型）', 'aria-label': '对话模型',
                }, (() => {
                  const groups = [];
                  for (const m of models) {
                    const g = m.group || '';
                    let b = groups.find((x) => x.g === g);
                    if (!b) { b = { g, items: [] }; groups.push(b); }
                    b.items.push(m);
                  }
                  const opt = (m) => h('option', { key: m.id, value: m.id }, m.label + (m.online === false ? '（离线）' : ''));
                  return groups.map((b, i) => b.g
                    ? h('optgroup', { key: b.g || String(i), label: b.g }, b.items.map(opt))
                    : b.items.map(opt));
                })()) : null,
                h('button', {
                  type: 'button', className: 'hp-compose-send', title: '发送', 'aria-label': '发送',
                  disabled: !input.trim(), onClick: () => sendUser(input),
                }, '➤')))),
          h('input', { ref: tplRef, type: 'file', accept: '.pptx,.potx,.ppt', style: { display: 'none' }, onChange: onPickTemplate, 'aria-hidden': true, tabIndex: -1 }),
          h('div', {
            className: 'hp-chat-resize' + (dragging ? ' on' : ''), role: 'separator', 'aria-orientation': 'vertical',
            title: '拖拽调整对话栏宽度',
            onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp, onPointerCancel: onResizeUp,
          })),
        /* ── 右：演化工作区 ── */
        h('div', { className: 'hp-stage-pane' + (isCanvasStage ? ' tight' : '') },
          isCanvasStage ? (isReal && ctx.renders && ctx.renders.length ? paneRenders() : paneCanvas) : pane));
    }

    /* ════════ 视图四：画布页 ════════ */
    const KIND_LABEL = { sp: '形状', pic: '图片', graphicFrame: '表格/图表', cxnSp: '连接线', grpSp: '组合' };
    const clone = (o) => JSON.parse(JSON.stringify(o));

    function CanvasView({ data, project, onToast, apiRef, initialVersion, initialSha }) {
      const [slide, setSlide] = useState(1);
      const [objs, setObjs] = useState(() => clone(data.canvas));
      const [sel, setSel] = useState(null);
      const [zoom, setZoom] = useState(0.75);
      const [ops, setOps] = useState([]);
      const [redoStack, setRedoStack] = useState([]);
      const [version, setVersion] = useState(initialVersion || 'v0003');
      const [sha, setSha] = useState(initialSha || 'a3f8c2e1…9d04');
      const [tab, setTab] = useState('props');
      const [queueOpen, setQueueOpen] = useState(false);
      const [applyOpen, setApplyOpen] = useState(false);
      const [compareOpen, setCompareOpen] = useState(false);
      const [annotations, setAnnotations] = useState([
        { id: 'an-1', slide: 4, type: '框选', text: '第三步「交接」节点建议与右侧输出对齐', version: 'v0003', sha: 'a3f8c2e1…9d04' },
      ]);
      const [noteForm, setNoteForm] = useState({ type: '框选', text: '' });
      const [fields, setFields] = useState({});
      const opSeq = useRef(1);
      const dragRef = useRef(null);
      const outerRef = useRef(null);

      const list = objs[String(slide)] || [];
      const page = SLIDE_PAGES.find((p) => p.n === slide);
      const pageLayout = data.layouts.find((l) => l.id === (page && page.layout)) || null;
      const selObj = list.find((o) => o.shape_id === sel) || null;
      const overlay = list.filter((o) => !(o.w >= 1200 && o.h >= 700)); // 整页位图不作为可编辑对象

      const findObj = (sl, id) => (objs[String(sl)] || []).find((o) => o.shape_id === id);
      const updateObj = (sl, id, patch) => setObjs((prev) => ({
        ...prev,
        [String(sl)]: (prev[String(sl)] || []).map((o) => (o.shape_id === id ? { ...o, ...patch } : o)),
      }));
      const pushOp = (op) => { setOps((prev) => [...prev, { ...op, id: 'op-' + (opSeq.current++) }]); setRedoStack([]); };
      const applyOpVals = (op, dir) => {
        const v = op[dir];
        if (!v) return;
        if (op.op === 'geometry') updateObj(op.slide, op.shape_id, { x: v.x, y: v.y, w: v.w, h: v.h });
        else if (op.op === 'text') updateObj(op.slide, op.shape_id, { text: v.text });
      };
      const undo = () => {
        const last = ops[ops.length - 1];
        if (!last) return;
        applyOpVals(last, 'prev');
        setOps(ops.slice(0, -1));
        setRedoStack([...redoStack, last]);
      };
      const redo = () => {
        const last = redoStack[redoStack.length - 1];
        if (!last) return;
        applyOpVals(last, 'next');
        setRedoStack(redoStack.slice(0, -1));
        setOps([...ops, last]);
      };
      const removeOp = (id) => {
        const op = ops.find((o) => o.id === id);
        if (op) applyOpVals(op, 'prev');
        setOps(ops.filter((o) => o.id !== id));
      };

      /* ── 拖拽（指针事件 + 缩放换算；位移进入待应用队列） ── */
      const onObjPointerDown = (e, o) => {
        e.preventDefault(); e.stopPropagation();
        setSel(o.shape_id);
        if (o.locked) { onToast('「' + o.name + '」为组合/旋转对象：已在画布锁定，请在 WPS 中处理后重新载入'); return; }
        if (!o.editable_geometry) return;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
        dragRef.current = { id: o.shape_id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false };
      };
      const onObjPointerMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = (e.clientX - d.sx) / zoom, dy = (e.clientY - d.sy) / zoom;
        if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        d.moved = true;
        updateObj(slide, d.id, { x: Math.round((d.ox + dx) * 10) / 10, y: Math.round((d.oy + dy) * 10) / 10 });
      };
      const onObjPointerUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d && d.moved) {
          const o = findObj(slide, d.id);
          if (o) pushOp({ slide, shape_id: d.id, op: 'geometry', prev: { x: d.ox, y: d.oy, w: o.w, h: o.h }, next: { x: o.x, y: o.y, w: o.w, h: o.h }, label: '移动「' + o.name + '」→ (' + o.x + ', ' + o.y + ')' });
        }
      };

      /* ── 属性面板编辑提交 ── */
      const commitGeom = (o, key, raw) => {
        const v = parseFloat(raw);
        if (isNaN(v) || v === o[key]) return;
        const next = { x: o.x, y: o.y, w: o.w, h: o.h, [key]: v };
        pushOp({ slide, shape_id: o.shape_id, op: 'geometry', prev: { x: o.x, y: o.y, w: o.w, h: o.h }, next, label: '调整「' + o.name + '」' + ({ x: 'X', y: 'Y', w: '宽', h: '高' })[key] + ' = ' + v });
        updateObj(slide, o.shape_id, { [key]: v });
      };
      const commitText = (o, raw) => {
        const v = String(raw || '');
        if (v === (o.text || '')) return;
        pushOp({ slide, shape_id: o.shape_id, op: 'text', prev: { text: o.text || '' }, next: { text: v }, label: '修改「' + o.name + '」文字' });
        updateObj(slide, o.shape_id, { text: v });
      };
      const commitFields = () => {
        const vals = fields[slide] || {};
        const filled = Object.keys(vals).filter((k) => String(vals[k] || '').trim());
        if (!filled.length) { onToast('请先填写字段'); return; }
        pushOp({ slide, shape_id: null, op: 'fields', prev: null, next: clone(vals), label: '填充字段（第 ' + slide + ' 页 · ' + filled.length + ' 项）' });
        onToast('字段修改已写入待应用队列');
      };

      /* ── 对话指令注入（双通道：对话修改直达画布待应用队列） ── */
      useEffect(() => {
        if (!apiRef) return undefined;
        apiRef.current = {
          /* 在指定页找可编辑文字对象并提交修改；返回对象名或 null */
          applyTextEdit(slideN, matcher, text) {
            const listNow = objs[String(slideN)] || [];
            const target = listNow.find((o) => !o.locked && o.editable_text && matcher(o));
            if (!target) return null;
            commitText(target, text);
            return target.name;
          },
          getVersion() { return version; },
          getSha() { return sha; },
          getPendingOps() { return ops.length; },
        };
        return () => { if (apiRef) apiRef.current = null; };
      });

      /* ── 应用修订 / 渲染 / 导出（模拟） ── */
      const doApply = () => {
        setApplyOpen(false);
        const nv = 'v' + String(parseInt(version.slice(1), 10) + 1).padStart(4, '0');
        setVersion(nv); setSha('c41d88ab…' + String(Math.floor(Math.random() * 9000) + 1000));
        setOps([]); setRedoStack([]); setQueueOpen(false);
        onToast('已校验 SHA256 并生成新版本 ' + nv + '，重新渲染完成（演示）');
      };
      const fitZoom = () => {
        const el = outerRef.current;
        if (!el) return;
        const z = Math.min((el.clientWidth - 80) / 1280, (el.clientHeight - 76) / 720);
        setZoom(Math.max(0.25, Math.min(2, Math.round(z * 100) / 100)));
      };

      const zoomBtn = (z, label) => h('button', {
        key: label, type: 'button', className: 'hp-btn sm' + (zoom === z ? ' pri' : ''),
        onClick: () => setZoom(z), style: { minWidth: 44 },
      }, label);

      /* ── 右侧面板 ── */
      const panelProps = selObj
        ? h('div', null,
            h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
              h('b', null, selObj.name),
              h('span', { className: 'hp-tid' }, '#' + selObj.shape_id)),
            h('div', { className: 'hp-row', style: { gap: 6, marginBottom: 12 } },
              h(Chip, null, KIND_LABEL[selObj.kind] || selObj.kind),
              selObj.locked ? h(Badge, { tone: 'lock' }, '🔒 已锁定') : null,
              !selObj.locked && selObj.editable_text ? h(Badge, { tone: 'ok' }, '文字可编辑') : null,
              !selObj.locked && selObj.editable_geometry ? h(Badge, { tone: 'ok' }, '几何可编辑') : null),
            selObj.locked ? h('div', { className: 'hp-note warn', style: { marginBottom: 12 } },
              h('span', null, '🔒'),
              h('span', null, '组合 / 旋转 / 继承位置不明确的对象在画布锁定；建议在 WPS 中处理后用「导入外部修订」重新载入。')) : null,
            !selObj.locked && selObj.editable_text ? h('div', { style: { marginBottom: 12 } },
              h('label', { className: 'hp-label' }, '文字内容（失焦提交并写入队列）'),
              h('textarea', {
                className: 'hp-textarea', key: 't-' + selObj.shape_id, defaultValue: selObj.text || '',
                placeholder: '（空）', onBlur: (e) => commitText(selObj, e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur(); },
              })) : null,
            !selObj.locked && selObj.editable_geometry ? h('div', null,
              h('label', { className: 'hp-label' }, '几何（1280×720 逻辑坐标 · 96 DPI）'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                ['x', 'y', 'w', 'h'].map((k) => h('div', { key: k },
                  h('label', { className: 'hp-label', style: { marginBottom: 4 } }, { x: 'X', y: 'Y', w: '宽度', h: '高度' }[k]),
                  h('input', {
                    className: 'hp-input', key: k + '-' + selObj.shape_id, type: 'number', step: 1, defaultValue: selObj[k],
                    onBlur: (e) => commitGeom(selObj, k, e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
                  }))))) : null)
        : h(EmptyHint, { icon: '👆', text: '在画布中点击对象查看属性；拖拽可直接移动（自动写入待应用队列）' });

      const fieldVals = fields[slide] || {};
      const panelFields = pageLayout
        ? h('div', null,
            h('div', { className: 'hp-note', style: { marginBottom: 12 } },
              h('span', null, 'ⓘ'),
              h('span', null, '当前页版式：', h('b', null, pageLayout.name), '（', pageLayout.id, '），必填字段 ', pageLayout.required_fields.length, ' 项。')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              pageLayout.required_fields.map((f) => h('div', { key: f },
                h('label', { className: 'hp-label', style: { marginBottom: 4 } }, f),
                h('input', {
                  className: 'hp-input', value: fieldVals[f] || '',
                  placeholder: '填写「' + f + '」',
                  onChange: (e) => setFields({ ...fields, [slide]: { ...fieldVals, [f]: e.target.value } }),
                })))),
            h(Btn, { kind: 'pri', sm: true, style: { marginTop: 12 }, onClick: commitFields }, '写入待应用队列'))
        : h(EmptyHint, { icon: '🧩', text: '当前页未关联版式' });

      const panelAssets = pageLayout
        ? h('div', null,
            h('div', { className: 'hp-label' }, '本页配套素材（' + pageLayout.asset_ids.length + '）'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 } },
              pageLayout.asset_ids.length ? pageLayout.asset_ids.map((aid) => {
                const a = data.assets.find((x) => x.id === aid);
                if (!a) return h(Chip, { key: aid }, aid);
                return h('div', { key: aid, className: 'hp-card', style: { padding: 8, display: 'flex', alignItems: 'center', gap: 10 } },
                  h('span', { style: { width: 34, height: 34, borderRadius: 8, background: 'var(--hp-accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 'none' } },
                    h('img', { src: img(a.file), alt: a.name, style: { maxWidth: 26, maxHeight: 26 } })),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, a.name),
                    h('div', { className: 'hp-tid' }, a.id)),
                  h(Btn, { sm: true, onClick: () => onToast('已把「' + a.name + '」插入第 ' + slide + ' 页（演示）') }, '插入'));
              }) : h('div', { className: 'hp-sub' }, '本页版式无配套素材')) ,
            h('div', { className: 'hp-label' }, '分支素材库'),
            h('div', { className: 'hp-row', style: { gap: 6 } },
              data.assets.filter((a) => a.family === pageLayout.family).slice(0, 12).map((a) =>
                h('button', {
                  key: a.id, type: 'button', className: 'hp-btn sm', title: a.usage,
                  onClick: () => onToast('已把「' + a.name + '」插入第 ' + slide + ' 页（演示）'),
                }, a.name))) )
        : h(EmptyHint, { icon: '🎨', text: '当前页未关联版式素材' });

      const slideNotes = annotations.filter((a) => a.slide === slide);
      const panelNotes = h('div', null,
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
          h('select', { className: 'hp-select', style: { width: 96 }, value: noteForm.type, onChange: (e) => setNoteForm({ ...noteForm, type: e.target.value }) },
            ['框选', '箭头', '文字'].map((tt) => h('option', { key: tt }, tt))),
          h('input', {
            className: 'hp-input', placeholder: '批注内容…', value: noteForm.text,
            onChange: (e) => setNoteForm({ ...noteForm, text: e.target.value }),
            onKeyDown: (e) => { if (e.key === 'Enter' && noteForm.text.trim()) addNote(); },
          }),
          h(Btn, { kind: 'pri', sm: true, disabled: !noteForm.text.trim(), onClick: () => addNote() }, '添加')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          slideNotes.length ? slideNotes.map((a) => h('div', { key: a.id, className: 'hp-card', style: { padding: '8px 10px' } },
            h('div', { className: 'hp-row', style: { gap: 6, marginBottom: 4 } },
              h(Chip, null, a.type),
              h('span', { className: 'hp-tid' }, a.version + ' · ' + a.sha),
              h('span', { style: { flex: 1 } }),
              h(Btn, { kind: 'ghost', sm: true, onClick: () => setAnnotations(annotations.filter((x) => x.id !== a.id)) }, '删除')),
            h('div', { style: { fontSize: 13 } }, a.text)))
            : h('div', { className: 'hp-sub' }, '本页暂无批注；批注保存后显示对应版本与 SHA256，供对话侧生成修改计划。')));
      const addNote = () => {
        const t = noteForm.text.trim();
        if (!t) return;
        setAnnotations([...annotations, { id: 'an-' + Date.now(), slide, type: noteForm.type, text: t, version, sha }]);
        setNoteForm({ ...noteForm, text: '' });
        onToast('批注已保存（' + version + '）');
      };

      /* ── 渲染 ── */
      return h('div', { className: 'hp-cv' },
        /* 顶部工具栏 */
        h('div', { className: 'hp-cv-toolbar' },
          h(Btn, { sm: true, onClick: () => onToast('画布状态已保存（演示）') }, '💾 保存'),
          h(Btn, { sm: true, disabled: !ops.length, onClick: undo, title: '撤销上一操作' }, '↩ 撤销'),
          h(Btn, { sm: true, disabled: !redoStack.length, onClick: redo, title: '重做' }, '↪ 重做'),
          h('span', { className: 'hp-cv-sep' }),
          h(Btn, { sm: true, onClick: () => onToast('渲染任务已创建：WPS 12.0.19025（演示）') }, '🖥 渲染'),
          h(Btn, { sm: true, onClick: () => setCompareOpen(true) }, '⇄ 对比'),
          h('span', { className: 'hp-cv-sep' }),
          h(Btn, { kind: 'pri', sm: true, disabled: !ops.length, onClick: () => setApplyOpen(true) },
            '✓ 应用修订' + (ops.length ? '（' + ops.length + '）' : '')),
          h(Btn, { sm: true, onClick: () => onToast('已导出 output/deck-' + version + '.pptx（演示）') }, '⬇ 导出'),
          h('span', { style: { flex: 1 } }),
          h('span', { className: 'hp-tid', style: { marginRight: 4 } }, '缩放'),
          zoomBtn(0.5, '50%'), zoomBtn(0.75, '75%'), zoomBtn(1, '100%'), zoomBtn(1.5, '150%'), zoomBtn(2, '200%'),
          h(Btn, { sm: true, onClick: fitZoom }, '适应窗口')),

        /* 中部三栏 */
        h('div', { className: 'hp-cv-body' },
          /* 左：页面缩略图 */
          h('div', { className: 'hp-cv-left' },
            SLIDE_PAGES.map((p) => h('button', {
              key: p.n, type: 'button', className: 'hp-cv-thumb' + (slide === p.n ? ' on' : ''),
              onClick: () => { setSlide(p.n); setSel(null); },
            },
              h('img', { src: img(p.preview), alt: '第 ' + p.n + ' 页', loading: 'lazy' }),
              h('div', { style: { padding: '5px 8px', fontSize: 11 } },
                h('div', { className: 'hp-row', style: { gap: 4, justifyContent: 'space-between' } },
                  h('b', null, 'P' + p.n),
                  h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: p.status === 'rendered' ? 'var(--hp-accent)' : 'var(--hp-amber)' }, title: p.status === 'rendered' ? '已渲染' : '待视觉检查' })),
                h('div', { className: 'hp-tid', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.label)))),
            h('div', { className: 'hp-note', style: { padding: 8, fontSize: 11 } }, '演示项目共 12 页，此处加载 4 页样例')),

          /* 中：舞台 */
          h('div', { className: 'hp-cv-outer', ref: outerRef, onClick: (e) => { if (e.target === e.currentTarget) setSel(null); } },
            h('div', { style: { width: 1280 * zoom, height: 720 * zoom, flex: 'none', position: 'relative' } },
              h('div', { className: 'hp-stage', style: { transform: 'scale(' + zoom + ')' } },
                h('img', { className: 'bg', src: img(page.preview), alt: '第 ' + slide + ' 页渲染结果', draggable: false }),
                overlay.map((o) => h('button', {
                  key: o.shape_id, type: 'button',
                  className: 'hp-obj' + (sel === o.shape_id ? ' on' : '') + (o.locked ? ' lock' : ''),
                  style: { left: o.x, top: o.y, width: o.w, height: o.h },
                  title: o.name + (o.locked ? '（已锁定）' : ''),
                  'aria-label': o.name,
                  onPointerDown: (e) => onObjPointerDown(e, o),
                  onPointerMove: onObjPointerMove,
                  onPointerUp: onObjPointerUp,
                  onClick: (e) => { e.stopPropagation(); setSel(o.shape_id); },
                },
                  h('span', { className: 'tag' }, (o.locked ? '🔒 ' : '') + o.name))))),
            queueOpen ? h('div', { className: 'hp-queue' },
              h('div', { className: 'hp-row', style: { justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1,#e2e8f0)' } },
                h('b', { style: { fontSize: 13 } }, '待应用操作（' + ops.length + '）'),
                h('div', { className: 'hp-row', style: { gap: 6 } },
                  h(Btn, { kind: 'ghost', sm: true, disabled: !ops.length, onClick: () => { ops.slice().reverse().forEach((op) => applyOpVals(op, 'prev')); setOps([]); } }, '全部撤销'),
                  h(Btn, { kind: 'ghost', sm: true, onClick: () => setQueueOpen(false) }, '收起'))),
              ops.length ? h('div', { style: { padding: '6px 8px' } },
                ops.map((op) => h('div', { key: op.id, className: 'hp-row', style: { justifyContent: 'space-between', padding: '6px 8px', borderRadius: 8 } },
                  h('span', { style: { fontSize: 12 } },
                    h('span', { className: 'hp-tid', style: { marginRight: 6 } }, op.id),
                    '第 ' + op.slide + ' 页 · ' + op.label),
                  h(Btn, { kind: 'ghost', sm: true, onClick: () => removeOp(op.id) }, '撤销'))))
                : h('div', { className: 'hp-empty', style: { padding: 20 } }, '队列为空；画布上的修改会先进入这里，点击「应用修订」才生成新版本')) : null),

          /* 右：属性/字段/素材/批注 */
          h('div', { className: 'hp-cv-right' },
            h('div', { className: 'hp-cv-tabs' },
              [['props', '属性'], ['fields', '字段'], ['assets', '素材'], ['notes', '批注' + (slideNotes.length ? ' ' + slideNotes.length : '')]].map(([k, label]) =>
                h('button', { key: k, type: 'button', className: 'hp-cv-tab' + (tab === k ? ' on' : ''), onClick: () => setTab(k) }, label))),
            h('div', { className: 'hp-cv-panel' },
              tab === 'props' ? panelProps : tab === 'fields' ? panelFields : tab === 'assets' ? panelAssets : panelNotes))),

        /* 底部状态栏 */
        h('div', { className: 'hp-statusbar' },
          h('span', null, h('b', null, project.title)),
          h('span', { className: 'hp-tid' }, '版本 ' + version),
          h('span', null, '引擎 WPS 12.0.19025'),
          h('span', { className: 'hp-mono' }, 'SHA256 ' + sha),
          h('span', null, '画布 1280×720 @96DPI'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', className: 'hp-btn sm' + (ops.length ? ' pri' : ''),
            onClick: () => setQueueOpen(!queueOpen),
          }, '未应用操作 ' + ops.length)),

        /* 应用修订确认 */
        applyOpen ? h(Modal, {
          title: '应用修订并生成新版本',
          sub: '将校验当前文件 SHA256、停止并发写入、生成新 PPTX 并重新渲染',
          onClose: () => setApplyOpen(false),
          footer: [
            h(Btn, { key: 'c', onClick: () => setApplyOpen(false) }, '取消'),
            h(Btn, { key: 'ok', kind: 'pri', onClick: doApply }, '确认应用（生成 ' + ('v' + String(parseInt(version.slice(1), 10) + 1).padStart(4, '0')) + '）'),
          ],
        },
          h('div', { className: 'hp-note warn', style: { marginBottom: 12 } },
            h('span', null, '⚠'),
            h('span', null, '本次将应用 ', h('b', null, ops.length), ' 项待应用操作，影响当前项目 ', h('b', null, SLIDE_PAGES.length), ' 个已加载页面；旧版本保留可回滚。')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' } },
            ops.map((op) => h('div', { key: op.id, className: 'hp-row', style: { gap: 8, fontSize: 12, padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-2,#f8fafc)', borderRadius: 8 } },
              h('span', { className: 'hp-tid' }, op.id),
              h('span', null, '第 ' + op.slide + ' 页 · ' + op.label))))) : null,

        /* 版本对比 */
        compareOpen ? h(Modal, {
          title: '版本对比', sub: 'v0002（上一版本） vs ' + version + '（当前）· 第 ' + slide + ' 页',
          onClose: () => setCompareOpen(false), width: 980,
        },
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } },
            h('div', null,
              h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
                h('b', null, 'v0002'), h(Badge, { tone: 'lock' }, '历史版本')),
              h('div', { style: { borderRadius: 10, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l1,#e2e8f0)' } },
                h('img', { src: img(page.preview), alt: 'v0002 渲染', style: { width: '100%', display: 'block', filter: 'grayscale(.35) opacity(.85)' } })),
              h('div', { className: 'hp-tid', style: { marginTop: 6 } }, 'SHA256 77be01cd…41aa')),
            h('div', null,
              h('div', { className: 'hp-row', style: { justifyContent: 'space-between', marginBottom: 8 } },
                h('b', null, version + '（当前）'), h(Badge, { tone: 'ok' }, ops.length ? '含 ' + ops.length + ' 项未应用修改' : '与画布一致')),
              h('div', { style: { position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--hp-accent-soft-border)' } },
                h('img', { src: img(page.preview), alt: '当前渲染', style: { width: '100%', display: 'block' } }),
                overlay.map((o) => h('span', {
                  key: o.shape_id,
                  style: {
                    position: 'absolute',
                    left: (o.x / 1280 * 100) + '%', top: (o.y / 720 * 100) + '%',
                    width: (o.w / 1280 * 100) + '%', height: (o.h / 720 * 100) + '%',
                    border: '1.5px solid ' + (o.locked ? 'rgba(100,116,139,.7)' : 'var(--hp-accent)'),
                    borderRadius: 2, pointerEvents: 'none',
                  },
                }))),
              h('div', { className: 'hp-tid', style: { marginTop: 6 } }, 'SHA256 ' + sha + ' · 对象边界实时叠加'))),
          h('div', { className: 'hp-note', style: { marginTop: 14 } },
            h('span', null, 'ⓘ'),
            h('span', null, '演示：差异视图标记当前对象边界；完整版本对比在阶段 C（渲染与验收）提供逐页像素差异。'))) : null);
    }

    /* ════════ 根组件：左侧导航 + 三视图常挂载切换 ════════ */
    /* 一级导航：归档项目 → 模板库 → 对话制作
     * v0.3.0：模板库从「归档项目」页头按钮移回一级入口，位置在「归档项目」与「对话制作」之间。 */
    const NAV_ITEMS = [
      { id: 'home', icon: '🗂', label: '归档项目', desc: '已完成的 PPT 项目归档于此' },
      { id: 'templates', icon: '🧩', label: '模板库', desc: '风格分支与版式检索 · 模板包管理' },
      { id: 'studio', icon: '💬', label: '对话制作', desc: '对话确认需求 → 生成 → 画布修订 → 导出归档' },
    ];
    /* 视图标题表（一级导航三项 + 移动端顶栏标题） */
    const VIEW_TITLES = { home: '归档项目', templates: '模板库', studio: '对话制作' };

    /* 「归档项目」的判定：服务端已归档，或已完成（导出即闭环）——二者都算完成归档 */
    const isArchivedCard = (p) => !!p.archived || p.status === 'archived' || p.status === 'done';


    /* ── 历史对话（侧栏二级目录）状态：置顶 / 删除为前端持久化覆盖层 ── */
    const CONV_OVERLAY_KEY = 'hp:huiwen-ppt:conv-overlay:v2';
    function readConvOverlay() {
      try {
        const raw = window.localStorage.getItem(CONV_OVERLAY_KEY);
        const j = raw ? JSON.parse(raw) : null;
        return j && typeof j === 'object' ? j : {};
      } catch (e) { return {}; }
    }
    function writeConvOverlay(v) {
      try { window.localStorage.setItem(CONV_OVERLAY_KEY, JSON.stringify(v)); } catch (e) { /* 无 storage 时仅内存态 */ }
    }
    function nowLabel() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function Workbench() {
      const [view, setView] = useState('home');
      const [data, setData] = useState(null);
      const [loadErr, setLoadErr] = useState(null);
      const [toast, setToast] = useState(null);
      const [reloadTick, setReloadTick] = useState(0);
      const [projects, setProjects] = useState(null);
      /* 后端连接状态：real = 真实后端已接通；mock = 后端不可用，回退演示数据（方案 §5.9 降级语义） */
      const [backend, setBackend] = useState(null);
      /* 移动端（≤760px）导航抽屉开合；宽屏该状态无副作用（CSS 只在窄屏生效、顶栏隐藏） */
      const [navOpen, setNavOpen] = useState(false);
      /* 对话制作二级目录：展开态 / 行内「更多操作」菜单 / 删除二次确认 */
      const [navSubOpen, setNavSubOpen] = useState(false);
      const [convMenuId, setConvMenuId] = useState(null);
      const [confirmDelId, setConfirmDelId] = useState(null);
      /* 当前打开的对话（nonce 变化才触发重载）+ 本会话新建的本地对话 + 置顶/删除覆盖层 */
      const [activeConv, setActiveConv] = useState(null);
      const [localConvs, setLocalConvs] = useState([]);
      const [convOverlay, setConvOverlay] = useState(() => readConvOverlay());

      useEffect(() => {
        let alive = true;
        fetch(API + '/api/data', { credentials: 'same-origin' })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((j) => {
            if (!alive) return;
            setData(j);
            setBackend({ mode: 'real', revision: j.index_revision });
            setProjects(j.projects || []);
          })
          .catch((e) => {
            /* 0.3.4.3：正式业务系统——后端不可达即如实报错，不再回退演示数据 */
            if (alive) setLoadErr('后端服务不可用（' + (e && e.message ? e.message : e) + '）——请确认汇文 PPT 后端已随 DSH 启动后刷新重试。');
          });
        return () => { alive = false; };
      }, [reloadTick]);

      const onToast = useCallback((msg) => setToast({ msg, key: Date.now() }), []);
      const onNav = useCallback((v) => { setView(v); setNavOpen(false); }, []);
      /* 对话页导出后项目闭环归档：提升到此处，项目首页归档区可见 */
      const onProjectArchived = useCallback((proj) => {
        setProjects((prev) => (prev ? [proj, ...prev] : [proj]));
      }, []);
      /* WF-01：从后端刷新真实项目列表（导入/重开/归档后调用） */
      const onReloadProjects = useCallback(async () => {
        try {
          const res = await fetch(API + '/api/projects', { credentials: 'same-origin' });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.ok && Array.isArray(j.projects)) setProjects(j.projects);
        } catch { /* 刷新失败保留现状 */ }
      }, []);

      /* ── 对话制作二级目录：历史对话列表 + 新建 / 打开 / 置顶 / 归档 / 删除 ── */
      const patchConvOverlay = useCallback((id, patch) => {
        setConvOverlay((prev) => {
          const next = { ...prev, [id]: { ...(prev[id] || {}), ...patch } };
          writeConvOverlay(next);
          return next;
        });
      }, []);
      /* 历史对话 = 真实后端项目（真实模式） ∪ 本会话新建对话 ∪ 演示兜底 */
      const convList = useMemo(() => {
        const realMode = !!(backend && backend.mode === 'real');
        const fromProjects = realMode
          ? (projects || []).filter((p) => !isArchivedCard(p))
              .map((p) => ({ id: p.id, title: p.title || '未命名对话', updated: p.updated || '', archived: false, real: true }))
          : [];
        const localPart = localConvs.map((c) => ({ ...c, real: false }));
        return fromProjects.concat(localPart)
          .filter((c) => !(convOverlay[c.id] && convOverlay[c.id].hidden))
          .map((c) => ({ ...c, pinned: !!(convOverlay[c.id] && convOverlay[c.id].pinned) }))
          .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updated || '').localeCompare(String(a.updated || '')));
      }, [projects, backend, convOverlay, localConvs]);
      /* 「归档项目」页只吃已完成/已归档的卡片（进行中已与历史对话合并，不再重复展示） */
      const archivedProjects = useMemo(() => (projects || [])
        .filter((p) => isArchivedCard(p))
        .filter((p) => !(convOverlay[p.id] && convOverlay[p.id].hidden))
        .map((p) => ({ ...p, pinned: !!(convOverlay[p.id] && convOverlay[p.id].pinned) }))
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updated || '').localeCompare(String(a.updated || ''))),
      [projects, convOverlay]);
      const onNewConversation = useCallback(async () => {
        const nonce = Date.now();
        const goStudio = () => { setView('studio'); setNavOpen(false); setNavSubOpen(true); setConvMenuId(null); setConfirmDelId(null); };
        /* 真实模式：新建对话 = 创建后端项目壳（WF-02），此后材料/对话/大纲/生成/导出均有 projectId 可用 */
        if (backend && backend.mode === 'real') {
          try {
            const res = await fetch(API + '/api/projects/new', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}), credentials: 'same-origin',
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
            setActiveConv({ nonce, id: j.project.id, title: '新对话', real: true, fresh: true });
            goStudio();
            if (onReloadProjects) onReloadProjects(); // 新项目由 /api/projects 列表自动出现，不重复登记 localConvs
            return;
          } catch (e) {
            onToast('新建项目失败：' + (e && e.message ? e.message : e) + '，本次改为本地对话（降级演示）');
          }
        }
        const id = 'local-' + nonce;
        setLocalConvs((prev) => [{ id, title: '新对话', updated: nowLabel(), stage: 'idle', msgs: [], ctx: null, archived: false }, ...prev]);
        setActiveConv({ nonce, id, title: '新对话', fresh: true });
        goStudio();
      }, [backend, onToast, onReloadProjects]);
      const onConvSync = useCallback((id, snap) => {
        setLocalConvs((prev) => {
          const i = prev.findIndex((c) => c.id === id);
          if (i < 0) return prev; /* 真实后端项目：不在本地登记 */
          const next = prev.slice();
          next[i] = { ...prev[i], title: snap.title || prev[i].title || '新对话', stage: snap.stage, msgs: snap.msgs, ctx: snap.ctx, updated: nowLabel() };
          return next;
        });
      }, []);
      const openConversation = useCallback((c) => {
        setConvMenuId(null); setConfirmDelId(null);
        setView('studio'); setNavOpen(false); setNavSubOpen(true);
        setActiveConv({ nonce: Date.now(), id: c.id, title: c.title, real: !!c.real, fresh: false, record: c.real ? null : c });
      }, []);
      const toggleConvPin = useCallback((c) => {
        patchConvOverlay(c.id, { pinned: !c.pinned });
        setConvMenuId(null); setConfirmDelId(null);
        onToast(!c.pinned ? '已置顶「' + c.title + '」' : '已取消置顶「' + c.title + '」');
      }, [patchConvOverlay, onToast]);
      const toggleConvArchive = useCallback(async (c) => {
        setConvMenuId(null); setConfirmDelId(null);
        if (c.real && backend && backend.mode === 'real') {
          try {
            const action = c.archived ? 'reopen' : 'archive';
            const res = await fetch(API + '/api/projects/' + encodeURIComponent(c.id) + '/' + action, { method: 'POST', credentials: 'same-origin' });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
            onToast(c.archived ? '已重新打开「' + c.title + '」' : '已归档「' + c.title + '」');
            if (onReloadProjects) onReloadProjects();
          } catch (e) { onToast((c.archived ? '重新打开' : '归档') + '失败：' + (e && e.message ? e.message : e)); }
          return;
        }
        setLocalConvs((prev) => prev.map((x) => (x.id === c.id ? { ...x, archived: !x.archived } : x)));
        onToast(c.archived ? '已重新打开「' + c.title + '」' : '已归档「' + c.title + '」');
      }, [backend, onToast, onReloadProjects]);
      const deleteConversation = useCallback((c) => {
        setConvMenuId(null); setConfirmDelId(null);
        setLocalConvs((prev) => prev.filter((x) => x.id !== c.id));
        patchConvOverlay(c.id, { hidden: true });
        if (activeConv && activeConv.id === c.id) setActiveConv(null);
        onToast('已删除对话「' + c.title + '」' + (c.real ? '（本地列表移除；服务器项目目录删除待后端接口）' : ''));
      }, [patchConvOverlay, onToast, activeConv]);
      /* 进入/离开对话制作时自动开合二级目录（点一级项仍可手动再折叠） */
      useEffect(() => { setNavSubOpen(view === 'studio'); }, [view]);

      return h('div', { className: 'hp-root' + (navOpen ? ' hp-nav-open' : '') },
        h('style', null, CSS_TEXT),
        /* ── 移动端顶栏（窄屏显示；☰ 开合汇文 PPT 导航抽屉） ── */
        h('div', { className: 'hp-topbar' },
          h('button', {
            type: 'button', className: 'hp-navtoggle',
            'aria-label': navOpen ? '收起汇文 PPT 导航' : '展开汇文 PPT 导航',
            'aria-expanded': navOpen ? 'true' : 'false',
            onClick: () => setNavOpen((v) => !v),
          }, navOpen ? '✕' : '☰'),
          h('span', { className: 'hp-topbar-title' },
            '🎬 ' + (VIEW_TITLES[view] || '汇文 PPT'))),
        navOpen ? h('button', {
          type: 'button', className: 'hp-navscrim',
          'aria-label': '关闭导航', tabIndex: -1,
          onClick: () => setNavOpen(false),
        }) : null,
        /* ── 左侧导航（窄屏为 off-canvas 抽屉） ── */
        h('nav', { className: 'hp-nav' + (navOpen ? ' open' : ''), 'aria-label': '汇文 PPT 导航' },
          h('div', { className: 'hp-brand' },
            h('div', { className: 'hp-row', style: { gap: 10 } },
              h('span', { style: { fontSize: 24 } }, '🎬'),
              h('div', null,
                h('div', { style: { fontSize: 15, fontWeight: 700 } }, '汇文 PPT'),
                h('div', { className: 'hp-tid' }, VERSION))),
            h('p', { className: 'hp-sub', style: { marginTop: 8, fontSize: 11 } }, '对话驱动的 PPT 快速生产')),
          h('div', { className: 'hp-navlist' },
            NAV_ITEMS.map((n) => {
              const isStudio = n.id === 'studio';
              const subOpen = isStudio && navSubOpen;
              return h('div', { key: n.id, className: 'hp-navblock' },
                h('button', {
                  type: 'button',
                  className: 'hp-navitem' + (view === n.id ? ' on' : ''),
                  'aria-expanded': isStudio ? (subOpen ? 'true' : 'false') : undefined,
                  onClick: () => {
                    const wasActive = view === n.id;
                    setView(n.id); setNavOpen(false);
                    if (isStudio) { setNavSubOpen(wasActive ? !navSubOpen : true); setConvMenuId(null); setConfirmDelId(null); }
                  }, title: n.desc,
                },
                  h('span', { className: 'ic' }, n.icon),
                  h('span', { style: { flex: 1 } }, n.label),
                  isStudio ? h('span', { className: 'hp-navcaret' + (subOpen ? ' open' : '') }, '▾') : null),
                subOpen ? h('div', { className: 'hp-navsub' },
                  h('button', {
                    type: 'button', className: 'hp-navnew',
                    title: '新建对话：清空当前对话，开始新的 PPT 需求',
                    onClick: onNewConversation,
                  }, h('span', null, '＋'), h('span', null, '新建对话')),
                  h('div', { className: 'hp-navseclabel' },
                    h('span', null, '历史对话'),
                    h('span', null, convList.length ? String(convList.length) + ' 个' : '')),
                  convList.length
                    ? h('div', { className: 'hp-navconvs' }, convList.map((c) => {
                        const menuOn = convMenuId === c.id;
                        const isOn = !!(activeConv && !activeConv.fresh && activeConv.id === c.id);
                        return h('div', { key: c.id, className: 'hp-navconv-item' },
                          h('div', { className: 'hp-navconv' + (isOn ? ' on' : '') },
                            h('button', {
                              type: 'button', className: 'hp-navconv-main',
                              title: c.title + (c.real ? '（真实项目）' : '（本会话）'),
                              onClick: () => openConversation(c),
                            },
                              h('span', { className: 'ttl' }, (c.pinned ? '📌 ' : '') + c.title),
                              h('span', { className: 'meta' }, (c.archived ? '已归档 · ' : '') + (c.real ? '项目 · ' : '本会话 · ') + (c.updated || ''))),
                            h('button', {
                              type: 'button', className: 'hp-navconv-more' + (menuOn ? ' on' : ''),
                              'aria-label': '更多操作', 'aria-expanded': menuOn ? 'true' : 'false',
                              title: '更多操作：置顶 / 归档 / 删除',
                              onClick: () => { setConvMenuId(menuOn ? null : c.id); setConfirmDelId(null); },
                            }, '⋯')),
                          menuOn ? h('div', { className: 'hp-navconv-menu', role: 'menu' },
                            h('button', { type: 'button', role: 'menuitem', onClick: () => toggleConvPin(c) }, c.pinned ? '📌 取消置顶' : '📌 置顶'),
                            h('button', { type: 'button', role: 'menuitem', onClick: () => toggleConvArchive(c) }, c.archived ? '↩ 重新打开' : '📦 归档'),
                            h('button', {
                              type: 'button', role: 'menuitem', className: 'danger',
                              onClick: () => {
                                if (confirmDelId === c.id) { deleteConversation(c); return; }
                                setConfirmDelId(c.id);
                                onToast('再点一次「⚠ 确认删除」即可删除「' + c.title + '」');
                              },
                            }, confirmDelId === c.id ? '⚠ 确认删除' : '🗑 删除')) : null);
                      }))
                    : h('div', { className: 'hp-navsub-empty' }, '还没有历史对话，点上面「＋ 新建对话」开始')) : null);
            })),
          h('div', { className: 'hp-navfoot' },
            backend && backend.mode === 'real'
              ? h('div', { className: 'hp-note', style: { padding: 8, fontSize: 11 } },
                  h('span', null, '🟢'),
                  h('span', null, '真实后端已连接 · 索引 ' + String(backend.revision || '').slice(0, 8)))
              : h('div', { className: 'hp-note warn', style: { padding: 8, fontSize: 11 } },
                  h('span', null, '🧪'),
                  h('span', null, backend ? '后端未连接 · 演示数据模式，不读写真实 PPT 文件' : '正在连接后端…')))),

        /* ── 主区 ── */
        h('main', { className: 'hp-main' },
          !data && !loadErr ? h('div', { className: 'hp-empty', style: { paddingTop: 120 } },
            h('div', { style: { fontSize: 30, marginBottom: 10 } }, '🎬'),
            h('div', null, '正在加载模板索引…')) : null,
          loadErr ? h('div', { className: 'hp-empty', style: { paddingTop: 120 } },
            h('div', { style: { fontSize: 30, marginBottom: 10 } }, '⚠️'),
            h('div', { style: { marginBottom: 12 } }, '模板索引加载失败：' + loadErr),
            h(Btn, { kind: 'pri', onClick: () => { setLoadErr(null); setReloadTick((t) => t + 1); } }, '重试')) : null,
          data && projects ? h('div', { style: { display: view === 'home' ? 'block' : 'none', height: '100%', overflow: 'hidden' } },
            h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
              h(ProjectHome, { data, projects: archivedProjects, onNav, onToast, backend, onReloadProjects, onNewConversation }))) : null,
          data ? h('div', { style: { display: view === 'studio' ? 'block' : 'none', height: '100%', overflow: 'hidden' } },
            h(ConversationStudio, {
              data, onNav, onToast, onProjectArchived, onReloadProjects,
              historyMode: !!(backend && backend.mode === 'real'),
              backend,
              activeConv,
              activeConvId: activeConv && activeConv.id ? activeConv.id : null,
              onConvSync,
              onRequestNewConversation: onNewConversation,
            })) : null,
          data ? h('div', { style: { display: view === 'templates' ? 'block' : 'none', height: '100%', overflow: 'hidden' } },
            h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
              h(TemplateLibrary, { data, onNav, onToast }))) : null),

        h(Toast, { toast, onDone: () => setToast(null) }));
    }

    /* ════════ 侧栏图标（stroke 走 currentColor，由 sidebar 决定激活配色） ════════ */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
        h('path', { d: 'M7 9h6M7 12.5h10' }),
        h('path', { d: 'M9 21h6M12 17v4' }));
    }

    /* ════════ 模块出口（骨架固定写法） ════════ */
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const cleanups = [];
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'huiwen-ppt: dicts');
        const t = ctx.locale.bind(NS);
        // keyed main：工作台选择 cap:huiwen-ppt 时渲染汇文 PPT 主面板
        cleanups.push(
          ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS }, Workbench)),
        );
        // 侧栏「工作台」分组行
        cleanups.push(
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS }, PanelIcon)),
        );
        // 打开事件桥（cappacks:open-huiwen-ppt）：工作台首页卡片「打开」/ 子菜单派发时切入主面板
        function onOpen(ev) {
          const detail = (ev && ev.detail) || {};
          const layout = ctx.layout || (ctx.get && ctx.get('layout'));
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
          void detail;
        }
        // 侧栏桥：返回主页 + 折叠/展开（与政策解读/会议助手同一约定）
        function isSidebarCollapsed() {
          try {
            if (typeof document === 'undefined') return true;
            const expandedBtn = document.querySelector('button[aria-label="收起侧边栏"], button[aria-label="Collapse sidebar"]');
            return !expandedBtn || Boolean(document.querySelector('[data-sidebar-collapsed]'));
          } catch { return true; }
        }
        function setSidebarCollapsed(layout, wantCollapsed) {
          if (!layout || typeof layout.toggleSidebar !== 'function') return;
          const isCollapsed = isSidebarCollapsed();
          if (isCollapsed !== wantCollapsed) layout.toggleSidebar();
        }
        function onSidebarBridge(ev) {
          const detail = (ev && ev.detail) || {};
          const layout = ctx.layout || (ctx.get && ctx.get('layout'));
          if (detail.home === true && layout && typeof layout.selectPanel === 'function') layout.selectPanel(null);
          if (typeof detail.collapse === 'boolean' || typeof detail.expand === 'boolean') {
            const want = detail.collapse === true ? true : false;
            setSidebarCollapsed(layout, want);
          }
        }
        window.addEventListener(OPEN_EVENT, onOpen);
        window.addEventListener(SIDEBAR_EVENT, onSidebarBridge);
        cleanups.push(() => window.removeEventListener(OPEN_EVENT, onOpen));
        cleanups.push(() => window.removeEventListener(SIDEBAR_EVENT, onSidebarBridge));
        return () => {
          for (const dispose of cleanups.reverse()) { try { if (typeof dispose === 'function') dispose(); } catch {} }
        };
      },
    };
  },
});
