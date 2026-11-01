# 组件 CLI 与数据契约 v1

入口：`python <skill>/scripts/components.py --request request.json --result result.json`。
`--request -` 从 stdin 读 JSON；`--capabilities` 返回实际命令。不使用 shell 拼接用户内容。所有路径由 Host 解析为允许项目内的绝对路径，库内来源/预览使用相对路径。

成功返回 `{ "ok": true, "result": ... }`。使用 --result 时完整结果写入该文件，stdout 仅给 result_file。失败 exit=1，结构化错误写 stderr 与结果文件。无 HTTP 服务、无后台模型调用；dsh 包装本地进程即可。

## 命令

| command | 必需请求字段（另含 command） | 结果 |
| --- | --- | --- |
| capabilities | 无 | commands/native/parameterizations/limits |
| index | library, source, template_id, project_id；可选 annotations | template_version, source_sha256, coverage, components |
| thumbnails | library, template_id, render_dir | 来源区域预览数量；需 Pillow 与匹配的真实渲染 |
| search | library；可选 query, scope, project_id, relation, excluded_ids | 组件数组，含定义、来源和预览 |
| search-visual | library；可选 query, scope, project_id, relation, excluded_ids | 带视觉语义、来源预览及排序理由的组件；scope 默认 trial_candidates，保留生命周期过滤 |
| composition-ledger | visual_plan（元数据计划），或 plan（完整 BuildPlan） | 逐页构图族占用与重复冲突 |
| audit-visual | source、visual_plan（或 plan）；state / reuse 至少一项 | 来源哈希、实际对象复用、可见原生对象、构图与几何重复；不代替渲染和视觉检查 |
| get | library, component_id；可选 component_version | 一个完整组件定义 |
| style | source | 真实文件 StyleProfile |
| compile | library, plan | 校验后计划与样式、警告；不写 PPT |
| build | library, plan, output | output, sha256, state, revision, warnings, qa_status |
| apply-revision | library, source, state, operations, output, expected_sha256 | 新版本结果；source/state 为旧版本 |
| validate | source；可选 state, engine, render_dir, review | structure/visual/editability/status/errors/warnings |
| record-use | library, component_id, component_version, task_id, proof | 更新组件及去重记录 |
| promote | library, component_id, component_version, confirmed_by, note, proof | 手工晋级；确认来自用户 |
| retire | library, component_id, component_version, reason | 停用一个版本 |
| restore | library, component_id, component_version | 有活跃来源时恢复此前生命周期 |

search.scope 默认为 formal，可取 current_project / trial_candidates / history；history 每个 ID 返回最新匹配版本，完整版本列表读 index.json，再用 get 指定版本。分页、排序分数、选择理由由 Host/agent 包装；CLI 不返回虚构推荐分数。

## 定义与状态

`assets/components/index.json` 是实际索引文件名，设计稿中的 component-index.json/template-manifest.json/page-coverage.json 由这一个原子登记文件的 components/templates/coverage 承载。状态写入前持有 .write-lock，同库写入串行；Host 应串行化模板变更及构建。写锁只表示本地互斥，不是分布式事务。

组件：component_id、component_version、definition_hash、structure_hash、name、relation_type、role、granularity、lifecycle、quality_status、editability、capabilities、bounds、slide_size、source_refs、slots、element_tree、parameterization、preview、project_ids、use_records。element_tree 中子元素坐标属于父组空间，不能直接作为画布绝对坐标。

source_refs 包含 template_id/template_version/source_sha256/file/slide/part/shape_ids/active。组件 definition_hash 基于原生 XML、依赖与标注；只修改无关文档元数据不会让组件获得新版本。未标注的不同结构使用新 ID，不凭相似外观覆盖历史定义。

`.state.json` 的 slides[].instances[] 是真实 object_map：instance_id、shape_ids、maps[].id_map、dependencies、rect、fingerprint；连线 shape_ids 也包括在内。actual_source_ref 保存本次真正使用的来源，source_refs 保留组件的全部历史来源；不要把历史列表当作本次导入来源。layer 区分 background/content。组内 child ID 出现在 id_map 中，审计按真实来源子树核对。导出结果不内联大型 object_map，Host 读取 state。修改后的 revision/sha256 是画布和导出卡的版本事实。

## 最小真实构建样例

把下方 library/style_source/output 替换成安装路径和任务路径，内容来自本次演示指令。four-step-flow 是发布库已有稳定 ID；节点内容变化不是改原模板。

```json
{
  "command": "build",
  "library": "<skill>/assets/components",
  "output": "<project>/output/demo.pptx",
  "plan": {
    "schema_version": 1,
    "project_id": "demo-project",
    "request_id": "demo-build-1",
    "mode": "quick",
    "decision_source": "policy",
    "style_source": "<skill>/assets/clean-business/reference.pptx",
    "visual_policy": {"unique_compositions": true},
    "slides": [{
      "slide_id": "p1",
      "title": "从材料到交付的四个步骤",
      "composition_family": "four-step-serpentine-flow",
      "reuse_requirement": "structural",
      "instances": [{
        "instance_id": "flow",
        "component_id": "four-step-flow",
        "component_version": 1,
        "trial_candidate": true,
        "rect": {"x": 60, "y": 170, "width": 1160, "height": 440},
        "bindings": {"steps": [
          {"title": "材料核对", "description": "确认来源"},
          {"title": "组织论点", "description": "安排结构"},
          {"title": "生成页面", "description": "组合组件"},
          {"title": "检查交付", "description": "保存版本"}
        ]},
        "transform": {"node_count": 4, "arrangement": "two_rows"},
        "evidence_refs": ["user-instruction:demonstration"]
      }],
      "locks": []
    }]
  }
}
```

plan.schema_version=1，slides 1–500 页；mode quick/standard。坐标有限数字，非负且不越界。实例不能相互重叠，显式 layer:background 例外；标题区域由规划器避让并通过视觉检查。初版/修订都保存新文件；同路径同请求同文件哈希可幂等返回 reused:true，不同请求返回 OUTPUT_EXISTS。

bindings 的 key 使用 get 返回的 slot.key（原 shape ID）。text 值为字符串；table 为 `{"cells":[["列1","列2"]]}`；chart 为 `{"categories":["A","B"],"series":[{"name":"演示","values":[1,2]}]}`。参数化用 steps 或 items 数组，元素有 title/description；transform.node_count 必须等于数组长度。arrangement 为 horizontal/vertical/two_rows/grid/radial；radial 首项为中心。

annotations 按真实页码字符串分组；每项 shape_ids 指定原页顶层对象，组子对象通过 element_tree/slots 操作。parameterization 是 `{type:"repeat",node_shape_ids:[],anchor_shape_id:"",fields:{title:"",description:"",number:""}}`；这些 ID 必须来自源文件和蓝图内部，不能照抄其他模板。

## 修订 operations

每项有 op、slide_id；组件操作另有 instance_id。

| op | 其他字段 |
| --- | --- |
| set-binding | key, value |
| set-node-count | count, items（完整节点数组） |
| set-arrangement | arrangement |
| set-geometry | rect（整个组件） |
| set-title | text（不需要 instance_id） |
| replace-component | instance（完整替换实例，保留原 instance_id） |
| lock-component / unlock-component | instance_id |
| lock-region | lock_id, rect |
| unlock-region | lock_id |
| regenerate-region | rect, instances（模型规划的替换实例） |
| set-text / replace-text / geometry / table-cell | shape_id 及 studio.py 原操作字段 |

set-text 示例 `{op:"set-text",slide_id:"p1",shape_id:"实际输出ID",text:"新文字"}`；不要使用源模板 shape_id 修改输出。区域锁保护相交组件整体；空白锁区也不可被侵入。变更操作先校验，全部成功才保存新 PPT，失败不覆盖原稿。

## QA 与使用证明

review 为对象或 JSON 路径：source_sha256、visual:"passed"、reviewed_pages:[1,...]、reviewer、render_report（路径或对象）、editability:"passed"、editability_report（脚本实际报告路径）、unresolved:[]。review 是可信审阅者签署的事实，Host 不得由 UI 默认值自动生成。执行器核对哈希/页数，不能验证审阅者是否真的看过图。

proof 使用 validate 的完整报告，加 output_file、state_file。record-use 还核对 task_id 与 state.project_id、组件 ID/版本及文件哈希。任务计数以项目身份为准；Host 不得为重试创建新项目 ID。报告和源输出保留以便审计。自动晋级只对原生组件；图片的质量确认由人工处理。

## 错误与恢复

| code | Host 动作 |
| --- | --- |
| INVALID_REQUEST / INVALID_PLAN / INVALID_BINDING / INVALID_ANNOTATION | 修正字段，保留用户材料 |
| SOURCE_CHANGED / VERSION_CONFLICT | 重读最新文件/状态，重新规划，不强制覆盖 |
| COMPONENT_NOT_FOUND / COMPONENT_RETIRED / CANDIDATE_SCOPE | 重新检索，或显式历史恢复/候选试用 |
| COMPONENT_REQUIRES_REPAIR | 修复并重新提取，不能绕过 |
| UNBOUND_TEMPLATE_TEXT / MISSING_EVIDENCE | 补材料绑定，或明确待补，不沿用示例事实 |
| CONTENT_OVERLAP / CONTENT_OVERFLOW | 重排、拆页或换组件 |
| LOCK_CONFLICT | 保留锁，调整未锁区方案 |
| UNSUPPORTED_TRANSFORM / UNSUPPORTED_CHART / UNSUPPORTED_DEPENDENCY | 重建需要的结构或交给支持工具，说明局部限制 |
| NATIVE_EDIT_REQUIRES_REEXTRACT | 重新提取用户已编辑组件，或明确丢弃该次几何编辑 |
| DEPENDENCY_MISSING / RENDER_EVIDENCE_REQUIRED / REVIEW_HASH_MISMATCH | 修复来源/重新渲染和检查 |
| OUTPUT_EXISTS | 用新版本路径或原请求重试 |
| LIBRARY_BUSY | 串行重试；仅确认写进程已退出后处理残留锁 |

核心引擎 Python 3.10+ 标准库；缩略图需要 Pillow。WPS 渲染/编辑检查需要 Windows、PowerShell 和 KWPP.Application。其他平台可以构建，但不应宣称通过 WPS 验收。
