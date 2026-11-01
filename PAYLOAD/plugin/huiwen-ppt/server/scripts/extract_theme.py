#!/usr/bin/env python3
"""提取 PPTX/POTX 主题（汇文PPT 插件 WF-04 自定义风格导入）。
纯标准库：zipfile + re。stdout 输出 JSON：
{"theme_name", "palette": {dk1,lt1,dk2,lt2,accent1..6}, "palette_list": [hex...], "masters": n, "fonts": {"major","minor","major_ea","minor_ea"}, "slides": n}
错误：stderr {"error": ...}，退出码 1。
"""
import json
import re
import sys
import zipfile


def read_theme(z, name):
    xml = z.read(name).decode('utf-8', 'replace')
    out = {}

    def clr(tag):
        m = re.search(r'<a:' + tag + r'>.*?(?:<a:srgbClr val="([0-9A-Fa-f]{6})"|<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})")', xml, re.S)
        if not m:
            return None
        return ('#' + (m.group(1) or m.group(2)).upper())

    for tag in ('dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'):
        v = clr(tag)
        if v:
            out[tag] = v
    scheme = re.search(r'<a:clrScheme name="([^"]*)"', xml)
    fonts = {}
    for kind in ('majorFont', 'minorFont'):
        latin = re.search(r'<a:' + kind + r'>\s*<a:latin typeface="([^"]*)"', xml)
        ea = re.search(r'<a:' + kind + r'>[\s\S]*?<a:ea typeface="([^"]*)"', xml)
        fonts[kind] = latin.group(1) if latin else ''
        fonts[kind + '_ea'] = ea.group(1) if ea else ''
    return {
        'theme_name': scheme.group(1) if scheme else '自定义模板',
        'palette': out,
        'fonts': fonts,
    }


def main(path):
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        print(json.dumps({'error': '无法打开模板包：' + str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    themes = sorted(n for n in z.namelist() if re.fullmatch(r'ppt/theme/theme\d+\.xml', n))
    masters = [n for n in z.namelist() if re.fullmatch(r'ppt/slideMasters/slideMaster\d+\.xml', n)]
    slides = [n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
    if not themes:
        print(json.dumps({'error': '包内没有主题定义（ppt/theme/theme1.xml 缺失）'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    t = read_theme(z, themes[0])
    pal = t['palette']
    ordered = [pal.get(k) for k in ('accent1', 'accent2', 'accent4', 'accent6', 'dk2', 'lt2')]
    palette_list = [c for c in ordered if c]
    for c in pal.values():
        if len(palette_list) >= 6:
            break
        if c not in palette_list:
            palette_list.append(c)
    result = {
        'theme_name': t['theme_name'],
        'palette': pal,
        'palette_list': palette_list[:6],
        'masters': len(masters),
        'slides': len(slides),
        'fonts': t['fonts'],
    }
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main(sys.argv[1])
