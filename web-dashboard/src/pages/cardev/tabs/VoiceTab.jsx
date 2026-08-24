import React, { useEffect, useState } from "react";
import { Btn, Card, Field, Input, StatusBar, ButtonGrid, Grid } from "../ui.jsx";
import { cardevApi } from "../api.js";

const COMMON = [
  { key: "PreviousMusic", label: "上一首" },
  { key: "ResumeMusic", label: "播放" },
  { key: "PauseMusic", label: "暂停" },
  { key: "NextMusic", label: "下一首" },
  { key: "FastForwordMusic", label: "快进" },
  { key: "FastReverseMusic", label: "快退" },
  { key: "OpenVideo", label: "打开（第一个）视频" },
  { key: "CloseVideo", label: "关闭视频" },
  { key: "CollectMusic", label: "收藏内容" },
  { key: "DiscollectMusic", label: "取消收藏" },
  { key: "OpenCollect", label: "打开我的收藏音乐" },
  { key: "OpenCollectionVideo", label: "打开我的收藏视频" },
];

export default function VoiceTab({ serial }) {
  const [musicKw, setMusicKw] = useState("");
  const [videoKw, setVideoKw] = useState("");
  const [customIntent, setCustomIntent] = useState("");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    cardevApi.getLastText("voice_music").then((r) => r.value && setMusicKw(r.value));
    cardevApi.getLastText("voice_video").then((r) => r.value && setVideoKw(r.value));
    cardevApi.getLastText("voice_custom").then((r) => r.value && setCustomIntent(r.value));
  }, []);

  function showResult(label, r) {
    setStatus({
      type: r.ok ? "ok" : "err",
      text: `${label}: ${r.ok ? "OK" : (r.error || r.stderr || "失败")}\n${(r.stdout || "").trim()}`.slice(0, 800),
    });
  }

  async function runCommon(key) {
    const r = await cardevApi.voiceCommon(serial, key);
    showResult(`常用语音 ${key}`, r);
  }

  async function searchMusic() {
    if (!musicKw.trim()) return;
    cardevApi.setLastText("voice_music", musicKw);
    showResult("搜索音乐", await cardevApi.searchMusic(serial, musicKw));
  }

  async function searchVideo() {
    if (!videoKw.trim()) return;
    cardevApi.setLastText("voice_video", videoKw);
    showResult("搜索视频", await cardevApi.searchVideo(serial, videoKw));
  }

  async function runCustom() {
    if (!customIntent.trim()) return;
    cardevApi.setLastText("voice_custom", customIntent);
    showResult(`自定义 ${customIntent}`, await cardevApi.voiceCustom(serial, customIntent));
  }

  return (
    <div className="space-y-4">
      <Card title="常用语音指令（VOICE_ACTION 广播）">
        <ButtonGrid items={COMMON} onClick={runCommon} disabled={!serial} />
      </Card>

      <Grid minWidth={320}>
        <Card title="音乐类应用搜索">
          <div className="flex gap-2">
            <Input value={musicKw} onChange={setMusicKw} placeholder="请输入要搜索的音乐名/关键字"
              onKeyDown={(e) => e.key === "Enter" && searchMusic()} />
            <Btn onClick={searchMusic} disabled={!serial || !musicKw.trim()}>搜索音乐</Btn>
          </div>
        </Card>

        <Card title="视频类应用搜索">
          <div className="flex gap-2">
            <Input value={videoKw} onChange={setVideoKw} placeholder="请输入要搜索的视频名/关键字"
              onKeyDown={(e) => e.key === "Enter" && searchVideo()} />
            <Btn onClick={searchVideo} disabled={!serial || !videoKw.trim()}>搜索视频</Btn>
          </div>
        </Card>

        <Card title="自定义语音 intent">
          <div className="flex gap-2">
            <Input value={customIntent} onChange={setCustomIntent} placeholder="例如 PreviousMusic / OpenVideo"
              onKeyDown={(e) => e.key === "Enter" && runCustom()} />
            <Btn onClick={runCustom} disabled={!serial || !customIntent.trim()}>执行</Btn>
          </div>
        </Card>
      </Grid>

      {status && <StatusBar status={status} />}
    </div>
  );
}
