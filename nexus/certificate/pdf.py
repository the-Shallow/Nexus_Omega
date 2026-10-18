"""Recovery certificates as print-ready PDF, with no dependencies.

A tiny PDF 1.4 writer (Letter pages; the standard Helvetica, Helvetica-Bold,
Courier and Symbol fonts; WinAnsi text) and two layouts built on it:

    render_certificate_pdf(cert)    a twin certificate from nexus.doctors
    render_recording_pdf(detail)    a recorded fleet run from nexus.recordings

Every value printed comes from the record; anything missing prints as "–".
"""

from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from functools import lru_cache

__all__ = ["render_certificate_pdf", "render_recording_pdf", "sanitize_text"]

# ------------------------------------------------------------------ geometry

PAGE_W, PAGE_H = 612.0, 792.0  # US Letter
MARGIN = 56.0
CONTENT_W = PAGE_W - 2 * MARGIN
BAND_H = 40.0  # graphite header band
RULE_H = 2.0  # NVIDIA-green rule under it
BODY_TOP = BAND_H + RULE_H + 30.0
BODY_BOTTOM = PAGE_H - 66.0  # the footer lives below this
DASH = "\u2013"  # en dash, WinAnsi 0x96: printed for every missing value
SEP = "  \xb7  "  # middle dot, WinAnsi 0xB7

# ------------------------------------------------------------------- palette

GRAPHITE = "#0b0f12"
NV_GREEN = "#76b900"
WHITE = "#ffffff"
INK = "#0f172a"
BODY = "#1e293b"
MUTED = "#64748b"
FAINT = "#94a3b8"
HAIR = "#e2e8f0"
OUTCOME = {"VERIFIED": "#4d7c0f", "ROLLED_BACK": "#be123c", "REQUIRES_APPROVAL": "#b45309", "ABSTAIN": "#475569"}
TAG = {True: ("#3f6212", "#ecfccb"), False: ("#be123c", "#ffe4e6"), None: ("#64748b", "#f1f5f9")}

REG, BOLD, MONO, SYM = "F1", "F2", "F3", "F4"
FONTS = {REG: "Helvetica", BOLD: "Helvetica-Bold", MONO: "Courier", SYM: "Symbol"}

# Standard Adobe AFM advance widths (1/1000 em) for WinAnsi codes 32..255.
_HELVETICA = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
    556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
    350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
)
_HELVETICA_BOLD = (
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
    556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
    350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
)
_SYMBOL_OMEGA = 768  # "W" (0x57) in the Symbol font is the Greek capital Omega

# --------------------------------------------------------------------- text

_REPLACEMENTS = {
    "\t": " ", "\n": " ", "\r": " ",  # the no-break space (WinAnsi 0xA0) stays: lines never wrap at it
    "\u03a9": "Omega", "\u2126": "Omega", "\u03c9": "omega", "\u0394": "Delta", "\u2206": "Delta",
    "\u03b4": "delta", "\u03b1": "alpha", "\u03b2": "beta", "\u03bb": "lambda", "\u03c3": "sigma",
    "\u03bc": "\xb5",
    "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21d2": "=>", "\u21a9": "<-", "\u21aa": "->",
    "\u27f6": "->", "\u2794": "->", "\u279c": "->", "\u2191": "^", "\u2193": "v",
    "\u2265": ">=", "\u2264": "<=", "\u2260": "!=", "\u2248": "~", "\u223c": "~", "\u2212": "-",
    "\u221e": "inf", "\u22c5": "\xb7", "\u2219": "\xb7",
    "\u2713": "PASS", "\u2714": "PASS", "\u2705": "PASS", "\u2611": "PASS",
    "\u2717": "FAIL", "\u2718": "FAIL", "\u274c": "FAIL",
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2043": "-",
    "\u26a0": "!",
}


def _winansi(ch: str) -> bool:
    try:
        ch.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True


def sanitize_text(value) -> str:
    """Text the standard fonts can show: WinAnsi characters kept, others mapped to ASCII."""
    text = unicodedata.normalize("NFC", value if isinstance(value, str) else str(value))
    out = []
    for ch in text:
        rep = _REPLACEMENTS.get(ch)
        if rep is not None:
            out.append(rep)
            continue
        cat = unicodedata.category(ch)
        if cat in ("Cc", "Cf", "Mn", "Me", "Cs"):
            continue
        if _winansi(ch):
            out.append(ch)
        elif cat.startswith("Z"):
            out.append(" ")
        else:
            base = "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c) and _winansi(c))
            out.append(base or "?")
    return "".join(out)


def _escape(text: str) -> str:
    raw = text.encode("cp1252", "replace").decode("latin-1")
    return raw.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _width(text: str, font: str, size: float, spacing: float = 0.0) -> float:
    data = text.encode("cp1252", "replace")
    if font == MONO:
        units = 600 * len(data)
    elif font == SYM:
        units = sum(_SYMBOL_OMEGA if b == 0x57 else 600 for b in data)
    else:
        table = _HELVETICA_BOLD if font == BOLD else _HELVETICA
        units = sum(table[b - 32] for b in data if b >= 32)
    return units * size / 1000 + spacing * len(data)


def _split_long(word: str, font: str, size: float, width: float) -> list[str]:
    """Break a token wider than the line, preferring a cut after / - _ , . : =."""
    chunks = []
    while word and _width(word, font, size) > width:
        n, acc = 0, 0.0
        for ch in word:
            w = _width(ch, font, size)
            if n and acc + w > width:
                break
            acc += w
            n += 1
        cut = max((i + 1 for i in range(n // 2, n) if word[i] in "/-_,.:=;)]}"), default=n)
        chunks.append(word[:cut])
        word = word[cut:]
    chunks.append(word)
    return chunks


def _wrap_runs(runs: list[tuple[str, str, str]], size: float, width: float) -> list[list[tuple[str, str, str]]]:
    """Greedy word wrap over styled runs [(text, font, color)] into lines of segments."""
    tokens: list[tuple[str, str, str, bool]] = []  # word, font, color, glued to the previous word
    ended_with_space = True
    for text, font, color in runs:
        text = sanitize_text(text)
        if not text:
            continue
        for j, part in enumerate(text.split(" ")):
            if part:
                tokens.append((part, font, color, j == 0 and not ended_with_space and bool(tokens)))
        ended_with_space = text.endswith(" ")
    lines: list[list[tuple[str, str, str, bool]]] = []
    line: list[tuple[str, str, str, bool]] = []
    used = 0.0
    for word, font, color, glued in tokens:
        w = _width(word, font, size)
        gap = 0.0 if glued or not line else _width(" ", font, size)
        if line and used + gap + w > width:
            lines.append(line)
            line, used, gap = [], 0.0, 0.0
        if not line and w > width:
            *head, word = _split_long(word, font, size, width)
            lines.extend([(chunk, font, color, False)] for chunk in head)
            w = _width(word, font, size)
        line.append((word, font, color, gap > 0))
        used += gap + w
    if line:
        lines.append(line)
    merged = []
    for line in lines:
        segs: list[list[str]] = []
        for word, font, color, space in line:
            piece = (" " if space else "") + word
            if segs and segs[-1][1] == font and segs[-1][2] == color:
                segs[-1][0] += piece
            else:
                segs.append([piece, font, color])
        merged.append([(t, f, c) for t, f, c in segs])
    return merged


def _baseline(size: float, leading: float) -> float:
    """Baseline offset that centres cap height in a line box of `leading` points."""
    return (leading + 0.7 * size) / 2


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


# ------------------------------------------------------------- PDF drawing


def _n(value: float) -> str:
    s = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


@lru_cache(maxsize=None)
def _rgb(color: str) -> str:
    h = color.lstrip("#")
    return " ".join((f"{int(h[i:i + 2], 16) / 255:.3f}".rstrip("0").rstrip(".") or "0") for i in (0, 2, 4))


def _rrect_path(x: float, y: float, w: float, h: float, r: float) -> str:
    """A rounded rectangle path in PDF space ((x, y) is the bottom-left corner)."""
    r = max(0.0, min(r, w / 2, h / 2))
    k = r * 0.5523
    return " ".join([
        f"{_n(x + r)} {_n(y)} m {_n(x + w - r)} {_n(y)} l",
        f"{_n(x + w - r + k)} {_n(y)} {_n(x + w)} {_n(y + r - k)} {_n(x + w)} {_n(y + r)} c",
        f"{_n(x + w)} {_n(y + h - r)} l",
        f"{_n(x + w)} {_n(y + h - r + k)} {_n(x + w - r + k)} {_n(y + h)} {_n(x + w - r)} {_n(y + h)} c",
        f"{_n(x + r)} {_n(y + h)} l",
        f"{_n(x + r - k)} {_n(y + h)} {_n(x)} {_n(y + h - r + k)} {_n(x)} {_n(y + h - r)} c",
        f"{_n(x)} {_n(y + r)} l",
        f"{_n(x)} {_n(y + r - k)} {_n(x + r - k)} {_n(y)} {_n(x + r)} {_n(y)} c h",
    ])


class _Doc:
    """Top-down layout over Letter pages. `y` is measured from the top edge."""

    SECTION_H = 39.0  # gap + label + rule above a section's first block

    def __init__(self, ref: str, footer: list[tuple[str, str]]) -> None:
        self.ref = ref
        self.footer = footer
        self.pages: list[list[str]] = []
        self.ops: list[str] = []
        self.y = BODY_TOP
        self._section: str | None = None
        self.new_page()

    # -------------------------------------------------------------- paging

    def new_page(self) -> None:
        self.ops = []
        self.pages.append(self.ops)
        self._header()
        self.y = BODY_TOP

    def ensure(self, height: float) -> None:
        """Start a new page unless `height` more points fit (or this page is still empty).

        A pending section label is drawn here, so it always lands on the same
        page as the first block under it.
        """
        label = self.SECTION_H if self._section else 0.0
        if self.y + label + height > BODY_BOTTOM and self.y > BODY_TOP + 1:
            self.new_page()
        if self._section:
            title, self._section = self._section, None
            self.y += 24 if self.y > BODY_TOP + 1 else 9
            self.text(MARGIN, self.y, title.upper(), BOLD, 7, MUTED, cs=1.3)
            self.y += 6
            self.rule(self.y)
            self.y += 9

    def space(self, height: float) -> None:
        self.y += height

    def build(self, title: str) -> bytes:
        total = len(self.pages)
        for number, ops in enumerate(self.pages, 1):
            self.ops = ops
            self._footer(number, total)
        return _assemble(["\n".join(ops).encode("latin-1") for ops in self.pages], title)

    def _header(self) -> None:
        self.rect(0, 0, PAGE_W, BAND_H, GRAPHITE)
        self.rect(0, BAND_H, PAGE_W, RULE_H, NV_GREEN)
        base = BAND_H / 2 + 4.3
        self.text(MARGIN, base, "NEXUS", BOLD, 12, WHITE, cs=2.6)
        self.text(MARGIN + _width("NEXUS", BOLD, 12, 2.6) + 2.2, base + 0.2, "W", SYM, 13.5, WHITE)  # Ω
        label = self.ref if len(self.pages) == 1 else f"Recovery Certificate{SEP}{self.ref}"
        self.text(PAGE_W - MARGIN, base - 0.4, label, REG, 7.5, "#9aa4af", align="right")

    def _footer(self, number: int, total: int) -> None:
        top = PAGE_H - 46
        self.rule(top)
        self.text(PAGE_W - MARGIN, top + 13, f"Page {number} of {total}", REG, 7, MUTED, align="right")
        label_w = max((_width(label.upper(), BOLD, 6.2, 0.7) for label, _ in self.footer), default=0) + 8
        y = top + 13
        for label, value in self.footer:
            self.text(MARGIN, y, label.upper(), BOLD, 6.2, FAINT, cs=0.7)
            for line in _wrap_runs([(value, MONO, MUTED)], 6.8, CONTENT_W - label_w - 70)[:2]:
                self.segments(MARGIN + label_w, y, line, 6.8)
                y += 9

    # ---------------------------------------------------------- primitives

    def rect(self, x: float, top: float, w: float, h: float, fill: str) -> None:
        self.ops.append(f"{_rgb(fill)} rg {_n(x)} {_n(PAGE_H - top - h)} {_n(w)} {_n(h)} re f")

    def rule(self, top: float, x0: float = MARGIN, x1: float = PAGE_W - MARGIN, color: str = HAIR, width: float = 0.6) -> None:
        y = _n(PAGE_H - top)
        self.ops.append(f"{_rgb(color)} RG {_n(width)} w {_n(x0)} {y} m {_n(x1)} {y} l S")

    def round_rect(self, x: float, top: float, w: float, h: float, r: float, fill: str, stroke: str | None = None) -> None:
        path = _rrect_path(x, PAGE_H - top - h, w, h, r)
        if stroke:
            self.ops.append(f"{_rgb(fill)} rg {_rgb(stroke)} RG 0.7 w {path} B")
        else:
            self.ops.append(f"{_rgb(fill)} rg {path} f")

    def circle(self, cx: float, cy: float, r: float, fill: str) -> None:
        path = _rrect_path(cx - r, PAGE_H - cy - r, 2 * r, 2 * r, r)
        self.ops.append(f"{_rgb(fill)} rg {_rgb(WHITE)} RG 1.6 w {path} B")

    def text(self, x: float, baseline: float, s: str, font: str = REG, size: float = 9.0, color: str = BODY,
             cs: float = 0.0, align: str = "left") -> float:
        """Draw one line of text; returns its advance width."""
        s = s if font == SYM else sanitize_text(s)
        w = _width(s, font, size, cs)
        if not s:
            return 0.0
        if align == "right":
            x -= w - cs
        elif align == "center":
            x -= (w - cs) / 2
        self.ops.append(f"BT /{font} {_n(size)} Tf {_rgb(color)} rg {_n(cs)} Tc {_n(x)} {_n(PAGE_H - baseline)} Td ({_escape(s)}) Tj ET")
        return w

    def segments(self, x: float, baseline: float, line: list[tuple[str, str, str]], size: float,
                 align: str = "left", right: float = 0.0) -> None:
        if align == "right":
            x = right - sum(_width(t, f, size) for t, f, _ in line)
        for text, font, color in line:
            x += self.text(x, baseline, text, font, size, color)

    def flow(self, runs, x: float = MARGIN, width: float = CONTENT_W, size: float = 9.2, leading: float | None = None,
             font: str = REG, color: str = BODY) -> None:
        """Wrap text (a string or [(text, font, color)]) at the cursor, breaking pages between lines."""
        if isinstance(runs, str):
            runs = [(runs, font, color)]
        leading = leading or round(size * 1.42, 2)
        for line in _wrap_runs(runs, size, width):
            self.ensure(leading)
            self.segments(x, self.y + _baseline(size, leading), line, size)
            self.y += leading

    # -------------------------------------------------------------- blocks

    def title(self, title: str, subtitle: str) -> None:
        self.text(MARGIN, self.y + 17, title, BOLD, 23, INK, cs=-0.2)
        self.y += 27
        self.flow(subtitle, size=11, leading=15, color=MUTED)

    def outcome(self, label: str, state, reason_runs: list) -> None:
        color = OUTCOME.get(state, OUTCOME["ABSTAIN"]) if isinstance(state, str) else FAINT
        top = self.y + 16
        self.text(MARGIN + 15, top + 7, label.upper(), BOLD, 6.5, MUTED, cs=1.1)
        self.text(MARGIN + 15, top + 37, state.replace("_", " ") if isinstance(state, str) and state else DASH, BOLD, 30, color, cs=0.3)
        self.y = top + 46
        if reason_runs:
            self.flow(reason_runs, x=MARGIN + 15, width=CONTENT_W - 15, size=10, leading=14)
        self.rect(MARGIN, top, 3, self.y - top, color)

    def callout(self, runs: list, fill: str, stroke: str, x: float = MARGIN) -> None:
        pad, size, leading = 8.0, 9.5, 13.5
        width = PAGE_W - MARGIN - x
        lines = _wrap_runs(runs, size, width - 2 * pad)
        h = len(lines) * leading + 2 * pad - 3
        self.ensure(h + 8)
        top = self.y + 6
        self.round_rect(x, top, width, h, 4, fill, stroke)
        y = top + pad - 1.5
        for line in lines:
            self.segments(x + pad, y + _baseline(size, leading), line, size)
            y += leading
        self.y = top + h

    def badge(self, runs: list, fill: str, stroke: str) -> None:
        size, leading, padx, pady = 7.6, 11.0, 9.0, 4.0
        lines = _wrap_runs(runs, size, CONTENT_W - 2 * padx)
        w = max(sum(_width(t, f, size) for t, f, _ in line) for line in lines) + 2 * padx
        h = len(lines) * leading + 2 * pady
        top = self.y + 14
        self.round_rect(MARGIN, top, w, h, min(h / 2, 8), fill, stroke)
        y = top + pady
        for line in lines:
            self.segments(MARGIN + padx, y + _baseline(size, leading), line, size)
            y += leading
        self.y = top + h

    def section(self, title: str) -> None:
        """A small uppercase label, drawn with the next block (see ensure)."""
        self._section = title

    def grid(self, cells: list[tuple], cols: int = 3) -> None:
        """Label-over-value cells; a cell is (label, value, span, mono)."""
        gap = 18.0
        col_w = (CONTENT_W - gap * (cols - 1)) / cols
        rows, row, used = [], [], 0
        for cell in cells:
            span = max(1, min(cell[2], cols))
            if used + span > cols:
                rows.append(row)
                row, used = [], 0
            row.append((cell, span))
            used += span
        if row:
            rows.append(row)
        for row in rows:
            laid, x = [], MARGIN
            for (label, value, _, mono), span in row:
                w = col_w * span + gap * (span - 1)
                text = _clip(_txt(value), 900)
                size = 8.8 if mono else 9.5
                lines = _wrap_runs([(text, MONO if mono else REG, FAINT if text == DASH else INK)], size, w)
                laid.append((x, label, lines, size))
                x += w + gap
            h = 11 + max(len(lines) for _, _, lines, _ in laid) * 13 + 9
            self.ensure(h)
            for x, label, lines, size in laid:
                self.text(x, self.y + 6.5, label.upper(), BOLD, 6.2, FAINT, cs=0.9)
                y = self.y + 10
                for line in lines:
                    self.segments(x, y + _baseline(size, 13), line, size)
                    y += 13
            self.y += h

    def timeline(self, points: list[tuple]) -> None:
        """Milestones (label, value, note) evenly spaced on a line; not to scale."""
        n = len(points)
        h = 64.0
        self.ensure(h)
        top, x0, x1 = self.y, MARGIN + 3.5, PAGE_W - MARGIN - 3.5
        line_y = top + 24
        self.rule(line_y, x0, x1, "#cbd5e1", 1.0)
        for i, (label, value, note) in enumerate(points):
            x = x0 + (x1 - x0) * i / (n - 1) if n > 1 else x0
            align = "left" if i == 0 else ("right" if i == n - 1 else "center")
            tx = x - 3.5 if align == "left" else (x + 3.5 if align == "right" else x)
            value = _txt(value)
            known = value != DASH
            self.circle(x, line_y, 3.5, NV_GREEN if known else "#cbd5e1")
            self.text(tx, top + 11, label.upper(), BOLD, 6.2, MUTED, cs=0.8, align=align)
            self.text(tx, line_y + 18, value, BOLD, 10.5, INK if known else FAINT, align=align)
            if note not in (None, ""):
                self.text(tx, line_y + 30, _txt(note), REG, 7.5, MUTED, align=align)
        self.y = top + h

    def table(self, headers: list[str], rows: list[list], widths: list[float]) -> None:
        aligns = ["left"] + ["right"] * (len(headers) - 1)

        def head() -> None:
            x = MARGIN
            for text, w, a in zip(headers, widths, aligns):
                self.text(x if a == "left" else x + w, self.y + 8, text.upper(), BOLD, 6.2, MUTED, cs=0.8, align=a)
                x += w
            self.y += 13
            self.rule(self.y, color="#cbd5e1", width=0.8)

        laid = []
        for row in rows:
            cells = []
            for i, (value, w) in enumerate(zip(row, widths)):
                text = _clip(_txt(value), 300)
                color = FAINT if text == DASH else (BODY if i == 0 else INK)
                cells.append(_wrap_runs([(text, REG, color)], 9.5, w - (12 if i == 0 else 0)))
            laid.append((cells, max(len(c) for c in cells) * 13 + 7))
        # Keep the table on one page when it fits on one.
        self.ensure(min(13 + sum(h for _, h in laid), BODY_BOTTOM - BODY_TOP - self.SECTION_H))
        head()
        for cells, h in laid:
            if self.y + h > BODY_BOTTOM:
                self.new_page()
                head()
            x = MARGIN
            for i, (lines, w) in enumerate(zip(cells, widths)):
                y = self.y + 3.5
                for line in lines:
                    self.segments(x, y + _baseline(9.5, 13), line, 9.5, align=aligns[i], right=x + w)
                    y += 13
                x += w
            self.y += h
            self.rule(self.y, width=0.5)

    def check(self, passed: bool | None, name: str, detail: str | None = None, tag: str | None = None, tag_w: float = 38.0) -> None:
        """One PASS/FAIL row (or another tag, coloured by `passed`)."""
        tag = tag or ("PASS" if passed is True else "FAIL" if passed is False else DASH)
        fg, bg = TAG[passed if isinstance(passed, bool) else None]
        x_name = MARGIN + tag_w + 11
        det_w = 165.0 if detail else 0.0
        name_lines = _wrap_runs([(_clip(name, 400), REG, INK)], 9.5, PAGE_W - MARGIN - x_name - det_w - (14 if detail else 0))
        det_lines = _wrap_runs([(_clip(detail, 400), REG, MUTED)], 8.2, det_w) if detail else []
        h = max(len(name_lines) * 13, len(det_lines) * 11.5) + 8
        self.ensure(h)
        self.round_rect(MARGIN, self.y + 2.5, tag_w, 12.5, 3, bg)
        self.text(MARGIN + tag_w / 2, self.y + 11.2, tag, BOLD, 6.6, fg, cs=0.6, align="center")
        y = self.y + 2
        for line in name_lines:
            self.segments(x_name, y + _baseline(9.5, 13), line, 9.5)
            y += 13
        y = self.y + 2.8
        for line in det_lines:
            self.segments(0, y + _baseline(8.2, 11.5), line, 8.2, align="right", right=PAGE_W - MARGIN)
            y += 11.5
        self.y += h

    def kv(self, label: str, value, mono: bool = False, color: str = INK) -> None:
        """A definition row: small label column, wrapped value."""
        label_w, leading = 108.0, 13.0
        text = _clip(_txt(value), 900)
        size = 8.6 if mono else 9.3
        lines = _wrap_runs([(text, MONO if mono else REG, FAINT if text == DASH else color)], size, CONTENT_W - label_w)
        self.ensure(len(lines) * leading + 3)
        self.text(MARGIN, self.y + _baseline(9.3, leading), label, BOLD, 7.6, MUTED)
        for line in lines:
            self.segments(MARGIN + label_w, self.y + _baseline(size, leading), line, size)
            self.y += leading
        self.y += 3

    def kv_tag(self, label: str, passed: bool | None, tag: str, runs: list, tag_w: float = 60.0) -> None:
        """A definition row whose value starts with a coloured tag (policy decisions)."""
        label_w, leading, size = 108.0, 13.0, 9.3
        x_tag = MARGIN + label_w
        x_text = x_tag + tag_w + 9
        lines = _wrap_runs(runs, size, PAGE_W - MARGIN - x_text)
        self.ensure(len(lines) * leading + 5)
        fg, bg = TAG[passed if isinstance(passed, bool) else None]
        if label:
            self.text(MARGIN, self.y + _baseline(size, leading), label, BOLD, 7.6, MUTED)
        self.round_rect(x_tag, self.y + 0.4, tag_w, 12.5, 3, bg)
        self.text(x_tag + tag_w / 2, self.y + 9.1, tag, BOLD, 6.6, fg, cs=0.6, align="center")
        for line in lines:
            self.segments(x_text, self.y + _baseline(size, leading), line, size)
            self.y += leading
        self.y += 5

    def code(self, text: str, indent: float = 0.0, size: float = 8.0, color: str = BODY) -> None:
        self.flow([(text, MONO, color)], x=MARGIN + indent, width=CONTENT_W - indent, size=size, leading=size * 1.5)

    def note(self, text: str, size: float = 7.8, color: str = MUTED, indent: float = 0.0) -> None:
        self.flow([(text, REG, color)], x=MARGIN + indent, width=CONTENT_W - indent, size=size, leading=size * 1.45)

    def evidence_row(self, ev_id: str, finding: str, meta: str | None = None, facts: str | None = None) -> None:
        x, w = MARGIN + 50, CONTENT_W - 50
        found = _wrap_runs([(_clip(finding, 600), REG, INK)], 9.2, w)
        data = _wrap_runs([(_clip(facts, 600), MONO, BODY)], 7.0, w) if facts else []
        where = _wrap_runs([(_clip(meta, 300), REG, FAINT)], 7.4, w) if meta else []
        h = len(found) * 12.8 + (len(data) + len(where)) * 10 + 7
        self.ensure(h)
        y = self.y
        self.text(MARGIN, y + _baseline(9.2, 12.8), ev_id, MONO, 7.8, MUTED)
        for line in found:
            self.segments(x, y + _baseline(9.2, 12.8), line, 9.2)
            y += 12.8
        for line, size in [(ln, 7.0) for ln in data] + [(ln, 7.4) for ln in where]:
            self.segments(x, y + _baseline(size, 10), line, size)
            y += 10
        self.y += h


def _assemble(streams: list[bytes], title: str) -> bytes:
    """Objects: 1 catalog, 2 page tree, 3-6 fonts, 7 info, then a page and its content per page."""
    kids = " ".join(f"{8 + 2 * i} 0 R" for i in range(len(streams)))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {len(streams)} >>".encode(),
        *(f"<< /Type /Font /Subtype /Type1 /BaseFont /{FONTS[f]} /Encoding /WinAnsiEncoding >>".encode() for f in (REG, BOLD, MONO)),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>",
        # Info strings are PDFDocEncoding, not WinAnsi; UTF-16BE (with BOM) is unambiguous.
        f"<< /Title <FEFF{title.encode('utf-16-be').hex().upper()}> /Producer (NEXUS Omega) /Creator (nexus.certificate.pdf) >>".encode(),
    ]
    resources = "<< /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> /ProcSet [/PDF /Text] >>"
    for i, data in enumerate(streams):
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_n(PAGE_W)} {_n(PAGE_H)}] /Resources {resources} /Contents {9 + 2 * i} 0 R >>".encode()
        )
        objects.append(f"<< /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{off:010d} 00000 n \n" for off in offsets).encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return bytes(out)


# ---------------------------------------------------------- value helpers


def _dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value) -> list:
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _num(value) -> str:
    s = repr(float(value)) if isinstance(value, float) else str(value)
    return s[:-2] if s.endswith(".0") else s


def _txt(value) -> str:
    """A record value as text; None and empty values print as the dash."""
    if value is None or value == "" or value == [] or value == {}:
        return DASH
    if isinstance(value, bool):
        return "yes" if value else "no"
    if _is_num(value):
        return _num(value)
    if isinstance(value, (list, tuple)):
        return ", ".join(_txt(v) for v in value)
    if isinstance(value, dict):
        return ", ".join(f"{k}={_txt(v)}" for k, v in value.items())
    return str(value)


def _join(*parts, sep: str = SEP) -> str:
    return sep.join(_txt(p) for p in parts if p not in (None, "", [], {})) or DASH


def _scaled(value, factor: float, digits: int) -> str:
    return f"{value * factor:.{digits}f}" if _is_num(value) else DASH


def _secs(value) -> str:
    return f"{_num(value)} s" if _is_num(value) else DASH


def _when(value, fmt: str = "%H:%M:%S") -> str:
    """An ISO timestamp shown in UTC (raw text if it does not parse)."""
    if not isinstance(value, str) or not value:
        return DASH
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return value
    return (t.astimezone(timezone.utc) if t.tzinfo else t).strftime(fmt)


def _arg(value) -> str:
    """A value in key=value text, as the record spells it (true/false, lists in brackets)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "[" + ", ".join(_arg(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k}: {_arg(v)}" for k, v in value.items()) + "}"
    return _txt(value)


def _pairs(mapping: dict) -> str:
    return SEP.join(f"{k}={_arg(v)}" for k, v in mapping.items())


def _args(args) -> str:
    """Compact key=value arguments, resource first."""
    args = _dict(args)
    keys = sorted(args, key=lambda k: (k not in ("resource_id", "target", "service"), list(args).index(k)))
    return " ".join(f"{k}={_arg(args[k])}" for k in keys)


def _cell(label: str, value, span: int = 1, mono: bool = False) -> tuple:
    return (label, value, span, mono)


# ---------------------------------------------------- twin certificates


def render_certificate_pdf(cert: dict) -> bytes:
    """A twin recovery certificate (as stored by nexus.doctors) as PDF bytes."""
    c = _dict(cert)
    incident, timeline = _dict(c.get("incident")), _dict(c.get("timeline"))
    verification, repair, diagnosis = _dict(c.get("verification")), _dict(c.get("repair")), _dict(c.get("diagnosis"))
    state = c.get("terminal_state")
    ref = _txt(c.get("certificate_id"))
    doc = _Doc(ref, [("SHA-256", _txt(c.get("sha256")))])
    target = incident.get("target") or incident.get("targets")

    doc.title("Recovery Certificate", _join(incident.get("title"), target))
    doc.outcome("Outcome", state, [(_txt(c.get("terminal_reason")), REG, BODY)])
    controller = _txt(c.get("controller"))
    provenance = c.get("provenance") or "twin"
    dot = " \xb7 "
    if provenance == "twin":
        doc.badge([("SIMULATED", BOLD, INK), (f"{dot}SimPy digital twin{dot}controller: {controller}", REG, "#334155")], "#f1f5f9", "#cbd5e1")
    elif provenance == "fixture":  # seed data for incident memory, not produced by the twin
        doc.badge([("FIXTURE", BOLD, "#78350f"), (f"{dot}illustrative seed certificate{dot}controller: {controller}", REG, "#92400e")], "#fffbeb", "#fcd34d")
    else:
        doc.badge([(_txt(provenance).upper(), BOLD, INK), (f"{dot}controller: {controller}", REG, "#334155")], "#f1f5f9", "#cbd5e1")

    doc.section("Incident")
    cells = [
        _cell("Incident", incident.get("title")),
        _cell("Class", incident.get("incident_class")),
        _cell("Candidate", incident.get("candidate_id")),
        _cell("Target", target),
        _cell("Doctor", c.get("doctor")),
        _cell("Dashboards alerted", c.get("dashboards_alerted")),
        _cell("Run", c.get("run_id"), mono=True),
        _cell("Issued", c.get("issued_at")),
        _cell("Certificate", c.get("certificate_id"), mono=True),
    ]
    if incident.get("upstream_url"):
        cells.append(_cell("Upstream issue", incident["upstream_url"], span=3))
    if c.get("fixture_note"):
        cells.append(_cell("Note", c["fixture_note"], span=3))
    doc.grid(cells)

    doc.section("Timeline")
    doc.timeline([
        ("Fault", timeline.get("fault_clock"), None),
        ("Detected", timeline.get("detected_clock"), None),
        ("Repair applied", timeline.get("acted_clock"), None),
        ("Closed", timeline.get("closed_clock"), state.replace("_", " ") if isinstance(state, str) else None),
    ])
    doc.grid([_cell("Time to detect", _secs(timeline.get("time_to_detect_s"))), _cell("Time to recover", _secs(timeline.get("time_to_recover_s")))])
    states = _list(c.get("states"))
    if states:
        trail = "  \u203a  ".join(_join(s.get("state"), s.get("clock"), sep=" ") for s in states)
        doc.flow([("States   ", BOLD, MUTED), (trail, REG, MUTED)], size=7.6, leading=11)

    before, after = verification.get("before"), verification.get("after")
    if isinstance(before, dict) or isinstance(after, dict):
        b, a = _dict(before), _dict(after)
        doc.section("Before / after")
        doc.table(["Measurement", "Before", "After"], [
            ["TTFT p95 (ms)", _scaled(b.get("ttft_p95"), 1000, 0), _scaled(a.get("ttft_p95"), 1000, 0)],
            ["Error rate (%)", _scaled(b.get("error_rate"), 100, 2), _scaled(a.get("error_rate"), 100, 2)],
            ["Tool-call canary (%)", _scaled(b.get("canary"), 100, 1), _scaled(a.get("canary"), 100, 1)],
            ["Capacity (%)", _scaled(b.get("capacity"), 100, 0), _scaled(a.get("capacity"), 100, 0)],
        ], [260, 120, 120])
        notes = []
        if _is_num(b.get("t")):
            notes.append(f"Before: at detection (twin T+{_num(b['t'])} s).")
        if _is_num(a.get("t")):
            notes.append(f"After: when verification closed (twin T+{_num(a['t'])} s).")
        pva = _dict(c.get("prediction_vs_actual"))
        if _is_num(pva.get("mae_s")):
            notes.append(f"Twin forecast vs measured {_txt(pva.get('metric'))}: mean absolute error {_num(pva['mae_s'])} s over {_txt(pva.get('samples'))} samples.")
        if notes:
            doc.space(4)
            doc.note(" ".join(notes))

    doc.section("Checks")
    checks = _list(verification.get("checks"))
    for ch in checks:
        detail = ch.get("detail")
        doc.check(ch.get("passed") if isinstance(ch.get("passed"), bool) else None, _txt(ch.get("name")), _txt(detail) if detail not in (None, "") else None)
    if not checks:
        doc.note(f"{DASH}  no independent checks in this certificate")

    doc.section("Actions")
    doc.kv("Repair", repair.get("label"))
    for action in _list(repair.get("actions")):
        doc.code(f"{_txt(action.get('kind'))}({', '.join(f'{k}={_arg(v)}' for k, v in _dict(action.get('args')).items())})", indent=108)
    doc.kv("Change tokens", repair.get("change_tokens"), mono=True)
    doc.kv("Rollback token", repair.get("rollback_token"), mono=True)
    doc.kv("Rollback exercised", repair.get("rollback_exercised"))
    precheck = _dict(c.get("precheck"))
    if precheck:
        cands, seeds = precheck.get("candidates"), precheck.get("seeds")
        doc.kv("Twin precheck", _join(
            f"{len(cands)} candidates" if isinstance(cands, list) else None,
            f"{len(seeds)} seeds" if isinstance(seeds, list) else None,
            f"{_num(precheck['horizon'])} s horizon" if _is_num(precheck.get("horizon")) else None,
            f"recommended {precheck['recommended']}" if precheck.get("recommended") else None,
        ))
    for i, p in enumerate(_list(c.get("policy"))):
        decision = p.get("decision")
        passed = True if decision == "approved" else False if decision == "rejected" else None
        runs = [(_txt(p.get("policy")), REG, INK)] + ([(f"{SEP}{p['reason']}", REG, MUTED)] if p.get("reason") else [])
        doc.kv_tag("Policy" if i == 0 else "", passed, _txt(decision).upper(), runs)

    doc.section("Tool calls")
    calls = _list(c.get("tool_calls"))
    errors = sum(t.get("status") == "error" for t in calls)
    doc.kv("Calls", f"{len(calls)}" + (f" ({errors} returned an error)" if errors else "") if calls else None)
    doc.kv("Distinct tools", list(dict.fromkeys(_txt(t.get("tool")) for t in calls)), mono=True)
    budget = _dict(c.get("budget"))
    used, limits = _dict(budget.get("used")), _dict(budget.get("limits"))
    if used:
        order = ["tool_calls", "context_rounds", "steps", "mutations"]
        keys = sorted(used, key=lambda k: order.index(k) if k in order else len(order))
        doc.kv("Budget used", SEP.join(f"{_txt(used[k])}/{_txt(limits.get('max_' + k))} {k.replace('_', ' ')}" for k in keys))

    doc.section("Evidence")
    evidence = _list(c.get("evidence"))
    for e in evidence[:12]:
        doc.evidence_row(_txt(e.get("evidence_id")), _txt(e.get("finding")), meta=_join(e.get("source_type"), e.get("source"), e.get("collected_at")))
    if len(evidence) > 12:
        doc.note(f"+ {len(evidence) - 12} more evidence items in the JSON certificate.", indent=50)
    if not evidence:
        doc.note(DASH)

    doc.section("Diagnosis")
    doc.flow(_txt(diagnosis.get("summary")), size=10.5, leading=15, color=INK)
    doc.space(4)
    doc.kv("Hypothesis", diagnosis.get("hypothesis"), mono=True)
    doc.kv("Confidence", diagnosis.get("confidence"))
    doc.kv("Cites", diagnosis.get("evidence"), mono=True)
    hypotheses = _list(c.get("hypotheses"))
    if hypotheses:
        doc.space(4)
        doc.table(["Hypotheses considered", "Confidence"], [[_join(h.get("label"), h.get("id")), _txt(h.get("confidence"))] for h in hypotheses], [400, 100])
    return doc.build(f"Recovery Certificate {ref}")


# ----------------------------------------------------- recorded fleet runs


def _payloads(events: list[dict], event_type: str) -> list[dict]:
    return [_dict(e.get("payload")) for e in events if e.get("event_type") == event_type]


def _evidence_content(item) -> dict:
    """The recorded content of one evidence file ({"content": {...}, ...})."""
    item = _dict(item)
    return _dict(item.get("content")) if "content" in item else item


def _facts(item) -> str | None:
    """The few recorded values that make an evidence item readable at a glance."""
    content = _evidence_content(item)
    data = content.get("data")
    if isinstance(data, dict):
        workers = data.get("workers")
        if isinstance(workers, dict):
            return SEP.join(
                f"{name}: p95 {_scaled(_dict(w).get('p95_s'), 1000, 0)} ms, errors {_scaled(_dict(w).get('error_rate'), 100, 1)}%"
                for name, w in workers.items()
            )
        keys = [k for k in ("http_status", "structured_tool_call_count", "verdict") if k in data]
        if keys:
            return _pairs({k: data[k] for k in keys})
    for key in ("configuration", "state"):
        if isinstance(content.get(key), dict) and content[key]:
            return _pairs(content[key])
    if content.get("metric"):
        return f"{content['metric']}={_txt(content.get('value'))} {_txt(content.get('unit'))} over {_txt(content.get('window'))}"
    actions = content.get("actions")
    if isinstance(actions, list) and actions:
        return "actions: " + ", ".join(_txt(_dict(a).get("id")) for a in actions)
    return None


def render_recording_pdf(detail: dict) -> bytes:
    """A recorded fleet run (nexus.recordings.get_recording) as PDF bytes."""
    d = _dict(detail)
    s = _dict(d.get("summary"))
    events = _list(d.get("events"))
    episode = _dict(d.get("episode"))
    evidence = _dict(d.get("evidence"))
    index = _list(d.get("evidence_index"))
    sources = _dict(d.get("sources"))
    decision = _dict(episode.get("decision"))
    executor = _dict(episode.get("executor"))
    verification = _dict(episode.get("verification"))
    validated = (_payloads(events, "decision_validated") or [{}])[-1]
    started = (_payloads(events, "run_started") or [{}])[0]
    completed = (_payloads(events, "run_completed") or [{}])[-1]
    run_id = _txt(s.get("id"))
    failed = s.get("agent_outcome") == "failed"
    state = s.get("terminal_state")
    doc = _Doc(run_id, [("Agent trail", _txt(sources.get("events"))), ("Referee episode", _txt(sources.get("episode")))])

    doc.title("Recovery Certificate", _join(s.get("title"), s.get("target")))
    # The terminal state is the executor's verdict on the agent's plan (ABSTAIN when the agent
    # failed); the referee scores the episode separately. Neither comes from the agent itself.
    if failed:
        doc.outcome("Outcome", state, [])
        doc.callout([("Agent run failed: ", BOLD, "#9f1239"), (_txt(s.get("failure")), REG, "#881337")], "#fff1f2", "#fecdd3", x=MARGIN + 15)
        doc.space(4)
        doc.flow(f"Nothing was changed. Referee score: success {_txt(s.get('success'))}{SEP}false VERIFIED {_txt(s.get('false_verified'))}.",
                 x=MARGIN + 15, width=CONTENT_W - 15, size=10, leading=14)
    elif episode:
        doc.outcome("Outcome", state, [
            ("Terminal state from the executor's hidden canary; success is scored separately by the independent referee.", REG, BODY),
            (f"  Referee success: {_txt(s.get('success'))}{SEP}False VERIFIED: {_txt(s.get('false_verified'))}{SEP}"
             f"Solve time: {_secs(s.get('solve_seconds'))}", REG, MUTED),
        ])
    else:
        doc.outcome("Outcome", state, [("No referee episode is paired with this run.", REG, MUTED)])
    dot = " \xb7 "
    doc.badge([
        ("RECORDED ON A REAL FLEET", BOLD, "#365314"),
        (f"{dot}{s.get('environment') or 'Brev'}{dot}controller: {_txt(s.get('controller'))}{dot}replay\xa0of\xa0run\xa0{run_id}", REG, "#3f6212"),
    ], "#f7fbef", "#b5d77a")

    manifest = next((evidence.get(r.get("evidence_id")) for r in index if str(r.get("source", "")).startswith("environment:")), None)
    doc.section("Incident")
    cells = [
        _cell("Incident", s.get("title")),
        _cell("Fault", s.get("fault"), mono=True),
        _cell("Target", s.get("target")),
        _cell("Environment", s.get("environment")),
        _cell("Serving image", s.get("serving_image")),
        _cell("Solver", s.get("solver")),
        _cell("Run", s.get("id"), mono=True),
        _cell("Agent outcome", s.get("agent_outcome")),
        _cell("Date (UTC)", _when(s.get("started_at"), "%Y-%m-%d")),
    ]
    if _evidence_content(manifest).get("description"):
        cells.append(_cell("Fleet", _evidence_content(manifest)["description"], span=3))
    trigger = _dict(started.get("trigger"))
    if trigger.get("summary"):
        cells.append(_cell("Trigger given to the agent", trigger["summary"], span=3))
    doc.grid(cells)

    doc.section("Timeline")
    doc.timeline([
        ("Agent started", _when(s.get("started_at")), None),
        ("Agent finished", _when(s.get("agent_ended_at")), s.get("agent_outcome")),
        ("Executor started", _when(executor.get("started_at")), None),
        ("Executor ended", _when(executor.get("ended_at")), _secs(executor.get("seconds")) if _is_num(executor.get("seconds")) else None),
        ("Episode closed", _when(s.get("ended_at")), state.replace("_", " ") if isinstance(state, str) else None),
    ])
    doc.grid([
        _cell("Solve time (referee)", _secs(s.get("solve_seconds"))),
        _cell("Executor", _secs(executor.get("seconds"))),
        _cell("Executor status", executor.get("status")),
    ])

    route = _dict(verification.get("route"))
    probe_id, probe = next(
        ((r.get("evidence_id"), _dict(_evidence_content(evidence.get(r.get("evidence_id"))).get("data")))
         for r in index if _dict(_evidence_content(evidence.get(r.get("evidence_id"))).get("data")).get("probe_id") == "route-probe"),
        (None, {}),
    )
    detected = _dict(probe.get("workers"))
    if route or detected:
        names = list(dict.fromkeys([*detected, *(k if k.startswith("target-") else f"target-{k}" for k in route)]))
        after_of = {(k if k.startswith("target-") else f"target-{k}"): _dict(v) for k, v in route.items()}
        rows = []
        for name in names:
            at, af = _dict(detected.get(name)), after_of.get(name, {})
            rows.append([f"{name} p95 latency (ms)", _scaled(at.get("p95_s"), 1000, 0), _scaled(af.get("p95_s"), 1000, 0)])
            rows.append([f"{name} error rate (%)", _scaled(at.get("error_rate"), 100, 1), _scaled(af.get("error_rate"), 100, 1)])
        after_label = "After repair (referee probe)" if executor else "End of episode (referee probe)"
        doc.section("Before / after")
        doc.table(["Measurement", f"At detection ({probe_id})" if probe_id else "At detection", after_label], rows, [200, 140, 160])
        def per_worker(workers: dict) -> str | None:
            counts = {_dict(w).get("requests") for w in workers.values()}
            return f"{_num(counts.pop())} requests per worker" if len(counts) == 1 and _is_num(next(iter(counts))) else None

        notes = []
        if probe_id:
            notes.append(f"At detection: the route probe through HAProxy in the monitoring snapshot ({_join(probe_id, per_worker(detected), sep=', ')}).")
        if route:
            requests = per_worker(route)
            notes.append(f"After: the referee's own route probe{f' ({requests})' if requests else ''}.")
        if notes:
            doc.space(4)
            doc.note(" ".join(notes))

    doc.section("Checks")
    if verification:
        if "users_ok" in verification:
            doc.check(verification.get("users_ok") if isinstance(verification.get("users_ok"), bool) else None,
                      "Users served through HAProxy", "route probe and hidden canary")
        if "hidden_passed" in verification:
            doc.check(verification.get("hidden_passed") if isinstance(verification.get("hidden_passed"), bool) else None,
                      "Hidden tool-call canary through HAProxy")
        if "root_fixed" in verification:
            doc.check(verification.get("root_fixed") if isinstance(verification.get("root_fixed"), bool) else None,
                      "Root cause fixed", "hidden canary on the faulty worker")
        if "faulty_worker_drained" in verification:
            drained = verification.get("faulty_worker_drained")
            doc.check(not drained if isinstance(drained, bool) else None,
                      "Repaired worker back in rotation" if executor else "Faulty worker not left drained",
                      "faulty worker left drained" if drained is True else None)
    if executor:
        canary = _dict(executor.get("verification"))
        failed_cases = canary.get("failed_cases")
        doc.check(canary.get("passed") if isinstance(canary.get("passed"), bool) else None, "Executor's own canary",
                  _join(f"health {_txt(canary.get('health_status'))}" if "health_status" in canary else None,
                        f"{len(failed_cases)} failed cases" if isinstance(failed_cases, list) else None) if canary else None)
    elif episode:
        doc.check(None, "Executor's own canary", "no executor record")
    if isinstance(s.get("false_verified"), bool):
        doc.check(not s["false_verified"], "No false VERIFIED claim")
    if not episode:
        doc.note(f"{DASH}  no referee episode is paired with this run")

    doc.section("Actions")
    plan = _dict(decision.get("repair_plan")) or _dict(validated.get("repair_plan"))
    if plan:
        action = _dict(plan.get("action"))
        args = _dict(action.get("arguments"))
        doc.kv("Proposed by the agent", _join(action.get("tool"), args.get("action_id"), f"on {args['target']}" if args.get("target") else None, sep=" "))
        if args.get("parameters"):
            doc.code(_args(args.get("parameters")), indent=108)
        doc.kv("Plan", _join(f"confidence {_txt(plan.get('confidence'))}" if plan.get("confidence") is not None else None,
                             f"cites {_txt(plan.get('evidence'))}" if plan.get("evidence") else None))
        if plan.get("expected_effect"):
            doc.kv("Expected effect", plan.get("expected_effect"))
    else:
        proposed = _list((_payloads(events, "repair_tool_call_redirected") or [{}])[-1].get("proposed"))
        if proposed:
            p = proposed[0]
            doc.kv("Called as a tool", _join(p.get("action_id"), f"on {p['target']}" if p.get("target") else None, sep=" "))
            if p.get("parameters"):
                doc.code(_args(p.get("parameters")), indent=108)
            doc.note("The runtime redirected this call into the plan instead of running it"
                     + ("; the run failed before a validated decision." if failed else "."), indent=108)
        else:
            doc.kv("Proposed by the agent", None)
    for evaluated in _payloads(events, "repair_plan_evaluated")[-1:]:
        policy, approval = _dict(evaluated.get("policy")), _dict(evaluated.get("approval"))
        status = policy.get("status")
        doc.kv_tag("Policy", True if status == "APPROVED" else False if isinstance(status, str) else None, _txt(status),
                   [(_txt(policy.get("reason")), REG, INK)])
        if approval.get("change_id") or approval.get("rollback_token"):
            doc.kv("Change", _join(f"change_id={approval['change_id']}" if approval.get("change_id") else None,
                                   f"rollback_token={approval['rollback_token']}" if approval.get("rollback_token") else None), mono=True)
    if executor:
        doc.kv("Applied by the executor", _join(executor.get("action"), f"on {executor['service']}" if executor.get("service") else None, sep=" "))
        doc.code(_pairs({k: executor[k] for k in ("profile", "status", "change_id", "seconds") if executor.get(k) not in (None, "")}), indent=108)
        before = _dict(executor.get("before"))
        shown = {k: before[k] for k in ("tool_call_parser", "chat_template", "enable_auto_tool_choice") if k in before}
        if shown:
            doc.kv("Before the change", _pairs(shown), mono=True)
    else:
        doc.kv("Applied by the executor", None)

    doc.section("Tool calls")
    calls = _payloads(events, "context_requested")
    doc.kv("Calls", _join(f"{len(calls)} tool calls",
                          f"{_txt(completed['context_rounds'])} context rounds" if "context_rounds" in completed else None,
                          f"{_txt(completed['steps'])} model steps" if "steps" in completed else None))
    for i, call in enumerate(calls, 1):
        doc.code(f"{i:>2}. {_txt(call.get('tool'))} {_args(call.get('operational_arguments'))}".rstrip(), indent=108, size=7.6)

    doc.section("Evidence")
    for row in index:
        ev_id = row.get("evidence_id")
        doc.evidence_row(_txt(ev_id), _txt(row.get("finding")), meta=_join(row.get("source_type"), row.get("source")),
                         facts=_facts(evidence.get(ev_id)) if isinstance(ev_id, str) else None)
    if not index:
        doc.note(DASH)

    doc.section("Diagnosis")
    doc.flow(_txt(s.get("summary")), size=10.5, leading=15, color=INK)
    hypotheses = _list(decision.get("hypotheses")) or _list(validated.get("hypotheses"))
    if hypotheses:
        doc.space(4)
        doc.table(["Hypothesis", "Supported by", "Confidence"],
                  [[_txt(h.get("id")), _txt(h.get("supports")), _txt(h.get("confidence"))] for h in hypotheses], [190, 220, 90])
    stop = decision.get("stop_reason") or validated.get("stop_reason")
    if stop:
        doc.space(4)
        doc.kv("Stop reason", stop)
    return doc.build(f"Recovery Certificate {run_id}")
