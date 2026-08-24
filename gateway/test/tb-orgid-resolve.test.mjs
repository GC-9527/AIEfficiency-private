import test from "node:test";
import assert from "node:assert/strict";

test("listTbOrganizations maps organization list", async () => {
  const { listTbOrganizations } = await import("../services/teambition.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    async json() {
      return [
        { _id: "org-a", name: "A", projectIds: ["p1", "p2"] },
        { _id: "org-b", name: "B", projectIds: [] },
      ];
    },
  });
  try {
    const list = await listTbOrganizations("cookie=1");
    assert.deepEqual(list, [
      { id: "org-a", name: "A", projectCount: 2 },
      { id: "org-b", name: "B", projectCount: 0 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveTbOrgId picks org with most members when config empty", async () => {
  const configMod = await import("../services/config.js");
  const { resolveTbOrgId } = await import("../services/teambition.js");
  const cfg = configMod.getConfig();
  const prevOrgId = cfg.teambition?.orgId || "";
  const originalFetch = globalThis.fetch;
  try {
    configMod.updateConfig({ teambition: { ...(cfg.teambition || {}), orgId: "" } });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/members")) {
        if (u.includes("org-big")) {
          return {
            status: 200,
            ok: true,
            async json() { return [{ _userId: "u1" }, { _userId: "u2" }, { _userId: "u3" }]; },
          };
        }
        if (u.includes("org-small")) {
          return { status: 200, ok: true, async json() { return [{ _userId: "u1" }]; } };
        }
        return { status: 404, ok: false, async json() { return {}; } };
      }
      if (u.includes("/api/organizations")) {
        return {
          status: 200,
          ok: true,
          async json() {
            return [
              { _id: "org-small", name: "Small", projectIds: [] },
              { _id: "org-big", name: "Big", projectIds: [] },
            ];
          },
        };
      }
      return { status: 404, ok: false, async json() { return {}; } };
    };
    const id = await resolveTbOrgId({ cookie: "c=1", persist: true });
    assert.equal(id, "org-big");
    assert.equal(configMod.getConfig().teambition.orgId, "org-big");
  } finally {
    globalThis.fetch = originalFetch;
    configMod.updateConfig({
      teambition: { ...(configMod.getConfig().teambition || {}), orgId: prevOrgId },
    });
  }
});
