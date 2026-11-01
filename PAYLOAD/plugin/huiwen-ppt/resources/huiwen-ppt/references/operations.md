# 操作参考

以下命令的 `python` 替换为环境可用的 Python 3.10+，`studio.py` 使用本 skill 的绝对路径。命令中的路径按实际工作区替换。

```text
python studio.py inspect --source source.pptx --output inspection.json
python studio.py register --source source.pptx --library library --name 产品介绍
python studio.py list --library library
python studio.py approve-template --template library/templates/<id> --confirmed-by 用户 --note 已确认视觉与表达规则
python studio.py project --source source.pptx --project projects/task-001
python studio.py import-revision --source revised.pptx --project projects/task-001 --expected-sha256 <当前文件SHA256> --engine wps
python studio.py patch --source source.pptx --patch edits.json --output revision.pptx
python studio.py build --template library/templates/<id> --plan plan.json --output new-deck.pptx
python studio.py render --source revision.pptx --output previews --engine wps
python studio.py render --source revision.pptx --output compatibility-preview --engine powerpoint
python studio.py serve --project projects/task-001 --engine wps
python studio.py knowledge --library library --item fact.json --confirmed-by 用户
```

## 修改格式

```json
{
  "expected_sha256": "输入文件实际 SHA256",
  "operations": [
    {"slide": 2, "shape_id": "4", "op": "replace-text", "old": "旧文字", "new": "新文字"},
    {"slide": 2, "shape_id": "5", "op": "set-text", "text": "完整的新文字"},
    {"slide": 2, "shape_id": "5", "op": "geometry", "x": 90, "y": 160, "width": 400, "height": 160},
    {"slide": 3, "shape_id": "7", "op": "table-cell", "row": 0, "column": 1, "text": "新内容"}
  ]
}
```

几何采用 96 DPI 的 CSS 像素。`set-text` 以首个正文文本 run 的样式重建段落，可能改变混合文字样式，优先用 `replace-text` 保留原 run。相同旧文字在目标中须唯一；多匹配和未匹配都停止。页码按 presentation 的实际页序，非文件名序号。图表、图像与组合对象不能用文本操作。

## 复用页面的构建计划

```json
{
  "phase": "final",
  "approvals": {
    "requirements": {"confirmed_by": "用户", "note": "需求摘要已确认"},
    "outline": {"confirmed_by": "用户", "note": "逐页大纲已确认"},
    "samples": {"confirmed_by": "用户", "note": "代表性样张已确认"}
  },
  "slides": [
    {"source_slide": 1, "purpose": "封面", "operations": []},
    {"source_slide": 3, "purpose": "产品能力", "operations": [
      {"shape_id": "4", "op": "set-text", "text": "本次内容"}
    ]}
  ]
}
```

`phase: sample` 只要求需求与大纲确认，用于样张制作；整套使用 `phase: final`。工具检查字段齐全，确认记录须由实际对话建立，不能由工具替用户批准。`source_slide` 可以重复，重复页面的备注、图表和嵌入工作簿会独立复制。布局、母版、主题和只读图片共享。构建清理不可达的原始页面，原文件留在模板库。

新布局先由相应制作工具生成并确认，随后作为工作模板的原生页面复用；当前构建命令仅复用原有页面。

## 画布

外部制作工具的修订用 `import-revision` 导入。先让用户保存画布待应用修改，核对并停止此项目的服务进程，再传入当前文件 SHA256 执行导入。命令保留旧版本和全部批注，创建新版本并渲染；渲染失败时保留新 PPT，状态记录失败。批注自带旧版本与 SHA256，重新应用前必须核对目标对象。相同文件重复导入返回 unchanged。项目服务停止期间运行此命令，避免和画布同时写入。

恢复服务使用本次启动返回的新令牌地址。Windows 后台启动使用隐藏窗口，保存日志；验证首页、`/api/state` 和实际 PNG 均可访问，确认版本与 SHA256 后再打开画布。输出了新 PPT 文件不代表画布已同步。

服务绑定回环地址，返回带随机访问令牌的地址。在 Codex 浏览器面板打开该地址。画布显示实际 PNG 和 OOXML 对象边界。拖拽、调整尺寸、文字编辑都先进入待应用列表。应用生成新版本并尝试用所选软件渲染。渲染失败会保留已生成文件并明确显示预览未验证。

图层选择、方向键及数值输入可替代拖拽。批注支持区域框与箭头，保存至 `annotations.json`。回到 Codex 说明“按画布批注修改”，读取这些记录，解决有歧义的指令后应用。保存批注不会自行启动新的 Codex 回合。

`state.json` 保存原参考、当前文件、版本和渲染状态。`versions` 保存全部版本。修改文件 SHA256 必须匹配，防止旧画布覆盖新文件。新知识条目必须给出事实文本、来源文件、页码、适用范围、事实日期（未知可为 null）及时间敏感标记，并通过实际确认后保存。
