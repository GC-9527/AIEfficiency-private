import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createPinnedAttachmentRequestOptions,
  isTrustedTeambitionCookieHost,
  readAttachmentBuffer,
} from "../services/teambition.js";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("readAttachmentBuffer 返回有界 Buffer 和 content type", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("hello");
  }, async (url) => {
    const result = await readAttachmentBuffer(url, {
      maxBytes: 16,
      allowPrivateHostsForTests: true,
    });
    assert.equal(result.buffer.toString("utf8"), "hello");
    assert.equal(result.contentType, "text/plain");
    assert.equal(result.size, 5);
  });
});

test("readAttachmentBuffer 只连接校验时选定的 IP，并保留原始 Host", async () => {
  let receivedHost = "";
  await withServer((req, res) => {
    receivedHost = String(req.headers.host || "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned");
  }, async (serverUrl) => {
    const local = new URL(serverUrl);
    const source = `http://attachment.example.test:${local.port}/evidence`;
    let validationLookups = 0;
    const result = await readAttachmentBuffer(source, {
      allowPrivateHostsForTests: true,
      dnsLookup: async (hostname, options) => {
        validationLookups += 1;
        assert.equal(hostname, "attachment.example.test");
        assert.equal(options.all, true);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    assert.equal(result.buffer.toString("utf8"), "pinned");
    assert.equal(validationLookups, 1);
    assert.equal(receivedHost, `attachment.example.test:${local.port}`);
  });
});

test("HTTPS 固定 IP 请求仍使用原始域名作为 Host 和 SNI", async () => {
  const options = createPinnedAttachmentRequestOptions(
    new URL("https://files.teambition.com:8443/path/file.txt?token=x"),
    { address: "203.0.113.8", family: 4 },
  );
  assert.equal(options.hostname, "files.teambition.com");
  assert.equal(options.servername, "files.teambition.com");
  assert.equal(options.headers.Host, "files.teambition.com:8443");
  assert.equal(options.path, "/path/file.txt?token=x");
  const resolved = await new Promise((resolve, reject) => {
    options.lookup("files.teambition.com", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(resolved, [{ address: "203.0.113.8", family: 4 }]);
});

test("readAttachmentBuffer 对每一次重定向重新校验并固定目标 IP", async () => {
  await withServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("redirected");
  }, async (serverUrl) => {
    const local = new URL(serverUrl);
    let validationLookups = 0;
    const result = await readAttachmentBuffer(
      `http://attachment.example.test:${local.port}/start`,
      {
        allowPrivateHostsForTests: true,
        dnsLookup: async () => {
          validationLookups += 1;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      },
    );
    assert.equal(result.buffer.toString("utf8"), "redirected");
    assert.equal(validationLookups, 2);
  });
});

test("readAttachmentBuffer 对没有 content-length 的流也执行实时上限", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("12345");
    res.end("67890");
  }, async (url) => {
    await assert.rejects(
      readAttachmentBuffer(url, {
        maxBytes: 6,
        allowPrivateHostsForTests: true,
      }),
      /超过推理读取上限/,
    );
  });
});

test("readAttachmentBuffer 在请求超时时终止读取", async () => {
  await withServer((_req, res) => {
    setTimeout(() => res.end("late"), 1200);
  }, async (url) => {
    await assert.rejects(
      readAttachmentBuffer(url, {
        timeoutMs: 1000,
        allowPrivateHostsForTests: true,
      }),
      /读取超时/,
    );
  });
});

test("readAttachmentBuffer 默认拒绝 loopback/private SSRF", async () => {
  await assert.rejects(
    readAttachmentBuffer("http://127.0.0.1:3000/internal"),
    /HTTPS|私有网络/,
  );
  await assert.rejects(
    readAttachmentBuffer("https://169.254.169.254/latest/meta-data"),
    /私有网络/,
  );
  await assert.rejects(
    readAttachmentBuffer("https://attachment.example.test/internal", {
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    /私有网络/,
  );
  await assert.rejects(
    readAttachmentBuffer("https://[::ffff:7f00:1]/internal"),
    /私有网络/,
  );
});

test("只有 teambition.com 本域和子域可以携带 TB Cookie", () => {
  assert.equal(isTrustedTeambitionCookieHost("teambition.com"), true);
  assert.equal(isTrustedTeambitionCookieHost("www.teambition.com"), true);
  assert.equal(isTrustedTeambitionCookieHost("evil-teambition.com"), false);
  assert.equal(isTrustedTeambitionCookieHost("teambition.com.evil.test"), false);
});
