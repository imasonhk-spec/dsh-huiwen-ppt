# 组件生产工作流

适用于自由组合、跨模板借用、可变流程、上传新模板和局部重生成。执行器为 `scripts/components.py`，请求格式见 [接口契约](component-contracts.md)。普通整页填充仍走 studio.py。两条路线不共用旧构建器的人工批准字段；Quick 的 decision_source 写 policy，不伪造用户确认。

## C01 导入与清点

1. 保存用户 PPTX/POTX 原件，记录 SHA256、项目与替换目标。用实际页数，不信文件名。
2. `index` 保存来源快照并生成 index.json。每页 coverage 包含对象树、角色、受限项、未分配项。模板更新使用同一 template_id；新模板使用新 ID。
3. 调用 `studio.py render --source SOURCE --output DIRECTORY --engine wps`，以实际渲染图检查源页。`thumbnails` 必须使用匹配 source_sha256 的 native-render.json。
4. 新上传模板默认只对当前 project_id 开放；内置两分支也先保持候选。已知商务第 15/20 页缺陷被标为 requires_repair，不自动复用。

索引失败不改原件；同源同标注重试不会添加模板版本。新索引格式 extraction_version=2。原始图片不能假装已拆成文字和节点。

## C02 语义组件与候选

自动提取单元素、原生组、页面主体和几何容器组合。它们是检索候选，不能全称为验证过的语义版式。模型读取预览和 element_tree 后用 annotations 指定语义组件、顶层 shape_ids、固定 component_id 和参数化蓝图；再执行 index。

内置蓝图包括 four-step-flow、flexible-cards、flexible-hub，以及说明组、表格、图表。节点数量支持 2–8，中心辐射至少 3。其他流程先标注实际节点对象，不猜 shape_id。编号、标题和正文保持原生文本；节点连线由执行器重建。

候选只表示已经抽取，QA 合格才能交付使用结果。缩略图是来源区域裁切，可能包含相邻/背景内容，UI 不应当作透明的孤立组件。

## C03 材料、大纲与选择

只使用本任务材料事实，先写论点和证据，再规划页面。默认 8–12 页，信息多时拆页。材料缺口用假设/待补；Quick 能合理继续时直接生成，只追问无法确定任务目标的关键缺口。不要引用模板原有业务数据充当用户事实。

先搜索 formal 和 current_project。首次使用内置候选时查 trial_candidates，查看预览、slots、能力和限制，计划显式写 trial_candidate:true。不需要逐组件请求用户批准。history 仅用于明确恢复，requires_repair 不参加自动选择。

按关系选组件，整页可以重新设计。避免相邻页重复相同构图，允许流程、表格、数据对照、中心辐射、卡片交替；重复构图有信息表达理由时可保留。选择依据和材料定位由 agent 写入计划扩展字段，执行器不替代业务事实核验。

## C04 目标样式与编译

上传模板优先成为 style_source；否则以两绿色分支之一为主。style 命令读取真实主题、直接色、字体及画布尺寸，不能用文件名生成色板。输出配色以主色、明度和字体适配；不会自动理解任意模板完整品牌语法，Logo、位图保持原图，特殊容器/背景按需从目标模板选取组件。

写 CompositionPlan：每页标题、实例 rect、固定组件版本、bindings、evidence_refs、transform、locks。文本绑定需覆盖组件 slots；没有内容的字段写待补或空值并说明。allow_template_examples 仅限模板示例演示，不用于真实汇报。compile 检查原件哈希、来源、范围、字段、重叠和锁；超载换结构/拆页，避免缩小文字硬塞。

坐标使用解析得到的 slide_size；内置画布是 1280×720，其他模板不保证相同尺寸。组件 rect 是保留区域；图片和原生组合等比 contain 后可能不填满。标题默认在 x=52,y=32,height=70 的区域，规划主体时避开它。

## C05 构建

build 输出新 PPTX 与同名 .state.json。图表/嵌入工作簿按实例独立克隆，组内部文字可绑定，连接端点重映射。结构未绑定或不支持时失败，不悄悄栅格化。来源 PPT 只读。

模型可基于当前材料构造新的页面结构或重建需要的位图核心结构；将真实生成的可编辑 PPTX 作为新来源 index，再组合。生成图像通过所在宿主可用工具完成，记录内部 provenance，交付不显示 AI 素材标签。没有图像/重建工具时继续原生可实现部分，对保留图片说明编辑限制。

build 是确定性执行器，不内置大模型、图片生成服务或通用图片转流程图算法。不要向用户称任意图片都能自动完美重建。

## C06 检查、修复与交付

validate 首先检查结构、越界、ID、关系、连接端点和源哈希。engine:wps 时真实渲染。无渲染、逐页视觉核对和编辑抽查时状态只能 review_required。

逐页看渲染：溢出、裁切、重叠、配色、字体、模板示例残留。自动几何检查不能保证文字全部可读，WPS BoundHeight/Width 探针也不能替代视觉判断。对低于 10pt 的小字警告逐项复核。复杂嵌套旋转、SmartArt、OLE、动画不能宣称无损。

执行 verify_component_editability.ps1：先 Phase edit 在独立测试副本改文本/位置/表格/图表尺寸/连接线，关闭测试副本；另一次调用 Phase reopen 核对保存结果。不关闭用户 WPS 应用。图表数据 CLI 测试核对 cache 与 workbook；此脚本不验证 WPS 的编辑数据对话框。

提交 review（哈希、全部页码、审阅者、真实 render_report 与 editability_report、未解决问题）再次 validate。只有 status=passed 可交付。用户验收、WPS 验收、PowerPoint 验收分开记；未运行 PowerPoint 不声称双软件通过。

## C07 锁定和局部修改

读取当前 PPTX、state 和 sha256；把对话与 UI 操作编为同一 operations。支持组件锁和矩形区域锁；区域锁保守地保护所有相交组件，不拆开跨边界组件。改节点数必须同时提供完整的新节点内容。

apply-revision 要求 expected_sha256；过期拒绝。锁定区 XML 和依赖指纹不变，任何新对象侵入锁区都会失败。regenerate-region 由 agent 提供替换实例，执行器只处理指定区域。不得通过清锁绕过冲突。

原生对象级几何变更后会记录 native_geometry_override。之后语义重建须重新提取该组件，或明确 discard_native_edits；否则拒绝，防止吞掉用户调整。对象级编辑与同组件语义重建分成两次修订。用户在 WPS 外部保存后旧 state 失效，应重新导入/提取并建立新状态，不绕过哈希。

## C08 沉淀和恢复

通过 QA 的新页面/组件先候选。record-use 必须附真实输出、state 路径与完整 QA，task_id 与 state.project_id 一致，且输出包含该组件版本；同任务重试只计一次。同版本 3 个不同任务且无未解决问题后自动晋级原生组件。人工确认可 promote，记录真实确认人和说明，agent 不冒充用户。

删页/重导入后没有活跃来源的组件退役；多个有效来源只删一个时继续可用。固定语义 ID 可跨源共享，未标注的相似外观不会冒险自动合并。手动退役需显式恢复。历史来源快照仍在，可在计划指定旧版本与 allow_historical:true，仅用于明确恢复。restore 恢复默认推荐需要活跃来源，必要时先重新导入保留的原件。

## 当前限制

- 分类/数值图表数据绑定保持图型和系列数；带额外工作簿公式的标题、误差线、散点图等拒绝数据改写，可整体复制或交给专用工具。
- 表格支持保持行列结构的单元格绑定，合并延续单元格留空；增删行列需要重建组件。
- 替换一段文字沿用首段/首 run 风格，原混合富文本强调不保证逐字保留；需重建为独立文本框或交付前修订核对。
- 编译不自动选择组件、调用模型或生成图像；语义规划由 Codex/dsh agent 执行。网络服务、作业队列、UI 权限由 dsh Host 提供。
