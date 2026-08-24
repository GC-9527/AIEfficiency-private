import { StringDecoder } from "node:string_decoder";

/**
 * 为进程 stdout/stderr 提供有状态的 UTF-8 解码。
 *
 * Node 的 data 事件只保证字节顺序，不保证 chunk 落在字符边界。直接对每个
 * Buffer 调用 toString() 会把跨 chunk 的中文永久替换为 U+FFFD。
 */
export function createUtf8StreamDecoder() {
  const decoder = new StringDecoder("utf8");
  let ended = false;

  return {
    write(chunk) {
      if (ended || chunk == null) return "";
      // 设置过 stream encoding 的调用方已经由 Node 完成了有状态解码。
      if (typeof chunk === "string") return chunk;
      return decoder.write(chunk);
    },

    end(chunk) {
      if (ended) return "";
      ended = true;
      if (typeof chunk === "string") return `${decoder.end()}${chunk}`;
      return chunk == null ? decoder.end() : decoder.end(chunk);
    },
  };
}
