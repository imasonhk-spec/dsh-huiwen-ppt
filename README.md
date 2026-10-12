# 汇文 PPT（@local/huiwen-ppt）

huiwen-ppt skill 的 DSH 工作台插件 **UI 原型**（阶段 A 前置：界面与交互验证）。

- **纯前端原型**：全部数据为演示数据（`assets/mock-data.json`，由 huiwen-ppt skill 的真实模板目录、
  版式与对象边界提取）；生成 / 渲染 / 导出 / 应用修订均为模拟反馈，不读写真实 PPT 文件。
- **能力包契约**（CAPABILITY-PACK-API v1.0）：工作台首页出现「汇文 PPT 🎬」卡片，
  点击经 `cappacks:open-huiwen-ppt` 打开主面板。
- **四个视图**：项目首页 / 模板库（筛选 + 详情抽屉 + 版式比较）/ 新建项目向导（9 步）/
  画布页（对象选中、拖拽、属性编辑、待应用队列、版本对比、批注）。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：能力包清单注册 + `/api/huiwen-ppt/assets/...` 静态预览路由（只读，认证门禁同政策解读） |
| `client.js` | Client 半：无构建、无 JSX、全部 `React.createElement`；hp-* 样式前缀；DSH 设计令牌深浅主题联动 |
| `assets/previews/` | 模板预览 PNG/SVG（取自 skill 的 clean-business / style-library 分支） |
| `assets/mock-data.json` | 版式 / 素材 / 画布对象边界 / 模拟项目数据 |

## 界面风格

与会议助手、政策解读一致：中性浅色工作台 UI + DSH 设计令牌（`--dsw-alias-*`）深浅主题联动；
模板预览区完整保留模板自身的绿色视觉体系（绿色简洁商务 `#086440` / 绿色办公插画）。

## 后续阶段（见《huiwen-ppt → dsh 本地插件改造方案》）

- 阶段 A：真实模板索引 + studio.py 本地 API；
- 阶段 B：brief/plan 真实生成与模板页复制；
- 阶段 C：WPS/PowerPoint/LibreOffice 渲染适配与验收；
- 阶段 D：画布修订真实回写与 SHA256 并发保护；
- 阶段 E：模板学习与知识治理。

## 发行件

`dist/dsh-huiwen-ppt-0.3.5.tgz` —— 确定性构建（校验见 [dist/CHECKSUMS.md](dist/CHECKSUMS.md)）。

## 版本

| 版本 | 内容 |
| --- | --- |
| 0.3.5 | 首发 = 8.6 多用户网关（192.168.8.6:3082）宿主 profile 线上活副本快照（2026-10-13） |

## 部署

宿主 profile `~/.dsh/profiles/web` 的 `dsh.profile.bundles` 需含 `@local/huiwen-ppt`；
能力包入口见 `package.json` 的 `dsh.capabilityPack`（`cap:huiwen-ppt`，order 20）。

## 脱敏口径

源码中**注释/文档**里的家目录路径以 `<HOME_PATH>` 占位；**代码里的运行时默认值**
（如 `server/config.js` 的 `dataDir` / `skillDir`）保留原始绝对路径，以保证
`pnpm add <git-url>` / `file:` 安装后行为与 8.6 线上一致。
`dist/` 中的发行 tgz 为线上原样字节，可直接安装。
