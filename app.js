// 資料查詢（手機版）：大盤、自選股、查詢與基本資料、試算、持股、排行、到價提醒；與電腦版同步
const APP_VERSION = '1.3.0';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
const MKT = { tse: '上市', otc: '上櫃' };
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200); }

// ---------- 設定 ----------
const S = {};
function loadSettings() {
  Object.assign(S, {
    apiBase: DB.setting('apiBase', (window.APP_CONFIG && APP_CONFIG.apiBase) || ''), token: DB.setting('token', ''),
    theme: DB.setting('theme', 'stealth'), interval: DB.setting('interval', 5), marketOnly: DB.setting('marketOnly', true),
    rate: DB.setting('rate', 0.1425), disc: DB.setting('disc', 6), minFee: DB.setting('minFee', 20),
    mvType: DB.setting('mvType', 'stock'), mvVol: DB.setting('mvVol', 500), mvCap: DB.setting('mvCap', 0),
    qmode: DB.setting('qmode', 'lot'),          // 報價顯示：lot 整股（張）／odd 零股（股）
  });
}
const setS = (k, v) => { S[k] = v; DB.setSetting(k, v); };
const feeCfg = () => ({ rate: S.rate / 100, disc: S.disc / 10, min: S.minFee });
const sign = d => document.body.classList.contains('stealth') ? (d > 0 ? '+' : d < 0 ? '-' : '') : (d > 0 ? '▲' : d < 0 ? '▼' : '');
const cls = d => d > 0 ? 'up' : d < 0 ? 'down' : '';
const pctTxt = (v, dd = 2) => v == null ? '—' : `${sign(v)}${fmt(Math.abs(v), dd)}%`;

function applyTheme() {
  const st = S.theme === 'stealth';
  document.body.classList.toggle('stealth', st);
  document.querySelectorAll('[data-alt]').forEach(el => { if (!el.dataset.orig) el.dataset.orig = el.textContent; el.textContent = st ? el.dataset.alt : el.dataset.orig; });
  document.querySelectorAll('#sTheme button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.theme)));
}

// ---------- 轉接站 ----------
async function api(path, opts = {}) {
  if (!S.apiBase || !S.token) throw new Error('尚未連結電腦版');
  const r = await fetch(S.apiBase.replace(/\/$/, '') + path, { ...opts, headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showSetup('通行碼已失效，請重新配對'); throw new Error('未授權'); }
  if (!r.ok && r.status !== 409) throw new Error(j.error || `轉接站回應 ${r.status}`);
  return { status: r.status, ...j };
}

// ---------- 第一次使用：配對 ----------
function showSetup(msg) { $('setup').hidden = false; $('suUrl').value = S.apiBase || ''; $('suMsg').textContent = msg || ''; }
$('suGo').addEventListener('click', async () => {
  const url = $('suUrl').value.trim().replace(/\/$/, ''), code = $('suCode').value.trim().toUpperCase();
  if (!/^https:\/\//.test(url)) return ($('suMsg').textContent = '轉接站網址要以 https:// 開頭');
  if (!/^[A-Z0-9]{8}$/.test(code)) return ($('suMsg').textContent = '配對碼是 8 碼英數字');
  $('suMsg').textContent = '連結中…';
  try {
    const r = await fetch(`${url}/pair/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `回應 ${r.status}`);
    setS('apiBase', url); setS('token', j.token);
    $('setup').hidden = true; $('suCode').value = '';
    toast('已連結電腦版');
    await afterSetup();
  } catch (e) { $('suMsg').textContent = `連結失敗：${e.message}`; }
});

// ---------- 股票清單 ----------
let STOCKS = [], stockMap = new Map();
function loadStocksLocal() {
  STOCKS = DB.all('SELECT * FROM stocks ORDER BY code');
  stockMap = new Map(STOCKS.map(s => [s.code, s]));
}
async function refreshStocks() {
  const r = await api('/stocks');
  if (!r.stocks?.length) return;
  if (DB.meta('stocks_date') === r.dataDate && STOCKS.length) return;
  DB.batch(run => { run('DELETE FROM stocks'); for (const s of r.stocks) run('INSERT INTO stocks (code, name, market, close, change, shares, volume) VALUES (?, ?, ?, ?, ?, ?, ?)', s); });
  DB.setMeta('stocks_date', r.dataDate || '');
  loadStocksLocal();
}

// ---------- 開盤時間與更新 ----------
function taipei() {
  const t = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
  return { date: t.slice(0, 10), hm: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)), day: new Date(`${t.slice(0, 10)}T12:00:00+08:00`).getUTCDay() };
}
const marketOpen = () => { const n = taipei(); return n.day >= 1 && n.day <= 5 && n.hm >= 540 && n.hm < 815; };
let timer = null, lastOk = 0, Q = {}, ODD = {}, INDEX = [], inflight = false;
function startTimer() { clearInterval(timer); poll(true); timer = setInterval(poll, S.interval * 1000); }
async function poll(force) {
  if (inflight || !S.token || document.hidden) return;
  if (!force && S.marketOnly && !marketOpen() && lastOk && Date.now() - lastOk < 30 * 60e3) { renderState(); return; }
  inflight = true;
  try {
    const codes = [...new Set([cur?.code, ...watchCodes(), ...DB.all('SELECT DISTINCT code FROM holdings').map(r => r.code), ...DB.all('SELECT DISTINCT code FROM alerts WHERE triggered_at IS NULL').map(r => r.code)].filter(Boolean))];
    const [qr, ir] = await Promise.all([codes.length ? api(`/quote?codes=${codes.join(',')}`) : { quotes: [] }, api('/index')]);
    qr.quotes.forEach(q => { Q[q.code] = q; });
    if (cur && view === 'quote' && S.qmode === 'odd') {
      try { const o = await api(`/odd?codes=${cur.code}`); const x = o.quotes.find(q => q.code === cur.code); if (x) ODD[cur.code] = x; }
      catch (e) { ODD[cur.code] = { error: e.message }; }
    }
    INDEX = ir.indexes || INDEX;
    lastOk = Date.now();
    renderIndex(); renderWatch(); if (view === 'hold') renderHold(); if (view === 'quote') renderQuote(); checkAlerts();
  } catch (e) { $('state').textContent = `更新失敗：${e.message}`; }
  finally { inflight = false; renderState(); }
}
function renderState() {
  if (!lastOk) return;
  const t = new Date(lastOk).toLocaleTimeString('zh-TW', { hour12: false });
  $('state').textContent = marketOpen() ? `${t} 更新` : (S.marketOnly ? '休市・已暫停' : `休市・${t}`);
  $('wUpd').textContent = `${t} 更新`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) { poll(true); syncSoon(0); } });

// ---------- 大盤 ----------
function renderIndex() {
  if (!INDEX.length) return;
  const st = document.body.classList.contains('stealth');
  $('mkt').innerHTML = INDEX.map(x => {
    const d = x.value - x.prevClose;
    return `<span>${st ? (x.id === 'taiex' ? 'T' : 'O') : (x.id === 'taiex' ? '加權' : '櫃買')} <b>${fmt(x.value, 2)}</b> <span class="${cls(d)}">${pctTxt(x.prevClose ? d / x.prevClose * 100 : 0)}</span></span>`;
  }).join('');
}

// ---------- 自選股 ----------
const watchCodes = () => DB.all('SELECT code FROM watchlist ORDER BY sort_order').map(r => r.code);
function rowHtml(code, extra = '') {
  const s = stockMap.get(code) || { name: '' }, q = Q[code];
  const price = q?.price ?? s.close, prev = q?.prevClose ?? (s.close != null && s.change != null ? s.close - s.change : null);
  const d = price != null && prev ? price - prev : 0;
  return `<div class="li" data-code="${code}"><span class="nm"><small>${code}</small>${esc(s.name)}</span>
    <span class="p ${cls(d)}">${price != null ? fmt(price, 2) : '—'}</span><span class="c ${cls(d)}">${prev ? pctTxt(d / prev * 100) : ''}</span>${extra}</div>`;
}
function renderWatch() {
  const codes = watchCodes();
  $('watch').innerHTML = codes.length ? codes.map(c => rowHtml(c)).join('') : '<p class="empty">還沒有自選股。到「查詢」找一檔股票，按「加入自選」。</p>';
  renderAlerts();
}
$('watch').addEventListener('click', e => { const r = e.target.closest('[data-code]'); if (r) openStock(r.dataset.code); });

// ---------- 到價提醒 ----------
// 提醒條件（電腦版、轉接站推播用同一套規則）
const ALERT_UNIT = { above: '元', below: '元', pct_up: '%', pct_down: '%', vol: '倍' };
function alertLabel(a) {
  const v = fmt(a.price, 2);
  return { above: `≥ ${v}`, below: `≤ ${v}`, pct_up: `漲幅 ≥ ${v}%`, pct_down: `跌幅 ≥ ${v}%`, vol: `量 ≥ 均量 ${v} 倍`,
    ma20_below: '跌破月線', ma20_above: '站上月線', high52: '創 52 週新高', low52: '創 52 週新低' }[a.direction] || a.direction;
}
function alertHit(a, q, r) {
  const p = q?.price; if (!(p > 0)) return false;
  const chg = q.prevClose > 0 ? (p - q.prevClose) / q.prevClose * 100 : 0;
  switch (a.direction) {
    case 'above': return p >= a.price;
    case 'below': return p <= a.price;
    case 'pct_up': return chg >= a.price;
    case 'pct_down': return -chg >= a.price;
    case 'vol': return r?.avgVol5 > 0 && q.volume >= r.avgVol5 * a.price;
    case 'ma20_below': return r?.ma20 > 0 && p < r.ma20;
    case 'ma20_above': return r?.ma20 > 0 && p > r.ma20;
    case 'high52': return r?.high52 > 0 && p > r.high52;
    case 'low52': return r?.low52 > 0 && p < r.low52;
  }
  return false;
}
// 進階提醒的參考數據（5 日均量、月線、52 週高低），每 30 分鐘從轉接站更新
let REFS = {}, refsAt = 0;
async function loadRefs() {
  const codes = [...new Set(DB.all("SELECT code FROM alerts WHERE triggered_at IS NULL AND direction NOT IN ('above', 'below')").map(r => r.code))];
  if (!codes.length || Date.now() - refsAt < 30 * 60e3) return;
  refsAt = Date.now();
  try { REFS = (await api(`/refs?codes=${codes.join(',')}`)).refs || {}; } catch { refsAt = 0; }
}
function renderAlerts() {
  const rows = DB.all('SELECT * FROM alerts ORDER BY triggered_at IS NOT NULL, created_at DESC');
  $('alerts').innerHTML = rows.length ? rows.map(a => {
    const s = stockMap.get(a.code) || {};
    return `<div class="li"><span class="nm"><small>${a.code}</small>${esc(s.name || '')}</span>
      <span class="p">${esc(alertLabel(a))}</span>
      <button class="x" data-adel="${a.uid}" aria-label="刪除提醒">×</button>
      <span class="sub">${a.triggered_at ? `已到價 ${esc(String(a.triggered_at).slice(5, 16))}（${fmt(a.hit_price, 2)}）` : Q[a.code] ? `現價 ${fmt(Q[a.code].price, 2)}・等待中` : '等待中'}</span></div>`;
  }).join('') : '<p class="empty small">沒有提醒。App 開著的時候，股價到了會在上方顯示提醒。</p>';
}
$('alerts').addEventListener('click', e => { const b = e.target.closest('[data-adel]'); if (b) { DB.run('DELETE FROM alerts WHERE uid = ?', [b.dataset.adel]); renderAlerts(); syncSoon(); } });
function checkAlerts() {
  loadRefs();
  const hits = [];
  for (const a of DB.all('SELECT * FROM alerts WHERE triggered_at IS NULL')) {
    const q = Q[a.code]; if (!q?.price) continue;
    if (alertHit(a, q, REFS[a.code])) {
      DB.run('UPDATE alerts SET triggered_at = ?, hit_price = ? WHERE uid = ?', [new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }), q.price, a.uid]);
      hits.push(`${a.code} ${stockMap.get(a.code)?.name || ''} ${alertLabel(a)}（${fmt(q.price, 2)}）`);
    }
  }
  if (hits.length) {
    $('alertBar').hidden = false;
    $('alertBar').innerHTML = hits.map(h => `<span>${esc(h)}</span>`).join('') + '<button id="abClose">知道了</button>';
    $('abClose').onclick = () => { $('alertBar').hidden = true; };
    renderAlerts(); syncSoon();
  }
}

// ---------- 查詢 ----------
let cur = null, view = 'watch';
const q = $('q'), sugg = $('sugg');
q.addEventListener('input', () => {
  const t = q.value.trim().toUpperCase();
  if (!t) { sugg.hidden = true; return; }
  const ex = [], st = [], has = [];
  for (const s of STOCKS) { const n = String(s.name).toUpperCase(); if (s.code === t || n === t) ex.push(s); else if (s.code.startsWith(t) || n.startsWith(t)) st.push(s); else if (n.includes(t)) has.push(s); }
  const list = ex.concat(st, has).slice(0, 15);
  sugg.innerHTML = list.length ? list.map(s => `<li data-code="${s.code}"><span class="c">${s.code}</span><span>${esc(s.name)}</span></li>`).join('') : '<li>找不到符合的股票</li>';
  sugg.hidden = false;
});
sugg.addEventListener('click', e => { const li = e.target.closest('[data-code]'); if (li) { sugg.hidden = true; q.blur(); openStock(li.dataset.code); } });
function openStock(code) {
  const s = stockMap.get(code); if (!s) return toast('股票清單裡找不到這檔');
  cur = s; q.value = `${s.code} ${s.name}`; FUND = null; fundSeq++;
  go('quote'); renderQuote(); poll(true); loadFund();
}
function renderQuote() {
  if (!cur) { $('quote').innerHTML = '<p class="empty">輸入代號或名稱查詢。</p>'; $('fund').hidden = true; return; }
  const s = cur, qt = Q[s.code], v = x => x > 0 ? fmt(x, 2) : '—';
  const inWatch = !!DB.get('SELECT 1 FROM watchlist WHERE code = ?', [s.code]);
  const d = qt ? qt.price - qt.prevClose : 0;
  const odd = S.qmode === 'odd';
  $('quote').innerHTML = `<div class="panel qcard">
    <div class="qhead"><b>${s.code} ${esc(s.name)} <span class="muted small">${MKT[s.market] || ''}</span></b><span class="muted small">${qt ? `${esc(qt.time)} 更新` : '報價載入中…'}</span></div>
    <div class="seg qmode" id="qMode"><button data-qm="lot" aria-pressed="${!odd}">整股</button><button data-qm="odd" aria-pressed="${odd}">零股</button></div>
    ${odd ? oddHtml(qt, ODD[s.code], v) : qt ? `<div class="qprice"><span class="big ${cls(d)}">${v(qt.price)}</span><span class="${cls(d)}">${sign(d)}${fmt(Math.abs(d), 2)}（${pctTxt(qt.prevClose ? d / qt.prevClose * 100 : 0)}）</span></div>
    <div class="qstats"><div><span class="muted">開盤</span><b>${v(qt.open)}</b></div><div><span class="muted">最高</span><b>${v(qt.high)}</b></div><div><span class="muted">最低</span><b>${v(qt.low)}</b></div><div><span class="muted">昨收</span><b>${v(qt.prevClose)}</b></div>
      <div><span class="muted">成交量</span><b>${qt.volume != null ? fmt(qt.volume) : '—'}</b></div><div><span class="muted">漲停</span><b>${v(qt.limitUp)}</b></div><div><span class="muted">跌停</span><b>${v(qt.limitDown)}</b></div>
      <div><span class="muted">市值</span><b>${s.shares && qt.price ? capTxt(s.shares * qt.price / 1e8) : '—'}</b></div></div>
    <div class="book"><table>${(qt.bids || []).slice(0, 5).map(b => `<tr><td class="${cls(b.price - qt.prevClose)}">${v(b.price)}</td><td>${b.vol != null ? fmt(b.vol) : ''}</td></tr>`).join('')}</table>
      <table>${(qt.asks || []).slice(0, 5).map(b => `<tr><td class="${cls(b.price - qt.prevClose)}">${v(b.price)}</td><td>${b.vol != null ? fmt(b.vol) : ''}</td></tr>`).join('')}</table></div>` : ''}
    <div class="qact"><button class="btn" id="qWatch">${inWatch ? '✓ 已在自選' : '＋ 加入自選'}</button><button class="btn" id="qAlert">到價提醒</button><button class="btn" id="qHold">加入持股</button></div>
    <form class="inline" id="qAlertForm" hidden><select id="qaDir"><option value="above">漲到 ≥</option><option value="below">跌到 ≤</option><option value="pct_up">漲幅 ≥ %</option><option value="pct_down">跌幅 ≥ %</option><option value="vol">量 ≥ 均量倍數</option><option value="ma20_below">跌破月線</option><option value="ma20_above">站上月線</option><option value="high52">創 52 週新高</option><option value="low52">創 52 週新低</option></select><input id="qaPrice" inputmode="decimal" placeholder="價格"><button class="btn" type="submit">新增</button></form>
  </div>`;
  $('qWatch').onclick = () => {
    if (inWatch) DB.run('DELETE FROM watchlist WHERE code = ?', [s.code]);
    else DB.run('INSERT INTO watchlist (code, sort_order) VALUES (?, ?)', [s.code, (DB.get('SELECT MAX(sort_order) AS m FROM watchlist').m || 0) + 1]);
    renderQuote(); renderWatch(); syncSoon(); toast(inWatch ? '已移出自選' : '已加入自選');
  };
  $('qAlert').onclick = () => { $('qAlertForm').hidden = !$('qAlertForm').hidden; };
  $('qaDir').onchange = () => { const u = ALERT_UNIT[$('qaDir').value]; $('qaPrice').hidden = !u; $('qaPrice').placeholder = u === '元' ? '價格' : u === '%' ? '幾 %' : u === '倍' ? '幾倍' : ''; };
  $('qMode').onclick = e => { const b = e.target.closest('[data-qm]'); if (!b || b.dataset.qm === S.qmode) return; setS('qmode', b.dataset.qm); renderQuote(); if (b.dataset.qm === 'odd') poll(true); };
  $('qAlertForm').onsubmit = e => {
    e.preventDefault(); const p = Number($('qaPrice').value);
    if (!(p > 0)) return toast('請輸入價格');
    DB.run('INSERT INTO alerts (uid, code, direction, price, created_at) VALUES (?, ?, ?, ?, ?)', [CALC.uid(), s.code, $('qaDir').value, p, new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })]);
    toast('已新增提醒'); renderAlerts(); syncSoon(); $('qAlertForm').hidden = true;
  };
  $('qHold').onclick = () => { go('hold'); openHoldForm(s.code, qt?.price || s.close); };
  $('fund').hidden = false;
}
// 零股：價格、與整股的差價、成交量（股）、五檔（股數）
function oddHtml(qt, o, v) {
  if (!o) return '<p class="muted small">零股報價載入中…</p>';
  if (o.error) return `<p class="muted small">零股報價取得失敗：${esc(o.error)}</p>`;
  const d = o.price - o.prevClose, diff = qt?.price > 0 && o.price > 0 ? o.price - qt.price : null;
  const src = { trade: '零股成交價', mid: '零股尚無成交，以買賣中間價估算', prev: '零股尚無成交，顯示昨收' }[o.priceSource] || '';
  const rows = arr => (arr || []).slice(0, 5).map(b => `<tr><td class="${cls(b.price - o.prevClose)}">${v(b.price)}</td><td>${b.vol != null ? fmt(b.vol) : ''}</td></tr>`).join('');
  return `<div class="qprice"><span class="big ${cls(d)}">${v(o.price)}</span><span class="${cls(d)}">${sign(d)}${fmt(Math.abs(d), 2)}（${pctTxt(o.prevClose ? d / o.prevClose * 100 : 0)}）</span></div>
    <div class="muted small">${src}${o.time ? `・${esc(o.time)}` : ''}${diff != null ? `・比整股 ${v(qt.price)} ${diff === 0 ? '相同' : `${diff > 0 ? '貴' : '便宜'} ${fmt(Math.abs(diff), 2)}`}` : ''}</div>
    <div class="qstats"><div><span class="muted">開盤</span><b>${v(o.open)}</b></div><div><span class="muted">最高</span><b>${v(o.high)}</b></div><div><span class="muted">最低</span><b>${v(o.low)}</b></div><div><span class="muted">昨收</span><b>${v(o.prevClose)}</b></div>
      <div><span class="muted">成交（股）</span><b>${o.volume != null ? fmt(o.volume) : '—'}</b></div><div><span class="muted">約合（張）</span><b>${o.volume != null ? fmt(o.volume / 1000, 1) : '—'}</b></div>
      <div><span class="muted">最近一筆</span><b>${o.lastVol != null ? `${fmt(o.lastVol)} 股` : '—'}</b></div><div><span class="muted">買 1 股</span><b>${v(o.price)}</b></div></div>
    <div class="book"><table>${rows(o.bids)}</table><table>${rows(o.asks)}</table></div>
    <p class="muted small">五檔數量單位是「股」。盤中零股 09:00～13:30、盤後零股 13:40～14:30，集合競價成交較慢。</p>`;
}
const capTxt = c => c >= 10000 ? `${fmt(c / 10000, 2)} 兆` : `${fmt(c, c >= 100 ? 0 : 1)} 億`;

// ---------- 基本資料 ----------
let FUND = null, fundSeq = 0, fTab = 'trend', fRange = '1y', holdAll = false;
async function finmind(dataset, code, start) {
  const r = await fetch(`https://api.finmindtrade.com/api/v4/data?dataset=${dataset}&data_id=${code}&start_date=${start}`);
  const j = await r.json(); if (j.status !== 200) throw new Error(j.msg || 'FinMind 讀取失敗');
  return j.data || [];
}
async function loadFund() {
  const s = cur, seq = fundSeq, etf = CALC.isEtf(s.code);
  $('fBody').innerHTML = '<p class="empty">載入基本資料中…</p>';
  document.querySelector('[data-ft=hold]').hidden = !etf;
  if (fTab === 'hold' && !etf) fTab = 'trend';
  const errs = [];
  const [h, dv, ep, ho] = await Promise.all([
    api(`/chart?code=${s.code}`).catch(e => { errs.push(`股價：${e.message}`); return null; }),
    finmind('TaiwanStockDividend', s.code, CALC.yearsAgo(10)).catch(e => { errs.push(`配息：${e.message}`); return []; }),
    etf ? [] : finmind('TaiwanStockFinancialStatements', s.code, CALC.yearsAgo(6)).catch(e => { errs.push(`EPS：${e.message}`); return []; }),
    etf ? api(`/etf-holdings?code=${s.code}`).catch(e => { errs.push(`持股：${e.message}`); return null; }) : null,
  ]);
  if (seq !== fundSeq) return;
  let divs = dv.map(d => ({ period: d.year, exDate: d.CashExDividendTradingDate || d.StockExDividendTradingDate || '', payDate: d.CashDividendPaymentDate || '',
    cash: (d.CashEarningsDistribution || 0) + (d.CashStatutorySurplus || 0), stock: (d.StockEarningsDistribution || 0) + (d.StockStatutorySurplus || 0) }))
    .filter(d => d.cash > 0 || d.stock > 0).sort((a, b) => (b.exDate || '').localeCompare(a.exDate || ''));
  if (!divs.length && h?.divs) divs = h.divs.map(d => ({ period: '', exDate: d.date, payDate: '', cash: d.amount, stock: 0 })).reverse();
  if (h) for (const d of divs) { const i = d.exDate ? CALC.idxOnOrBefore(h.dates, d.exDate) - 1 : -1; if (i >= 0) d.yieldAt = d.cash / h.close[i] * 100; }
  const eps = ep.filter(x => x.type === 'EPS').map(x => ({ date: x.date, eps: x.value })).sort((a, b) => a.date.localeCompare(b.date));
  FUND = { h, divs, eps, hold: ho, errs, etf };
  renderFund();
}
function priceNow() { return Q[cur?.code]?.price || cur?.close; }
function renderFund() {
  document.querySelectorAll('[data-ft]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ft === fTab)));
  if (fTab === 'calc') { $('fBody').innerHTML = calcHtml(); bindCalc(); return; }
  if (['chips', 'rev', 'news', 'bt'].includes(fTab)) { fundExtra(cur.code, fTab); return; }
  if (!FUND) return;
  const F = FUND, price = priceNow(), body = $('fBody');
  const err = F.errs.length ? `<p class="muted small">部分資料讀取失敗：${esc(F.errs.join('；'))}</p>` : '';
  if (fTab === 'trend') {
    if (!F.h || F.h.close.length < 30) { body.innerHTML = '<p class="empty">歷史股價不足，無法判斷趨勢。</p>' + err; return; }
    const t = CALC.trend(F.h, price), dc = d => d === '向上' ? 'up' : d === '向下' ? 'down' : '';
    const box = (lb, j) => `<div><span class="muted">${lb}</span><b class="${dc(j.dir)}">${j.dir}</b><span class="muted">${j.ma ? `${j.above ? '價在線上' : '價在線下'}` : ''}</span></div>`;
    body.innerHTML = `<div><b class="${dc(t.overall)}" style="font-size:1.1rem">${t.overall}</b>　<span class="muted small">${t.align}・52 週位置 ${t.pos52 != null ? fmt(t.pos52, 0) + '%' : '—'}</span></div>
      <div class="dir3">${box('短期（月線）', t.short)}${box('中期（季線）', t.mid)}${box('長期（年線）', t.long)}</div>
      ${chartHtml(F.h)}<p class="muted small">均線往上且股價在均線上方為「向上」，反之「向下」，其餘「盤整」。只是技術面參考。</p>${err}`;
  }
  if (fTab === 'div') {
    if (!F.divs.length) { body.innerHTML = '<p class="empty">查不到配息紀錄。</p>' + err; return; }
    const s = CALC.divSummary(F.divs, price), today = CALC.today();
    body.innerHTML = `<div class="cards"><div class="card"><span>近一年現金股利</span><b>${fmt(s.cash12, 2)} 元</b><span>${s.count12} 次・${s.freq}</span></div>
      <div class="card"><span>近一年殖利率</span><b>${s.yield12 != null ? fmt(s.yield12, 2) + '%' : '—'}</b></div>
      <div class="card"><span>下次除息</span><b>${s.next ? esc(s.next.exDate) : '尚未公告'}</b><span>${s.next ? `${fmt(s.next.cash, 3)} 元` : ''}</span></div>
      <div class="card"><span>每年合計</span><b style="font-size:.85rem">${s.byYear.slice(0, 3).map(y => `${y.year}：${fmt(y.cash, 2)}`).join('<br>')}</b></div></div>
      <div class="twrap"><table class="tbl"><tr><th>期間</th><th>除息日</th><th>發放日</th><th>現金</th><th>殖利率</th></tr>
      ${F.divs.slice(0, 12).map(d => `<tr${d.exDate > today ? ' class="up"' : ''}><td>${esc(d.period || '—')}</td><td>${esc((d.exDate || '—').slice(2))}</td><td>${esc((d.payDate || '—').slice(2))}</td><td>${fmt(d.cash, 3)}</td><td>${d.yieldAt != null ? fmt(d.yieldAt, 2) + '%' : '—'}</td></tr>`).join('')}</table></div>${err}`;
  }
  if (fTab === 'ret') {
    if (!F.h) { body.innerHTML = '<p class="empty">歷史股價讀取失敗。</p>' + err; return; }
    const r = CALC.returns(F.h, F.divs, price).filter(x => x.available);
    body.innerHTML = r.length ? `<div class="twrap"><table class="tbl"><tr><th>期間</th><th>股價</th><th>配息</th><th>含息</th><th>年化</th></tr>
      ${r.map(x => `<tr><td>${x.label}</td><td class="${cls(x.priceRet)}">${pctTxt(x.priceRet, 1)}</td><td>${x.cash ? fmt(x.cash, 2) : '—'}</td><td class="${cls(x.totalRet)}"><b>${pctTxt(x.totalRet, 1)}</b></td><td class="${cls(x.annualized)}">${x.annualized != null ? pctTxt(x.annualized, 1) : '—'}</td></tr>`).join('')}</table></div>
      <p class="muted small">以目前價格計算；含息＝加回期間內的現金股利（不再投入）。</p>${err}` : '<p class="empty">上市時間太短，無法計算報酬。</p>';
  }
  if (fTab === 'eps') {
    if (F.etf) { body.innerHTML = '<p class="empty">ETF 沒有 EPS，可以看「報酬」或「持股」。</p>'; return; }
    if (!F.eps.length) { body.innerHTML = '<p class="empty">查不到 EPS。</p>' + err; return; }
    const q8 = F.eps.slice(-8), yr = {};
    for (const x of F.eps) { const y = x.date.slice(0, 4); yr[y] = yr[y] || { eps: 0, q: 0 }; yr[y].eps += x.eps; yr[y].q++; }
    const qL = s => `${s.slice(2, 4)}Q${Math.ceil(Number(s.slice(5, 7)) / 3)}`;
    body.innerHTML = `<div class="twrap"><table class="tbl"><tr><th>季度</th>${q8.map(x => `<th>${qL(x.date)}</th>`).join('')}</tr><tr><td>EPS</td>${q8.map(x => `<td class="${x.eps < 0 ? 'down' : ''}">${fmt(x.eps, 2)}</td>`).join('')}</tr></table></div>
      <div class="twrap" style="margin-top:8px"><table class="tbl"><tr><th>年度</th><th>EPS 合計</th><th>年增</th></tr>
      ${Object.entries(yr).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([y, v], i, arr) => { const p = arr[i + 1]?.[1]; const g = p && p.q === 4 && v.q === 4 && p.eps ? (v.eps / p.eps - 1) * 100 : null;
        return `<tr><td>${y}${v.q < 4 ? `（${v.q} 季）` : ''}</td><td>${fmt(v.eps, 2)}</td><td class="${cls(g)}">${g != null ? pctTxt(g, 1) : '—'}</td></tr>`; }).join('')}</table></div>${err}`;
  }
  if (fTab === 'hold') {
    const h = F.hold;
    if (!h) { body.innerHTML = '<p class="empty">查不到持股資料。</p>' + err; return; }
    const top10 = h.list.slice(0, 10).reduce((a, x) => a + x.weight, 0), max = Math.max(...h.list.map(x => x.weight), 0.01);
    const shown = holdAll ? h.list : h.list.slice(0, 20);
    body.innerHTML = `<div class="cards"><div class="card"><span>持股檔數</span><b>${fmt(h.list.length)}${h.full ? '' : '+'}</b></div><div class="card"><span>前十大合計</span><b>${fmt(top10, 1)}%</b></div></div>
      ${h.alloc ? `<p class="small muted">股票 ${fmt(h.alloc.stock, 1)}%・債券 ${fmt(h.alloc.bond, 1)}%・現金 ${fmt(h.alloc.cash, 1)}%</p>` : ''}
      <div class="twrap"><table class="tbl"><tr><th>#</th><th>名稱</th><th>比重</th></tr>
      ${shown.map((x, i) => `<tr><td>${i + 1}</td><td>${x.twCode ? `<button class="linkish" data-open="${x.twCode}">${esc(x.name)}</button>` : esc(x.name)}</td><td><span class="wbar"><i style="width:${x.weight / max * 100}%"></i></span>${fmt(x.weight, 2)}%</td></tr>`).join('')}</table></div>
      ${h.list.length > 20 ? `<button class="btn" id="holdMore" style="margin-top:8px">${holdAll ? '只顯示前 20 檔' : `顯示全部 ${fmt(h.list.length)} 檔`}</button>` : ''}
      <p class="muted small">${esc(h.source)}・${esc(h.date || '')}</p>${err}`;
  }
}
// ---------- 籌碼、營收、公告、回測 ----------
const EXTRA = {};
const lotsTxt = v => `<span class="${cls(v)}">${v > 0 ? '+' : v < 0 ? '-' : ''}${fmt(Math.abs(v))}</span>`;
async function fundExtra(code, tab) {
  const body = $('fBody'), key = `${tab}:${code}`;
  if (tab === 'bt') { body.innerHTML = btHtml(code); bindBt(); return; }
  if (!EXTRA[key]) {
    body.innerHTML = '<p class="empty">載入中…</p>';
    try {
      if (tab === 'chips') {
        const start = CALC.yearsAgo(0.15);
        const [inst, mg] = await Promise.all([finmind('TaiwanStockInstitutionalInvestorsBuySell', code, start), finmind('TaiwanStockMarginPurchaseShortSale', code, start)]);
        const by = {};
        for (const r of inst) { const d = by[r.date] ||= { date: r.date, f: 0, t: 0, d: 0 }; const n = Math.round((r.buy - r.sell) / 1000); if (/Foreign/.test(r.name)) d.f += n; else if (/Investment_Trust/.test(r.name)) d.t += n; else if (/Dealer/.test(r.name)) d.d += n; }
        EXTRA[key] = { days: Object.values(by).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20), margin: mg.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20) };
      }
      if (tab === 'rev') EXTRA[key] = (await finmind('TaiwanStockMonthRevenue', code, CALC.yearsAgo(2.2))).map(r => ({ y: r.revenue_year, m: r.revenue_month, rev: r.revenue, pub: r.create_time }));
      if (tab === 'news') EXTRA[key] = ((await api('/news')).items || []).filter(n => n.code === code);
    } catch (e) { body.innerHTML = `<p class="empty">讀取失敗：${esc(e.message)}</p>`; return; }
  }
  if (fTab !== tab || cur?.code !== code) return;
  const d = EXTRA[key];
  if (tab === 'chips') {
    if (!d.days.length) { body.innerHTML = '<p class="empty">查不到法人買賣超。</p>'; return; }
    const streak = k => { let n = 0; const s = Math.sign(d.days[0][k]); if (!s) return '—'; for (const x of d.days) { if (Math.sign(x[k]) === s) n++; else break; } return s > 0 ? `連買 ${n} 天` : `連賣 ${n} 天`; };
    const sum5 = k => d.days.slice(0, 5).reduce((t, x) => t + x[k], 0), m0 = d.margin[0];
    body.innerHTML = `<div class="cards">${[['外資', 'f'], ['投信', 't'], ['自營商', 'd']].map(([n, k]) => `<div class="card"><span>${n}・${streak(k)}</span><b>${lotsTxt(sum5(k))}</b><span>近 5 日（張）</span></div>`).join('')}
      ${m0 ? `<div class="card"><span>融資餘額</span><b>${fmt(m0.MarginPurchaseTodayBalance)}</b><span>${lotsTxt(m0.MarginPurchaseTodayBalance - m0.MarginPurchaseYesterdayBalance)} 張・融券 ${fmt(m0.ShortSaleTodayBalance)}</span></div>` : ''}</div>
      <div class="twrap"><table class="tbl"><tr><th>日期</th><th>外資</th><th>投信</th><th>自營</th><th>融資</th></tr>
      ${d.days.map(x => { const m = d.margin.find(y => y.date === x.date); return `<tr><td>${x.date.slice(5)}</td><td>${lotsTxt(x.f)}</td><td>${lotsTxt(x.t)}</td><td>${lotsTxt(x.d)}</td><td>${m ? lotsTxt(m.MarginPurchaseTodayBalance - m.MarginPurchaseYesterdayBalance) : ''}</td></tr>`; }).join('')}</table></div>
      <p class="muted small">單位：張。FinMind（證交所、櫃買中心）盤後資料。</p>`;
  }
  if (tab === 'rev') {
    if (!d.length) { body.innerHTML = `<p class="empty">${CALC.isEtf(code) ? 'ETF 沒有月營收。' : '查不到月營收。'}</p>`; return; }
    const k = (y, m) => `${y}-${String(m).padStart(2, '0')}`, map = Object.fromEntries(d.map(r => [k(r.y, r.m), r]));
    const rows = d.map(r => { const p = map[k(r.m === 1 ? r.y - 1 : r.y, r.m === 1 ? 12 : r.m - 1)], l = map[k(r.y - 1, r.m)];
      return { mo: k(r.y, r.m), rev: r.rev, pub: r.pub, mom: p ? (r.rev / p.rev - 1) * 100 : null, yoy: l ? (r.rev / l.rev - 1) * 100 : null }; }).sort((a, b) => b.mo.localeCompare(a.mo)).slice(0, 18);
    body.innerHTML = `<div class="cards"><div class="card"><span>最新 ${rows[0].mo}</span><b>${fmt(rows[0].rev / 1e8, 1)} 億</b></div><div class="card"><span>年增率</span><b class="${cls(rows[0].yoy)}">${pctTxt(rows[0].yoy)}</b><span>月增 ${pctTxt(rows[0].mom)}</span></div></div>
      <div class="twrap"><table class="tbl"><tr><th>月份</th><th>營收（億）</th><th>月增</th><th>年增</th></tr>${rows.map(r => `<tr><td>${r.mo}</td><td>${fmt(r.rev / 1e8, 1)}</td><td class="${cls(r.mom)}">${pctTxt(r.mom)}</td><td class="${cls(r.yoy)}">${pctTxt(r.yoy)}</td></tr>`).join('')}</table></div>
      <p class="muted small">每月 10 日前公布上個月營收。</p>`;
  }
  if (tab === 'news') body.innerHTML = newsHtml(d, '近 30 天沒有重大訊息（電腦版開著時才會更新這份資料）。');
}
function newsHtml(items, empty) {
  return items.length ? items.map(n => `<details class="news"><summary><span class="d">${esc(n.date.slice(5))} ${esc(n.time || '')}・${esc(n.code)} ${esc(n.name || '')}</span><br>${esc(n.subject)}</summary>
    ${n.summary ? `<p><b>AI 摘要：</b>${esc(n.summary)}</p>` : ''}<p class="small">${esc(n.detail || '').replace(/\n/g, '<br>')}</p></details>`).join('') : `<p class="empty small">${empty}</p>`;
}
function btHtml(code) {
  return `<form class="btf" id="btForm"><label>代號（逗號分開，最多 3 檔）<input id="btCodes" value="${esc(code)}${code === '0050' ? ',0056' : ',0050'}" autocomplete="off" autocapitalize="characters"></label>
    <label>每月投入<input id="btAmt" inputmode="numeric" value="10000"></label><label>每月幾號<input id="btDay" inputmode="numeric" value="6"></label>
    <label>回測<select id="btYears"><option value="3">3 年</option><option value="5" selected>5 年</option><option value="10">10 年</option></select></label>
    <button class="primary" type="submit" style="grid-column:1/-1">開始回測</button></form><div id="btOut"></div>`;
}
function bindBt() {
  $('btForm').onsubmit = async e => {
    e.preventDefault();
    $('btOut').innerHTML = '<p class="empty">計算中…</p>';
    try {
      const r = await api('/backtest', { method: 'POST', body: JSON.stringify({ codes: $('btCodes').value, amount: $('btAmt').value, day: $('btDay').value, years: $('btYears').value, rate: S.rate, disc: S.disc, minFee: 1 }) });
      if (r.error) throw new Error(r.error);
      const ok = r.results.filter(x => !x.error), colors = ['var(--accent)', '#d08a2e', '#4c9a6a'];
      const maxV = Math.max(1, ...ok.flatMap(x => x.curve.map(p => Math.max(p.v, p.inv)))), n = Math.max(2, ...ok.map(x => x.curve.length));
      const path = (pts, k) => pts.map((p, i) => `${i ? 'L' : 'M'}${(i / (n - 1) * 1000).toFixed(1)},${(140 - p[k] / maxV * 132).toFixed(1)}`).join('');
      $('btOut').innerHTML = r.results.map((x, i) => x.error ? `<p class="muted small">${x.code}：${esc(x.error)}</p>` : `<div class="card" style="margin-bottom:6px"><span><span style="color:${colors[i]}">●</span> ${x.code} ${esc(x.name || '')}・${x.times} 次</span>
        <b>${fmt(x.value)}</b><span>投入 ${fmt(x.invested)}・<span class="${cls(x.pl)}">${pctTxt(x.plPct)}</span>・年化 ${x.irr != null ? pctTxt(x.irr) : '—'}・最大回落 -${fmt(x.maxDD, 1)}%</span></div>`).join('')
        + (ok.length ? `<svg class="btc" viewBox="0 0 1000 142" preserveAspectRatio="none"><path d="${path(ok[0].curve, 'inv')}" fill="none" stroke="var(--muted)" stroke-dasharray="6 5" stroke-width="2"/>${ok.map((x, i) => `<path d="${path(x.curve, 'v')}" fill="none" stroke="${colors[i]}" stroke-width="3"/>`).join('')}</svg>
          <p class="muted small">虛線是累計投入，實線是市值。用還原股價（配息再投入）、以金額買零股計算。過去績效不代表未來。</p>` : '');
    } catch (err) { $('btOut').innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
  };
}
function chartHtml(h) {
  const days = { '6m': 182, '1y': 365, '3y': 1095, '5y': 1826 }[fRange];
  const from = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  let i0 = h.dates.findIndex(x => x >= from); if (i0 < 0) i0 = 0;
  const step = Math.max(1, Math.floor((h.dates.length - i0) / 300));
  const idx = []; for (let i = i0; i < h.dates.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== h.dates.length - 1) idx.push(h.dates.length - 1);
  const s = { c: idx.map(i => h.close[i]), m20: idx.map(i => CALC.sma(h.close, 20, i)), m60: idx.map(i => CALC.sma(h.close, 60, i)), m240: idx.map(i => CALC.sma(h.close, 240, i)) };
  const all = Object.values(s).flat().filter(v => v != null), lo = Math.min(...all), hi = Math.max(...all), W = 360, H = 150, L = 36;
  const x = i => L + i / (idx.length - 1) * (W - L - 2), y = v => 4 + (1 - (v - lo) / (hi - lo || 1)) * (H - 22);
  const path = a => { let p = '', on = false; a.forEach((v, i) => { if (v == null) { on = false; return; } p += `${on ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; on = true; }); return p; };
  return `<div class="chart"><div class="range">${['6m', '1y', '3y', '5y'].map(r => `<button data-fr="${r}" aria-pressed="${r === fRange}">${{ '6m': '6月', '1y': '1年', '3y': '3年', '5y': '5年' }[r]}</button>`).join('')}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="股價走勢">
      ${[lo, (lo + hi) / 2, hi].map(v => `<text x="0" y="${y(v) + 3}">${fmt(v, v >= 100 ? 0 : 1)}</text>`).join('')}
      <path class="ln m240" d="${path(s.m240)}"/><path class="ln m60" d="${path(s.m60)}"/><path class="ln m20" d="${path(s.m20)}"/><path class="ln c" d="${path(s.c)}"/>
      <text x="${L}" y="${H - 2}">${h.dates[idx[0]]}</text><text x="${W - 2}" y="${H - 2}" text-anchor="end">${h.dates[h.dates.length - 1]}</text></svg>
    <p class="muted small">黑：收盤　藍：月線　橘：季線　綠：年線</p></div>`;
}
$('fTabs').addEventListener('click', e => { const b = e.target.closest('[data-ft]'); if (b) { fTab = b.dataset.ft; renderFund(); } });
$('fBody').addEventListener('click', e => {
  const r = e.target.closest('[data-fr]'); if (r) { fRange = r.dataset.fr; renderFund(); return; }
  if (e.target.id === 'holdMore') { holdAll = !holdAll; renderFund(); return; }
  const o = e.target.closest('[data-open]'); if (o) openStock(o.dataset.open);
});

// ---------- 試算 ----------
let calcMode = 'amt';
function calcHtml() {
  const p = priceNow() || '';
  return `<div class="seg" id="cMode"><button data-cm="amt" aria-pressed="${calcMode === 'amt'}">金額→股數</button><button data-cm="shr" aria-pressed="${calcMode === 'shr'}">股數→金額</button><button data-cm="pl" aria-pressed="${calcMode === 'pl'}">停利停損</button></div>
    <div class="form"><label>${calcMode === 'pl' ? '買進價' : '每股價格'}<input id="cP" inputmode="decimal" value="${p}"></label>
    ${calcMode === 'amt' ? '<label>可用金額<input id="cA" inputmode="decimal" value="100000"></label>' : '<label>股數<input id="cN" inputmode="numeric" value="1000"></label>'}
    ${calcMode === 'pl' ? '<div class="inline"><label>停利 %<input id="cTp" inputmode="decimal" value="10"></label><label>停損 %<input id="cSl" inputmode="decimal" value="5"></label></div>' : ''}</div>
    <div id="cOut"></div>`;
}
function bindCalc() {
  const run = () => {
    const c = feeCfg(), p = Number($('cP').value), out = $('cOut');
    if (!(p > 0)) { out.innerHTML = '<p class="empty">請輸入價格</p>'; return; }
    const line = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
    if (calcMode === 'amt') {
      const amt = Number($('cA').value), n = CALC.maxShares(amt, p, c, 1);
      if (!n) { out.innerHTML = '<p class="empty">金額不足</p>'; return; }
      const g = n * p, f = CALC.fee(n, p, c);
      out.innerHTML = `<div class="cards"><div class="card"><span>最多可買</span><b>${fmt(n)} 股</b><span>${Math.floor(n / 1000) ? `${Math.floor(n / 1000)} 張 + ` : ''}${n % 1000} 股</span></div><div class="card"><span>剩餘</span><b>${fmt(amt - g - f, 0)}</b></div></div>
        <table class="tbl">${line('成交金額', fmt(g, 0))}${line('手續費', fmt(f))}${line('總成本', fmt(g + f, 0))}</table>`;
    } else if (calcMode === 'shr') {
      const n = Math.floor(Number($('cN').value)); if (!(n > 0)) return;
      const g = n * p, f = CALC.fee(n, p, c), tax = Math.floor(g * CALC.taxRate(cur?.code) + 1e-9);
      out.innerHTML = `<table class="tbl">${line('成交金額', fmt(g, 0))}${line('手續費', fmt(f))}${line('買進總成本', `<b>${fmt(g + f, 0)}</b>`)}${line('賣出證交稅', fmt(tax))}${line('賣出實收', fmt(g - f - tax, 0))}</table>`;
    } else {
      const n = Math.floor(Number($('cN').value)); if (!(n > 0)) return;
      const etf = CALC.isEtf(cur?.code), tax = CALC.taxRate(cur?.code), cost = n * p + CALC.fee(n, p, c);
      const be = CALC.priceForNet(cost, n, c, tax, etf), tp = CALC.priceForNet(cost * (1 + Number($('cTp').value) / 100), n, c, tax, etf), sl = CALC.priceForNet(cost * (1 - Number($('cSl').value) / 100), n, c, tax, etf);
      const pl = s => { const v = CALC.sellNet(n, s, c, tax) - cost; return `<span class="${cls(v)}">${v >= 0 ? '+' : '-'}${fmt(Math.abs(v))}</span>`; };
      out.innerHTML = `<table class="tbl">${line('損益兩平', `<b>${fmt(be, 2)}</b>`)}${line('停利賣在', `${fmt(tp, 2)}（${pl(tp)}）`)}${line('停損賣在', `${fmt(sl, 2)}（${pl(sl)}）`)}${line('升降單位', fmt(CALC.tickOf(p, etf), 2))}</table>`;
    }
  };
  $('fBody').querySelectorAll('input').forEach(i => i.addEventListener('input', run));
  $('cMode').onclick = e => { const b = e.target.closest('[data-cm]'); if (b) { calcMode = b.dataset.cm; renderFund(); } };
  run();
}

// ---------- 持股 ----------
function openHoldForm(code, price) {
  $('hForm').hidden = false; $('hCode').value = code || ''; $('hPrice').value = price || ''; $('hShares').value = $('hShares').value || '1000';
  $('hDate').value = CALC.today(); feeHint();
}
function feeHint() { const n = Number($('hShares').value), p = Number($('hPrice').value); $('hFee').textContent = n > 0 && p > 0 ? `手續費約 ${fmt(CALC.fee(n, p, feeCfg()))} 元` : ''; }
['hShares', 'hPrice'].forEach(i => $(i).addEventListener('input', feeHint));
$('hAddBtn').addEventListener('click', () => { $('hForm').hidden ? openHoldForm(cur?.code, Q[cur?.code]?.price) : ($('hForm').hidden = true); });
$('hForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('hCode').value.trim().toUpperCase(), n = Math.floor(Number($('hShares').value)), p = Number($('hPrice').value);
  if (!stockMap.has(code)) return toast('找不到這個代號');
  if (!(n > 0) || !(p > 0)) return toast('請輸入股數和價格');
  DB.run('INSERT INTO holdings (uid, code, buy_date, shares, price, fee) VALUES (?, ?, ?, ?, ?, ?)', [CALC.uid(), code, $('hDate').value || CALC.today(), n, p, CALC.fee(n, p, feeCfg())]);
  $('hForm').hidden = true; toast('已加入持股'); renderHold(); syncSoon(); poll(true);
});
let openLots = new Set();
function renderHold() {
  const rows = DB.all('SELECT * FROM holdings ORDER BY code, buy_date'), c = feeCfg();
  if (!rows.length) { $('hSum').innerHTML = ''; $('holds').innerHTML = '<p class="empty">還沒有持股。按「＋ 新增」，或在「查詢」頁按「加入持股」。</p>'; return; }
  const g = new Map();
  for (const h of rows) { const x = g.get(h.code) || { code: h.code, lots: [], shares: 0, cost: 0 }; x.lots.push(h); x.shares += h.shares; x.cost += h.shares * h.price + h.fee; g.set(h.code, x); }
  let tot = { mv: 0, cost: 0, net: 0, day: 0 };
  const list = [...g.values()].map(x => {
    const q = Q[x.code], s = stockMap.get(x.code) || {}, price = q?.price ?? s.close ?? 0;
    const net = CALC.sellNet(x.shares, price, c, CALC.taxRate(x.code)), pl = net - x.cost;
    tot.mv += x.shares * price; tot.cost += x.cost; tot.net += net; if (q?.prevClose) tot.day += x.shares * (price - q.prevClose);
    const stop = x.lots.find(l => l.stop_price)?.stop_price || null, take = x.lots.find(l => l.take_price)?.take_price || null;
    return { ...x, name: s.name, price, pl, pct: pl / x.cost * 100, stop, take, stopHit: stop && price > 0 && price <= stop, takeHit: take && price > 0 && price >= take };
  });
  const tpl = tot.net - tot.cost;
  $('hSum').innerHTML = `<div class="card"><span>市值</span><b>${fmt(tot.mv)}</b></div><div class="card"><span>損益（扣費稅）</span><b class="${cls(tpl)}">${tpl >= 0 ? '+' : '-'}${fmt(Math.abs(tpl))}</b><span class="${cls(tpl)}">${pctTxt(tot.cost ? tpl / tot.cost * 100 : 0)}</span></div>
    <div class="card"><span>成本</span><b>${fmt(tot.cost)}</b></div><div class="card"><span>今日</span><b class="${cls(tot.day)}">${tot.day >= 0 ? '+' : '-'}${fmt(Math.abs(tot.day))}</b></div>`;
  const st = document.body.classList.contains('stealth');
  $('holds').innerHTML = list.map(x => `<div class="li" data-toggle="${x.code}"><span class="nm"><small>${x.code}</small>${esc(x.name || '')}${x.stopHit ? `<span class="stopb down">${st ? '下限' : '停損'}</span>` : ''}${x.takeHit ? `<span class="stopb up">${st ? '上限' : '停利'}</span>` : ''}</span><span class="p">${fmt(x.price, 2)}</span><span class="c ${cls(x.pl)}">${pctTxt(x.pct)}</span>
    <span class="sub">${fmt(x.shares)} 股・均價 ${fmt(x.cost / x.shares, 2)}・損益 <span class="${cls(x.pl)}">${x.pl >= 0 ? '+' : '-'}${fmt(Math.abs(x.pl))}</span>・${x.lots.length} 筆 ▾</span></div>
    ${openLots.has(x.code) ? `<div class="hact"><span>${st ? '下限' : '停損'}</span><input data-stop="${x.code}" inputmode="decimal" value="${x.stop ?? ''}"><span>${st ? '上限' : '停利'}</span><input data-take="${x.code}" inputmode="decimal" value="${x.take ?? ''}"><button class="btn" data-stops="${x.code}">儲存</button><span class="muted">均價 -10% ${fmt(x.cost / x.shares * 0.9, 2)}・+20% ${fmt(x.cost / x.shares * 1.2, 2)}</span></div>`
      + x.lots.map(l => `<div class="li"><span class="nm small muted">${esc(l.buy_date)}・${fmt(l.shares)} 股 @ ${fmt(l.price, 2)}</span><button class="btn" data-sell="${l.uid}" style="padding:2px 8px">賣出</button><button class="x" data-hdel="${l.uid}" aria-label="刪除這筆">×</button></div>
        <form class="hact" data-sellform="${l.uid}" hidden><span>賣</span><input name="shares" inputmode="numeric" value="${l.shares}"><span>股 @</span><input name="price" inputmode="decimal" value="${x.price || ''}"><input name="date" type="date" value="${CALC.today()}"><button class="btn" type="submit">確定賣出</button></form>`).join('') : ''}`).join('');
  checkStops(list);
}
// 停損停利：同一天同一檔只提示一次（推播由轉接站負責）
const stopShown = new Set();
function checkStops(list) {
  const msgs = [];
  for (const x of list) for (const [hit, kind, px] of [[x.stopHit, '停損', x.stop], [x.takeHit, '停利', x.take]]) {
    const k = `${x.code}-${kind}-${CALC.today()}`;
    if (hit && !stopShown.has(k)) { stopShown.add(k); msgs.push(`${x.code} ${x.name || ''} 到${kind}價 ${fmt(px, 2)}（現價 ${fmt(x.price, 2)}）`); }
  }
  if (msgs.length) { $('alertBar').hidden = false; $('alertBar').innerHTML = msgs.map(h => `<span>${esc(h)}</span>`).join('') + '<button id="abClose">知道了</button>'; $('abClose').onclick = () => { $('alertBar').hidden = true; }; }
}
$('holds').addEventListener('submit', e => {
  const f = e.target.closest('[data-sellform]'); if (!f) return;
  e.preventDefault();
  const h = DB.get('SELECT * FROM holdings WHERE uid = ?', [f.dataset.sellform]);
  const n = Math.floor(Number(f.shares.value)), p = Number(f.price.value);
  if (!h || !(n > 0) || n > h.shares) return toast(`賣出股數要在 1～${h?.shares} 股之間`);
  if (!(p > 0)) return toast('請輸入賣出價格');
  const c = feeCfg(), fee = CALC.fee(n, p, c), tax = Math.floor(n * p * CALC.taxRate(h.code)), buyFee = Math.round(h.fee * n / h.shares * 100) / 100;
  DB.batch(run => {
    run('INSERT INTO sells (uid, code, sell_date, shares, price, fee, tax, buy_date, buy_price, buy_fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [CALC.uid(), h.code, f.date.value || CALC.today(), n, p, fee, tax, h.buy_date, h.price, buyFee]);
    if (n === h.shares) run('DELETE FROM holdings WHERE uid = ?', [h.uid]);
    else run('UPDATE holdings SET shares = ?, fee = ? WHERE uid = ?', [h.shares - n, Math.round((h.fee - buyFee) * 100) / 100, h.uid]);
  });
  const pl = n * p - fee - tax - (n * h.price + buyFee);
  toast(`已賣出，損益 ${pl >= 0 ? '+' : '-'}${fmt(Math.abs(pl))} 元`); renderHold(); syncSoon();
});
$('holds').addEventListener('click', e => {
  const sb = e.target.closest('[data-sell]');
  if (sb) { e.stopPropagation(); const f = document.querySelector(`[data-sellform="${sb.dataset.sell}"]`); f.hidden = !f.hidden; return; }
  const ss = e.target.closest('[data-stops]');
  if (ss) {
    const code = ss.dataset.stops, v = x => { const n = Number(x); return n > 0 ? n : null; };
    DB.run('UPDATE holdings SET stop_price = ?, take_price = ? WHERE code = ?', [v(document.querySelector(`[data-stop="${code}"]`).value), v(document.querySelector(`[data-take="${code}"]`).value), code]);
    toast('已儲存，到價會通知'); renderHold(); syncSoon(); return;
  }
  if (e.target.closest('.hact')) return;
  const d = e.target.closest('[data-hdel]');
  if (d) { if (d.dataset.armed !== '1') { d.dataset.armed = '1'; d.textContent = '確定？'; return; } DB.run('DELETE FROM holdings WHERE uid = ?', [d.dataset.hdel]); renderHold(); syncSoon(); return; }
  const t = e.target.closest('[data-toggle]'); if (t) { const c = t.dataset.toggle; openLots.has(c) ? openLots.delete(c) : openLots.add(c); renderHold(); }
});

// ---------- 持股頁：除權息、年度損益、組合分析、重大訊息 ----------
const DIVS = {};
async function divsOf(code) {
  if (DIVS[code]) return DIVS[code];
  const rows = await finmind('TaiwanStockDividend', code, CALC.yearsAgo(3)).catch(() => []);
  return DIVS[code] = rows.map(d => ({ exDate: d.CashExDividendTradingDate || '', payDate: d.CashDividendPaymentDate || '', cash: (d.CashEarningsDistribution || 0) + (d.CashStatutorySurplus || 0) })).filter(d => d.exDate && d.cash > 0);
}
function lotsAll() {
  return [...DB.all('SELECT code, buy_date, shares FROM holdings').map(h => ({ code: h.code, buy: h.buy_date, sold: null, shares: h.shares })),
    ...DB.all('SELECT code, buy_date, sell_date, shares FROM sells').map(s => ({ code: s.code, buy: s.buy_date || '0000', sold: s.sell_date, shares: s.shares }))];
}
async function renderDivPanel(box) {
  const held = {}; for (const h of DB.all('SELECT code, SUM(shares) AS s FROM holdings GROUP BY code')) held[h.code] = h.s;
  const codes = [...new Set([...Object.keys(held), ...watchCodes()])], today = CALC.today(), out = [];
  for (const code of codes) for (const d of await divsOf(code)) if (d.exDate >= today) out.push({ code, ...d, shares: held[code] || 0 });
  out.sort((a, b) => a.exDate.localeCompare(b.exDate));
  box.innerHTML = out.length ? out.map(x => `<div class="li"><span class="nm"><small>${x.code}</small>${esc(stockMap.get(x.code)?.name || '')}${x.shares ? '' : '<small>（自選）</small>'}</span><span class="p">${esc(x.exDate.slice(5))}</span><span class="c">${fmt(x.cash, 3)} 元</span>
    <span class="sub">${x.shares ? `持有 ${fmt(x.shares)} 股，預估可領 ${fmt(Math.round(x.shares * x.cash))} 元` : '目前沒持有'}${x.payDate ? `・${esc(x.payDate.slice(5))} 發放` : ''}</span></div>`).join('')
    + '<p class="muted small">除息日前一天收盤前持有才領得到。開了推播，除息前一天晚上 7 點會通知。</p>' : '<p class="empty small">持股和自選股近期沒有除息公告。</p>';
}
async function renderYearPanel(box) {
  const year = String(new Date().getFullYear()), sells = DB.all('SELECT * FROM sells WHERE sell_date LIKE ? ORDER BY sell_date DESC', [`${year}%`]);
  const ls = lotsAll(), divs = [];
  for (const code of [...new Set(ls.map(l => l.code))]) for (const d of await divsOf(code)) {
    if (!d.exDate.startsWith(year) || d.exDate > CALC.today()) continue;
    const sh = ls.filter(l => l.code === code && l.buy < d.exDate && (!l.sold || l.sold >= d.exDate)).reduce((t, l) => t + l.shares, 0);
    if (sh) divs.push({ code, exDate: d.exDate, cash: d.cash, shares: sh, amount: Math.round(sh * d.cash) });
  }
  const pl = s => s.shares * s.price - s.fee - s.tax - (s.shares * s.buy_price + s.buy_fee);
  const realized = sells.reduce((t, s) => t + pl(s), 0), divSum = divs.reduce((t, d) => t + d.amount, 0), nhi = divs.filter(d => d.amount >= 20000);
  box.innerHTML = `<div class="cards"><div class="card"><span>${year} 已實現損益</span><b class="${cls(realized)}">${realized >= 0 ? '+' : '-'}${fmt(Math.abs(realized))}</b></div><div class="card"><span>股利收入</span><b>${fmt(divSum)}</b><span>${divs.length} 筆</span></div>
    <div class="card"><span>手續費＋證交稅</span><b>${fmt(sells.reduce((t, s) => t + s.fee + s.tax + s.buy_fee, 0))}</b></div><div class="card"><span>合計</span><b class="${cls(realized + divSum)}">${fmt(realized + divSum)}</b></div></div>
    ${nhi.length ? `<div class="warnl">有 ${nhi.length} 筆股利超過 2 萬元，會扣 2.11% 二代健保補充保費（約 ${fmt(nhi.reduce((t, d) => t + Math.round(d.amount * 0.0211), 0))} 元）。</div>` : ''}
    ${sells.map(s => `<div class="li"><span class="nm"><small>${s.code}</small>${esc(stockMap.get(s.code)?.name || '')}</span><span class="p">${esc(s.sell_date.slice(5))}</span><span class="c ${cls(pl(s))}">${pl(s) >= 0 ? '+' : '-'}${fmt(Math.abs(pl(s)))}</span>
      <span class="sub">${fmt(s.shares)} 股・買 ${fmt(s.buy_price, 2)} → 賣 ${fmt(s.price, 2)}</span></div>`).join('')}
    ${divs.map(d => `<div class="li"><span class="nm"><small>${d.code}</small>股利</span><span class="p">${esc(d.exDate.slice(5))}</span><span class="c">${fmt(d.amount)}</span><span class="sub">${fmt(d.shares)} 股 × ${fmt(d.cash, 3)} 元</span></div>`).join('')}
    <p class="muted small">在持股明細按「賣出」會記到這裡。完整的報表（含歷年）在電腦版「資產」頁。</p>`;
}
async function renderPfPanel(box) {
  const rows = DB.all('SELECT code, SUM(shares) AS shares, SUM(shares * price + fee) AS cost FROM holdings GROUP BY code');
  if (!rows.length) { box.innerHTML = '<p class="empty small">還沒有持股。</p>'; return; }
  let ind = {};
  try { ind = JSON.parse(DB.meta('industry') || '{}'); } catch {}
  if (!ind._at || Date.now() - ind._at > 7 * 86400e3) {
    try { const all = await finmind('TaiwanStockInfo', '', ''); ind = { _at: Date.now() }; for (const r of all) if (!ind[r.stock_id] || ind[r.stock_id] === '電子工業') ind[r.stock_id] = r.industry_category; DB.setMeta('industry', JSON.stringify(ind)); } catch {}
  }
  const st = rows.map(r => { const px = Q[r.code]?.price ?? stockMap.get(r.code)?.close ?? 0; return { ...r, name: stockMap.get(r.code)?.name || '', value: r.shares * px, industry: ind[r.code] || (CALC.isEtf(r.code) ? 'ETF' : '其他') }; });
  const total = st.reduce((t, x) => t + x.value, 0) || 1;
  st.forEach(x => { x.w = x.value / total * 100; }); st.sort((a, b) => b.value - a.value);
  const inds = {}; for (const x of st) inds[x.industry] = (inds[x.industry] || 0) + x.w;
  // ETF 成分股重疊（透過轉接站查 ETF 持股）
  const etfs = st.filter(x => CALC.isEtf(x.code)), comp = {};
  for (const e of etfs.slice(0, 5)) { try { comp[e.code] = (await api(`/etf-holdings?code=${e.code}`)).list || []; } catch {} }
  const ov = [];
  for (let i = 0; i < etfs.length; i++) for (let j = i + 1; j < etfs.length; j++) {
    const A = comp[etfs[i].code] || [], B = Object.fromEntries((comp[etfs[j].code] || []).map(x => [x.twCode || x.name, x.weight]));
    if (A.length && Object.keys(B).length) ov.push([etfs[i].code, etfs[j].code, Math.round(A.reduce((t, x) => t + Math.min(x.weight, B[x.twCode || x.name] || 0), 0))]);
  }
  const bar = (label, w) => `<div class="b"><span>${label}</span><i style="width:${Math.max(1, w)}%"></i><span>${fmt(w, 1)}%</span></div>`;
  const warns = [];
  if (st[0].w > 40) warns.push(`${st[0].code} 占了 ${fmt(st[0].w, 0)}%，集中在單一標的。`);
  const topInd = Object.entries(inds).sort((a, b) => b[1] - a[1])[0];
  if (topInd && topInd[1] > 60 && topInd[0] !== 'ETF') warns.push(`${topInd[0]} 占了 ${fmt(topInd[1], 0)}%，產業過度集中。`);
  for (const [a, b, o] of ov) if (o >= 50) warns.push(`${a} 和 ${b} 成分股重疊約 ${o}%，分散效果有限。`);
  box.innerHTML = `${warns.map(w => `<div class="warnl">${esc(w)}</div>`).join('')}<div class="bars"><b class="small">各檔占比</b>${st.map(x => bar(`${x.code} ${esc(x.name)}`, x.w)).join('')}
    <b class="small">產業分布</b>${Object.entries(inds).sort((a, b) => b[1] - a[1]).map(([k, w]) => bar(esc(k), w)).join('')}</div>
    ${ov.length ? `<p class="small">ETF 重疊：${ov.map(([a, b, o]) => `${a}×${b} ${o}%`).join('、')}</p>` : ''}<p class="muted small">和大盤比較、透過 ETF 間接持有的股票，在電腦版「資產」頁。</p>`;
}
async function renderNewsPanel(box) {
  try {
    const codes = new Set([...DB.all('SELECT DISTINCT code FROM holdings').map(r => r.code), ...watchCodes()]);
    const r = await api('/news');
    box.innerHTML = newsHtml((r.items || []).filter(n => codes.has(n.code)), '近 30 天持股與自選股沒有重大訊息。') + (r.at ? `<p class="muted small">電腦版整理於 ${esc(r.at.slice(5, 16))}</p>` : '');
  } catch (e) { box.innerHTML = `<p class="empty small">讀取失敗：${esc(e.message)}</p>`; }
}
for (const [id, fn] of [['pDiv', renderDivPanel], ['pYear', renderYearPanel], ['pPf', renderPfPanel], ['pNews', renderNewsPanel]]) {
  $(id).addEventListener('toggle', () => { if ($(id).open) { const b = $(id).querySelector('.mbody'); b.innerHTML = '<p class="empty small">載入中…</p>'; fn(b).catch(e => { b.innerHTML = `<p class="empty small">${esc(e.message)}</p>`; }); } });
}

// ---------- 推播通知 ----------
function urlB64ToUint8(s) { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return '這個瀏覽器不支援推播。iPhone 要 iOS 16.4 以上，而且要從主畫面打開 App。';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? '已開啟推播：到價提醒、停損停利、除息前一天會通知。' : Notification.permission === 'denied' ? '通知被關閉了，請到 iPhone「設定 → 通知 → 資料查詢」打開。' : '還沒開啟推播。';
}
$('pushOn').addEventListener('click', async () => {
  try {
    if (!('PushManager' in window)) throw new Error('請先把 App 加到主畫面，再從主畫面打開');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('沒有允許通知');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/push/key');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ sub: sub.toJSON(), device: navigator.userAgent.includes('iPhone') ? 'iPhone' : '手機' }) });
    toast('已開啟推播'); $('pushInfo').textContent = await pushState();
  } catch (e) { toast(`開啟失敗：${e.message}`); }
});
$('pushTest').addEventListener('click', async () => { try { const r = await api('/push/test', { method: 'POST' }); toast(r.total ? `已送出（${r.sent}/${r.total} 台裝置）` : '還沒有裝置開啟推播'); } catch (e) { toast(e.message); } });
$('pushOff').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker.getRegistration(), sub = await reg?.pushManager.getSubscription();
  if (sub) { await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {}); await sub.unsubscribe(); }
  toast('已關閉推播'); $('pushInfo').textContent = await pushState();
});

// ---------- 排行 ----------
let mvSide = 'up', MV = null, mvAt = 0;
async function loadMovers(force) {
  if (!force && MV && Date.now() - mvAt < 30e3) return renderMovers();
  $('movers').innerHTML = '<p class="empty">載入中…</p>';
  try { MV = await api(`/movers?type=${S.mvType}&minVol=${S.mvVol}&minCap=${S.mvType === 'etf' ? 0 : S.mvCap}`); mvAt = Date.now(); renderMovers(); }
  catch (e) { $('movers').innerHTML = `<p class="empty">排行讀取失敗：${esc(e.message)}</p>`; }
}
function renderMovers() {
  if (!MV) return;
  const list = MV[mvSide] || [];
  $('movers').innerHTML = list.length ? list.map((x, i) => `<div class="li" data-code="${x.code}"><span class="nm"><small>${i + 1}. ${x.code}</small>${esc(x.name)}</span><span class="p">${fmt(x.price, 2)}</span><span class="c ${cls(x.pct)}">${pctTxt(x.pct)}</span>
    <span class="sub">成交 ${fmt(x.volume)} 張${x.cap != null ? `・市值 ${capTxt(x.cap)}` : ''}</span></div>`).join('') : '<p class="empty">沒有符合條件的股票</p>';
  $('mvMeta').textContent = `${MV.time ? new Date(MV.time).toLocaleTimeString('zh-TW', { hour12: false }) + ' 更新・' : ''}排除成交量未滿 ${fmt(S.mvVol)} 張${S.mvCap && S.mvType !== 'etf' ? `、市值未滿 ${fmt(S.mvCap)} 億` : ''}`;
}
$('movers').addEventListener('click', e => { const r = e.target.closest('[data-code]'); if (r) openStock(r.dataset.code); });
$('mvType').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; setS('mvType', b.dataset.t); syncMvUi(); loadMovers(true); });
$('mvSide').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; mvSide = b.dataset.s; syncMvUi(); renderMovers(); });
$('mvVol').addEventListener('change', e => { setS('mvVol', Number(e.target.value)); loadMovers(true); });
$('mvCap').addEventListener('change', e => { setS('mvCap', Number(e.target.value)); loadMovers(true); });
function syncMvUi() {
  document.querySelectorAll('#mvType button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === S.mvType)));
  document.querySelectorAll('#mvSide button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === mvSide)));
  $('mvVol').value = String(S.mvVol); $('mvCap').value = String(S.mvCap); $('mvCap').disabled = S.mvType === 'etf';
}

// ---------- 同步 ----------
let syncT = null, syncing = false, lastSync = null;   // 資料庫開好後才讀取
function localDoc() {
  const doc = { watchlist: {}, holdings: {}, alerts: {}, sells: {} };
  for (const w of DB.all('SELECT * FROM watchlist')) doc.watchlist[w.code] = { order: w.sort_order };
  for (const h of DB.all('SELECT * FROM holdings')) doc.holdings[h.uid] = { code: h.code, buy_date: h.buy_date, shares: h.shares, price: h.price, fee: h.fee, note: h.note || null, stop: h.stop_price ?? null, take: h.take_price ?? null };
  for (const a of DB.all('SELECT * FROM alerts')) doc.alerts[a.uid] = { code: a.code, direction: a.direction, price: a.price, created_at: a.created_at, triggered_at: a.triggered_at || null, hit_price: a.hit_price ?? null };
  for (const x of DB.all('SELECT * FROM sells')) doc.sells[x.uid] = { code: x.code, sell_date: x.sell_date, shares: x.shares, price: x.price, fee: x.fee, tax: x.tax, buy_date: x.buy_date, buy_price: x.buy_price, buy_fee: x.buy_fee, note: x.note || null };
  return doc;
}
function applyDoc(doc) {
  DB.batch(run => {
    run('DELETE FROM watchlist'); for (const [code, w] of Object.entries(doc.watchlist || {})) run('INSERT INTO watchlist (code, sort_order) VALUES (?, ?)', [code, w.order]);
    run('DELETE FROM holdings'); for (const [uid, h] of Object.entries(doc.holdings || {})) run('INSERT INTO holdings (uid, code, buy_date, shares, price, fee, note, stop_price, take_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, h.code, h.buy_date, h.shares, h.price, h.fee, h.note, h.stop ?? null, h.take ?? null]);
    run('DELETE FROM sells'); for (const [uid, x] of Object.entries(doc.sells || {})) run('INSERT INTO sells (uid, code, sell_date, shares, price, fee, tax, buy_date, buy_price, buy_fee, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, x.code, x.sell_date, x.shares, x.price, x.fee, x.tax, x.buy_date, x.buy_price, x.buy_fee, x.note]);
    run('DELETE FROM alerts'); for (const [uid, a] of Object.entries(doc.alerts || {})) run('INSERT INTO alerts (uid, code, direction, price, created_at, triggered_at, hit_price) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, a.code, a.direction, a.price, a.created_at, a.triggered_at, a.hit_price]);
  });
}
async function syncNow() {
  if (syncing || !S.token) return;
  syncing = true;
  try {
    for (let i = 0; i < 3; i++) {
      const remote = await api('/sync');
      const base = JSON.parse(DB.meta('sync_base') || '{}'), local = localDoc();
      const merged = CALC.mergeDoc(base, local, remote.doc || {});
      if (!CALC.same(merged, remote.doc)) {
        const put = await api('/sync', { method: 'PUT', headers: { 'If-Match': String(remote.rev || 0) }, body: JSON.stringify({ doc: merged }) });
        if (put.status === 409) continue;
      }
      if (!CALC.same(merged, local)) { applyDoc(merged); renderWatch(); renderHold(); }
      DB.setMeta('sync_base', JSON.stringify(merged));
      break;
    }
    lastSync = new Date().toLocaleString('zh-TW', { hour12: false }); DB.setMeta('sync_last', lastSync);
    $('syncInfo').textContent = `已和電腦版同步：${lastSync}`;
  } catch (e) { $('syncInfo').textContent = `同步失敗：${e.message}`; }
  finally { syncing = false; }
}
function syncSoon(ms = 1500) { clearTimeout(syncT); syncT = setTimeout(syncNow, ms); }
setInterval(() => { if (!document.hidden) syncNow(); }, 60e3);

// ---------- 日報（電腦版產生，透過轉接站下載；讀過的存在手機，離線也能看） ----------
let rpKind = 'all', rpOpen = null;
function mdToHtml(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const lines = String(md || '').replace(/\r/g, '').split('\n'), out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      close();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tw"><table><tr>${head.map(x => `<th>${inline(x)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(x => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = l.match(/^\s*[-*]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) { const t = ul ? 'ul' : 'ol'; if (list !== t) { close(); out.push(`<${t}>`); list = t; } out.push(`<li>${inline((ul || ol)[1])}</li>`); continue; }
    close();
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  close();
  return out.join('');
}
async function loadReports() {
  try {
    const { reports } = await api('/reports');
    const keep = new Set(reports.map(r => r.key));
    DB.batch(run => {
      for (const r of reports) {
        const local = DB.get('SELECT created_at FROM reports WHERE key = ?', [r.key]);
        if (!local) run('INSERT INTO reports (key, kind, created_at, model, headline, count) VALUES (?, ?, ?, ?, ?, ?)', [r.key, r.kind, r.created_at, r.model, r.headline, r.count]);
        else if (local.created_at !== r.created_at) run('UPDATE reports SET kind = ?, created_at = ?, model = ?, headline = ?, count = ?, json = NULL WHERE key = ?', [r.kind, r.created_at, r.model, r.headline, r.count, r.key]);
      }
      for (const l of DB.all('SELECT key FROM reports')) if (!keep.has(l.key)) run('DELETE FROM reports WHERE key = ?', [l.key]);
    });
    renderReports();
    prefetchReports();
  } catch (e) {
    renderReports(`目前連不上轉接站，顯示手機裡已下載的日報（${e.message}）`);
  }
}
// 背景下載最新 10 份，通勤沒訊號時也能看
async function prefetchReports() {
  for (const r of DB.all('SELECT key FROM reports WHERE json IS NULL ORDER BY created_at DESC LIMIT 10')) {
    try { const j = await api(`/report?key=${encodeURIComponent(r.key)}`); DB.run('UPDATE reports SET json = ? WHERE key = ?', [JSON.stringify(j), r.key]); } catch { break; }
  }
  if (!rpOpen) renderReports();
}
function hilite(text, words) {
  let s = esc(text);
  for (const w of words) s = s.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  return s;
}
function renderReports(note) {
  document.querySelectorAll('#rpKind button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === rpKind)));
  const words = $('rpQ').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let rows = DB.all('SELECT * FROM reports ORDER BY created_at DESC');
  if (rpKind !== 'all') rows = rows.filter(r => (r.kind || 'video') === rpKind);
  if (words.length) rows = rows.filter(r => { const hay = `${r.key} ${r.headline} ${r.json || ''}`.toLowerCase(); return words.every(w => hay.includes(w)); });
  const total = DB.get('SELECT COUNT(*) AS n, SUM(json IS NOT NULL) AS d FROM reports');
  $('rpMeta').textContent = note || (total.n ? `共 ${total.n} 份，已下載 ${total.d || 0} 份可離線閱讀${words.length ? '（搜尋只涵蓋已下載的內容）' : ''}` : '');
  $('reports').innerHTML = rows.length ? rows.map(r => `<div class="rp" data-key="${esc(r.key)}">
    <span class="t"><b>${esc(r.key.replace(/ (自訂|社群)$/, ''))}</b><span class="pill ${r.kind === 'social' ? 'social' : ''}">${r.kind === 'social' ? '社群' : r.key.endsWith('自訂') ? '自訂分析' : '每日'}</span>
      <span class="muted small">${r.count || 0} ${r.kind === 'social' ? '則' : '支'}</span>${r.json ? '' : '<span class="offline">未下載</span>'}</span>
    <span class="h">${hilite(r.headline || '', words)}</span></div>`).join('')
    : `<p class="empty">${total.n ? '沒有符合的日報。' : '還沒有日報。電腦版產生日報後，下次同步就會出現在這裡。'}</p>`;
}
async function openReport(key) {
  let r = DB.get('SELECT * FROM reports WHERE key = ?', [key]);
  if (!r) return;
  rpOpen = key;
  $('rpList').hidden = true; $('rpView').hidden = false; window.scrollTo(0, 0);
  $('rpBody').innerHTML = '<p class="empty">載入中…</p>'; $('rpStats').innerHTML = ''; $('rpItems').innerHTML = '';
  let j = r.json ? JSON.parse(r.json) : null;
  if (!j) {
    try { j = await api(`/report?key=${encodeURIComponent(key)}`); DB.run('UPDATE reports SET json = ? WHERE key = ?', [JSON.stringify(j), key]); }
    catch (e) { $('rpBody').innerHTML = `<p class="empty">這份日報還沒下載到手機，目前也連不上轉接站（${esc(e.message)}）。</p>`; return; }
  }
  if (rpOpen !== key) return;
  $('rpInfo').textContent = `${String(j.created_at || '').slice(5, 16)}・${j.model || ''}`;
  $('rpItemsSum').textContent = `收錄的${j.kind === 'social' ? '貼文' : '影片'}（${(j.items || []).length}）`;
  $('rpItems').innerHTML = `<ol>${(j.items || []).map(it => `<li>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)} <span class="muted small">${esc(it.channel || '')}</span></li>`).join('')}</ol>`;
  $('rpStats').innerHTML = j.stats ? socialStats(j.stats) : '';
  $('rpBody').innerHTML = mdToHtml(j.content);
}
// 社群日報的統計：數字、個股熱度（點開看誰說了什麼）、帳號觀點
function socialStats(st) {
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
  return `<div class="cards"><div class="card"><span>收集貼文</span><b>${st.totalPosts}</b></div><div class="card"><span>和股票有關</span><b>${st.stockPosts}</b></div>
    <div class="card"><span>提到的個股</span><b>${st.tickers.length} 檔</b></div><div class="card"><span>整體氣氛</span><b class="${st.overall === '偏多' ? 'up' : st.overall === '偏空' ? 'down' : ''}">${esc(st.overall)}</b></div></div>
    ${st.tickers.length ? `<div class="panel heat" style="margin-bottom:10px"><b>個股熱度</b>${st.tickers.slice(0, 15).map(t => `<details><summary class="hr"><span class="nm">${esc(t.ticker && t.ticker !== t.name ? `${t.ticker} ${t.name}` : t.name)}</span>
      <span class="mkb">${t.market === '台股' ? '台' : t.market === '美股' ? '美' : '他'}</span>
      <span class="sbar"><i class="b" style="width:${pct(t.看多, t.mentions)}%"></i><i class="s" style="width:${pct(t.看空, t.mentions)}%"></i><i class="n" style="width:${pct(t.中性, t.mentions)}%"></i></span>
      <span class="n small">${t.mentions} 次</span></summary>
      <div class="hq">${t.quotes.map(q => `<span><b>${esc(q.author)}</b>（${esc(q.view)}）：${esc(q.reason || '')}</span>`).join('')}
      ${t.market === '台股' && stockMap.has(t.ticker) ? `<button class="btn" data-open="${esc(t.ticker)}">看報價</button>` : ''}</div></details>`).join('')}</div>` : ''}`;
}
$('reports').addEventListener('click', e => { const r = e.target.closest('[data-key]'); if (r) openReport(r.dataset.key); });
$('rpBack').addEventListener('click', () => { rpOpen = null; $('rpView').hidden = true; $('rpList').hidden = false; renderReports(); });
$('rpKind').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) { rpKind = b.dataset.k; renderReports(); } });
$('rpQ').addEventListener('input', () => renderReports());
$('rpStats').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openStock(b.dataset.open); });

// ---------- 分頁 ----------
function go(v) {
  view = v;
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== `v-${v}`; });
  document.querySelectorAll('.tabbar button').forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === v));
  if (v === 'watch') renderWatch();
  if (v === 'quote') renderQuote();
  if (v === 'hold') renderHold();
  if (v === 'movers') { syncMvUi(); loadMovers(); }
  if (v === 'settings') renderSettings();
  if (v === 'reports') { if (!rpOpen) { renderReports(); loadReports(); } }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

// ---------- 設定 ----------
function renderSettings() {
  applyTheme();
  $('sInt').value = String(S.interval); $('sMkt').checked = !!S.marketOnly;
  $('sRate').value = S.rate; $('sDisc').value = S.disc; $('sMin').value = S.minFee;
  $('syncInfo').textContent = lastSync ? `已和電腦版同步：${lastSync}` : '還沒同步過';
  $('sVer').textContent = `版本 ${APP_VERSION}・股票清單 ${STOCKS.length} 檔（${DB.meta('stocks_date') || '—'}）`;
  pushState().then(t => { $('pushInfo').textContent = t; });
}
$('sTheme').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { setS('theme', b.dataset.v); applyTheme(); renderIndex(); } });
$('sInt').addEventListener('change', e => { setS('interval', Number(e.target.value)); startTimer(); });
$('sMkt').addEventListener('change', e => { setS('marketOnly', e.target.checked); poll(true); });
[['sRate', 'rate'], ['sDisc', 'disc'], ['sMin', 'minFee']].forEach(([id, k]) => $(id).addEventListener('change', e => { const v = Number(e.target.value); if (v >= 0) setS(k, v); }));
$('sSync').addEventListener('click', async () => { await syncNow(); toast($('syncInfo').textContent); });
$('sRepair').addEventListener('click', () => showSetup('輸入電腦版新產生的配對碼'));

// ---------- 啟動 ----------
async function afterSetup() {
  await refreshStocks().catch(e => toast(`股票清單讀取失敗：${e.message}`));
  await syncNow();
  startTimer();
  go(view);
  const code = new URLSearchParams(location.search).get('code');
  if (code && stockMap.has(code)) { history.replaceState(null, '', location.pathname); openStock(code); }
}
(async () => {
  try {
    await DB.open();
    loadSettings(); applyTheme(); loadStocksLocal();
    lastSync = DB.meta('sync_last');
    $('loading').hidden = true;
    go('watch');
    if (!S.token) showSetup(); else afterSetup();
  } catch (e) { $('loading').textContent = `載入失敗：${e.message}`; }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
