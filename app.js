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
      <td>${a.photoUrl ? `<a href="${escapeHtml(a.photoUrl)}" target="_blank" rel="noopener">查看</a>` : ''}</td>
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
// 灰階 + 對比拉伸，提升標籤文字辨識率
function preprocess(img) {
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(2000 / longSide, Math.max(1, 1200 / longSide));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let min = 255, max = 0;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    gray[j] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = ((gray[j] - min) / range) * 255;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  return c;
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

// 多種版面模式依序嘗試，對到就停（6=單一文字區塊，對標籤最準；11=零散文字；3=自動）
const OCR_PASSES = ['6', '11', '3'];
async function recognizeAsset(canvas) {
  const worker = await getWorker();
  const texts = [];
  for (const psm of OCR_PASSES) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(canvas);
    const text = data.text || '';
    texts.push(`[模式 ${psm}] ${text.trim()}`);
    const r = matchAsset(text);
    if (r) return { result: r, texts };
  }
  return { result: null, texts };
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
  $('#result-panel').classList.add('hidden');
  $('#ocr-detail').classList.add('hidden');
  $('#ocr-detail').open = false;
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
    const { result: m, texts } = await recognizeAsset(preprocess(img));
    const text = texts.join('\n');
    $('#ocr-text').textContent = text || '（未辨識到文字）';
    $('#ocr-detail').classList.remove('hidden');

    if (!m) {
      setResult('fail', `❌ 找不到清單中的 ${PREFIX} 資產編號，請重新上傳（請對準標籤、避免反光與模糊）`);
      return;
    }
    if (m.ambiguous) {
      setResult('fail', `❌ 無法確定是哪一筆（${m.ambiguous.join('、')}），請拍近一點重新上傳`);
      return;
    }

    const hit = m.asset;
    const already = isDone(hit);
    setResult('processing', `✔ 辨識到 ${m.code}，照片上傳中…`);
    const r = await api('upload', { assetId: hit.assetId, imageBase64: compress(img), ocrText: text });

    hit.status = '已盤點';
    hit.time = r.time;
    hit.photoUrl = r.fileUrl;
    renderTable(hit.assetId);
    setResult('success', `✅ ${hit.assetId}${hit.name ? `（${hit.name}）` : ''} 盤點完成${already ? '（已更新照片）' : ''}`);
  } catch (e) {
    setResult('fail', '⚠️ 發生錯誤：' + e.message + '，請重新上傳');
  } finally {
    busy = false;
    $('#file-input').value = '';
  }
}

/* ---------- 啟動 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  $('#btn-start').addEventListener('click', startInventory);
  $('#btn-refresh').addEventListener('click', startInventory);
  $('#btn-logout').addEventListener('click', () => logout());
  $('#btn-close-result').addEventListener('click', closeResult);
  $('#file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

  session = loadSession();
  if (session) enterMain(); else showLogin();
  waitForGsi().then(initGoogle);
});
