import assert from "node:assert/strict";
import test from "node:test";
import { createUtf8StreamDecoder } from "../services/utf8-stream-decoder.js";

test("UTF-8 流式解码在任意字节边界拆分中文时保持内容完整", () => {
  const expected = "实时命令输出：中文检查通过 ✅";
  const bytes = Buffer.from(expected, "utf8");

  for (let split = 1; split < bytes.length; split += 1) {
    const decoder = createUtf8StreamDecoder();
    const actual = decoder.write(bytes.subarray(0, split))
      + decoder.write(bytes.subarray(split))
      + decoder.end();
    assert.equal(actual, expected, `字节拆分位置 ${split} 不应损坏 UTF-8`);
    assert.doesNotMatch(actual, /\uFFFD/);
  }
});

test("UTF-8 流式解码在结束时刷新残留的完整字符", () => {
  const decoder = createUtf8StreamDecoder();
  const bytes = Buffer.from("命令完成", "utf8");
  const actual = decoder.write(bytes.subarray(0, bytes.length - 1))
    + decoder.end(bytes.subarray(bytes.length - 1));

  assert.equal(actual, "命令完成");
});
