"""HWP 5.0(한글 바이너리, OLE 복합문서) 본문 텍스트 추출기.

왜 필요한가: HWP 5.0은 본문(BodyText)이 zlib(raw deflate)으로 압축된 OLE
스트림이라, 기존 extractLegacy의 `strings` 방식으로는 목차 몇 줄 외에 본문이
전혀 나오지 않는다(실측: 5,154자짜리 시방서에서 strings는 88줄, 대부분 쓰레기).
부직포 같은 자재명은 대부분 본문·표 안에 있으므로 이 파일들은 사실상 검색
대상에서 빠져 있었다.

출력은 extract-xls.py와 같은 ExtractedSegment JSON 배열이다.
"""
import json
import re
import struct
import sys
import zlib

import olefile

HWPTAG_BEGIN = 0x10
HWPTAG_PARA_TEXT = HWPTAG_BEGIN + 51  # 67

# 문단 안에 섞여 있는 제어문자 중 "확장(extended)" 계열은 16바이트를 차지하고,
# 나머지 인라인 제어문자는 2바이트다. 이 구분을 틀리면 뒤 텍스트가 전부 깨진다.
EXTENDED_CONTROLS = {1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}


def parse_records(data):
    offset = 0
    while offset < len(data) - 4:
        header = struct.unpack_from("<I", data, offset)[0]
        tag = header & 0x3FF
        size = (header >> 20) & 0xFFF
        offset += 4
        if size == 0xFFF:  # 확장 크기: 다음 4바이트가 실제 길이
            size = struct.unpack_from("<I", data, offset)[0]
            offset += 4
        yield tag, data[offset:offset + size]
        offset += size


def decode_paragraph(raw):
    out = []
    i = 0
    while i < len(raw) - 1:
        code = struct.unpack_from("<H", raw, i)[0]
        if code in (0, 10, 13):
            out.append("\n")
            i += 2
        elif code < 32:
            i += 16 if code in EXTENDED_CONTROLS else 2
        else:
            out.append(chr(code))
            i += 2
    return "".join(out)


def extract(path):
    ole = olefile.OleFileIO(path)
    try:
        header = ole.openstream("FileHeader").read()
        if header[:32].rstrip(b"\x00") != b"HWP Document File":
            raise ValueError("HWP 5.0 시그니처가 아님")
        flags = struct.unpack_from("<I", header, 36)[0]
        compressed = bool(flags & 0x01)
        if flags & 0x02:
            raise ValueError("암호화된 HWP 파일")

        streams = sorted(
            (e for e in ole.listdir() if e and e[0] == "BodyText"),
            key=lambda e: e[-1],
        )
        segments = []
        for section_index, entry in enumerate(streams):
            data = ole.openstream("/".join(entry)).read()
            if compressed:
                try:
                    data = zlib.decompress(data, -15)
                except zlib.error:
                    data = zlib.decompress(data)
            para_index = 0
            for tag, body in parse_records(data):
                if tag != HWPTAG_PARA_TEXT:
                    continue
                para_index += 1
                text = decode_paragraph(body)
                for line in text.split("\n"):
                    line = re.sub(r"\s+", " ", line).strip()
                    if len(line) < 2:
                        continue
                    segments.append({
                        "text": line,
                        "sheet": None,
                        "page": None,
                        "location": f"{section_index + 1}구역 {para_index}문단",
                    })
        return segments
    finally:
        ole.close()


if __name__ == "__main__":
    print(json.dumps(extract(sys.argv[1]), ensure_ascii=False))
