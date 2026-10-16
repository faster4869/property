/* 資產盤點 前端主程式 */
const CFG = window.APP_CONFIG;
const SESSION_KEY = 'inventory_session';
const $ = (s) => document.querySelector(s);

let session = null;   // { idToken, email, name, picture, exp }
let assets = [];      // [{ assetId, name, status, time, photoUrl }]
let ocrWorker = null;
let busy = false;

/* ---------- Session ---------- */
function decodeJwt(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (s && s.exp * 1000 > Date.now() + 60_000) return s;
  } catch (e) {}
  return null;
}
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} session = null; }
function isSessionValid() { return session && session.exp * 1000 > Date.now() + 30_000; }

/* ---------- Google 登入 ---------- */
function waitForGsi() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (window.google?.accounts?.id) { clearInterval(t); resolve(); }
    }, 100);
  });
}
function initGoogle() {
  google.accounts.id.initialize({
    client_id: CFG.GOOGLE_CLIENT_ID,
    callback: onCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  google.accounts.id.renderButton($('#gsi-btn'), {
    theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', width: 280,
  });
}
function onCredential(resp) {
  const p = decodeJwt(resp.credential);
  if (CFG.ALLOWED_DOMAIN && p.hd !== CFG.ALLOWED_DOMAIN) {
    showLoginError(`僅限 @${CFG.ALLOWED_DOMAIN} 帳號登入`);
    return;
  }
  session = {
    idToken: resp.credential,
    email: String(p.email).toLowerCase(),
    name: p.name || p.email,
    picture: p.picture || '',
    exp: p.exp,
  };
  saveSession(session);
  enterMain();
}
function logout(msg) {
  clearSession();
  assets = [];
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  showLogin();
  if (msg) showLoginError(msg);
}

/* ---------- 畫面切換 ---------- */
function showLogin() {
  $('#view-main').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  $('#login-error').classList.add('hidden');
}
function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function enterMain() {
  if (!isSessionValid()) return logout('登入已過期，請重新登入');   // 主畫面守門：沒有登入帳號就不進入
  $('#user-name').textContent = session.name;
  $('#user-email').textContent = session.email;
  $('#user-pic').src = session.picture;
  $('#user-pic').classList.toggle('hidden', !session.picture);
  $('#view-login').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  $('#start-card').classList.remove('hidden');
  $('#inventory').classList.add('hidden');
}
function setLoading(on, text = '處理中…') {
  $('#loading-text').textContent = text;
  $('#loading').classList.toggle('hidden', !on);
}

/* ---------- 後端 API ---------- */
async function api(action, body = {}) {
  if (!isSessionValid()) { logout('登入已過期，請重新登入'); throw new Error('登入已過期'); }
  const res = await fetch(CFG.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS preflight
    body: JSON.stringify({ action, idToken: session.idToken, ...body }),
  });
  const json = await res.json();
  if (!json.ok) {
    if (/登入|驗證|過期/.test(json.error)) logout(json.error);
    throw new Error(json.error || '伺服器錯誤');
  }
  return json.data;
}

/* ---------- 盤點清單 ---------- */
async function startInventory() {
  setLoading(true, '讀取資產清單…');
  try {
    assets = await api('list');
    $('#start-card').classList.add('hidden');
    $('#inventory').classList.remove('hidden');
    renderTable();
    if (!assets.length) setResult('fail', '查無您名下的資產，請確認表單中的 Email 是否正確');
    getWorker(); // 先在背景載入 OCR 引擎
  } catch (e) {
    alert('讀取失敗：' + e.message);
  } finally {
    setLoading(false);
  }
}
const isDone = (a) => String(a.status).trim() === '已盤點';
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderTable(flashId) {
  const done = assets.filter(isDone).length;
  $('#progress').textContent = `已完成 ${done} / ${assets.length}`;
  // 未盤點排前面
  const sorted = [...assets].sort((a, b) => isDone(a) - isDone(b));
  $('#asset-body').innerHTML = sorted.map((a) => `
    <tr class="${isDone(a) ? 'done' : ''} ${a.assetId === flashId ? 'flash' : ''}">
      <td><strong>${escapeHtml(a.assetId)}</strong></td>
      <td>${escapeHtml(a.name)}</td>
      <td><span class="status ${isDone(a) ? 'ok' : 'todo'}">${isDone(a) ? '已盤點' : '未盤點'}</span></td>
      <td>${escapeHtml(a.time)}</td>
      <td>${a.photoUrl ? `<button class="link-btn" data-photo="${escapeHtml(a.assetId)}" type="button">查看</button>` : ''}</td>
    </tr>`).join('');
}

/* ---------- OCR ---------- */
function getWorker() {
  if (!ocrWorker) {
    ocrWorker = (async () => {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
      return w;
    })().catch((e) => { ocrWorker = null; throw e; });
  }
  return ocrWorker;
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('無法讀取圖片'));
    img.src = URL.createObjectURL(file);
  });
}
/* ---------- 影像前處理 ---------- */
// 灰階 + 對比拉伸（忽略最暗/最亮各 1% 的像素，避免反光點影響）
function enhance(c) {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data, n = px.length / 4;
  const gray = new Uint8ClampedArray(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    gray[j] = g; hist[gray[j]]++;
  }
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  for (acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = ((gray[j] - lo) / range) * 255;
    px[i] = px[i + 1] = px[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
// 整張照片（長邊約 1200～2000px）
function fullCanvas(img) {
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const s = Math.min(2000 / longSide, Math.max(1, 1200 / longSide));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return enhance(c);
}

/**
 * 用顏色找出黃色資產標籤（可旋轉、歪斜）。
 * 以影像矩（moments）算出色塊的中心、長短邊與傾斜角度。
 * 回傳縮圖座標 { cx, cy, w, h, angle }，w 為長邊、angle 為長邊的角度（弧度）
 */
function findLabel(px, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j++) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (r > 130 && g > 110 && r - b > 45 && g - b > 30 && Math.abs(r - g) < 70 && (max - min) / max > 0.2) mask[j] = 1;
  }
  const seen = new Uint8Array(w * h), stack = [];
  let best = null;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= w * h || seen[q] || !mask[q]) continue;
        seen[q] = 1; stack.push(q);
      }
    }
    if (n < w * h * 0.002) continue;
    const cx = sx / n, cy = sy / n;
    const mxx = sxx / n - cx * cx, myy = syy / n - cy * cy, mxy = sxy / n - cx * cy;
    const common = Math.sqrt(((mxx - myy) / 2) ** 2 + mxy ** 2);
    const l1 = (mxx + myy) / 2 + common, l2 = (mxx + myy) / 2 - common;
    if (l2 <= 0) continue;
    const L = Math.sqrt(12 * l1), S = Math.sqrt(12 * l2); // 均勻長方形：變異數 = 邊長² / 12
    // 長寬比像標籤、且色塊大致填滿那個長方形（排除黃色桌面、牆面等大片雜訊）
    if (L / S < 1.5 || L / S > 8 || n / (L * S) < 0.45) continue;
    if (!best || n > best.n) best = { cx, cy, w: L, h: S, angle: 0.5 * Math.atan2(2 * mxy, mxx - myy), n };
  }
  return best;
}
function detectLabel(img) {
  const SW = 400, s = SW / Math.max(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const b = findLabel(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  return b && { cx: b.cx / s, cy: b.cy / s, w: b.w / s, h: b.h / s, angle: b.angle }; // 換算回原圖座標
}

// 把標籤轉正（長邊水平），flip=true 時再轉 180°（處理上下顛倒）
// 回傳只含指定區域的畫布：yFrom~yTo 為標籤高度的比例（0=頂端，1=底端）
// labelH：轉正後標籤的高度(px)；220 時文字列約 120px，是 Tesseract 最準的字高
function uprightCrop(img, L, flip, yFrom, yTo, LABEL_H = 220, pad = 20) {
  const s = LABEL_H / L.h;
  const cw = Math.round(L.w * 1.08 * s), ch = Math.round(LABEL_H * (yTo - yFrom));
  const c = document.createElement('canvas');
  c.width = cw + pad * 2; c.height = ch + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.beginPath(); ctx.rect(pad, pad, cw, ch); ctx.clip();
  // 讓標籤中心對到畫布上對應的位置，再旋轉、縮放
  ctx.translate(pad + cw / 2, pad + LABEL_H * (0.5 - yFrom));
  ctx.rotate(-(L.angle + (flip ? Math.PI : 0)));
  ctx.scale(s, s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -L.cx, -L.cy);
  ctx.restore();
  return enhance(c);
}
// 整張照片旋轉 90° / 270°（找不到標籤時的備案）
function rotatedFull(img, deg) {
  const base = fullCanvas(img);
  const c = document.createElement('canvas');
  c.width = base.height; c.height = base.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(base, -base.width / 2, -base.height / 2);
  return c;
}

/**
 * 依序產生要嘗試的 OCR 輸入，比對成功就停：
 * 有找到黃色標籤 → 轉正後辨識上半部文字列（避開條碼），正反兩個方向都試，再試整張標籤
 * 找不到標籤 → 整張照片，含旋轉 90° / 270°
 */
function buildAttempts(img) {
  const attempts = [];
  const L = detectLabel(img);
  if (L) {
    const deg = Math.round((L.angle * 180) / Math.PI);
    // 文字列用兩種大小試，同一個字在不同大小下常常一個讀錯、一個讀對
    for (const size of [220, 170]) {
      for (const flip of [false, true]) {
        const tag = `標籤文字列 ${deg}°${flip ? '+180°' : ''}${size === 220 ? '' : ' (小)'}`;
        attempts.push({ name: tag, psm: '7', make: () => uprightCrop(img, L, flip, -0.05, 0.55, size) });
      }
    }
    for (const flip of [false, true]) {
      attempts.push({ name: `整張標籤${flip ? ' +180°' : ''}`, psm: '6', make: () => uprightCrop(img, L, flip, -0.15, 1.15) });
    }
  }
  let full = null;
  const fullOnce = () => (full = full || fullCanvas(img));
  attempts.push({ name: '整張照片', psm: '6', make: fullOnce });
  if (!L) {
    attempts.push({ name: '整張照片 90°', psm: '6', make: () => rotatedFull(img, 90) });
    attempts.push({ name: '整張照片 270°', psm: '6', make: () => rotatedFull(img, 270) });
  }
  attempts.push({ name: '整張照片(零散)', psm: '11', make: fullOnce });
  return attempts;
}
// 壓縮成 JPEG（長邊 1600px）供上傳
function compress(img) {
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

/* ---------- 比對 ---------- */
// 資產編號格式：PREFIX + NDIG 位數字（預設 SPTTW + 7 碼）
const PREFIX = String(CFG.ASSET_PREFIX || 'SPTTW').toUpperCase();
const NDIG = Number(CFG.ASSET_DIGITS) || 7;
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
// OCR 常把數字認成相似字母，在數字區段把它們轉回數字
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', G: '6', T: '7', B: '8' };
const toDigits = (s) => norm(s).replace(/[A-Z]/g, (c) => TO_DIGIT[c] || c);
// 取資產編號的數字部分（SPTTW0003553 → 0003553）
const digitPart = (id) => { const n = norm(id); return n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n.slice(-NDIG); };

/**
 * 從 OCR 文字找出資產編號，只認「PREFIX + NDIG 碼」，且必須是自己清單中的資產。
 * 1. 嚴格：文字中出現 SPTTW + 7 碼（數字段容錯 O→0 等）
 * 2. 容錯：前綴常被認錯（SPTTW → SPIW、SP1TW…），改抓連續 ≥7 位的數字段，
 *    取其中 7 碼比對清單；越靠數字段尾端的優先（前面多讀出的 0 視為雜訊）
 * 回傳 { asset, code } / { ambiguous: [...] } / null
 */
function matchAsset(text) {
  const byDigits = new Map(assets.map((a) => [digitPart(a.assetId), a]));
  const t = norm(text);

  const re = new RegExp(PREFIX + '([0-9A-Z]{' + NDIG + '})', 'g');
  for (const m of t.matchAll(re)) {
    const hit = byDigits.get(toDigits(m[1]));
    if (hit) return { asset: hit, code: PREFIX + digitPart(hit.assetId) };
  }

  const hits = new Map(); // asset → 分數（越小越好：距離數字段尾端幾碼）
  for (const line of String(text).split(/\n+/)) {
    for (const run of toDigits(line).match(/\d+/g) || []) {
      if (run.length < NDIG) continue;
      for (let end = run.length; end >= NDIG; end--) {
        const a = byDigits.get(run.slice(end - NDIG, end));
        if (!a) continue;
        const score = run.length - end;
        if (!hits.has(a) || hits.get(a) > score) hits.set(a, score);
      }
    }
  }
  if (!hits.size) return null;
  const sorted = [...hits].sort((x, y) => x[1] - y[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
    return { ambiguous: sorted.filter((s) => s[1] === sorted[0][1]).map((s) => s[0].assetId) };
  }
  return { asset: sorted[0][0], code: PREFIX + digitPart(sorted[0][0].assetId) };
}

/**
 * 近似比對：數字段只差 1 碼、且清單中只有一筆符合 → 回傳 { near, read }
 * 不自動判定為盤點完成，交由使用者確認（避免把別台資產記成自己的）
 */
function nearMatch(text) {
  const hits = new Map(); // asset → 讀到的編號
  for (const line of String(text).split(/\n+/)) {
    for (const run of toDigits(line).match(/\d+/g) || []) {
      for (let i = 0; i + NDIG <= run.length; i++) {
        const win = run.slice(i, i + NDIG);
        for (const a of assets) {
          const d = digitPart(a.assetId);
          if (d.length !== NDIG) continue;
          let diff = 0;
          for (let k = 0; k < NDIG && diff < 2; k++) if (d[k] !== win[k]) diff++;
          if (diff === 1 && !hits.has(a)) hits.set(a, PREFIX + win);
        }
      }
    }
  }
  if (hits.size !== 1) return null;
  const [[asset, read]] = [...hits];
  return { near: asset, read };
}

// 依序嘗試各種裁切與版面模式，比對到就停
async function recognizeAsset(img) {
  const worker = await getWorker();
  const texts = [];
  let ambiguous = null, near = null;
  for (const a of buildAttempts(img)) {
    await worker.setParameters({ tessedit_pageseg_mode: a.psm });
    const { data } = await worker.recognize(a.make());
    const text = data.text || '';
    texts.push(`[${a.name}] ${text.replace(/\s+/g, ' ').trim()}`);
    const r = matchAsset(text);
    if (r && r.asset) return { result: r, texts };
    if (r && r.ambiguous) ambiguous = ambiguous || r;
    near = near || nearMatch(text);
  }
  return { result: ambiguous || near, texts };
}

/* ---------- 上傳流程 ---------- */
let resultTimer = null;
function setResult(type, msg) {
  clearTimeout(resultTimer);
  $('#result').className = `result ${type}`;
  $('#result-text').textContent = msg;
  $('#result-panel').classList.remove('hidden');
  // 成功訊息 4 秒後自動收起；失敗訊息留著讓使用者看清楚，手動關閉
  if (type === 'success') resultTimer = setTimeout(closeResult, 4000);
}
function closeResult() {
  clearTimeout(resultTimer);
  pendingManual = null;
  $('#manual-box').classList.add('hidden');
  $('#result-panel').classList.add('hidden');
  const pv = $('#preview');
  if (pv.src.startsWith('blob:')) URL.revokeObjectURL(pv.src);
  pv.removeAttribute('src');
  pv.classList.add('hidden');
}
async function handleFile(file) {
  if (!file || busy) return;
  busy = true;
  closeResult(); // 清掉上一次的結果
  try {
    const img = await loadImage(file);
    $('#preview').src = img.src;
    $('#preview').classList.remove('hidden');

    setResult('processing', '🔍 辨識資產編號中…');
    const { result: m, texts } = await recognizeAsset(img);
    const text = texts.join('\n'); // 不顯示在畫面，只寫入 Drive 照片描述供追查

    if (m && m.asset) {
      await uploadAsset(m.asset, img, text, m.code);
      return;
    }
    // 辨識不到 → 讓使用者自己選擇資產後上傳
    if (m && m.near) {
      showManual(img, text, m.near.assetId,
        `⚠️ 讀到 ${m.read}，最接近您的 ${m.near.assetId}。請對照標籤確認後上傳，或重新拍照`);
    } else if (m && m.ambiguous) {
      showManual(img, text, '', `⚠️ 無法確定是哪一筆（${m.ambiguous.join('、')}），請選擇資產後上傳，或重新拍照`);
    } else {
      showManual(img, text, '', '❌ 無法辨識資產編號。請選擇這張照片對應的資產後上傳，或重新拍照');
    }
  } catch (e) {
    setResult('fail', '⚠️ 發生錯誤：' + e.message + '，請重新上傳');
  } finally {
    busy = false;
  }
}

async function uploadAsset(hit, img, text, code) {
  const already = isDone(hit);
  setResult('processing', `✔ 辨識到 ${code}，照片上傳中…`);
  const b64 = compress(img);
  const r = await api('upload', { assetId: hit.assetId, imageBase64: b64, ocrText: text });
  photoCache.set(hit.assetId, 'data:image/jpeg;base64,' + b64); // 剛上傳的照片不用再下載
  hit.status = '已盤點';
  hit.time = r.time;
  hit.photoUrl = r.fileUrl;
  renderTable(hit.assetId);
  setResult('success', `✅ ${hit.assetId}${hit.name ? `（${hit.name}）` : ''} 盤點完成${already ? '（已更新照片）' : ''}`);
}

/* ---------- 查看照片 ----------
 * Drive 不共用，照片經由後端驗證後取得，只能看自己名下資產的照片
 */
const photoCache = new Map(); // assetId → dataURL
async function viewPhoto(assetId) {
  const a = assets.find((x) => x.assetId === assetId);
  $('#photo-title').textContent = assetId + (a && a.name ? '　' + a.name : '');
  $('#photo-meta').textContent = a && a.time ? '盤點時間：' + a.time : '';
  $('#photo-img').removeAttribute('src');
  $('#photo-img').classList.add('hidden');
  $('#photo-msg').textContent = '照片載入中…';
  $('#photo-msg').classList.remove('hidden');
  $('#photo-modal').classList.remove('hidden');
  try {
    if (!photoCache.has(assetId)) {
      const p = await api('photo', { assetId });
      photoCache.set(assetId, `data:${p.mime};base64,${p.base64}`);
    }
    if ($('#photo-modal').classList.contains('hidden')) return; // 載入途中已關閉
    $('#photo-img').src = photoCache.get(assetId);
    $('#photo-img').classList.remove('hidden');
    $('#photo-msg').classList.add('hidden');
  } catch (e) {
    $('#photo-msg').textContent = '⚠️ ' + e.message;
  }
}
function closePhoto() { $('#photo-modal').classList.add('hidden'); }

/* ---------- 手動關聯資產 ---------- */
let pendingManual = null; // { img, text }
function showManual(img, text, preselect, msg) {
  setResult('warn', msg);
  pendingManual = { img, text };
  // 未盤點的排前面，已盤點的標示出來（選了就是更新照片）
  const sorted = [...assets].sort((a, b) => isDone(a) - isDone(b));
  $('#manual-select').innerHTML =
    `<option value="">— 選擇資產 —</option>` +
    sorted.map((a) => `<option value="${escapeHtml(a.assetId)}">${escapeHtml(a.assetId)}${a.name ? '　' + escapeHtml(a.name) : ''}${isDone(a) ? '（已盤點）' : ''}</option>`).join('');
  $('#manual-select').value = preselect || '';
  $('#btn-manual-upload').disabled = !preselect;
  $('#manual-box').classList.remove('hidden');
}
async function manualUpload() {
  const id = $('#manual-select').value;
  const hit = assets.find((a) => a.assetId === id);
  const p = pendingManual;
  if (!hit || !p || busy) return;
  pendingManual = null;
  $('#manual-box').classList.add('hidden');
  busy = true;
  try {
    await uploadAsset(hit, p.img, p.text + `\n[手動關聯] ${hit.assetId}`, hit.assetId);
  } catch (e) {
    setResult('fail', '⚠️ 發生錯誤：' + e.message + '，請重新上傳');
  } finally {
    busy = false;
  }
}

/* ---------- 啟動 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  $('#btn-start').addEventListener('click', startInventory);
  $('#btn-refresh').addEventListener('click', startInventory);
  $('#btn-logout').addEventListener('click', () => logout());
  $('#btn-close-result').addEventListener('click', closeResult);
  $('#manual-select').addEventListener('change', (e) => { $('#btn-manual-upload').disabled = !e.target.value; });
  $('#btn-manual-upload').addEventListener('click', manualUpload);
  $('#asset-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-photo]');
    if (b) viewPhoto(b.dataset.photo);
  });
  $('#btn-close-photo').addEventListener('click', closePhoto);
  $('#photo-modal').addEventListener('click', (e) => { if (e.target.id === 'photo-modal') closePhoto(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhoto(); });
  for (const id of ['#file-camera', '#file-gallery']) {
    $(id).addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  }

  session = loadSession();
  if (session) enterMain(); else showLogin();
  waitForGsi().then(initGoogle);
});
