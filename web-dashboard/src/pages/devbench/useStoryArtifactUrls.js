import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devbenchApi, storyArtifactUrl } from "./api.js";
import { isStoryArtifactRef } from "./storyMessageModel.mjs";

function accessKey(ref, download) {
  return `${ref}\0${download ? "1" : "0"}`;
}

export default function useStoryArtifactUrls(tabId, references, onToast) {
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const signature = useMemo(() => {
    const seen = new Set();
    return Array.from(references || [])
      .map((value) => String(value || "").trim())
      .filter((value) => {
        if (!isStoryArtifactRef(value) || seen.has(value)) return false;
        seen.add(value);
        return true;
      })
      .sort()
      .join("\n");
  }, [references]);
  const refs = useMemo(() => (signature ? signature.split("\n") : []), [signature]);
  const [access, setAccess] = useState({ signature: "", urls: {} });

  useEffect(() => {
    let disposed = false;
    let refreshTimer = null;
    if (!tabId || !refs.length) {
      setAccess({ signature, urls: {} });
      return () => {};
    }

    const load = async () => {
      const items = refs.flatMap((ref) => ([
        { ref, download: false },
        { ref, download: true },
      ]));
      const result = await devbenchApi.issueStoryArtifactTickets(tabId, items);
      if (disposed) return;
      if (!result?.ok) {
        setAccess({ signature, urls: {} });
        toastRef.current?.(result?.error || "故事点产物预览授权失败，请重试");
        return;
      }
      const urls = {};
      let refreshAt = Number.POSITIVE_INFINITY;
      for (const item of result.data?.items || []) {
        const ref = String(item?.ref || "").trim();
        const download = item?.download === true;
        if (!isStoryArtifactRef(ref) || !item?.ticket) continue;
        urls[accessKey(ref, download)] = storyArtifactUrl(tabId, ref, {
          download,
          ticket: item.ticket,
        });
        refreshAt = Math.min(refreshAt, Number(item.expiresAt) || refreshAt);
      }
      setAccess({ signature, urls });
      if (Number.isFinite(refreshAt)) {
        refreshTimer = setTimeout(load, Math.max(1_000, refreshAt - Date.now() - 30_000));
      }
    };

    void load();
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [refs, signature, tabId]);

  return useCallback((ref, { download = false } = {}) => {
    const normalized = String(ref || "").trim();
    if (!isStoryArtifactRef(normalized)) return normalized;
    if (access.signature !== signature) return "";
    return access.urls[accessKey(normalized, download)] || "";
  }, [access, signature]);
}
