import { Router } from "express";
import { requirePeerReplicationAuth, verifyToken } from "../services/admin-auth.js";
import {
  listFeishuProjectSyncErrors,
  listFeishuProjectRawPayloads,
  listFeishuProjectCommentSync,
  listFeishuProjectAttachmentSync,
  listFeishuProjectRetryableSyncErrors,
  listFeishuProjectSyncStatesSince,
} from "../db/sqlite.js";
import { getConfig, updateConfig } from "../services/config.js";
import { createFeishuProjectSyncRouter } from "../../features/FeiShuProjects/src/gateway-route.js";

export default createFeishuProjectSyncRouter({
  Router,
  verifyToken,
  requirePeerReplicationAuth,
  getConfig,
  updateConfig,
  listFeishuProjectSyncErrors,
  listFeishuProjectRawPayloads,
  listFeishuProjectCommentSync,
  listFeishuProjectAttachmentSync,
  listFeishuProjectRetryableErrors: listFeishuProjectRetryableSyncErrors,
  listFeishuProjectSyncStatesSince,
});
