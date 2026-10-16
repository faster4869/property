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
      await w.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/.',
      });
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
const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
// 處理 OCR 常見混淆字元：O/0、I/L/1、S/5、B/8、Z/2
const loose = (s) => norm(s).replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');

function matchAsset(text) {
  const cands = assets.filter((a) => norm(a.assetId).length >= 3);
  const lines = text.split(/\n+/).filter((l) => l.trim());
  const tries = [
    (a) => lines.some((l) => norm(l).includes(norm(a.assetId))),   // 單行嚴格比對
    (a) => lines.some((l) => loose(l).includes(loose(a.assetId))), // 單行容錯比對
    (a) => norm(text).includes(norm(a.assetId)),                    // 跨行嚴格比對
  ];
  for (const t of tries) {
    const hits = cands.filter(t);
    if (hits.length) {
      hits.sort((a, b) => norm(b.assetId).length - norm(a.assetId).length);
      return hits[0];
    }
  }
  return null;
}

/* ---------- 上傳流程 ---------- */
function setResult(type, msg) {
  const el = $('#result');
  el.className = `result ${type}`;
  el.textContent = msg;
}
async function handleFile(file) {
  if (!file || busy) return;
  busy = true;
  $('#ocr-detail').classList.add('hidden');
  try {
    const img = await loadImage(file);
    $('#preview').src = img.src;
    $('#preview').classList.remove('hidden');

    setResult('processing', '🔍 辨識資產編號中…');
    const worker = await getWorker();
    const { data } = await worker.recognize(preprocess(img));
    const text = data.text || '';
    $('#ocr-text').textContent = text.trim() || '（未辨識到文字）';
    $('#ocr-detail').classList.remove('hidden');

    const hit = matchAsset(text);
    if (!hit) {
      setResult('fail', '❌ 比對失敗，請重新上傳（請對準資產標籤、避免反光與模糊）');
      return;
    }

    const already = isDone(hit);
    setResult('processing', `✔ 辨識到 ${hit.assetId}，照片上傳中…`);
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
  $('#file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

  session = loadSession();
  if (session) enterMain(); else showLogin();
  waitForGsi().then(initGoogle);
});
