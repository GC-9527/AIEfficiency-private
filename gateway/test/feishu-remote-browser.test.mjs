import test from "node:test";
import assert from "node:assert/strict";
import {
  FEISHU_VIEWER_PATH,
  FEISHU_MCP_PAGE_URL,
  canUseLocalGuiBrowser,
} from "../services/feishu-browser-shared.js";
import {
  _resetFeishuRemoteSessionForTests,
  _setFeishuRemoteSessionForTests,
  _canAutoReplaceBusyFeishuSessionForTests,
  getFeishuRemoteStatus,
  detachFeishuBrowserViewer,
  countLiveFeishuRemoteViewers,
} from "../services/feishu-remote-browser.js";

test("FEISHU_VIEWER_PATH is /feishu-browser", () => {
  assert.equal(FEISHU_VIEWER_PATH, "/feishu-browser");
  assert.match(FEISHU_MCP_PAGE_URL, /project\.feishu\.cn\/b\/mcp/);
});

test("Linux without DISPLAY prefers remote", () => {
  assert.equal(canUseLocalGuiBrowser({
    platform: "linux",
    env: {},
    browserPath: "/usr/bin/chromium",
  }), false);
  assert.equal(canUseLocalGuiBrowser({
    platform: "linux",
    env: { DISPLAY: ":0" },
    browserPath: "/usr/bin/chromium",
  }), true);
  assert.equal(canUseLocalGuiBrowser({
    platform: "win32",
    env: {},
    browserPath: "C:\\Chrome\\chrome.exe",
  }), true);
});

test("feishu remote session auto-replace when no live viewers", () => {
  _resetFeishuRemoteSessionForTests();
  _setFeishuRemoteSessionForTests({
    busy: true,
    phase: "WAITING_FOR_SCAN",
    viewers: new Set(),
  });
  assert.equal(_canAutoReplaceBusyFeishuSessionForTests(), true);
  assert.equal(getFeishuRemoteStatus().viewerUrl, "/feishu-browser");

  const fakeWs = { readyState: 3 };
  _setFeishuRemoteSessionForTests({
    busy: true,
    phase: "WAITING_FOR_SCAN",
    viewers: new Set([fakeWs]),
  });
  assert.equal(countLiveFeishuRemoteViewers(), 0);
  assert.equal(_canAutoReplaceBusyFeishuSessionForTests(), true);

  const liveWs = { readyState: 1 };
  _setFeishuRemoteSessionForTests({
    busy: true,
    phase: "WAITING_FOR_SCAN",
    viewers: new Set([liveWs]),
  });
  assert.equal(_canAutoReplaceBusyFeishuSessionForTests(), false);
  detachFeishuBrowserViewer(liveWs);
  assert.equal(countLiveFeishuRemoteViewers(), 0);
  _resetFeishuRemoteSessionForTests();
});
