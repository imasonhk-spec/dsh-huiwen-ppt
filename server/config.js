/**
 * 汇文 PPT 后端 · 配置（server/config.js）
 * 默认指向当前工作区；huiwen-data/config.json 可覆盖。
 * 单用户本地部署，路径默认值即本机约定；换机时改 config.json。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, nowIso } from './util.js';

export const DEFAULTS = {
  schema: 1,
  created_at: null,
  dataDir: '/home/lgsj/Downloads/PPT Agent/huiwen-data',
  skillDir: '/home/lgsj/Downloads/PPT Agent/extracted/huiwen-ppt',
  python: 'python3',
  render: {
    engine: 'libreoffice',
    width: 1280,
    height: 720,
    dpi: 96,
    timeoutMs: 180000,
  },
  ollama: {
    base: 'http://127.0.0.1:11434',
    chatTimeoutMs: 240000,
    // 模型选择框数据源（可在此追加）；label 用用户可见名，tag 为本地 Ollama 模型 tag
    models: [
      { id: 'gufo-huiwen-luna', label: 'Gufo-huiwen-luna', tag: 'huiwen-luna:latest', desc: '36B 全能：视觉 / 工具 / 思考' },
      { id: 'gufo-huiwen-2-argon', label: 'Gufo-huiwen-2-Argon', tag: 'huiwen-2-agron:latest', desc: '记忆融合模型：回答自然简洁' },
    ],
    defaultModelId: 'gufo-huiwen-luna',
  },
  limits: {
    uploadMaxBytes: 200 * 1024 * 1024,
    pagesMax: 32,
  },
};

let CONFIG = null;

/** 初始化：建目录树 + 读/建 config.json */
export async function initConfig() {
  fs.mkdirSync(DEFAULTS.dataDir, { recursive: true });
  const cfgPath = path.join(DEFAULTS.dataDir, 'config.json');
  let user = {};
  if (fs.existsSync(cfgPath)) {
    user = await readJson(cfgPath, {}) || {};
  }
  CONFIG = deepMerge(structuredClone(DEFAULTS), user);
  CONFIG.created_at = user.created_at || nowIso();
  if (!fs.existsSync(cfgPath)) await writeJson(cfgPath, CONFIG);
  return CONFIG;
}

export function config() {
  if (!CONFIG) throw new Error('config 未初始化');
  return CONFIG;
}

export async function updateConfig(patch) {
  const cfgPath = path.join(config().dataDir, 'config.json');
  CONFIG = deepMerge(structuredClone(CONFIG), patch || {});
  await writeJson(cfgPath, CONFIG);
  return CONFIG;
}

export function subdir(...parts) {
  const p = path.join(config().dataDir, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}
