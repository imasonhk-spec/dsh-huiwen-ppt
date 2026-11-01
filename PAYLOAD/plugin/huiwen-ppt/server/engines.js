/**
 * 汇文 PPT 后端 · 引擎探测（server/engines.js）
 * 方案 §4.2：所有报告标记实际引擎与版本；引擎未执行时状态为“未验证”。
 */

import { config } from './config.js';
import { runCmd } from './util.js';
import { libreOfficeVersion } from './render.js';
import { listOllamaModels } from './llm.js';
import { windowsHealth } from './windows-render.js';

let CACHED = null;
let CACHED_AT = 0;

/** 引擎能力矩阵（60s 进程内缓存） */
export async function engineMatrix(force = false) {
  if (!force && CACHED && Date.now() - CACHED_AT < 60000) return CACHED;
  const cfg = config();
  const [py, lo, ollama] = await Promise.all([
    runCmd(cfg.python, ['--version'], { timeoutMs: 10000 }),
    libreOfficeVersion(),
    listOllamaModels().catch(() => null),
  ]);
  const pyVer = ((py.stdout || py.stderr || '').match(/Python\s+([\d.]+)/) || [])[1] || null;
  const windows=await windowsHealth();
  const matrix = {
    probed_at: new Date().toISOString(),
    structural: {
      engine: 'studio.py (python stdlib OOXML)',
      available: Boolean(pyVer),
      version: pyVer,
      note: 'inspect / register / build / patch 均由 studio.py 完成',
    },
    render: {
      libreoffice: { available: Boolean(lo), version: lo, role: '服务器内预览渲染（PNG）' },
      wps: { ...windows.wps, reason:windows.reason || null, role:'Windows 远端渲染',verified:false },
      powerpoint: { ...windows.powerpoint, reason:windows.reason || null, role:'Windows 远端渲染',verified:false },
    },
    llm: {
      available: Boolean(ollama),
      base: cfg.ollama.base,
      models: (cfg.ollama.models || []).map((m) => ({
        ...m,
        online: Boolean(ollama && (ollama.models || []).some((t) => t.name === m.tag)),
      })),
    },
    summary: 'libreoffice=' + (lo ? '可用 ' + lo : '不可用') + '；wps=人工验收；llm=' + (ollama ? '在线' : '离线'),
  };
  CACHED = matrix;
  CACHED_AT = Date.now();
  return matrix;
}
