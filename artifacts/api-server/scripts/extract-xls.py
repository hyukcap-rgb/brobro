import json
import struct
import sys

import xlrd
import xlrd.book

# 장애 대응(2026-10-13 로그 확인): 나라장터 공내역서 .xls 중 상당수가 외부 통합문서
# 참조(SUPBOOK 레코드)의 시트 이름이 깨진 UTF-16으로 저장돼 있어, xlrd가
# 워크북을 여는 단계(parse_globals)에서 UnicodeDecodeError로 통째로 실패했다
# (예: "드림로~원당대로간 가로등 공내역서.xls", 하루에도 여러 건). SUPBOOK은
# 다른 파일을 가리키는 수식 참조 정보일 뿐 셀 본문과 무관하다 — xlrd도 같은
# 레코드의 struct.error는 이미 무시하고 넘어간다. 디코딩 실패도 같은 방식으로
# 무시해서 본문 셀은 정상적으로 추출되게 한다. (handle_supbook은 맨 앞에서
# _supbook_types에 자리를 먼저 만들고 카운트를 올리므로, 중간에 빠져나와도
# 이후 EXTERNSHEET 처리의 인덱스가 어긋나지 않는다.)
_original_handle_supbook = xlrd.book.Book.handle_supbook


def _tolerant_handle_supbook(self, data):
    try:
        _original_handle_supbook(self, data)
    except (UnicodeDecodeError, struct.error, IndexError):
        pass


xlrd.book.Book.handle_supbook = _tolerant_handle_supbook

workbook = xlrd.open_workbook(sys.argv[1], on_demand=True)
rows = []
for sheet in workbook.sheets():
    for row_index in range(sheet.nrows):
        cells = []
        for column_index in range(sheet.ncols):
            value = sheet.cell_value(row_index, column_index)
            if value == "":
                continue
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            address = f"R{row_index + 1}C{column_index + 1}"
            cells.append({"address": address, "text": str(value)})
        if not cells:
            continue
        context = " | ".join(f"{cell['address']}={cell['text']}" for cell in cells)
        for cell in cells:
            rows.append({
                "text": cell["text"],
                "itemContext": context,
                "sheet": sheet.name,
                "page": None,
                "location": f"{sheet.name}!{cell['address']}",
            })
print(json.dumps(rows, ensure_ascii=False))
