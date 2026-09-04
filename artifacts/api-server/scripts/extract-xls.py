import json
import sys
import xlrd

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