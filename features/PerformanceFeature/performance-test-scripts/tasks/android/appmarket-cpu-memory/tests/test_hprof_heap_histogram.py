from __future__ import annotations

import struct
import sys
import tempfile
import unittest
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
SRC_DIR = TEST_DIR.parent / "src"
sys.path.insert(0, str(SRC_DIR))

from hprof_heap_histogram import HistogramParser, align, normalize_class_name


def record(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + struct.pack(">II", 0, len(body)) + body


class HprofHistogramTests(unittest.TestCase):
    def test_descriptor_normalization_and_alignment(self) -> None:
        self.assertEqual("com.example.Item[]", normalize_class_name("[Lcom/example/Item;"))
        self.assertEqual("byte[][]", normalize_class_name("[[B"))
        self.assertEqual(24, align(19))

    def test_parses_instance_object_array_and_primitive_array(self) -> None:
        thing_name_id = 0x100
        array_name_id = 0x101
        thing_class_id = 0x200
        array_class_id = 0x201

        string_thing = record(0x01, struct.pack(">I", thing_name_id) + b"com/example/Thing")
        string_array = record(0x01, struct.pack(">I", array_name_id) + b"[Lcom/example/Thing;")
        load_thing = record(0x02, struct.pack(">IIII", 1, thing_class_id, 0, thing_name_id))
        load_array = record(0x02, struct.pack(">IIII", 2, array_class_id, 0, array_name_id))

        class_dump = (
            bytes([0x20])
            + struct.pack(">II", thing_class_id, 0)
            + struct.pack(">IIIIII", 0, 0, 0, 0, 0, 0)
            + struct.pack(">IHHH", 24, 0, 0, 0)
        )
        instance_dump = bytes([0x21]) + struct.pack(">IIII", 0x300, 0, thing_class_id, 0)
        object_array = (
            bytes([0x22])
            + struct.pack(">IIIIII", 0x301, 0, 2, array_class_id, 0x300, 0)
        )
        primitive_array = (
            bytes([0x23])
            + struct.pack(">III", 0x302, 0, 3)
            + bytes([8])
            + b"abc"
        )
        heap = record(0x1C, class_dump + instance_dump + object_array + primitive_array)
        content = (
            b"JAVA PROFILE 1.0.2\0"
            + struct.pack(">IQ", 4, 0)
            + string_thing + string_array + load_thing + load_array + heap
        )

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sample.hprof"
            path.write_bytes(content)
            result = HistogramParser(path, largest_limit=10).parse()

        rows = {row["class_name"]: row for row in result["classes"]}
        self.assertEqual(24, rows["com.example.Thing"]["estimated_shallow_bytes"])
        self.assertEqual(24, rows["com.example.Thing[]"]["estimated_shallow_bytes"])
        self.assertEqual(24, rows["byte[]"]["estimated_shallow_bytes"])
        self.assertEqual(3, result["summary"]["managed_objects"])
        self.assertEqual(72, result["summary"]["estimated_shallow_bytes"])


if __name__ == "__main__":
    unittest.main()
