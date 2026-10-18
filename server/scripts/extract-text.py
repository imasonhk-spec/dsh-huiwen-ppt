#!/usr/bin/env python3
"""Extract complete text with source locators; never execute formulas or macros."""
import json, sys, zipfile, posixpath, subprocess
from pathlib import Path
import xml.etree.ElementTree as ET
def local(tag): return tag.rsplit("}",1)[-1]
def text(node): return "".join(t.text or "" for t in node.iter() if local(t.tag) == "t")
def relationships(z, part):
    relpath = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part)+".rels")
    root = ET.fromstring(z.read(relpath))
    return {r.attrib["Id"]:posixpath.normpath(posixpath.join(posixpath.dirname(part),r.attrib["Target"])) if not r.attrib["Target"].startswith("/") else r.attrib["Target"].lstrip("/") for r in root}
def rid(node): return next((v for k,v in node.attrib.items() if k.endswith("}id")),None)
def extract(source):
    ext = Path(source).suffix.lower()
    blocks = []
    if ext == ".pdf":
        p = subprocess.run(["pdftotext","-layout",source,"-"],capture_output=True,text=True,timeout=60)
        if p.returncode: raise ValueError("PDF 提取失败（损坏或加密）："+p.stderr.strip())
        for i, page in enumerate(p.stdout.split("\f"),1):
            if page.strip(): blocks.append({"locator":"PDF 第%d页"%i,"text":page.strip()})
        if not blocks: raise ValueError("PDF 没有可提取正文，扫描件需要 OCR")
        return blocks
    with zipfile.ZipFile(source) as z:
        if ext in (".docx",".docm"):
            root = ET.fromstring(z.read("word/document.xml"))
            for i,p in enumerate((n for n in root.iter() if local(n.tag) == "p"),1):
                value=text(p).strip()
                if value: blocks.append({"locator":"DOCX 段落%d"%i,"text":value})
        elif ext in (".pptx",".pptm",".potx",".ppsx"):
            part = "ppt/presentation.xml"
            root = ET.fromstring(z.read(part)); rels=relationships(z,part)
            for i,slide in enumerate((n for n in root.iter() if local(n.tag)=="sldId"),1):
                doc=ET.fromstring(z.read(rels[rid(slide)]))
                value="\n".join(text(p) for p in doc.iter() if local(p.tag)=="p")
                blocks.append({"locator":"PPTX 第%d页"%i,"text":value})
        elif ext in (".xlsx",".xlsm"):
            shared=[]
            if "xl/sharedStrings.xml" in z.namelist(): shared=[text(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
            root=ET.fromstring(z.read("xl/workbook.xml")); rels=relationships(z,"xl/workbook.xml")
            for sheet in (n for n in root.iter() if local(n.tag)=="sheet"):
                doc=ET.fromstring(z.read(rels[rid(sheet)])); name=sheet.attrib["name"]
                for row in (n for n in doc.iter() if local(n.tag)=="row"):
                    cells=[]
                    for cell in row:
                        if local(cell.tag)!="c": continue
                        value=next((v.text or "" for v in cell if local(v.tag)=="v"),"")
                        kind=cell.attrib.get("t")
                        if kind=="s" and value: value=shared[int(value)]
                        elif kind=="inlineStr": value=text(cell)
                        elif kind=="b": value="TRUE" if value=="1" else "FALSE"
                        formula=next((v.text or "" for v in cell if local(v.tag)=="f"),None)
                        if formula is not None and not value: value="[公式无缓存值]"
                        cells.append(cell.attrib.get("r","?")+"="+value)
                    if cells: blocks.append({"locator":"工作表「%s」行%s"%(name,row.attrib.get("r","?")),"text":" | ".join(cells)})
        else: raise ValueError("不支持的格式："+ext)
    return blocks
def main():
    try:
        blocks=extract(sys.argv[1])
        body="\n".join("【"+b["locator"]+"】"+b["text"] for b in blocks)
        if not body.strip(): raise ValueError("没有可提取正文，图片材料需要 OCR")
        maximum=int(sys.argv[2]) if len(sys.argv)>2 else 0
        print(json.dumps({"ok":True,"text":body[:maximum] if maximum>0 else body,"chars":len(body),"truncated":maximum>0 and len(body)>maximum,"blocks":blocks},ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error":str(e)},ensure_ascii=False),file=sys.stderr); sys.exit(1)
if __name__=="__main__": main()
