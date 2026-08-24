import { Router } from "express";
import { requireAuth } from "../services/admin-auth.js";
import {
  acceptLanSyncInvitationJoin,
  compactLanSyncOperations,
  createLanSyncInvitation,
  joinLanSyncInvitation,
  lanSyncDiagnostics,
  listLanSyncMembers,
  localPairingBundle,
  pairMember,
  updateLanSyncMemberState,
} from "../services/lan-sync/index.js";

const router = Router();

function route(work) {
  return async (req, res) => {
    try {
      return res.json({ ok: true, data: await work(req) });
    } catch (error) {
      return res.status(error?.statusCode || 400).json({
        ok: false,
        code: error?.code || "LAN_SYNC_REQUEST_FAILED",
        error: error?.message || "局域网同步请求失败",
      });
    }
  };
}

router.get("/diagnostics", requireAuth(["super", "admin"]), route(() => lanSyncDiagnostics()));
router.get("/members", requireAuth(["super", "admin"]), route(() => listLanSyncMembers()));
router.post("/invitations", requireAuth(["super", "admin"]), route((req) => (
  createLanSyncInvitation(req.body || {}, req.principal)
)));
router.post("/invitations/join", requireAuth(["super", "admin"]), route((req) => (
  joinLanSyncInvitation(req.body || {}, req.principal)
)));
// 该入口不使用浏览器管理员会话；10 分钟一次性加入码的 HMAC 证明即授权，
// 且证明绑定加入节点公钥，旁路监听者不能替换节点或复用到另一成员。
router.post("/invitations/accept", route((req) => acceptLanSyncInvitationJoin(req.body || {})));
router.get("/pairing-bundle", requireAuth(["super", "admin"]), route((req) => (
  localPairingBundle(String(req.query.host || ""))
)));

router.post("/members/pair", requireAuth(["super", "admin"]), route((req) => pairMember(req.body || {}, {
  allowReactivation: req.principal?.role === "super",
  allowKeyReplacement: req.principal?.role === "super",
})));

router.patch("/members/:nodeId/state", requireAuth(["super"]), route((req) => {
  const state = String(req.body?.state || "").trim().toLowerCase();
  return updateLanSyncMemberState(req.params.nodeId, state);
}));

router.post("/compaction", requireAuth(["super"]), route(() => compactLanSyncOperations()));

export default router;
