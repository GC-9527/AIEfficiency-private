import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createdPullRequestUrl,
  isEmbeddedElectron,
  openPullRequestPage,
  openPullRequestWindow,
} from "./pullRequestNavigation.js";

test("Electron renderer detection covers both Desktop preload and Service Control user agent", () => {
  assert.equal(isEmbeddedElectron({ electronAPI: { isElectron: true }, navigator: { userAgent: "Chrome" } }), true);
  assert.equal(isEmbeddedElectron({ navigator: { userAgent: "Mozilla/5.0 Electron/33.4.11" } }), true);
  assert.equal(isEmbeddedElectron({ navigator: { userAgent: "Mozilla/5.0 Chrome/131" } }), false);
});

test("createdPullRequestUrl only returns a canonical Codeup review detail page", () => {
  assert.equal(createdPullRequestUrl({
    mergeRequest: {
      created: true,
      data: { result: { detailUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/change/42" } },
    },
  }), "https://codeup.aliyun.com/xunihezi/AppMarket/change/42");
  assert.equal(createdPullRequestUrl({
    fallbackUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/changes",
    mergeRequest: {
      created: true,
      localId: 43,
      webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/merge_request/43",
    },
  }), "https://codeup.aliyun.com/xunihezi/AppMarket/change/43");
  assert.equal(createdPullRequestUrl({ mergeRequest: { created: false, webUrl: "https://example.com/change/1" } }), "");
  assert.equal(createdPullRequestUrl({ mergeRequest: { created: true, webUrl: "https://codeup.aliyun.com/xunihezi/AppMarket" } }), "");
  assert.equal(createdPullRequestUrl({ mergeRequest: { created: true, webUrl: "javascript:alert(1)" } }), "");
});

test("openPullRequestPage uses the desktop external browser after PR success", async () => {
  const calls = [];
  const result = await openPullRequestPage("https://codeup.aliyun.com/repo/change/7", {
    openExternal: async (url) => { calls.push(url); return true; },
    openWindow: () => { throw new Error("should not open a browser window"); },
  });
  assert.deepEqual(result, { opened: true, method: "external" });
  assert.deepEqual(calls, ["https://codeup.aliyun.com/repo/change/7"]);
});

test("openPullRequestPage falls back to the Service Control window handler when preload is unavailable", async () => {
  const calls = [];
  const serviceControlWindow = {
    navigator: { userAgent: "Mozilla/5.0 Electron/33.4.11" },
    open: (url, target) => {
      calls.push([url, target]);
      return null; // setWindowOpenHandler deny 后 Electron 返回 null
    },
  };
  const result = await openPullRequestPage("https://codeup.aliyun.com/repo/change/10", {
    openExternal: async () => false,
    openWindow: (url) => openPullRequestWindow(url, serviceControlWindow),
  });
  assert.deepEqual(result, { opened: true, method: "new-window" });
  assert.deepEqual(calls, [["https://codeup.aliyun.com/repo/change/10", "_blank"]]);

  assert.equal(openPullRequestWindow("https://codeup.aliyun.com/repo/change/11", {
    navigator: { userAgent: "Mozilla/5.0 Chrome/131" },
    open: () => null,
  }), false, "普通浏览器弹窗被拦截时不能伪报成功");
});

test("openPullRequestPage reuses the reserved window and never replaces the current page", async () => {
  const popup = { closed: false, location: { href: "about:blank" } };
  const reserved = await openPullRequestPage("https://codeup.aliyun.com/repo/change/8", {
    popupWindow: popup,
  });
  assert.deepEqual(reserved, { opened: true, method: "reserved-window" });
  assert.equal(popup.location.href, "https://codeup.aliyun.com/repo/change/8");

  let current = "";
  const fallback = await openPullRequestPage("https://codeup.aliyun.com/repo/change/9", {
    openWindow: () => null,
    navigateCurrent: (url) => { current = url; },
  });
  assert.deepEqual(fallback, { opened: false, method: "blocked" });
  assert.equal(current, "");
});
