# AI HUB 可编辑扩展使用指南

> 当前模板：插画 v3 / 14 页，商务 v4 / 41 页。商务通用 1–13、参考构图 14–21、AI HUB 22–41；包内页码分别为 1–8 和 1–20。以当前 manifest、layout-index 与预览为准。


属于 `green-clean-business` 分支，不是第三套独立风格。新增 20 页已经追加到主参考 22–41 页；`clean-aihub-NN` 对应主文件 `21+NN`，独立包 `ai-hub-editable.pptx` 对应 `NN`。`studio.py build` 复用稳定登记 ID `14-3314ab34ee` 时必须使用主文件页码。不要把扩展包第 5 页当作主文件第 5 页。

先在 `catalog.json` 根据关系类型、名称和标签选布局，再读取 `layout-index.json` 的实际对象 ID、坐标和预览。可将同一主风格内的标题、表格、节点、流程、时间条和素材按内容关系组合。不要把封面、结束页以及带业务案例的页面机械整套复制到新任务。

源页 2–14、19 的主体由位图重建，源页 1、15–18、20 保留原生结构。图表型百分比为可编辑 KPI 文字，不伪称其为带工作簿的统计图；第 2 页是原生表格；架构与流程是原生形状和连接线。人物、原始城市背景、品牌与场景插画保留位图，图内品牌和小标签不能逐字编辑。未恢复原稿动画或位图中的原始层级。

默认字体沿用微软雅黑；原生保留页包含少量 Calibri 的西文继承，旧商务主文件包含少量 Aptos。新任务沿用当前页面真实样式，按内容容量先调整行数和分区，再拆页，不能持续缩小字号。保持背景在底层，连接线在节点边缘可见，不穿越正文；生成后必须 WPS 渲染并核对。

调研指标 70.3%、59.5%、43.2%、24.3%、67.6%、75.7%、54.1%，源页计划日期、42 项任务、12 个阶段以及技术能力和竞品判断均是来源示例。它们不进入已确认业务知识，也不能自动用于其他比赛或客户材料。复用时使用本任务的事实、来源与日期。

以下主文件映射为当前 v4；8 页参考包对应主文件 14–21，20 页 AI HUB 包对应 22–41。

| 当前主文件页码 | 稳定版式 ID | 版式 |
| --- | --- | --- |
| 1 | clean-cover | 主题封面 |
| 2 | clean-needs | 需求与服务映射 |
| 3 | clean-capabilities | 五项能力总览 |
| 4 | clean-flow | 四步流程与交接 |
| 5 | clean-architecture | 协作架构与责任 |
| 6 | clean-hub | 平台与服务生态 |
| 7 | clean-comparison | 方案条件对照 |
| 8 | clean-metrics | 指标对照与解释 |
| 9 | clean-case | 案例机制与证据 |
| 10 | clean-roadmap | 阶段计划与验收 |
| 11 | clean-governance | 运行规则与异常处理 |
| 12 | clean-icons | 线性图标素材页 |
| 13 | clean-closing | 讨论与决策事项 |
| 14 | clean-reference-01 | 三支柱责任与数据协同 |
| 15 | clean-reference-02 | 授权数据到 Agent 广场 |
| 16 | clean-reference-03 | A2A 协作机制与五步确认 |
| 17 | clean-reference-04 | 社群入口与交流协作 |
| 18 | clean-reference-05 | 企业难点到平台服务映射 |
| 19 | clean-reference-06 | 企业专属 Agent 中心 |
| 20 | clean-reference-07 | 政企双侧通道与结果回写 |
| 21 | clean-reference-08 | 三项判断与指标占位 |
| 22 | clean-aihub-01 | 主题封面 |
| 23 | clean-aihub-02 | 调研覆盖与建设准备 |
| 24 | clean-aihub-03 | 三项判断与七项指标 |
| 25 | clean-aihub-04 | 企业专属 Agent 与五项关系 |
| 26 | clean-aihub-05 | 政企通道与确认回写 |
| 27 | clean-aihub-06 | 三层架构与平台底座 |
| 28 | clean-aihub-07 | 企业政府产业三方愿景 |
| 29 | clean-aihub-08 | 五项应用与共用基础 |
| 30 | clean-aihub-09 | 政策文件与四步服务 |
| 31 | clean-aihub-10 | 办事难点与五类支持 |
| 32 | clean-aihub-11 | 社群输入与协作成果 |
| 33 | clean-aihub-12 | 供需合作与五步机制 |
| 34 | clean-aihub-13 | 能力名片与供需网络 |
| 35 | clean-aihub-14 | 招投标渠道与五步服务 |
| 36 | clean-aihub-15 | 双轨项目计划与月度里程碑 |
| 37 | clean-aihub-16 | 六项技术能力 |
| 38 | clean-aihub-17 | 演进对比与方案差异 |
| 39 | clean-aihub-18 | 风险维护与组织挑战 |
| 40 | clean-aihub-19 | 组织统筹权责与数据协同 |
| 41 | clean-aihub-20 | 结束与决策收尾 |

用户修改后授权重新导入；业务示例仍需核实。WPS 渲染及编辑抽查通过，PowerPoint 未验证。
