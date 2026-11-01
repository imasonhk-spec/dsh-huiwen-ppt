#!/usr/bin/env python3
"""Reference-backed PPTX operations and a local editing canvas. Python 3.10+."""
import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import re
import secrets
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from xml.dom import minidom
import zipfile

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}
EMU = 9525
HERE = Path(__file__).resolve().parent


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(f.read()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(4) + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def parse(data):
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("XML entities and DTDs are not supported")
    return minidom.parseString(data)


def nodes(node, prefix, name):
    return list(node.getElementsByTagNameNS(NS[prefix], name))


def first(node, prefix, name):
    return next(iter(nodes(node, prefix, name)), None)


def children(node, prefix=None, name=None):
    return [n for n in node.childNodes if n.nodeType == n.ELEMENT_NODE and
            (prefix is None or n.namespaceURI == NS[prefix]) and (name is None or n.localName == name)]


def xml_bytes(doc):
    return doc.toxml(encoding="UTF-8")


def rel_path(part):
    folder, name = posixpath.split(part)
    return posixpath.join(folder, "_rels", name + ".rels")


def resolve(part, target):
    name = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(part), target))
    if name == ".." or name.startswith("../"):
        raise ValueError("Relationship target leaves the package")
    return name


def load_package(path):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or len(names) > 20000:
            raise ValueError("Ambiguous or oversized PPTX package")
        if sum(i.file_size for i in infos) > 768 * 1024 * 1024:
            raise ValueError("PPTX expands beyond 768 MB")
        for name in names:
            if name.startswith("/") or ".." in name.split("/") or "\\" in name:
                raise ValueError("Invalid package member")
        parts = {i.filename: z.read(i) for i in infos}
        metadata = {i.filename: i for i in infos}
    if "ppt/presentation.xml" not in parts:
        raise ValueError("The file is not a supported transitional PPTX")
    if any(n.startswith("_xmlsignatures/") for n in parts):
        raise ValueError("Digitally signed presentations require a separate signing workflow")
    return parts, metadata


def write_package(path, parts, metadata):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with path.open("xb") as out:
            created = True
            with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
                for name, data in parts.items():
                    info = copy.copy(metadata[name]) if name in metadata else zipfile.ZipInfo(name)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    z.writestr(info, data)
    except Exception:
        if created:
            path.unlink(missing_ok=True)
        raise


def relationships(parts, part):
    name = rel_path(part)
    if name not in parts:
        return {}
    return {n.getAttribute("Id"): n for n in nodes(parse(parts[name]), "rel", "Relationship")}


def slide_parts(parts):
    doc = parse(parts["ppt/presentation.xml"])
    rels = relationships(parts, "ppt/presentation.xml")
    size = first(doc, "p", "sldSz")
    if size is None:
        raise ValueError("Slide dimensions are missing")
    slides = []
    listing = first(doc, "p", "sldIdLst")
    for n in children(listing, "p", "sldId") if listing else []:
        rid = n.getAttributeNS(NS["r"], "id")
        if rid not in rels or rels[rid].getAttribute("TargetMode") == "External":
            raise ValueError("Slide relationship is missing or external")
        slides.append(resolve("ppt/presentation.xml", rels[rid].getAttribute("Target")))
    return slides, {"width": int(size.getAttribute("cx")) / EMU, "height": int(size.getAttribute("cy")) / EMU}


def linked_part(parts, part, kind):
    for rel in relationships(parts, part).values():
        if rel.getAttribute("Type").endswith("/" + kind) and rel.getAttribute("TargetMode") != "External":
            return resolve(part, rel.getAttribute("Target"))
    return None


def shape_nodes(doc):
    tree = first(doc, "p", "spTree")
    found = []
    def walk(parent, grouped=False):
        for n in children(parent):
            if n.namespaceURI != NS["p"]:
                continue
            if n.localName == "grpSp":
                walk(n, True)
            elif n.localName in ("sp", "pic", "graphicFrame", "cxnSp"):
                found.append((n, grouped))
    if tree:
        walk(tree)
    return found


def shape_id(n):
    prop = first(n, "p", "cNvPr")
    return prop.getAttribute("id") if prop else None


def own_transform(n):
    for name in ("spPr", "xfrm"):
        for child in children(n, "p", name):
            return child if name == "xfrm" else first(child, "a", "xfrm")
    return None


def inherited_transform(parts, slide_part, shape):
    direct = own_transform(shape)
    if direct is not None:
        return direct
    ph = first(shape, "p", "ph")
    if ph is None:
        return None
    idx, kind = ph.getAttribute("idx") or "0", ph.getAttribute("type") or "obj"
    for level in ("slideLayout", "slideMaster"):
        target = linked_part(parts, slide_part, level)
        if target is None and level == "slideMaster":
            layout = linked_part(parts, slide_part, "slideLayout")
            target = linked_part(parts, layout, level) if layout else None
        if not target or target not in parts:
            continue
        candidates = []
        for s, grouped in shape_nodes(parse(parts[target])):
            candidate = first(s, "p", "ph")
            if candidate and not grouped:
                if level == "slideLayout" and (candidate.getAttribute("idx") or "0") == idx:
                    candidates.append(s)
                elif level == "slideMaster" and (candidate.getAttribute("type") or "obj") == kind:
                    candidates.append(s)
        if len(candidates) == 1 and own_transform(candidates[0]) is not None:
            return own_transform(candidates[0])
    return None


def geometry(transform):
    if transform is None:
        return None
    off, ext = first(transform, "a", "off"), first(transform, "a", "ext")
    if off is None or ext is None:
        return None
    return {"x": int(off.getAttribute("x")) / EMU, "y": int(off.getAttribute("y")) / EMU,
            "width": int(ext.getAttribute("cx")) / EMU, "height": int(ext.getAttribute("cy")) / EMU}


def text_content(node):
    return "\n".join("".join(t.firstChild.data if t.firstChild else "" for t in nodes(p, "a", "t"))
                      for p in nodes(node, "a", "p"))


def full_page_pictures(parts, part, shapes, size):
    found = []
    for index, (shape, grouped) in enumerate(shapes):
        if shape.localName != "pic" or grouped:
            continue
        position = geometry(inherited_transform(parts, part, shape))
        if position and position["x"] <= 2 and position["y"] <= 2 and position["x"] + position["width"] >= size["width"] - 2 and position["y"] + position["height"] >= size["height"] - 2:
            found.append({"order": index, "shape_id": shape_id(shape), "position": position})
    return found


def inspect_file(path):
    parts, _ = load_package(path)
    slides, size = slide_parts(parts)
    result = {"source": str(Path(path).resolve()), "sha256": digest(path), "slide_size": size,
              "slides": [], "themes": [], "fonts": {}, "font_sizes_pt": {}, "colors": {},
              "warnings": [], "style_scope": "Direct OOXML styles; inheritance requires visual inspection"}
    def count(key, value):
        if value:
            result[key][value] = result[key].get(value, 0) + 1
    for i, part in enumerate(slides, 1):
        doc = parse(parts[part])
        entry = {"number": i, "part": part, "layout": linked_part(parts, part, "slideLayout"), "elements": []}
        shapes = shape_nodes(doc)
        pictures = full_page_pictures(parts, part, shapes, size)
        entry["full_page_pictures"] = pictures
        for order, (n, grouped) in enumerate(shapes):
            prop = first(n, "p", "cNvPr")
            transform = inherited_transform(parts, part, n)
            position = geometry(transform)
            rotated = transform is not None and (int(transform.getAttribute("rot") or "0") != 0 or
                       transform.getAttribute("flipH") in ("1", "true") or transform.getAttribute("flipV") in ("1", "true"))
            kind = "table" if first(n, "a", "tbl") else "chart" if n.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/chart", "chart") else n.localName
            text = text_content(n)
            hidden = bool(prop and prop.getAttribute("hidden") in ("1", "true"))
            occluded = any(pic["order"] > order for pic in pictures)
            item = {"shape_id": shape_id(n), "name": prop.getAttribute("name") if prop else "",
                    "kind": kind, "text": text, "position": position,
                    "editable_text": n.localName == "sp" and first(n, "p", "txBody") is not None and not grouped and not occluded and not hidden,
                    "editable_geometry": bool(position) and not grouped and not rotated and not occluded and not hidden,
                    "grouped": grouped, "rotated_or_flipped": rotated, "hidden": hidden,
                    "occluded_by_full_page_picture": occluded,
                    "full_page_picture": any(pic["shape_id"] == shape_id(n) for pic in pictures)}
            if kind == "table":
                item["cells"] = [[text_content(c) for c in children(row, "a", "tc")] for row in nodes(n, "a", "tr")]
            entry["elements"].append(item)
        for n in nodes(doc, "a", "latin") + nodes(doc, "a", "ea") + nodes(doc, "a", "cs"):
            count("fonts", n.getAttribute("typeface"))
        for n in nodes(doc, "a", "rPr") + nodes(doc, "a", "defRPr"):
            if n.hasAttribute("sz"):
                count("font_sizes_pt", str(int(n.getAttribute("sz")) / 100))
        for n in nodes(doc, "a", "srgbClr"):
            count("colors", n.getAttribute("val"))
        if nodes(doc, "p", "timing"):
            result["warnings"].append({"slide": i, "type": "animation", "note": "Inspect animation behavior in the native app"})
        if any(e["grouped"] or e["rotated_or_flipped"] for e in entry["elements"]):
            result["warnings"].append({"slide": i, "type": "transformed_objects", "note": "Canvas locks grouped/rotated geometry"})
        if any(e["occluded_by_full_page_picture"] and e["text"] for e in entry["elements"]):
            result["warnings"].append({"slide": i, "type": "bitmap_over_text", "note": "Text below a full-page image requires visibility review; excluded from knowledge candidates"})
        result["slides"].append(entry)
    for part in sorted(parts):
        if re.fullmatch(r"ppt/theme/theme\d+\.xml", part):
            doc = parse(parts[part])
            result["themes"].append({"part": part, "name": doc.documentElement.getAttribute("name"),
                                     "fonts": [n.getAttribute("typeface") for n in nodes(doc, "a", "latin") + nodes(doc, "a", "ea")],
                                     "colors": [n.getAttribute("val") for n in nodes(doc, "a", "srgbClr")]})
    result["masters"] = sorted(n for n in parts if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", n))
    result["layouts"] = sorted(n for n in parts if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", n))
    return result


def set_text(body, value):
    if not isinstance(value, str) or len(value) > 100000:
        raise ValueError("Text must be a string of at most 100000 characters")
    doc = body.ownerDocument
    paragraphs = children(body, "a", "p")
    old = paragraphs[0] if paragraphs else None
    style = first(old, "a", "rPr") if old else None
    pstyle = next(iter(children(old, "a", "pPr")), None) if old else None
    endstyle = next(iter(children(old, "a", "endParaRPr")), None) if old else None
    for p in paragraphs:
        body.removeChild(p)
    for line in value.split("\n"):
        p = doc.createElementNS(NS["a"], "a:p")
        # Some exporters declare drawing namespaces on each paragraph.
        if old:
            for attr in old.attributes.values():
                if attr.namespaceURI == "http://www.w3.org/2000/xmlns/":
                    p.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
        p.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:a", NS["a"])
        if pstyle:
            p.appendChild(pstyle.cloneNode(True))
        r = doc.createElementNS(NS["a"], "a:r")
        if style:
            r.appendChild(style.cloneNode(True))
        t = doc.createElementNS(NS["a"], "a:t")
        t.appendChild(doc.createTextNode(line))
        r.appendChild(t)
        p.appendChild(r)
        if endstyle:
            p.appendChild(endstyle.cloneNode(True))
        body.appendChild(p)


def replace_text(body, old, new):
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise ValueError("Replacement requires non-empty old text and string new text")
    paragraphs = nodes(body, "a", "p")
    matches = []
    for p in paragraphs:
        texts = nodes(p, "a", "t")
        value = "".join(t.firstChild.data if t.firstChild else "" for t in texts)
        start = 0
        while True:
            offset = value.find(old, start)
            if offset < 0:
                break
            matches.append((texts, offset))
            start = offset + len(old)
    if len(matches) != 1:
        raise ValueError(f"Expected one text match in target, found {len(matches)}")
    texts, start = matches[0]
    end, offset, inserted = start + len(old), 0, False
    for t in texts:
        value = t.firstChild.data if t.firstChild else ""
        run_end = offset + len(value)
        if run_end > start and offset < end:
            left = max(0, start - offset)
            right = min(len(value), end - offset)
            updated = value[:left] + (new if not inserted else "") + value[right:]
            inserted = True
            while t.firstChild:
                t.removeChild(t.firstChild)
            t.appendChild(t.ownerDocument.createTextNode(updated))
        offset = run_end


def apply_operations(parts, operations):
    slides, size = slide_parts(parts)
    documents = {}
    for op in operations:
        if not isinstance(op, dict):
            raise ValueError("Each operation must be an object")
        index = op.get("slide")
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= len(slides):
            raise ValueError("Operation slide must be a valid 1-based page number")
        part = slides[index - 1]
        doc = documents.setdefault(part, parse(parts[part]))
        matches = [(n, grouped) for n, grouped in shape_nodes(doc) if shape_id(n) == str(op.get("shape_id"))]
        if len(matches) != 1:
            raise ValueError("Target shape ID is missing or ambiguous")
        shape, grouped = matches[0]
        action = op.get("op")
        shapes = shape_nodes(doc)
        order = next(i for i, (n, _) in enumerate(shapes) if n is shape)
        if any(pic["order"] > order for pic in full_page_pictures(parts, part, shapes, size)):
            raise ValueError("Target is below a full-page image: rebuild the image content as native objects before editing")
        if grouped:
            raise ValueError("Grouped objects require a group-aware editor")
        if action in ("set-text", "replace-text"):
            body = next(iter(children(shape, "p", "txBody")), None)
            if shape.localName != "sp" or body is None:
                raise ValueError("Text operation requires a native slide text shape")
            if action == "set-text":
                set_text(body, op.get("text"))
            else:
                replace_text(body, op.get("old"), op.get("new"))
        elif action == "table-cell":
            table = first(shape, "a", "tbl")
            row, column = op.get("row"), op.get("column")
            if table is None or not isinstance(row, int) or not isinstance(column, int) or row < 0 or column < 0:
                raise ValueError("Valid table row and column are required")
            rows = children(table, "a", "tr")
            if row >= len(rows) or column >= len(children(rows[row], "a", "tc")):
                raise ValueError("Table cell is outside the table")
            cell = children(rows[row], "a", "tc")[column]
            if cell.getAttribute("hMerge") in ("1", "true") or cell.getAttribute("vMerge") in ("1", "true"):
                raise ValueError("Edit the leading cell of a merged table region")
            set_text(first(cell, "a", "txBody"), op.get("text"))
        elif action == "geometry":
            transform = inherited_transform(parts, part, shape)
            position = geometry(transform)
            if position is None or int(transform.getAttribute("rot") or "0") or transform.getAttribute("flipH") in ("1", "true") or transform.getAttribute("flipV") in ("1", "true"):
                raise ValueError("Unsupported or missing object transform")
            for key in ("x", "y", "width", "height"):
                if key in op:
                    value = op[key]
                    if not isinstance(value, (float, int)) or isinstance(value, bool) or not math.isfinite(value) or abs(value) > 100000:
                        raise ValueError("Geometry values must be finite pixels within 100000")
                    if key in ("width", "height") and value <= 0:
                        raise ValueError("Object dimensions must be positive")
                    position[key] = value
            direct = own_transform(shape)
            if direct is None:
                container = next(iter(children(shape, "p", "spPr")), None)
                if container is None:
                    raise ValueError("Cannot materialize this inherited transform")
                direct = doc.importNode(transform, True)
                container.insertBefore(direct, container.firstChild)
            off, ext = first(direct, "a", "off"), first(direct, "a", "ext")
            for key, node, attr in (("x", off, "x"), ("y", off, "y"), ("width", ext, "cx"), ("height", ext, "cy")):
                node.setAttribute(attr, str(round(position[key] * EMU)))
        else:
            raise ValueError(f"Unsupported operation: {action}")
    for part, doc in documents.items():
        serialized = xml_bytes(doc)
        parse(serialized)
        parts[part] = serialized
    return sorted(documents)


def patch_file(source, patch, output):
    source = Path(source).resolve()
    expected = patch.get("expected_sha256")
    if not expected or digest(source) != expected:
        raise ValueError("Input SHA256 mismatch or missing: reload before applying changes")
    operations = patch.get("operations")
    if not isinstance(operations, list) or not operations or len(operations) > 1000:
        raise ValueError("Provide 1–1000 operations")
    parts, metadata = load_package(source)
    changed = apply_operations(parts, operations)
    write_package(output, parts, metadata)
    return {"output": str(Path(output).resolve()), "sha256": digest(output), "changed_parts": changed, "source_sha256": expected}


def build_file(template, plan, output):
    folder = Path(template)
    manifest = read_json(folder / "manifest.json")
    if manifest.get("status") != "approved":
        raise ValueError("Template rules must be confirmed before building")
    phase = plan.get("phase")
    if phase not in ("sample", "final"):
        raise ValueError("Build phase must be sample or final")
    gates = ("requirements", "outline", "samples") if phase == "final" else ("requirements", "outline")
    for gate in gates:
        record = plan.get("approvals", {}).get(gate, {})
        if not record.get("confirmed_by") or not record.get("note"):
            raise ValueError(f"Actual user confirmation required: {gate}")
    selected = plan.get("slides")
    if not isinstance(selected, list) or not selected or len(selected) > 500:
        raise ValueError("Provide 1–500 selected template pages")
    parts, metadata = load_package(folder / "reference.pptx")
    if digest(folder / "reference.pptx") != manifest["source_sha256"]:
        raise ValueError("Retained template reference changed")
    originals, _ = slide_parts(parts)
    content_types = parse(parts["[Content_Types].xml"])
    types = {n.getAttribute("PartName").lstrip("/"): n.getAttribute("ContentType") for n in nodes(content_types, "ct", "Override")}
    cloned = []
    # Each output page owns editable dependencies; structural themes and media are shared.
    for page_index, selection in enumerate(selected, 1):
        number = selection.get("source_slide")
        if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= len(originals):
            raise ValueError("Selected source slide is out of range")
        mapping = {}
        def clone(part):
            if part in mapping:
                return mapping[part]
            folder_name, basename = posixpath.split(part)
            stem, ext = posixpath.splitext(basename)
            target = f"{folder_name}/{stem}_studio_{page_index}{ext}"
            if target in parts:
                raise ValueError("Template contains conflicting generated part names")
            mapping[part] = target
            parts[target] = parts[part]
            if part in types:
                override = content_types.createElementNS(NS["ct"], "Override")
                override.setAttribute("PartName", "/" + target)
                override.setAttribute("ContentType", types[part])
                content_types.documentElement.appendChild(override)
            relname = rel_path(part)
            if relname in parts:
                doc = parse(parts[relname])
                for rel in nodes(doc, "rel", "Relationship"):
                    if rel.getAttribute("TargetMode") == "External":
                        continue
                    linked = resolve(part, rel.getAttribute("Target"))
                    kind = rel.getAttribute("Type").rsplit("/", 1)[-1]
                    if kind in ("slideLayout", "slideMaster", "notesMaster", "theme", "image", "audio", "video", "media"):
                        dest = linked
                    else:
                        if linked not in parts:
                            raise ValueError("Missing editable dependency: " + linked)
                        dest = clone(linked)
                    rel.setAttribute("Target", posixpath.relpath(dest, posixpath.dirname(target)))
                parts[rel_path(target)] = xml_bytes(doc)
            return target
        cloned.append(clone(originals[number - 1]))
    presentation = parse(parts["ppt/presentation.xml"])
    listing = first(presentation, "p", "sldIdLst")
    if listing is None:
        raise ValueError("Template has no slide list")
    for node in list(listing.childNodes):
        listing.removeChild(node)
    for custom in nodes(presentation, "p", "custShowLst") + nodes(presentation, "p", "extLst"):
        if custom.parentNode == presentation.documentElement:
            custom.parentNode.removeChild(custom)
    presrels = parse(parts[rel_path("ppt/presentation.xml")])
    for rel in list(nodes(presrels, "rel", "Relationship")):
        if rel.getAttribute("Type").endswith("/slide"):
            rel.parentNode.removeChild(rel)
    used_ids = {n.getAttribute("Id") for n in nodes(presrels, "rel", "Relationship")}
    for index, part in enumerate(cloned, 1):
        rid = "rIdStudio" + str(index)
        if rid in used_ids:
            raise ValueError("Conflicting presentation relationship ID")
        rel = presrels.createElementNS(NS["rel"], "Relationship")
        for key, value in {"Id": rid, "Type": NS["r"] + "/slide", "Target": posixpath.relpath(part, "ppt")}.items():
            rel.setAttribute(key, value)
        presrels.documentElement.appendChild(rel)
        sid = presentation.createElementNS(NS["p"], "p:sldId")
        sid.setAttribute("id", str(255 + index))
        sid.setAttributeNS(NS["r"], "r:id", rid)
        listing.appendChild(sid)
    parts["ppt/presentation.xml"] = xml_bytes(presentation)
    parts[rel_path("ppt/presentation.xml")] = xml_bytes(presrels)
    operations = []
    for index, selection in enumerate(selected, 1):
        operations.extend(dict(op, slide=index) for op in selection.get("operations", []))
    apply_operations(parts, operations)
    reachable = {"[Content_Types].xml", "_rels/.rels"}
    def visit(part):
        if part in reachable:
            return
        if part not in parts:
            raise ValueError("Missing relationship target: " + part)
        reachable.add(part)
        relname = rel_path(part)
        if relname in parts:
            reachable.add(relname)
            for rel in relationships(parts, part).values():
                if rel.getAttribute("TargetMode") != "External":
                    visit(resolve(part, rel.getAttribute("Target")))
    rootrels = parse(parts["_rels/.rels"])
    for rel in nodes(rootrels, "rel", "Relationship"):
        if rel.getAttribute("TargetMode") != "External":
            visit(resolve("", rel.getAttribute("Target")))
    for override in list(nodes(content_types, "ct", "Override")):
        if override.getAttribute("PartName").lstrip("/") not in reachable:
            override.parentNode.removeChild(override)
    parts["[Content_Types].xml"] = xml_bytes(content_types)
    parts = {name: data for name, data in parts.items() if name in reachable}
    # Selected output pages may inherit hidden state from a template; make them visible.
    for part in cloned:
        doc = parse(parts[part])
        if doc.documentElement.hasAttribute("show"):
            doc.documentElement.removeAttribute("show")
            parts[part] = xml_bytes(doc)
    write_package(output, parts, metadata)
    return {"output": str(Path(output).resolve()), "sha256": digest(output), "slide_count": len(cloned), "phase": phase}


def register(source, library, name):
    inspection = inspect_file(source)
    template_id = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")[:32] or "template"
    template_id += "-" + inspection["sha256"][:10]
    folder = Path(library).resolve() / "templates" / template_id
    if folder.exists():
        raise ValueError("Template already exists: " + str(folder))
    folder.mkdir(parents=True)
    shutil.copy2(source, folder / "reference.pptx")
    manifest = {"id": template_id, "name": name, "version": 1, "status": "draft", "created_at": now(),
                "source_path": str(Path(source).resolve()), "source_sha256": inspection["sha256"],
                "slide_count": len(inspection["slides"]), "slide_size": inspection["slide_size"]}
    save_json(folder / "manifest.json", manifest)
    save_json(folder / "inspection.json", inspection)
    candidates = [{"id": f"{template_id}-page-{s['number']}", "status": "candidate", "source_file": manifest["source_path"],
                   "source_sha256": manifest["source_sha256"], "slide": s["number"], "fact_date": None,
                   "scope": None, "text": "\n".join(e["text"] for e in s["elements"] if e["text"] and not e["hidden"] and not e["occluded_by_full_page_picture"]),
                   "image_text_review": "required" if any(e["occluded_by_full_page_picture"] and e["text"] for e in s["elements"]) or not any(e["text"] for e in s["elements"]) else "partial_visual_review_required"}
                  for s in inspection["slides"]]
    save_json(folder / "knowledge-candidates.json", candidates)
    return {"template": str(folder), "manifest": manifest}


def create_project(source, project):
    folder = Path(project).resolve()
    if folder.exists() and any(folder.iterdir()):
        raise ValueError("Project directory must be new or empty")
    inspect_file(source)
    (folder / "versions").mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, folder / "reference.pptx")
    shutil.copy2(source, folder / "versions" / "revision-000.pptx")
    state = {"created_at": now(), "source": str(Path(source).resolve()), "reference_sha256": digest(source),
             "revision": 0, "current": "versions/revision-000.pptx", "current_sha256": digest(source),
             "renders": {}, "compatibility": {"wps": "not_verified", "powerpoint": "not_verified"}}
    save_json(folder / "state.json", state)
    save_json(folder / "annotations.json", [])
    return {"project": str(folder), "state": state}


def project_path(folder, relative):
    target = (folder / relative).resolve()
    if not target.is_relative_to(folder.resolve()):
        raise ValueError("Project path escapes its workspace")
    return target


def render(source, output, engine):
    folder = Path(output).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    source = Path(source).resolve()
    if os.name != "nt":
        raise ValueError("Native WPS/PowerPoint rendering currently requires Windows")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                             str(HERE / "render.ps1"), "-Source", str(source), "-Output", str(folder), "-Engine", engine],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    report_file = folder / "native-render.json"
    if result.returncode != 0 or not report_file.exists():
        raise ValueError("Native rendering failed: " + (result.stderr or result.stdout)[-3000:])
    report = read_json(report_file)
    report.update({"source_sha256": digest(source), "created_at": now(), "visual_review": "pending"})
    save_json(report_file, report)
    return report


def apply_project(folder, payload, engine):
    state = read_json(folder / "state.json")
    source = project_path(folder, state["current"])
    if payload.get("expected_sha256") != digest(source):
        raise ValueError("The presentation changed; reload the canvas before applying")
    revision = state["revision"] + 1
    relative = f"versions/revision-{revision:03d}.pptx"
    report = patch_file(source, payload, folder / relative)
    save_json(folder / "versions" / f"revision-{revision:03d}.patch.json", payload)
    state.update({"revision": revision, "current": relative, "current_sha256": report["sha256"],
                  "renders": {}, "compatibility": {"wps": "not_verified", "powerpoint": "not_verified"}})
    save_json(folder / "state.json", state)
    try:
        target = f"previews/revision-{revision:03d}/{engine}"
        native = render(folder / relative, folder / target, engine)
        state["renders"][engine] = {"folder": target, "sha256": report["sha256"], "report": native}
        state["compatibility"][engine] = "rendered_review_pending"
        report["render"] = native
    except (ValueError, subprocess.TimeoutExpired) as e:
        report["render_error"] = str(e)
        state["compatibility"][engine] = "render_failed"
    save_json(folder / "state.json", state)
    return report


def import_revision(folder, source, expected_sha256, engine):
    """Import an authored deck while the canvas service is stopped."""
    folder = Path(folder).resolve()
    state = read_json(folder / "state.json")
    current = project_path(folder, state["current"])
    if expected_sha256 != state["current_sha256"] or expected_sha256 != digest(current):
        raise ValueError("The presentation changed; reload before importing")
    info = inspect_file(source)
    if info["sha256"] == expected_sha256:
        return {"unchanged": True, "sha256": expected_sha256}
    revision = state["revision"] + 1
    relative = f"versions/revision-{revision:03d}.pptx"
    with open(source, "rb") as incoming, open(folder / relative, "xb") as target:
        shutil.copyfileobj(incoming, target)
    new_hash = digest(folder / relative)
    if new_hash != info["sha256"]:
        raise ValueError("Source changed during import; current revision preserved")
    save_json(folder / "versions" / f"revision-{revision:03d}.import.json",
              {"source": str(Path(source).resolve()), "source_sha256": new_hash,
               "previous_sha256": expected_sha256, "imported_at": now()})
    state.update({"revision": revision, "current": relative, "current_sha256": new_hash,
                  "renders": {}, "compatibility": {"wps": "not_verified", "powerpoint": "not_verified"}})
    save_json(folder / "state.json", state)
    report = {"revision": revision, "sha256": new_hash, "slide_count": len(info["slides"])}
    try:
        target = f"previews/revision-{revision:03d}/{engine}"
        native = render(folder / relative, folder / target, engine)
        state["renders"][engine] = {"folder": target, "sha256": new_hash, "report": native}
        state["compatibility"][engine] = "rendered_review_pending"
        report["render"] = native
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        state["compatibility"][engine] = "render_failed"
        report["render_error"] = str(error)
    save_json(folder / "state.json", state)
    return report


def serve(folder, engine, port):
    folder = Path(folder).resolve()
    read_json(folder / "state.json")
    token = secrets.token_urlsafe(24)
    lock = threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, code, body, content_type="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            url = urlsplit(self.path)
            received = self.headers.get("X-Studio-Token") or parse_qs(url.query).get("token", [""])[0]
            host = self.headers.get("Host", "")
            origin = self.headers.get("Origin")
            return secrets.compare_digest(received, token) and host == f"127.0.0.1:{self.server.server_port}" and (not origin or origin == "http://" + host)

        def do_GET(self):
            try:
                path = urlsplit(self.path).path
                if path in ("/", "/canvas.js", "/canvas.css"):
                    if path == "/" and not self.authorized():
                        self.respond(403, {"error": "Open the canvas URL returned by the skill"})
                        return
                    name = {"/": "canvas.html", "/canvas.js": "canvas.js", "/canvas.css": "canvas.css"}[path]
                    kind = {"/": "text/html; charset=utf-8", "/canvas.js": "text/javascript; charset=utf-8", "/canvas.css": "text/css; charset=utf-8"}[path]
                    self.respond(200, (HERE.parent / "assets" / name).read_bytes(), kind)
                    return
                if not self.authorized():
                    self.respond(403, {"error": "Invalid local session"})
                    return
                if path == "/api/state":
                    state = read_json(folder / "state.json")
                    file = project_path(folder, state["current"])
                    info = inspect_file(file)
                    state["file_changed_externally"] = info["sha256"] != state["current_sha256"]
                    previews = state.get("renders", {}).get(engine)
                    if previews and previews["sha256"] != info["sha256"]:
                        previews = None
                    self.respond(200, {"state": state, "inspection": info, "engine": engine,
                                       "preview_available": bool(previews), "annotations": read_json(folder / "annotations.json")})
                elif path == "/api/file":
                    state = read_json(folder / "state.json")
                    file = project_path(folder, state["current"])
                    self.respond(200, file.read_bytes(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")
                elif re.fullmatch(r"/preview/\d+\.png", path):
                    state = read_json(folder / "state.json")
                    preview = state.get("renders", {}).get(engine)
                    if not preview or preview["sha256"] != digest(project_path(folder, state["current"])):
                        self.respond(404, {"error": "Actual render is unavailable or stale"})
                        return
                    number = int(path.rsplit("/", 1)[-1].split(".")[0])
                    if not 1 <= number <= preview["report"]["slide_count"]:
                        raise ValueError("Preview page out of range")
                    file = project_path(folder, preview["folder"] + f"/slide-{number:03d}.png")
                    self.respond(200, file.read_bytes(), "image/png")
                else:
                    self.respond(404, {"error": "Unknown endpoint"})
            except (ValueError, OSError, KeyError, zipfile.BadZipFile) as e:
                self.respond(400, {"error": str(e)})

        def do_POST(self):
            if not self.authorized():
                self.respond(403, {"error": "Invalid local session"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2 * 1024 * 1024:
                    raise ValueError("Invalid request size")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Request must be an object")
                path = urlsplit(self.path).path
                with lock:
                    if path == "/api/apply":
                        result = apply_project(folder, payload, engine)
                    elif path == "/api/annotations":
                        state = read_json(folder / "state.json")
                        if payload.get("expected_sha256") != digest(project_path(folder, state["current"])):
                            raise ValueError("Presentation changed; reload before saving annotations")
                        comment = payload.get("comment")
                        if not isinstance(comment, str) or not comment.strip() or len(comment) > 10000:
                            raise ValueError("Provide a comment of 1–10000 characters")
                        slide = payload.get("slide")
                        count = len(inspect_file(project_path(folder, state["current"]))["slides"])
                        if not isinstance(slide, int) or isinstance(slide, bool) or not 1 <= slide <= count:
                            raise ValueError("Annotation slide is invalid")
                        region = payload.get("region")
                        if region is not None:
                            if not isinstance(region, dict) or region.get("kind") not in ("box", "arrow"):
                                raise ValueError("Invalid annotation region")
                            for key in ("x1", "y1", "x2", "y2"):
                                v = region.get(key)
                                if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or abs(v) > 100000:
                                    raise ValueError("Invalid annotation coordinates")
                        comments = read_json(folder / "annotations.json")
                        comments.append({"id": secrets.token_hex(6), "created_at": now(), "status": "pending",
                                         "source_sha256": payload["expected_sha256"], "revision": state["revision"],
                                         "slide": slide, "shape_id": payload.get("shape_id"), "region": region, "comment": comment.strip()})
                        save_json(folder / "annotations.json", comments)
                        result = {"saved": True, "annotation": comments[-1]}
                    elif path == "/api/render":
                        state = read_json(folder / "state.json")
                        target = f"previews/revision-{state['revision']:03d}/{engine}"
                        file = project_path(folder, state["current"])
                        native = render(file, folder / target, engine)
                        state["renders"][engine] = {"folder": target, "sha256": digest(file), "report": native}
                        state["compatibility"][engine] = "rendered_review_pending"
                        save_json(folder / "state.json", state)
                        result = native
                    else:
                        self.respond(404, {"error": "Unknown endpoint"})
                        return
                self.respond(200, result)
            except (ValueError, OSError, KeyError, subprocess.TimeoutExpired, zipfile.BadZipFile) as e:
                self.respond(400, {"error": str(e)})
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/?token={token}", "project": str(folder), "engine": engine}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("inspect"); p.add_argument("--source", required=True); p.add_argument("--output", required=True)
    p = sub.add_parser("register"); p.add_argument("--source", required=True); p.add_argument("--library", required=True); p.add_argument("--name", required=True)
    p = sub.add_parser("list"); p.add_argument("--library", required=True)
    p = sub.add_parser("approve-template"); p.add_argument("--template", required=True); p.add_argument("--confirmed-by", required=True); p.add_argument("--note", required=True)
    p = sub.add_parser("project"); p.add_argument("--source", required=True); p.add_argument("--project", required=True)
    p = sub.add_parser("import-revision"); p.add_argument("--source", required=True); p.add_argument("--project", required=True); p.add_argument("--expected-sha256", required=True); p.add_argument("--engine", choices=("wps", "powerpoint"), default="wps")
    p = sub.add_parser("patch"); p.add_argument("--source", required=True); p.add_argument("--patch", required=True); p.add_argument("--output", required=True)
    p = sub.add_parser("build"); p.add_argument("--template", required=True); p.add_argument("--plan", required=True); p.add_argument("--output", required=True)
    p = sub.add_parser("render"); p.add_argument("--source", required=True); p.add_argument("--output", required=True); p.add_argument("--engine", choices=("wps", "powerpoint"), default="wps")
    p = sub.add_parser("serve"); p.add_argument("--project", required=True); p.add_argument("--port", type=int, default=0); p.add_argument("--engine", choices=("wps", "powerpoint"), default="wps")
    p = sub.add_parser("knowledge"); p.add_argument("--library", required=True); p.add_argument("--item", required=True); p.add_argument("--confirmed-by", required=True)
    args = parser.parse_args()
    if args.command == "inspect":
        data = inspect_file(args.source); save_json(args.output, data)
        result = {"inspection": str(Path(args.output).resolve()), "slide_count": len(data["slides"]), "sha256": data["sha256"]}
    elif args.command == "register":
        result = register(args.source, args.library, args.name)
    elif args.command == "list":
        result = [read_json(p) for p in sorted((Path(args.library) / "templates").glob("*/manifest.json"))]
    elif args.command == "approve-template":
        folder = Path(args.template)
        for name in ("visual-rules.md", "expression-rules.md"):
            if not (folder / name).is_file() or not (folder / name).read_text(encoding="utf-8").strip():
                raise ValueError("Complete and review template rules before approval")
        result = read_json(folder / "manifest.json")
        result.update({"status": "approved", "confirmation": {"confirmed_by": args.confirmed_by, "note": args.note, "at": now()}})
        save_json(folder / "manifest.json", result)
    elif args.command == "project":
        result = create_project(args.source, args.project)
    elif args.command == "import-revision":
        result = import_revision(args.project, args.source, args.expected_sha256, args.engine)
    elif args.command == "patch":
        result = patch_file(args.source, read_json(args.patch), args.output)
    elif args.command == "build":
        result = build_file(args.template, read_json(args.plan), args.output)
    elif args.command == "render":
        result = render(args.source, args.output, args.engine)
    elif args.command == "serve":
        serve(args.project, args.engine, args.port); return
    elif args.command == "knowledge":
        item = read_json(args.item)
        for field in ("text", "source_file", "source_sha256", "slide", "scope", "fact_date", "time_sensitive"):
            if field not in item:
                raise ValueError("Knowledge item missing: " + field)
        if not item["text"] or not item["scope"] or not isinstance(item["slide"], int) or item["slide"] < 1 or not isinstance(item["time_sensitive"], bool):
            raise ValueError("Knowledge text, scope, page and sensitivity must be explicit")
        source_info = inspect_file(item["source_file"])
        if item["source_sha256"] != source_info["sha256"] or item["slide"] > len(source_info["slides"]):
            raise ValueError("Knowledge source or page does not match")
        key = hashlib.sha256((item["source_sha256"] + str(item["slide"]) + item["text"]).encode("utf-8")).hexdigest()[:16]
        target = Path(args.library) / "knowledge" / (key + ".json")
        if target.exists():
            raise ValueError("Knowledge fact already exists")
        item.update({"id": key, "status": "confirmed", "confirmation": {"confirmed_by": args.confirmed_by, "at": now()}})
        save_json(target, item)
        result = {"knowledge": str(target.resolve())}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
