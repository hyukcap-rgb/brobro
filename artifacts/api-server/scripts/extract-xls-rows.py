"""구형 엑셀(.xls)을 행 단위로 읽는다(키워드 정밀 매칭, 2026-10-30).

출력: [{name, hidden, hiddenCols:[열번호], rows:[{r, hidden, cells:[[열번호, 글]]}]}]
열·행 번호는 1부터. 숨김 시트/행/열 정보는 formatting_info=True일 때만 나오므로, 그걸로 못 열면
서식 없이 다시 열어 글만 낸다(숨김 정보 없음).
"""
import json
import struct
import sys

import xlrd
import xlrd.book

_original_handle_supbook = xlrd.book.Book.handle_supbook


def _tolerant_handle_supbook(self, data):
    try:
        _original_handle_supbook(self, data)
    except (UnicodeDecodeError, struct.error, IndexError):
        pass


xlrd.book.Book.handle_supbook = _tolerant_handle_supbook


def open_book(path):
    try:
        return xlrd.open_workbook(path, formatting_info=True, on_demand=True), True
    except Exception:
        return xlrd.open_workbook(path, on_demand=True), False


book, formatted = open_book(sys.argv[1])
out = []
for index in range(book.nsheets):
    sheet = book.sheet_by_index(index)
    hidden_cols = []
    if formatted:
        for col, info in getattr(sheet, "colinfo_map", {}).items():
            if getattr(info, "hidden", 0):
                hidden_cols.append(col + 1)
    rows = []
    rowinfo = getattr(sheet, "rowinfo_map", {}) if formatted else {}
    for r in range(sheet.nrows):
        cells = []
        for c in range(sheet.ncols):
            value = sheet.cell_value(r, c)
            if value == "":
                continue
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            text = str(value).strip()
            if text:
                cells.append([c + 1, text])
        if not cells:
            continue
        info = rowinfo.get(r)
        rows.append({"r": r + 1, "hidden": bool(getattr(info, "hidden", 0)) if info else False, "cells": cells})
    out.append({
        "name": sheet.name,
        "hidden": bool(getattr(sheet, "visibility", 0)) if formatted else False,
        "hiddenCols": hidden_cols,
        "rows": rows,
    })
    book.unload_sheet(index)
print(json.dumps(out, ensure_ascii=False))
