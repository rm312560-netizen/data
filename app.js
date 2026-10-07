// 資料查詢（手機版）：大盤、自選股、查詢與基本資料、試算、持股、排行、到價提醒；與電腦版同步
const APP_VERSION = '1.0.0';
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
let timer = null, lastOk = 0, Q = {}, INDEX = [], inflight = false;
function startTimer() { clearInterval(timer); poll(true); timer = setInterval(poll, S.interval * 1000); }
async function poll(force) {
  if (inflight || !S.token || document.hidden) return;
  if (!force && S.marketOnly && !marketOpen() && lastOk && Date.now() - lastOk < 30 * 60e3) { renderState(); return; }
  inflight = true;
  try {
    const codes = [...new Set([cur?.code, ...watchCodes(), ...DB.all('SELECT DISTINCT code FROM holdings').map(r => r.code), ...DB.all('SELECT DISTINCT code FROM alerts WHERE triggered_at IS NULL').map(r => r.code)].filter(Boolean))];
    const [qr, ir] = await Promise.all([codes.length ? api(`/quote?codes=${codes.join(',')}`) : { quotes: [] }, api('/index')]);
    qr.quotes.forEach(q => { Q[q.code] = q; });
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
function renderAlerts() {
  const rows = DB.all('SELECT * FROM alerts ORDER BY triggered_at IS NOT NULL, created_at DESC');
  $('alerts').innerHTML = rows.length ? rows.map(a => {
    const s = stockMap.get(a.code) || {};
    return `<div class="li"><span class="nm"><small>${a.code}</small>${esc(s.name || '')}</span>
      <span class="p">${a.direction === 'above' ? '≥' : '≤'} ${fmt(a.price, 2)}</span>
      <button class="x" data-adel="${a.uid}" aria-label="刪除提醒">×</button>
      <span class="sub">${a.triggered_at ? `已到價 ${esc(String(a.triggered_at).slice(5, 16))}（${fmt(a.hit_price, 2)}）` : Q[a.code] ? `現價 ${fmt(Q[a.code].price, 2)}・等待中` : '等待中'}</span></div>`;
  }).join('') : '<p class="empty small">沒有提醒。App 開著的時候，股價到了會在上方顯示提醒。</p>';
}
$('alerts').addEventListener('click', e => { const b = e.target.closest('[data-adel]'); if (b) { DB.run('DELETE FROM alerts WHERE uid = ?', [b.dataset.adel]); renderAlerts(); syncSoon(); } });
function checkAlerts() {
  const hits = [];
  for (const a of DB.all('SELECT * FROM alerts WHERE triggered_at IS NULL')) {
    const q = Q[a.code]; if (!q?.price) continue;
    if (a.direction === 'above' ? q.price >= a.price : q.price <= a.price) {
      DB.run('UPDATE alerts SET triggered_at = ?, hit_price = ? WHERE uid = ?', [new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }), q.price, a.uid]);
      hits.push(`${a.code} ${stockMap.get(a.code)?.name || ''} ${a.direction === 'above' ? '漲到' : '跌到'} ${fmt(q.price, 2)}`);
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
  $('quote').innerHTML = `<div class="panel qcard">
    <div class="qhead"><b>${s.code} ${esc(s.name)} <span class="muted small">${MKT[s.market] || ''}</span></b><span class="muted small">${qt ? `${esc(qt.time)} 更新` : '報價載入中…'}</span></div>
    ${qt ? `<div class="qprice"><span class="big ${cls(d)}">${v(qt.price)}</span><span class="${cls(d)}">${sign(d)}${fmt(Math.abs(d), 2)}（${pctTxt(qt.prevClose ? d / qt.prevClose * 100 : 0)}）</span></div>
    <div class="qstats"><div><span class="muted">開盤</span><b>${v(qt.open)}</b></div><div><span class="muted">最高</span><b>${v(qt.high)}</b></div><div><span class="muted">最低</span><b>${v(qt.low)}</b></div><div><span class="muted">昨收</span><b>${v(qt.prevClose)}</b></div>
      <div><span class="muted">成交量</span><b>${qt.volume != null ? fmt(qt.volume) : '—'}</b></div><div><span class="muted">漲停</span><b>${v(qt.limitUp)}</b></div><div><span class="muted">跌停</span><b>${v(qt.limitDown)}</b></div>
      <div><span class="muted">市值</span><b>${s.shares && qt.price ? capTxt(s.shares * qt.price / 1e8) : '—'}</b></div></div>
    <div class="book"><table>${(qt.bids || []).slice(0, 5).map(b => `<tr><td class="${cls(b.price - qt.prevClose)}">${v(b.price)}</td><td>${b.vol != null ? fmt(b.vol) : ''}</td></tr>`).join('')}</table>
      <table>${(qt.asks || []).slice(0, 5).map(b => `<tr><td class="${cls(b.price - qt.prevClose)}">${v(b.price)}</td><td>${b.vol != null ? fmt(b.vol) : ''}</td></tr>`).join('')}</table></div>` : ''}
    <div class="qact"><button class="btn" id="qWatch">${inWatch ? '✓ 已在自選' : '＋ 加入自選'}</button><button class="btn" id="qAlert">到價提醒</button><button class="btn" id="qHold">加入持股</button></div>
    <form class="inline" id="qAlertForm" hidden><select id="qaDir"><option value="above">漲到 ≥</option><option value="below">跌到 ≤</option></select><input id="qaPrice" inputmode="decimal" placeholder="價格"><button class="btn" type="submit">新增</button></form>
  </div>`;
  $('qWatch').onclick = () => {
    if (inWatch) DB.run('DELETE FROM watchlist WHERE code = ?', [s.code]);
    else DB.run('INSERT INTO watchlist (code, sort_order) VALUES (?, ?)', [s.code, (DB.get('SELECT MAX(sort_order) AS m FROM watchlist').m || 0) + 1]);
    renderQuote(); renderWatch(); syncSoon(); toast(inWatch ? '已移出自選' : '已加入自選');
  };
  $('qAlert').onclick = () => { $('qAlertForm').hidden = !$('qAlertForm').hidden; };
  $('qAlertForm').onsubmit = e => {
    e.preventDefault(); const p = Number($('qaPrice').value);
    if (!(p > 0)) return toast('請輸入價格');
    DB.run('INSERT INTO alerts (uid, code, direction, price, created_at) VALUES (?, ?, ?, ?, ?)', [CALC.uid(), s.code, $('qaDir').value, p, new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })]);
    toast('已新增提醒'); renderAlerts(); syncSoon(); $('qAlertForm').hidden = true;
  };
  $('qHold').onclick = () => { go('hold'); openHoldForm(s.code, qt?.price || s.close); };
  $('fund').hidden = false;
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
    return { ...x, name: s.name, price, pl, pct: pl / x.cost * 100 };
  });
  const tpl = tot.net - tot.cost;
  $('hSum').innerHTML = `<div class="card"><span>市值</span><b>${fmt(tot.mv)}</b></div><div class="card"><span>損益（扣費稅）</span><b class="${cls(tpl)}">${tpl >= 0 ? '+' : '-'}${fmt(Math.abs(tpl))}</b><span class="${cls(tpl)}">${pctTxt(tot.cost ? tpl / tot.cost * 100 : 0)}</span></div>
    <div class="card"><span>成本</span><b>${fmt(tot.cost)}</b></div><div class="card"><span>今日</span><b class="${cls(tot.day)}">${tot.day >= 0 ? '+' : '-'}${fmt(Math.abs(tot.day))}</b></div>`;
  $('holds').innerHTML = list.map(x => `<div class="li" data-toggle="${x.code}"><span class="nm"><small>${x.code}</small>${esc(x.name || '')}</span><span class="p">${fmt(x.price, 2)}</span><span class="c ${cls(x.pl)}">${pctTxt(x.pct)}</span>
    <span class="sub">${fmt(x.shares)} 股・均價 ${fmt(x.cost / x.shares, 2)}・損益 <span class="${cls(x.pl)}">${x.pl >= 0 ? '+' : '-'}${fmt(Math.abs(x.pl))}</span>・${x.lots.length} 筆 ▾</span></div>
    ${openLots.has(x.code) ? x.lots.map(l => `<div class="li"><span class="nm small muted">${esc(l.buy_date)}・${fmt(l.shares)} 股 @ ${fmt(l.price, 2)}</span><span></span><button class="x" data-hdel="${l.uid}" aria-label="刪除這筆">×</button></div>`).join('') : ''}`).join('');
}
$('holds').addEventListener('click', e => {
  const d = e.target.closest('[data-hdel]');
  if (d) { if (d.dataset.armed !== '1') { d.dataset.armed = '1'; d.textContent = '確定？'; return; } DB.run('DELETE FROM holdings WHERE uid = ?', [d.dataset.hdel]); renderHold(); syncSoon(); return; }
  const t = e.target.closest('[data-toggle]'); if (t) { const c = t.dataset.toggle; openLots.has(c) ? openLots.delete(c) : openLots.add(c); renderHold(); }
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
  const doc = { watchlist: {}, holdings: {}, alerts: {} };
  for (const w of DB.all('SELECT * FROM watchlist')) doc.watchlist[w.code] = { order: w.sort_order };
  for (const h of DB.all('SELECT * FROM holdings')) doc.holdings[h.uid] = { code: h.code, buy_date: h.buy_date, shares: h.shares, price: h.price, fee: h.fee, note: h.note || null };
  for (const a of DB.all('SELECT * FROM alerts')) doc.alerts[a.uid] = { code: a.code, direction: a.direction, price: a.price, created_at: a.created_at, triggered_at: a.triggered_at || null, hit_price: a.hit_price ?? null };
  return doc;
}
function applyDoc(doc) {
  DB.batch(run => {
    run('DELETE FROM watchlist'); for (const [code, w] of Object.entries(doc.watchlist || {})) run('INSERT INTO watchlist (code, sort_order) VALUES (?, ?)', [code, w.order]);
    run('DELETE FROM holdings'); for (const [uid, h] of Object.entries(doc.holdings || {})) run('INSERT INTO holdings (uid, code, buy_date, shares, price, fee, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, h.code, h.buy_date, h.shares, h.price, h.fee, h.note]);
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
