"""Make a PDF printer-friendly: remove images and colored blocks, keep the text readable.
Needs: pip install pymupdf"""
import re
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:  # older PyMuPDF
    import fitz

TOKEN_RE = re.compile(
    rb"""(?P<str>\((?:\\.|[^\\()])*\))|(?P<hex><[0-9A-Fa-f\s]*>)|(?P<dict><<|>>)|(?P<arr>[\[\]])"""
    rb"""|(?P<name>/[^\s/\[\]()<>%]*)|(?P<cmt>%[^\r\n]*)|(?P<num>[+-]?(?:\d+\.?\d*|\.\d+))"""
    rb"""|(?P<op>[A-Za-z'"][A-Za-z0-9'"*]*)|(?P<ws>\s+)|(?P<other>.)""", re.S)

FILL_OPS = {b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"}
TEXT_OPS = {b"Tj", b"TJ", b"'", b'"'}
GRAY_SPACES = {b"/DeviceGray", b"/G", b"/CalGray"}
PATH_END = FILL_OPS | {b"S", b"s", b"n"}
PATH_BUILD = {b"m", b"l", b"c", b"v", b"y", b"re"}
MIN_SIDE, MIN_AREA = 12.0, 600.0  # a filled shape this big is a "block", smaller ones are lines/icons


def _points(op, n):
    if op in (b"m", b"l") and len(n) == 2:
        return [(n[0], n[1])]
    if op == b"c" and len(n) == 6:
        return [(n[0], n[1]), (n[2], n[3]), (n[4], n[5])]
    if op in (b"v", b"y") and len(n) == 4:
        return [(n[0], n[1]), (n[2], n[3])]
    if op == b"re" and len(n) == 4:
        return [(n[0], n[1]), (n[0] + n[2], n[1] + n[3])]
    return []


def _is_block(bb):
    if not bb:
        return False
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    return w >= MIN_SIDE and h >= MIN_SIDE and w * h >= MIN_AREA


def _colored(rgb):
    return max(rgb) - min(rgb) > 0.15


def _cmyk(c, m, y, k):
    return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))


def transform_stream(data, whiten_blocks=True, darken_white_text=True):
    """Insert explicit colour changes around fills/text; never edits existing operands."""
    out, args = [], []
    seg = 0  # index in `out` where the operands of the current statement begin
    fill, restore, cs_stmt = None, None, None
    stack = []
    bbox = None  # bounding box of the path being built
    for m in TOKEN_RE.finditer(data):
        kind = m.lastgroup
        tok = m.group(0)
        out.append(tok)
        if kind in ("ws", "cmt"):
            continue
        if kind != "op":
            if kind in ("num", "name", "str", "hex", "arr", "dict", "other"):
                args.append((kind, tok))
            continue
        op = tok
        stmt = b"".join(out[seg:])
        nums = [float(a[1]) for a in args if a[0] == "num"]
        has_name = any(a[0] == "name" for a in args)
        if op in PATH_BUILD:
            pts = _points(op, nums)
            if pts:
                xs, ys = [q[0] for q in pts], [q[1] for q in pts]
                nb = [min(xs), min(ys), max(xs), max(ys)]
                bbox = nb if bbox is None else [min(bbox[0], nb[0]), min(bbox[1], nb[1]),
                                                max(bbox[2], nb[2]), max(bbox[3], nb[3])]
        elif op == b"q":
            stack.append((fill, restore, cs_stmt))
        elif op == b"Q":
            if stack:
                fill, restore, cs_stmt = stack.pop()
        elif op == b"cs":
            cs_stmt = stmt
            fill, restore = None, None
            cs_name = args[-1][1] if args else b""
            cs_stmt = (cs_name, stmt)
        elif op == b"g" and len(nums) == 1:
            fill, restore, cs_stmt = (nums[0],) * 3, stmt, None
        elif op == b"rg" and len(nums) == 3:
            fill, restore, cs_stmt = tuple(nums), stmt, None
        elif op == b"k" and len(nums) == 4:
            fill, restore, cs_stmt = _cmyk(*nums), stmt, None
        elif op in (b"sc", b"scn") and not has_name:
            base = (cs_stmt[1] + b"\n") if isinstance(cs_stmt, tuple) else b""
            space = cs_stmt[0] if isinstance(cs_stmt, tuple) else b""
            if len(nums) == 3:
                fill = tuple(nums)
            elif len(nums) == 4:
                fill = _cmyk(*nums)
            elif len(nums) == 1 and space in GRAY_SPACES:
                fill = (nums[0],) * 3
            else:
                fill = None
            restore = base + stmt if fill is not None else None
        elif op in (b"sc", b"scn"):  # pattern etc.
            fill, restore = None, None
        elif (op in FILL_OPS and whiten_blocks and fill and restore and _is_block(bbox)
              and (_colored(fill) or sum(fill) / 3 < 0.5)):
            out.insert(seg, b"\n1 1 1 rg\n")
            out.append(b"\n" + restore + b"\n")
        elif op in TEXT_OPS and darken_white_text and fill and restore and min(fill) >= 0.85:
            out.insert(seg, b"\n0 g\n")
            out.append(b"\n" + restore + b"\n")
        if op in PATH_END:
            bbox = None
        seg = len(out)
        args = []
    return b"".join(out)


BACKGROUND_SHARE = 0.6  # an image covering this share of the page is a template, not a picture
DARK = 150  # template pixels darker than this (0-255 gray) stay black, the rest turns white


def _lighten(doc, page, xref):
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha or pix.n != 1:
        pix = fitz.Pixmap(fitz.csGRAY, pix)
    lut = bytes(0 if v < DARK else 255 for v in range(256))
    pix = fitz.Pixmap(fitz.csGRAY, pix.width, pix.height, bytes(pix.samples).translate(lut), False)
    page.replace_image(xref, pixmap=pix)


def _form_children(doc, xref):
    obj = doc.xref_object(xref)
    m = re.search(r"/Resources\s+(\d+)\s+0\s+R", obj)
    if m:
        obj = obj + doc.xref_object(int(m.group(1)))
    found = set()
    for sec in re.finditer(r"/XObject\s*<<(.*?)>>", obj, re.S):
        found.update(int(x) for x in re.findall(r"(\d+)\s+0\s+R", sec.group(1)))
    return [x for x in found if doc.xref_get_key(x, "Subtype")[1] == "/Form"]


def _page_forms(doc, page):
    seen, todo = set(), [x[0] for x in page.get_xobjects()]
    todo = [x for x in todo if doc.xref_get_key(x, "Subtype")[1] == "/Form"]
    while todo:
        x = todo.pop()
        if x in seen:
            continue
        seen.add(x)
        todo.extend(_form_children(doc, x))
    return seen


def clean_pdf(src):
    """Returns (dst_path or None, graphics_cleaned: bool).
    None = the PDF has no real text (a scan): nothing is changed."""
    src = Path(src)
    doc = fitz.open(str(src))
    try:
        text_pages = [i for i, pg in enumerate(doc) if pg.get_text().strip()]
        if not text_pages:
            return None, False
        # 1) images. An image that covers most of a page is usually the page template itself (headings, boxes:
        #    Mei Modiin, arnona): keep only its dark parts in black and white instead of deleting it.
        for pg in doc:
            area = pg.rect.width * pg.rect.height
            for img in pg.get_images(full=True):
                rects = pg.get_image_rects(img[0])
                if rects and max(r.width * r.height for r in rects) >= BACKGROUND_SHARE * area:
                    try:
                        _lighten(doc, pg, img[0])
                        continue
                    except Exception as e:
                        print("lighten skipped:", e)
                pg.delete_image(img[0])
        before = {i: doc[i].get_text() for i in text_pages}
        dst = src.with_name(src.stem + "_noimg.pdf")
        doc.save(str(dst), garbage=3, deflate=True)
        # 2) colored blocks (only on pages that have real text)
        graphics_ok = False
        try:
            doc2 = fitz.open(str(dst))
            try:
                other = set()
                for i, pg in enumerate(doc2):
                    if i not in text_pages:
                        other |= _page_forms(doc2, pg)
                done = set()
                for i in text_pages:
                    pg = doc2[i]
                    darken = True
                    xrefs = pg.get_contents()
                    if xrefs:
                        new = transform_stream(pg.read_contents(), True, darken)
                        doc2.update_stream(xrefs[0], new)
                        for x in xrefs[1:]:
                            doc2.update_stream(x, b" ")
                    for fx in _page_forms(doc2, pg) - other - done:
                        raw = doc2.xref_stream(fx)
                        if raw:
                            doc2.update_stream(fx, transform_stream(raw, True, darken))
                        done.add(fx)
                tmp = dst.with_name(dst.stem + "_tmp.pdf")
                doc2.save(str(tmp), garbage=3, deflate=True)
            finally:
                doc2.close()
            check = fitz.open(str(tmp))
            try:
                ok = all(check[i].get_text() == before[i] for i in text_pages)
                for pg in check:
                    pg.get_pixmap(dpi=20)  # must still render
            finally:
                check.close()
            if ok:
                tmp.replace(dst)
                graphics_ok = True
            else:
                tmp.unlink()
        except Exception as e:
            print("graphics cleaning skipped:", e)
        return dst, graphics_ok
    finally:
        doc.close()
