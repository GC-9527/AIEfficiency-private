#!/usr/bin/env python3
"""Build a class/object shallow-heap histogram from a converted Android HPROF.

Android ``am dumpheap`` writes an Android-flavoured HPROF. Convert it first
with the SDK ``hprof-conv`` tool, then pass the standard HPROF 1.0.2 file to
this module. The result is intentionally a *shallow* heap histogram: native
allocations, graphics buffers and retained/dominator sizes require separate
evidence and must not be inferred from Java object bytes.
"""

from __future__ import annotations

import argparse
import csv
import heapq
import json
import struct
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO


TAG_STRING = 0x01
TAG_LOAD_CLASS = 0x02
TAG_HEAP_DUMP = 0x0C
TAG_HEAP_DUMP_SEGMENT = 0x1C

ROOT_ID_ONLY = {0xFF, 0x05, 0x07, 0x89, 0x8A, 0x8B, 0x8C, 0x8D, 0x90}
ROOT_ID_U4 = {0x04, 0x06}
ROOT_ID_U4_U4 = {0x02, 0x03, 0x08, 0x8E}

SUBTAG_CLASS_DUMP = 0x20
SUBTAG_INSTANCE_DUMP = 0x21
SUBTAG_OBJECT_ARRAY_DUMP = 0x22
SUBTAG_PRIMITIVE_ARRAY_DUMP = 0x23
SUBTAG_PRIMITIVE_ARRAY_NODATA = 0xC3
SUBTAG_HEAP_DUMP_INFO = 0xFE

TYPE_SIZES = {
    2: None,  # object reference; depends on the HPROF identifier size
    4: 1,     # boolean
    5: 2,     # char
    6: 4,     # float
    7: 8,     # double
    8: 1,     # byte
    9: 2,     # short
    10: 4,    # int
    11: 8,    # long
}
TYPE_NAMES = {
    4: "boolean[]",
    5: "char[]",
    6: "float[]",
    7: "double[]",
    8: "byte[]",
    9: "short[]",
    10: "int[]",
    11: "long[]",
}


def align(value: int, boundary: int = 8) -> int:
    return (value + boundary - 1) // boundary * boundary


def normalize_class_name(name: str) -> str:
    name = name.replace("/", ".")
    primitive = {
        "Z": "boolean", "C": "char", "F": "float", "D": "double",
        "B": "byte", "S": "short", "I": "int", "J": "long",
    }
    dimensions = 0
    while name.startswith("["):
        dimensions += 1
        name = name[1:]
    if dimensions:
        if name.startswith("L") and name.endswith(";"):
            name = name[1:-1]
        else:
            name = primitive.get(name, name)
        return name + "[]" * dimensions
    if name.startswith("L") and name.endswith(";"):
        return name[1:-1]
    return name


def category_for(class_name: str, kind: str) -> str:
    lowered = class_name.lower()
    if kind == "primitive_array":
        return "基础类型数组"
    if kind == "object_array":
        return "对象引用数组"
    if lowered.startswith("com.appmarket"):
        return "应用业务对象"
    if any(token in lowered for token in ("bitmap", "drawable", "glide", "coil", "picasso", "image")):
        return "图片与图形对象"
    if any(token in lowered for token in ("webview", "chromium", "org.chromium")):
        return "WebView/Chromium 对象"
    if lowered.startswith(("android.view.", "android.widget.", "androidx.")):
        return "Android UI/Jetpack 对象"
    if lowered.startswith(("okhttp3.", "retrofit2.", "java.net.")):
        return "网络对象"
    if lowered.startswith(("kotlinx.coroutines.", "kotlin.")):
        return "Kotlin/协程对象"
    if lowered in ("java.lang.string", "java.lang.class") or lowered.startswith(("java.util.", "java.lang.ref.")):
        return "字符串/集合/运行时对象"
    if lowered.startswith(("android.", "java.", "javax.", "sun.", "dalvik.")):
        return "系统框架对象"
    return "第三方或其他对象"


@dataclass
class ClassDump:
    instance_size: int
    field_bytes: int


class Reader:
    def __init__(self, stream: BinaryIO) -> None:
        self.stream = stream

    def read_exact(self, size: int) -> bytes:
        value = self.stream.read(size)
        if len(value) != size:
            raise EOFError(f"wanted {size} bytes, got {len(value)}")
        return value

    def u1(self) -> int:
        return self.read_exact(1)[0]

    def u2(self) -> int:
        return struct.unpack(">H", self.read_exact(2))[0]

    def u4(self) -> int:
        return struct.unpack(">I", self.read_exact(4))[0]

    def u8(self) -> int:
        return struct.unpack(">Q", self.read_exact(8))[0]

    def ident(self, identifier_size: int) -> int:
        return int.from_bytes(self.read_exact(identifier_size), "big", signed=False)

    def skip(self, size: int) -> None:
        if size < 0:
            raise ValueError(f"negative skip: {size}")
        self.stream.seek(size, 1)


class HistogramParser:
    def __init__(self, path: Path, largest_limit: int = 100) -> None:
        self.path = path
        self.largest_limit = largest_limit
        self.header = ""
        self.identifier_size = 0
        self.timestamp_ms = 0
        self.strings: dict[int, str] = {}
        self.class_name_string: dict[int, int] = {}
        self.class_dumps: dict[int, ClassDump] = {}
        self.instance_counts: dict[int, int] = defaultdict(int)
        self.instance_data_bytes: dict[int, int] = defaultdict(int)
        self.object_array_counts: dict[int, int] = defaultdict(int)
        self.object_array_elements: dict[int, int] = defaultdict(int)
        self.object_array_bytes: dict[int, int] = defaultdict(int)
        self.primitive_array_counts: dict[int, int] = defaultdict(int)
        self.primitive_array_elements: dict[int, int] = defaultdict(int)
        self.primitive_array_bytes: dict[int, int] = defaultdict(int)
        self.largest_arrays: list[tuple[int, int, str, int, int]] = []
        self.record_counts: dict[str, int] = defaultdict(int)
        self.heap_subrecord_counts: dict[str, int] = defaultdict(int)

    def _type_size(self, type_code: int) -> int:
        if type_code not in TYPE_SIZES:
            raise ValueError(f"unknown HPROF value type 0x{type_code:02x}")
        size = TYPE_SIZES[type_code]
        return self.identifier_size if size is None else size

    def _skip_value(self, reader: Reader, type_code: int) -> None:
        reader.skip(self._type_size(type_code))

    def _remember_array(self, size: int, object_id: int, kind: str, type_or_class: int, length: int) -> None:
        item = (size, object_id, kind, type_or_class, length)
        if len(self.largest_arrays) < self.largest_limit:
            heapq.heappush(self.largest_arrays, item)
        elif size > self.largest_arrays[0][0]:
            heapq.heapreplace(self.largest_arrays, item)

    def parse(self) -> dict[str, Any]:
        with self.path.open("rb") as stream:
            reader = Reader(stream)
            header_bytes = bytearray()
            while True:
                char = reader.read_exact(1)
                if char == b"\0":
                    break
                header_bytes.extend(char)
                if len(header_bytes) > 256:
                    raise ValueError("invalid HPROF header")
            self.header = header_bytes.decode("ascii", errors="replace")
            self.identifier_size = reader.u4()
            self.timestamp_ms = reader.u8()
            if self.identifier_size not in (4, 8):
                raise ValueError(f"unsupported HPROF identifier size: {self.identifier_size}")

            while stream.tell() < self.path.stat().st_size:
                tag_raw = stream.read(1)
                if not tag_raw:
                    break
                tag = tag_raw[0]
                reader.u4()  # time delta; not needed for a heap histogram
                length = reader.u4()
                end = stream.tell() + length
                self.record_counts[f"0x{tag:02x}"] += 1
                if tag == TAG_STRING:
                    string_id = reader.ident(self.identifier_size)
                    value = reader.read_exact(length - self.identifier_size)
                    self.strings[string_id] = value.decode("utf-8", errors="replace")
                elif tag == TAG_LOAD_CLASS:
                    reader.u4()  # class serial
                    class_id = reader.ident(self.identifier_size)
                    reader.u4()  # stack trace serial
                    self.class_name_string[class_id] = reader.ident(self.identifier_size)
                elif tag in (TAG_HEAP_DUMP, TAG_HEAP_DUMP_SEGMENT):
                    self._parse_heap(reader, end)
                else:
                    reader.skip(length)
                if stream.tell() != end:
                    raise ValueError(
                        f"record 0x{tag:02x} ended at {stream.tell()}, expected {end}"
                    )
        return self.result()

    def _parse_heap(self, reader: Reader, end: int) -> None:
        while reader.stream.tell() < end:
            subtag = reader.u1()
            self.heap_subrecord_counts[f"0x{subtag:02x}"] += 1
            if subtag in ROOT_ID_ONLY:
                reader.ident(self.identifier_size)
            elif subtag == 0x01:  # JNI global
                reader.ident(self.identifier_size)
                reader.ident(self.identifier_size)
            elif subtag in ROOT_ID_U4:
                reader.ident(self.identifier_size)
                reader.u4()
            elif subtag in ROOT_ID_U4_U4:
                reader.ident(self.identifier_size)
                reader.u4()
                reader.u4()
            elif subtag == SUBTAG_HEAP_DUMP_INFO:
                reader.u4()
                reader.ident(self.identifier_size)
            elif subtag == SUBTAG_CLASS_DUMP:
                self._parse_class_dump(reader)
            elif subtag == SUBTAG_INSTANCE_DUMP:
                self._parse_instance_dump(reader)
            elif subtag == SUBTAG_OBJECT_ARRAY_DUMP:
                self._parse_object_array(reader)
            elif subtag in (SUBTAG_PRIMITIVE_ARRAY_DUMP, SUBTAG_PRIMITIVE_ARRAY_NODATA):
                self._parse_primitive_array(reader, has_data=subtag == SUBTAG_PRIMITIVE_ARRAY_DUMP)
            else:
                raise ValueError(
                    f"unsupported heap subtag 0x{subtag:02x} at offset {reader.stream.tell() - 1}"
                )

    def _parse_class_dump(self, reader: Reader) -> None:
        class_id = reader.ident(self.identifier_size)
        reader.u4()  # stack trace serial
        for _ in range(6):
            reader.ident(self.identifier_size)  # super, loader, signers, protection, reserved x2
        instance_size = reader.u4()
        constant_count = reader.u2()
        for _ in range(constant_count):
            reader.u2()
            self._skip_value(reader, reader.u1())
        static_count = reader.u2()
        for _ in range(static_count):
            reader.ident(self.identifier_size)
            self._skip_value(reader, reader.u1())
        field_count = reader.u2()
        field_bytes = 0
        for _ in range(field_count):
            reader.ident(self.identifier_size)
            field_bytes += self._type_size(reader.u1())
        self.class_dumps[class_id] = ClassDump(instance_size, field_bytes)

    def _parse_instance_dump(self, reader: Reader) -> None:
        reader.ident(self.identifier_size)  # object id
        reader.u4()  # stack trace serial
        class_id = reader.ident(self.identifier_size)
        data_length = reader.u4()
        self.instance_counts[class_id] += 1
        self.instance_data_bytes[class_id] += data_length
        reader.skip(data_length)

    def _parse_object_array(self, reader: Reader) -> None:
        object_id = reader.ident(self.identifier_size)
        reader.u4()
        length = reader.u4()
        class_id = reader.ident(self.identifier_size)
        data_bytes = length * self.identifier_size
        estimated = align(16 + data_bytes)
        self.object_array_counts[class_id] += 1
        self.object_array_elements[class_id] += length
        self.object_array_bytes[class_id] += estimated
        self._remember_array(estimated, object_id, "object", class_id, length)
        reader.skip(data_bytes)

    def _parse_primitive_array(self, reader: Reader, has_data: bool) -> None:
        object_id = reader.ident(self.identifier_size)
        reader.u4()
        length = reader.u4()
        type_code = reader.u1()
        data_bytes = length * self._type_size(type_code)
        estimated = align(16 + data_bytes)
        self.primitive_array_counts[type_code] += 1
        self.primitive_array_elements[type_code] += length
        self.primitive_array_bytes[type_code] += estimated
        self._remember_array(estimated, object_id, "primitive", type_code, length)
        if has_data:
            reader.skip(data_bytes)

    def _class_name(self, class_id: int) -> str:
        string_id = self.class_name_string.get(class_id)
        if string_id is None:
            return f"<unknown-class-0x{class_id:x}>"
        return normalize_class_name(self.strings.get(string_id, f"<missing-string-0x{string_id:x}>"))

    def result(self) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        for class_id, count in self.instance_counts.items():
            class_dump = self.class_dumps.get(class_id)
            data_bytes = self.instance_data_bytes[class_id]
            if class_dump and class_dump.instance_size > 0:
                per_instance = class_dump.instance_size
                estimate_source = "class_dump_instance_size"
            else:
                per_instance = align(16 + round(data_bytes / max(count, 1)))
                estimate_source = "field_data_plus_16_byte_header_estimate"
            estimated = per_instance * count
            class_name = self._class_name(class_id)
            rows.append(
                {
                    "class_name": class_name,
                    "kind": "instance",
                    "category": category_for(class_name, "instance"),
                    "instance_count": count,
                    "element_count": None,
                    "estimated_shallow_bytes": estimated,
                    "estimated_shallow_mb": round(estimated / 1024 / 1024, 4),
                    "average_shallow_bytes": round(estimated / count, 2),
                    "hprof_field_data_bytes": data_bytes,
                    "estimate_source": estimate_source,
                }
            )
        for class_id, count in self.object_array_counts.items():
            class_name = self._class_name(class_id)
            estimated = self.object_array_bytes[class_id]
            rows.append(
                {
                    "class_name": class_name,
                    "kind": "object_array",
                    "category": category_for(class_name, "object_array"),
                    "instance_count": count,
                    "element_count": self.object_array_elements[class_id],
                    "estimated_shallow_bytes": estimated,
                    "estimated_shallow_mb": round(estimated / 1024 / 1024, 4),
                    "average_shallow_bytes": round(estimated / count, 2),
                    "hprof_field_data_bytes": self.object_array_elements[class_id] * self.identifier_size,
                    "estimate_source": "16_byte_array_header_plus_hprof_references_aligned_8",
                }
            )
        for type_code, count in self.primitive_array_counts.items():
            class_name = TYPE_NAMES.get(type_code, f"primitive-type-{type_code}[]")
            estimated = self.primitive_array_bytes[type_code]
            rows.append(
                {
                    "class_name": class_name,
                    "kind": "primitive_array",
                    "category": category_for(class_name, "primitive_array"),
                    "instance_count": count,
                    "element_count": self.primitive_array_elements[type_code],
                    "estimated_shallow_bytes": estimated,
                    "estimated_shallow_mb": round(estimated / 1024 / 1024, 4),
                    "average_shallow_bytes": round(estimated / count, 2),
                    "hprof_field_data_bytes": self.primitive_array_elements[type_code] * self._type_size(type_code),
                    "estimate_source": "16_byte_array_header_plus_primitive_payload_aligned_8",
                }
            )
        rows.sort(key=lambda item: (item["estimated_shallow_bytes"], item["instance_count"]), reverse=True)

        categories: dict[str, dict[str, int]] = defaultdict(lambda: {"estimated_shallow_bytes": 0, "instance_count": 0})
        for row in rows:
            bucket = categories[row["category"]]
            bucket["estimated_shallow_bytes"] += int(row["estimated_shallow_bytes"])
            bucket["instance_count"] += int(row["instance_count"])
        category_rows = [
            {
                "category": name,
                **values,
                "estimated_shallow_mb": round(values["estimated_shallow_bytes"] / 1024 / 1024, 4),
            }
            for name, values in categories.items()
        ]
        category_rows.sort(key=lambda item: item["estimated_shallow_bytes"], reverse=True)

        largest: list[dict[str, Any]] = []
        for size, object_id, kind, type_or_class, length in sorted(self.largest_arrays, reverse=True):
            class_name = (
                TYPE_NAMES.get(type_or_class, f"primitive-type-{type_or_class}[]")
                if kind == "primitive"
                else self._class_name(type_or_class)
            )
            largest.append(
                {
                    "object_id": f"0x{object_id:x}",
                    "class_name": class_name,
                    "kind": f"{kind}_array",
                    "length": length,
                    "estimated_shallow_bytes": size,
                    "estimated_shallow_mb": round(size / 1024 / 1024, 4),
                }
            )

        total = sum(int(row["estimated_shallow_bytes"]) for row in rows)
        return {
            "schema_version": 1,
            "input": self.path.name,
            "hprof_header": self.header,
            "identifier_size": self.identifier_size,
            "timestamp_ms": self.timestamp_ms,
            "methodology": {
                "scope": "Java managed heap shallow sizes",
                "excludes": [
                    "native heap", "graphics/EGL buffers", "mmap code and APK pages",
                    "retained/dominator sizes", "allocation stack traces",
                ],
                "array_estimate": "16-byte header plus payload, aligned to 8 bytes",
            },
            "summary": {
                "class_rows": len(rows),
                "managed_objects": sum(int(row["instance_count"]) for row in rows),
                "estimated_shallow_bytes": total,
                "estimated_shallow_mb": round(total / 1024 / 1024, 4),
                "string_records": len(self.strings),
                "loaded_classes": len(self.class_name_string),
                "class_dumps": len(self.class_dumps),
            },
            "categories": category_rows,
            "classes": rows,
            "largest_arrays": largest,
            "record_counts": dict(self.record_counts),
            "heap_subrecord_counts": dict(self.heap_subrecord_counts),
        }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "class_name", "kind", "category", "instance_count", "element_count",
        "estimated_shallow_bytes", "estimated_shallow_mb", "average_shallow_bytes",
        "hprof_field_data_bytes", "estimate_source",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a shallow Java heap histogram from HPROF 1.0.2")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--csv-out", type=Path, required=True)
    parser.add_argument("--largest-arrays", type=int, default=100)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = HistogramParser(args.input, largest_limit=args.largest_arrays).parse()
    write_json(args.json_out, result)
    write_csv(args.csv_out, result["classes"])
    print(
        f"HPROF objects={result['summary']['managed_objects']} "
        f"shallow={result['summary']['estimated_shallow_mb']:.2f} MiB "
        f"classes={result['summary']['class_rows']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
