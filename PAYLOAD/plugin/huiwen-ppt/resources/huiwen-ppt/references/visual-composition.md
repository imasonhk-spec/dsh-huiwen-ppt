# 视觉组件选择与整稿编排

材料充分时一次生成全稿并自动 QA、修复后交付。样张只用于用户明确指定的分阶段任务。保留两套模板分支，不因增强商务图示而停用插画模板。

## 表达先于选图

每页先写主结论、实体、关系、输入输出与材料依据，再选择适用的完整组合。优先使用成熟流程、架构、协作图，再拆取内部组件重组。不为丰富而制造没有事实依据的部门层级、流程分支或能力。证据页可以保持简洁。

用 `components.py` 的 `search-visual` 检索机器人、办公人物、流程、协作、政策核验等。结果包括来源预览、语义与编辑边界，以及确定性的排序分数；排序不代替视觉判断。查看实际预览及对象槽位，再选 component_id 和版本。默认只在候选范围检索是因为当前内置库尚未积累三个不同任务的正式验证，不表示候选已成熟。

```json
{"command":"search-visual","library":"<skill>/assets/components","query":"智能体协作","scope":"trial_candidates"}
```

语义目录绑定 component_id、版本与 source_sha256。旧模板删页、退役、质量待修复及不属于当前任务的候选，仍由原搜索范围规则过滤。上传新模板时先索引，再补来源版本绑定的语义条目；缺少视觉标签的部分不能假称自动学习完成。

## 整稿构图只使用一次

新计划逐页填写 `composition_family`，设置 `visual_policy: {"unique_compositions": true}`。同一种整体空间组织和关系表达不可重复，改文字、颜色、微调位置仍相同。局部图标、人物、机器人与流程节点可复用。用户要求原模板固定填充时遵循其保真范围，不擅自打散原有页面。

先运行 `composition-ledger`，再结合整稿实际渲染核对。构图名不同但几何相同也会被 `audit-visual` 报错。几何指纹忽略文字与配色，并对整体位移/比例做归一化；它无法完整判断语义等价，指纹不同不等于构图一定不同。对疑似“相同四栏/相同截图侧说明”等页面必须目视复核。

可从已用源页拆局部组件来形成新构图，不能仅按源页编号判断重复。模板数量不足时组合新结构，不改业务关系来凑样式。

## 必须真实导入

官方 BuildPlan 通过现有构建器生成 `.state.json` 的 instances、maps、id_map、actual_source_ref 和 source_refs；actual_source_ref 是本次实际取用来源，source_refs 是组件历史来源。嵌套组按来源对象子树验证，参数化实例逐节点保留映射。在 visual_policy 开启时构建后自动审计，QA validate 再次核验；幂等重试也重查真实复用，不能把 blocked 降为 pending。旧计划接口保持兼容，新任务必须主动开启该策略。

外部构建器必须提供 `component-reuse.json`：output_sha256 及 imports，每条记录包含 page、source_file、source_sha256、source_part、source_shape_ids、id_map。明确删除的对象放入 deliberately_removed_output_shape_ids，不计有效复用。最终目标对象 ID 不应因为后处理而静默丢失。

```json
{"command":"audit-visual","source":"<output.pptx>","visual_plan":{"visual_policy":{"unique_compositions":true},"slides":[{"composition_family":"three-party-architecture","reuse_requirement":"structural"}]},"reuse":"<project>/component-reuse.json"}
```

检查来源真实存在且哈希匹配、源对象存在、目标对象存在并处于内容区域；隐藏、全页背景及被全页图片盖住的节点不计。structural 页最少需要两个可见原生来源对象，asset 页需要可见来源素材，original 页显式记录待视觉审查。这是最低真实性检查，不是“页面已经美观”的结论。不得把装饰图标的计数当作充分复用完整图示的证明。

## 素材与交付检查

机器人可作为特定智能体产品的统一角色，但其它题材按内容选主体。优先使用无品牌原素材；旧项目品牌必须处理。插画整体可移动缩放，流程文字和连接线保持原生可编辑。未生成的动作变体不得登记为已生成。

真实截图按原字节保留，不伪造查询结果或执行状态。截图中的模型选项不必然是现场配置，必要时在备注说明。图示和备注中的数字都要标明其证据强度。

一次完整交付至少包括：全稿计划、构图占用表、真实来源映射、visual-audit、实际引擎渲染、逐页视觉检查及副本编辑保存重开。通过后直接交付，既有事实边界和候选晋级规则继续有效。
