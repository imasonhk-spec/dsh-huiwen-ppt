#!/usr/bin/env python3
"""extract-text.py —— OOXML 材料正文提取（纯标准库，零依赖）。

用法：python3 extract-text.py <file> [maxchars]
输出：成功时 stdout 打印 {"ok": true, "text": "...", "chars": N, "truncated": bool}；
      失败时 stderr 打印 {"error": "..."}（与 studio.py 输出约定一致）。
支持：.docx/.docm（word/document.xml 段落）、
      .pptx/.ppsx/.potx/.pptm（ppt/slides/slideN.xml 逐页）、
      .xlsx/.xlsm（xl/sharedStrings.xml 共享字符串）。
原则：只读 zip 内的 XML 部件，不执行任何公式/宏/外链；不虚构内容。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_DEFAULT = 60000

KINDS = {
    ".docx": "docx", ".docm": "docx",
    ".pptx": "pptx", ".ppsx": "pptx", ".potx": "pptx", ".pptm": "pptx",
    ".xlsx": "xlsx", ".xlsm": "xlsx",
}


def fail(msg):
    print(json.dumps({"error": msg}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def para_lines(root):
    """按段落（w:p / a:p）聚合文本子节点（w:t / a:t），返回非空行列表。"""
    lines = []
    for p in root.iter():
        if local(p.tag) != "p":
            continue
        buf = []
        for t in p.iter():
            if local(t.tag) == "t" and t.text:
                buf.append(t.text)
        line = "".join(buf).strip()
        if line:
            lines.append(line)
    return lines


def extract_docx(z):
    try:
        root = ET.fromstring(z.read("word/document.xml"))
    except KeyError:
        fail("docx 缺少 word/document.xml 正文部件")
    return "\n".join(para_lines(root))


def extract_pptx(z):
    slides = []
    for name in z.namelist():
        m = re.match(r"^ppt/slides/slide(\d+)\.xml$", name)
        if m:
            slides.append((int(m.group(1)), name))
    if not slides:
        fail("pptx 缺少 ppt/slides/slideN.xml 幻灯片部件")
    slides.sort(key=lambda x: x[0])
    parts = []
    for n, name in slides:
        root = ET.fromstring(z.read(name))
        parts.append("【第%d页】%s" % (n, "；".join(para_lines(root))))
    return "\n".join(parts)


def extract_xlsx(z):
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        fail("xlsx 缺少 xl/sharedStrings.xml 字符串表部件")
    vals = []
    for si in root.iter():
        if local(si.tag) != "si":
            continue
        buf = []
        for t in si.iter():
            if local(t.tag) == "t" and t.text:
                buf.append(t.text)
        s = "".join(buf).strip()
        if s:
            vals.append(s)
    return "\n".join(vals)


def main():
    if len(sys.argv) < 2:
        fail("用法: extract-text.py <file> [maxchars]")
    path = sys.argv[1]
    try:
        maxchars = int(sys.argv[2]) if len(sys.argv) > 2 else MAX_DEFAULT
    except ValueError:
        maxchars = MAX_DEFAULT
    ext = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ""
    kind = KINDS.get(ext)
    if not kind:
        fail("不支持的扩展名: %s（支持 docx/pptx/xlsx 系）" % ext)
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail("不是有效的 OOXML 压缩包（旧版二进制格式请另存为 .docx/.pptx/.xlsx 后重传）")
    except RuntimeError:
        fail("文件已加密，无法提取")
    except OSError as e:
        fail("无法读取文件: %s" % e)
    with z:
        try:
            text = {"docx": extract_docx, "pptx": extract_pptx, "xlsx": extract_xlsx}[kind](z)
        except ET.ParseError:
            fail("内部 XML 解析失败（文件可能已损坏）")
        except RuntimeError:
            fail("文件已加密，无法提取")
    text = (text or "").strip()
    if not text:
        fail("未提取到文本内容（可能是纯图片/扫描文档）")
    full = len(text)
    truncated = full > maxchars
    if truncated:
        text = text[:maxchars]
    print(json.dumps({"ok": True, "text": text, "chars": full, "truncated": truncated}, ensure_ascii=False))


if __name__ == "__main__":
    main()
