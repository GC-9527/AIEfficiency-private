// === RAG Hybrid Search Microservice ===
// Standalone HTTP service for music knowledge search
// Called by n8n HTTP Request node

const http = require('http');

const QDRANT = process.env.QDRANT_URL || 'http://qdrant:6333';
const OLLAMA = process.env.OLLAMA_URL || 'http://ollama:11434';
const COLLECTION = process.env.COLLECTION_NAME || 'music_knowledge';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const VECTOR_THRESHOLD = 0.80;
const TOP_K = 10;
const DISPLAY = 5;
const PORT = 3001;

const GENRE_MAP = {
  '摇滚':'rock', '硬摇滚':'hard rock', '爵士':'jazz', '电子':'electronic',
  '嘻哈':'hip-hop', '说唱':'rap', '民谣':'folk', '古典':'classical',
  '蓝调':'blues', '乡村':'country', '金属':'metal', '朋克':'punk',
  '舞曲':'dance', '放松':'chillout', '抒情':'ballad', '独立':'indie',
  '灵魂':'soul', '雷鬼':'reggae', '拉丁':'latin', '节奏蓝调':'rnb',
  'R&B':'rnb', '韩国':'k-pop', '韩流':'k-pop', '韩语':'k-pop',
  '派对':'party', '浪漫':'romantic', '伤感':'sad', '怀旧':'classic',
  '另类':'alternative', '硬核':'hardcore', '后摇':'post-rock',
};

// --- Simplified ↔ Traditional Chinese conversion (common music chars) ---
const S2T_MAP = '万与专业丝东丧两严丰临为丽举义乐乱书买乱亚产亲亿仅从仓仪们价众优伟传伤伦体余佣侠俩偿储催傲儿允党兰关兴养冲决况冻净凑凤击凯刘创别删刮则劳势动务勋包华协单南博卧厂厅历压厌县参叶号吓合吕听吨员咏响哗唤啸团园围国图圆圣场坏块坚坛坝垒垫埃执培堑堕墙壮壮声壳处备够头夹夺奋奖奥奸妇妈姐姗姜姬娘娱婴嫔孙学宝实宠审宪宫宽宾对寺导寿将尔尘尝层届属岁岩岭峡峰崭嵘巩币帅师帐帜带帮帻干并广庄庆庐库应庙废开异弃张弥弯弹强归当录彦忆志忧快恋恳恶悬惧惨惩惯愿慑慨宪戏战户执扩扫扬扰抚抛抢护报担拟拥择挡挤挥损换据掷搜携摄摆摇摘撑撒撤播撰操擦攒支效敌敛数整斩断无旧时昙显晋晒晓晔晕晖暂暗术权杀杂条来杨极构枪柜栅标栈栋样桥梦检棱椟楼概榄榈模横橱欢欢残殇毁毕毕汇汉汤汹沉沈沟没沧河泪泼泽洁洒浅浇浆浩涌涡涤涨涩淀渊渗渡湖湾溃满滚滩漓潇潜潮澜灌灯灵灾灿炉炖炜炼烁烂烃烛烦烧烫热焕焰然煌燃爱爷牵犹独狭狮玛环现珐理琐瑞瓯璃畅画畴疗疡疯疾症痹盏监盖盗盘眉着睁瞒矶矿砖础确碍磁祸禄禅离种稳穷窃窑窜窝竞笔笋笼筑简箩篮篷籁系紧纠纪纯纱纲纳纵纷纸纹纺练组细终绍经结绘给络绝绞统继绩续绳绸综缅缔缘编缩缰缴罗罚罢罪网翼耸聂聋职联聪肃肤肿胀脉脐脑脱脸腊腻腾膊舆舰艺节芦苏苹获蒋蔷薪藏蛮蝇行衬补表袭裤装见观规觉览誓认议讯记讲许论设证评诊诗诞话诫误诱说谁调谐谢谱谣赃资赋赐赖赞赶趣践踊踪蹿车轧轨轮转轻载辆辑辞辽达迁过运近返还进远连迟适选逊递逻遗邓邮邻郑鄂酝酱酿释钉钓钢钦钩钻铁铃铜铝铠银铸铺链锁锋错锐锡键镇镶长门闭问间阁阅阳阵阶阻陈陕随隐隔险雪雾静韩页顶顾显颈颖频颗题额风飘飞饥饭饰饱饿驱驳驻骗骤骥鬓魔麦麻黄龄龙龟'.split('');
const T2S_MAP = '萬與專業絲東喪兩嚴豐臨為麗舉義樂亂書買亂亞產親億僅從倉儀們價眾優偉傳傷倫體餘傭俠倆償儲催傲兒允黨蘭關興養衝決況凍淨湊鳳擊凱劉創別刪刮則勞勢動務勛包華協單南博臥廠廳歷壓厭縣參葉號嚇合呂聽噸員詠響嘩喚嘯團園圍國圖圓聖場壞塊堅壇壩壘墊埃執培塹墮牆壯壯聲殼處備夠頭夾奪奮獎奧奸婦媽姐姍薑姬娘娛嬰嬪孫學寶實寵審憲宮寬賓對寺導壽將爾塵嘗層屆屬歲巖嶺峽峰嶄嶸鞏幣帥師帳幟帶幫幘幹並廣莊慶廬庫應廟廢開異棄張彌彎彈強歸當錄彥憶誌憂快戀懇惡懸懼慘懲慣願懾慨憲戲戰戶執擴掃揚擾撫拋搶護報擔擬擁擇擋擠揮損換據擲搜攜攝擺搖摘撐撒撤播撰操擦攢支效敵斂數整斬斷無舊時曇顯晉曬曉曄暈暉暫暗術權殺雜條來楊極構槍櫃柵標棧棟樣橋夢檢稜櫝樓概欖櫚模橫櫥歡歡殘殤毀畢畢匯漢湯洶沈瀋溝沒滄河淚潑澤潔灑淺澆漿浩湧渦滌漲澀澱淵滲渡湖灣潰滿滾灘漓瀟潛潮瀾灌燈靈災燦爐燉煒煉爍爛烴燭煩燒燙熱煥焰然煌燃愛爺牽猶獨狹獅瑪環現琺理瑣瑞甌璃暢畫疇療瘍瘋疾癥痺盞監蓋盜盤眉著睜瞞磯礦磚礎確礙磁禍祿禪離種穩窮竊窯竄窩競筆筍籠築簡籮籃篷籟係緊糾紀純紗綱納縱紛紙紋紡練組細終紹經結繪給絡絕絞統繼績續繩綢綜緬締緣編縮韁繳羅罰罷罪網翼聳聶聾職聯聰肅膚腫脹脈臍腦脫臉臘膩騰膊輿艦藝節蘆蘇蘋獲蔣薔薪藏蠻蠅行襯補表襲褲裝見觀規覺覽誓認議訊記講許論設證評診詩誕話誡誤誘說誰調諧謝譜謠贓資賦賜賴贊趕趣踐踴蹤躥車軋軌輪轉輕載輛輯辭遼達遷過運近返還進遠連遲適選遜遞邏遺鄧郵鄰鄭鄂醞醬釀釋釘釣鋼欽鉤鑽鐵鈴銅鋁鎧銀鑄鋪鏈鎖鋒錯銳錫鍵鎮鑲長門閉問間閣閱陽陣階阻陳陝隨隱隔險雪霧靜韓頁頂顧顯頸穎頻顆題額風飄飛飢飯飾飽餓驅駁駐騙驟驥鬢魔麥麻黃齡龍龜'.split('');

// Build bidirectional lookup
const s2tDict = {};
const t2sDict = {};
for (let i = 0; i < S2T_MAP.length; i++) {
  s2tDict[S2T_MAP[i]] = T2S_MAP[i];
  t2sDict[T2S_MAP[i]] = S2T_MAP[i];
}

function toTraditional(str) {
  return str.split('').map(c => s2tDict[c] || c).join('');
}

function toSimplified(str) {
  return str.split('').map(c => t2sDict[c] || c).join('');
}

// Get all variants of a string (original + simplified + traditional)
function getVariants(str) {
  const variants = new Set([str, toSimplified(str), toTraditional(str)]);
  return [...variants];
}

const STOP_RE = /推荐|歌曲|有什么|给我|一些|帮我|搜索|查找|找|听|播放|来点|适合|风格|类型|相关|音乐|有没有|流行乐|流行/g;
const SPLIT_RE = /[\s,，、]+/;          // NOTE: 的 is NOT a splitter (it's part of song names)
const SPLIT_WITH_DE = /[\s,，、的]+/;   // Secondary split that includes 的 for possessive patterns
const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

// --- HTTP POST helper ---
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.write(payload);
    req.end();
  });
}

// --- Qdrant scroll search ---
async function scroll(filter, limit) {
  const resp = await post(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
    filter, limit: limit || TOP_K, with_payload: true,
  });
  return resp.result?.points || [];
}

// --- Genre resolution ---
function resolveGenre(kw) {
  const tags = new Set();
  if (GENRE_MAP[kw]) tags.add(GENRE_MAP[kw]);
  for (const [cn, en] of Object.entries(GENRE_MAP)) {
    if (kw !== cn && kw.length > cn.length && kw.includes(cn)) tags.add(en);
  }
  return [...tags];
}

// --- Build filters for all fields (with simplified/traditional variants) ---
function allFieldFilters(kw) {
  const variants = getVariants(kw);
  const f = [];
  for (const v of variants) {
    f.push({ key: 'song_name', match: { text: v } });
    f.push({ key: 'artist', match: { text: v } });
    f.push({ key: 'album_name', match: { text: v } });
    f.push({ key: 'tags', match: { text: v } });
  }
  resolveGenre(kw).forEach(en => f.push({ key: 'tags', match: { text: en } }));
  return f;
}

function isSpecific(kw) {
  return HAS_CJK.test(kw) || kw.length >= 4;
}

// --- Hybrid search ---
// keywordsKeepDe:  split WITHOUT 的 → preserves song names like "乡间的路"
// keywordsSplitDe: split WITH 的    → splits possessives like "周杰伦的晴天"
async function hybridSearch(keywordsKeepDe, keywordsSplitDe, fullPhrase) {
  const seen = new Set();
  const ranked = [];

  function add(pts, rank) {
    for (const p of pts) {
      const key = `${p.payload.song_name}|${p.payload.artist}`;
      if (!seen.has(key)) { seen.add(key); ranked.push({ payload: p.payload, rank }); }
    }
  }

  // T0: Full phrase as artist name (handles "Linkin Park", "Taylor Swift")
  // Includes simplified/traditional variants
  if (fullPhrase && fullPhrase.length >= 2) {
    const artistVariants = getVariants(fullPhrase);
    const artistShould = artistVariants.map(v => ({ key: 'artist', match: { text: v } }));
    add(await scroll({ must: [{ should: artistShould }] }, DISPLAY), 0);
  }

  // T0.5: Song name match for keywords containing 的 (handles "乡间的路", "不能说的秘密")
  for (const kw of keywordsKeepDe) {
    if (kw.includes('的') && isSpecific(kw)) {
      const songVariants = getVariants(kw);
      const songShould = songVariants.map(v => ({ key: 'song_name', match: { text: v } }));
      add(await scroll({ must: [{ should: songShould }] }, DISPLAY), 0);
    }
  }

  // T1: Multi-keyword intersection (uses splitDe for granular matching)
  if (keywordsSplitDe.length >= 2) {
    const mustClauses = keywordsSplitDe.map(kw => ({ should: allFieldFilters(kw) }));
    add(await scroll({ must: mustClauses }, TOP_K), 1);
  }

  // T2: Song name exact match for splitDe keywords
  if (ranked.length < DISPLAY) {
    for (const kw of keywordsSplitDe) {
      if (isSpecific(kw)) {
        add(await scroll({ must: [{ key: 'song_name', match: { text: kw } }] }, DISPLAY), 2);
      }
    }
  }

  // T3: Union - any keyword on any field (uses splitDe for broadest coverage)
  if (ranked.length < DISPLAY) {
    const allKw = [...new Set([...keywordsKeepDe, ...keywordsSplitDe])];
    const shouldConds = allKw.flatMap(kw => allFieldFilters(kw));
    add(await scroll({ should: shouldConds }, TOP_K), 3);
  }

  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, DISPLAY).map(r => ({ score: 1.0, payload: r.payload }));
}

// --- Vector search fallback ---
async function vectorSearch(text) {
  const embed = await post(`${OLLAMA}/api/embeddings`, { model: EMBED_MODEL, prompt: text });
  const resp = await post(`${QDRANT}/collections/${COLLECTION}/points/search`, {
    vector: embed.embedding, limit: DISPLAY, with_payload: true,
  });
  return (resp.result || [])
    .filter(r => r.score >= VECTOR_THRESHOLD)
    .map(r => ({ score: r.score, payload: r.payload }));
}

// --- Format output ---
function formatOutput(results, query) {
  if (!results.length) return `知识库中未找到与「${query}」相关的结果。`;
  const lines = results.map((r, i) => {
    const p = r.payload || {};
    const match = r.score === 1.0 ? '精确匹配' : `语义 ${(r.score * 100).toFixed(1)}%`;
    return `${i + 1}. ${p.song_name || '?'} - ${p.artist || '?'}\n   专辑: ${p.album_name || '?'}\n   标签: ${(p.tags || '').replace(/\|/g, ', ')}\n   [${match}]`;
  });
  return `找到 ${results.length} 条结果:\n\n${lines.join('\n\n')}`;
}

// --- Main search handler ---
async function handleSearch(query) {
  if (!query || !query.trim()) return { output: '请输入搜索内容。' };

  // Auto-detect JSON input: if the query is a JSON object with known fields,
  // route to advanced search automatically.
  // This handles the case where users paste JSON into the chat window.
  const trimmed = query.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      const advancedFields = ['songName', 'artist', 'album', 'tags', 'lyrics'];
      const hasAdvancedField = advancedFields.some(f => parsed[f] && typeof parsed[f] === 'string' && parsed[f].trim());
      if (hasAdvancedField) {
        console.log('[/search] Auto-routing JSON input to advanced search');
        const advResult = await handleAdvancedSearch(parsed);
        return { output: advResult.output, results: advResult.results };
      }
    } catch (e) {
      // Not valid JSON, continue with normal text search
    }
  }

  const cleaned = query.replace(STOP_RE, ' ').trim();
  const fullPhrase = cleaned.replace(/\s+/g, ' ').trim();

  // Primary split: do NOT split on 的 (preserves song names like 乡间的路, 不能说的秘密)
  const keywordsKeepDe = cleaned.split(SPLIT_RE).filter(k => k.length > 0);
  // Secondary split: also split on 的 (handles possessive patterns like 周杰伦的晴天)
  const keywordsSplitDe = cleaned.split(SPLIT_WITH_DE).filter(k => k.length > 0);

  const hasKeywords = keywordsKeepDe.length > 0 || keywordsSplitDe.length > 0;
  let results = hasKeywords ? await hybridSearch(keywordsKeepDe, keywordsSplitDe, fullPhrase) : [];
  if (results.length === 0) {
    results = await vectorSearch(query);
  }

  return { output: formatOutput(results, query) };
}

// =============================================================
// Advanced Multi-Field Search
// =============================================================
// POST /search/advanced
// Body: { songName?, artist?, album?, tags?, lyrics?, limit? }
//
// Matching rules:
//   songName, artist, album → 强匹配 (must match when provided)
//   tags, lyrics            → 筛选 (prefer but not required)
//
// Examples:
//   songName + artist   → BOTH must match
//   artist + tags       → artist must match, tags used to rank/filter
//   artist + album      → BOTH must match
//   songName + album    → BOTH must match
//   tags only           → filter by tags

const FIELD_CONFIG = {
  songName:  { payloadKey: 'song_name',  weight: 5, strict: true },
  artist:    { payloadKey: 'artist',     weight: 4, strict: true },
  album:     { payloadKey: 'album_name', weight: 3, strict: true },
  tags:      { payloadKey: 'tags',       weight: 2, strict: false },
  lyrics:    { payloadKey: 'document',   weight: 1, strict: false },
};

// Expand Chinese genre keywords to English tags
function expandTagValues(val) {
  const values = new Set([val]);
  const parts = val.split(/[|,，\s]+/).filter(v => v);
  for (const part of parts) {
    values.add(part);
    resolveGenre(part).forEach(en => values.add(en));
  }
  return [...values];
}

// Check if a string likely contains GBK-garbled characters
function hasGarbledChars(str) {
  return /[\ufffd]|[\u0080-\u00ff]{2,}/.test(str) || /�/.test(str);
}

async function handleAdvancedSearch(params) {
  const { limit = DISPLAY } = params;

  // Collect provided fields
  const strictFields = [];  // must match
  const softFields = [];    // prefer but optional
  const allFields = [];

  for (const [inputKey, config] of Object.entries(FIELD_CONFIG)) {
    const value = params[inputKey];
    if (value && typeof value === 'string' && value.trim()) {
      const field = { inputKey, value: value.trim(), ...config };

      // Encoding check
      if (hasGarbledChars(field.value)) {
        return {
          output: `编码错误: "${inputKey}" 字段包含乱码 ("${field.value.substring(0, 20)}")。\n请确保请求使用 UTF-8 编码。\n提示: 在请求头中添加 Content-Type: application/json; charset=utf-8`,
          results: [],
        };
      }

      allFields.push(field);
      if (config.strict) {
        strictFields.push(field);
      } else {
        softFields.push(field);
      }
    }
  }

  if (allFields.length === 0) {
    return { output: '请至少提供一个搜索字段。', results: [] };
  }

  // --- Build Qdrant filter (with simplified/traditional Chinese variants) ---
  function buildFieldFilter(f) {
    if (f.inputKey === 'tags') {
      const tagValues = expandTagValues(f.value);
      return { should: tagValues.map(v => ({ key: f.payloadKey, match: { text: v } })) };
    }
    // Generate simplified + traditional variants for CJK text
    const variants = getVariants(f.value);
    return { should: variants.map(v => ({ key: f.payloadKey, match: { text: v } })) };
  }

  // --- Step 1: Search with strict fields as must + soft fields as should ---
  let results = [];
  const seen = new Set();

  function addResults(pts, tier) {
    const added = [];
    for (const p of pts) {
      const key = `${p.payload.song_name}|${p.payload.artist}`;
      if (!seen.has(key)) {
        seen.add(key);
        added.push({ payload: p.payload, tier });
      }
    }
    return added;
  }

  if (strictFields.length > 0) {
    // All strict fields go into must clause
    const mustClauses = strictFields.map(f => buildFieldFilter(f));

    // If soft fields exist, add as should (boost but not required)
    const shouldClauses = softFields.map(f => buildFieldFilter(f));

    // First try: strict must + soft should
    const filter = { must: mustClauses };
    if (shouldClauses.length > 0) {
      // Search with must only first, then we'll re-rank by soft field matches
    }

    const pts = await scroll(filter, TOP_K);
    results = addResults(pts, 0);

    // Re-rank by soft field matches if we have soft fields
    if (softFields.length > 0 && results.length > 0) {
      // For each result, check if soft fields match (for ranking)
      for (const r of results) {
        r.softMatches = [];
        for (const sf of softFields) {
          const payloadVal = (r.payload[sf.payloadKey] || '').toLowerCase();
          const searchTerms = sf.inputKey === 'tags'
            ? expandTagValues(sf.value).map(v => v.toLowerCase())
            : [sf.value.toLowerCase()];
          if (searchTerms.some(t => payloadVal.includes(t))) {
            r.softMatches.push(sf.inputKey);
          }
        }
      }
      // Sort: more soft matches first
      results.sort((a, b) => (b.softMatches?.length || 0) - (a.softMatches?.length || 0));
    }
  } else {
    // Only soft fields provided (e.g., tags only)
    // Use should (any match) with ranking
    const shouldClauses = softFields.flatMap(f => {
      const bf = buildFieldFilter(f);
      return bf.should || [bf];
    });

    if (shouldClauses.length > 0) {
      const pts = await scroll({ should: shouldClauses }, TOP_K);
      results = addResults(pts, 1);
    }
  }

  // --- Step 2: Format output ---
  const display = results.slice(0, limit);

  if (display.length === 0) {
    const queryDesc = allFields.map(f => `${f.inputKey}="${f.value}"`).join(', ');
    return { output: `知识库中未找到匹配的结果。\n查询条件: ${queryDesc}`, results: [] };
  }

  const strictDesc = strictFields.map(f => f.inputKey).join('+');
  const softDesc = softFields.map(f => f.inputKey).join('+');

  const lines = display.map((r, i) => {
    const p = r.payload || {};
    const softInfo = r.softMatches?.length > 0
      ? ` 筛选命中: ${r.softMatches.join('+')}`
      : softFields.length > 0 ? ' 筛选未命中' : '';
    const matchLabel = strictFields.length > 0
      ? `强匹配: ${strictDesc}${softInfo}`
      : `筛选匹配: ${softDesc}`;
    return `${i + 1}. ${p.song_name || '?'} - ${p.artist || '?'}\n   专辑: ${p.album_name || '?'}\n   标签: ${(p.tags || '').replace(/\|/g, ', ')}\n   [${matchLabel}]`;
  });

  const queryDesc = allFields.map(f => {
    const mode = f.strict ? '强匹配' : '筛选';
    return `${f.inputKey}="${f.value}"(${mode})`;
  }).join(', ');
  const output = `找到 ${display.length} 条结果 (${queryDesc}):\n\n${lines.join('\n\n')}`;

  return {
    output,
    results: display.map(r => ({
      songName: r.payload.song_name,
      artist: r.payload.artist,
      album: r.payload.album_name,
      tags: r.payload.tags,
      strictMatch: strictFields.map(f => f.inputKey),
      softMatch: r.softMatches || [],
      fullMatch: r.tier === 0,
    })),
  };
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/search' || req.url === '/search/advanced')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const rawBuffer = Buffer.concat(chunks);
        const body = rawBuffer.toString('utf-8');
        const params = JSON.parse(body);
        console.log(`[${req.url}] params:`, JSON.stringify(params, null, 0).substring(0, 300));
        let result;
        if (req.url === '/search/advanced') {
          result = await handleAdvancedSearch(params);
        } else {
          result = await handleSearch(params.query);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Search error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output: `搜索出错: ${err.message}` }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`RAG Search service listening on port ${PORT}`);
  console.log(`  Qdrant: ${QDRANT}`);
  console.log(`  Ollama: ${OLLAMA}`);
  console.log(`  Collection: ${COLLECTION}`);
  console.log(`  Embedding model: ${EMBED_MODEL}`);
});
