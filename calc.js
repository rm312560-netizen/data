// 計算：手續費、試算、升降單位、趨勢、分段報酬、配息摘要、同步合併（與電腦版相同規則）
(function () {
  const C = {};

  // ---------- 手續費與試算 ----------
  C.fee = (n, p, c) => n > 0 ? Math.max(c.min, Math.floor(n * p * c.rate * c.disc + 1e-9)) : 0;
  C.maxShares = (amount, p, c, step) => {
    let n = Math.floor(amount / (p * (1 + c.rate * c.disc)) / step) * step;
    while (n > 0 && n * p + C.fee(n, p, c) > amount) n -= step;
    while ((n + step) * p + C.fee(n + step, p, c) <= amount) n += step;
    return Math.max(0, n);
  };
  C.isEtf = code => /^00/.test(code || '');
  C.taxRate = code => C.isEtf(code) ? 0.001 : 0.003;
  C.tickOf = (price, etf) => etf ? (price < 50 ? 0.01 : 0.05) : price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5;
  const r2 = x => Math.round(x * 100) / 100;
  C.sellNet = (n, s, c, tax) => { const g = n * s; return g - C.fee(n, s, c) - Math.floor(g * tax + 1e-9); };
  // 賣出實收 ≥ goal 的最低合法價位
  C.priceForNet = (goal, n, c, tax, etf) => {
    let s = Math.max(0.01, r2(Math.ceil(r2(goal / n / C.tickOf(goal / n, etf)) - 1e-9) * C.tickOf(goal / n, etf)));
    for (let i = 0; i < 5000 && C.sellNet(n, s, c, tax) < goal; i++) s = r2(s + C.tickOf(s, etf));
    return s;
  };

  // ---------- 基本資料計算 ----------
  const dayStr = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  C.today = () => dayStr(Date.now());
  const yearsAgo = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return dayStr(d); };
  C.yearsAgo = yearsAgo;
  const sma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
  C.sma = sma;
  C.idxOnOrBefore = (dates, target) => { let lo = 0, hi = dates.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= target) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

  C.returns = (h, divs, price) => {
    const last = price > 0 ? price : h.close[h.close.length - 1], today = C.today();
    const back = (m, y) => { const d = new Date(`${today}T12:00:00+08:00`); if (y) d.setFullYear(d.getFullYear() - y); if (m) d.setMonth(d.getMonth() - m); return dayStr(d); };
    const P = [['1 個月', back(1)], ['3 個月', back(3)], ['6 個月', back(6)], ['今年以來', `${today.slice(0, 4)}-00`], ['1 年', back(0, 1)], ['3 年', back(0, 3)], ['5 年', back(0, 5)], ['10 年', back(0, 10)]];
    const yrs = { '1 年': 1, '3 年': 3, '5 年': 5, '10 年': 10 };
    return P.map(([label, from]) => {
      const i = C.idxOnOrBefore(h.dates, from);
      if (i < 0 || (h.dates[0] > from && label !== '今年以來')) return { label, available: false };
      const base = h.close[i], start = h.dates[i];
      const cash = divs.filter(d => d.exDate && d.exDate > start && d.exDate <= today).reduce((a, d) => a + d.cash, 0);
      return { label, available: true, from: start, base, priceRet: (last / base - 1) * 100, totalRet: ((last + cash) / base - 1) * 100, cash,
        annualized: yrs[label] ? (Math.pow((last + cash) / base, 1 / yrs[label]) - 1) * 100 : null };
    });
  };

  C.trend = (h, price) => {
    const c = h.close.slice(); if (price > 0) c.push(price);
    const n = c.length - 1, p = c[n];
    const ma = k => sma(c, k, n);
    const judge = (k, lb) => {
      const now = ma(k), before = sma(c, k, n - lb);
      if (now == null || before == null) return { dir: '資料不足' };
      const slope = (now / before - 1) * 100, above = p > now;
      return { dir: slope > 0.5 && above ? '向上' : slope < -0.5 && !above ? '向下' : '盤整', ma: now, above };
    };
    const L = { ma5: ma(5), ma20: ma(20), ma60: ma(60), ma120: ma(120), ma240: ma(240) };
    const s = judge(20, 5), m = judge(60, 20), l = judge(240, 20);
    const align = L.ma20 && L.ma60 && L.ma120 ? (p > L.ma20 && L.ma20 > L.ma60 && L.ma60 > L.ma120 ? '多頭排列' : p < L.ma20 && L.ma20 < L.ma60 && L.ma60 < L.ma120 ? '空頭排列' : '均線糾結') : '資料不足';
    const yr = c.slice(Math.max(0, c.length - 250)), hi = Math.max(...yr), lo = Math.min(...yr);
    const ups = [s, m, l].filter(x => x.dir === '向上').length, downs = [s, m, l].filter(x => x.dir === '向下').length;
    return { price: p, lines: L, short: s, mid: m, long: l, align, high52: hi, low52: lo, pos52: hi > lo ? (p - lo) / (hi - lo) * 100 : null,
      overall: ups >= 2 && align !== '空頭排列' ? '向上' : downs >= 2 && align !== '多頭排列' ? '向下' : '盤整' };
  };

  C.divSummary = (divs, price) => {
    const today = C.today(), yearAgo = yearsAgo(1);
    const past = divs.filter(d => d.exDate && d.exDate <= today), last12 = past.filter(d => d.exDate > yearAgo);
    const cash12 = last12.reduce((a, d) => a + d.cash, 0), n = last12.length;
    const byYear = {}; for (const d of past) { const y = d.exDate.slice(0, 4); byYear[y] = (byYear[y] || 0) + d.cash; }
    return { cash12, yield12: price > 0 ? cash12 / price * 100 : null, count12: n,
      freq: n >= 10 ? '月配' : n >= 4 ? '季配' : n >= 2 ? '半年配' : n === 1 ? '年配' : '近一年沒有配息',
      next: divs.filter(d => d.exDate && d.exDate > today).sort((a, b) => a.exDate.localeCompare(b.exDate))[0] || null,
      byYear: Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5).map(([year, cash]) => ({ year, cash })) };
  };

  // ---------- 同步合併（與電腦版 sync.js 相同） ----------
  const canon = v => v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v ?? null);
  C.same = (a, b) => canon(a) === canon(b);
  C.merge3 = (base = {}, local = {}, remote = {}) => {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const b = base[k], l = local[k], r = remote[k];
      if (l && r) out[k] = C.same(l, r) ? l : !C.same(l, b) ? l : r;
      else if (l) { if (!b || !C.same(l, b)) out[k] = l; }
      else if (r) { if (!b || !C.same(r, b)) out[k] = r; }
    }
    return out;
  };
  C.mergeDoc = (base = {}, local = {}, remote = {}) => ({
    watchlist: C.merge3(base.watchlist, local.watchlist, remote.watchlist),
    holdings: C.merge3(base.holdings, local.holdings, remote.holdings),
    alerts: C.merge3(base.alerts, local.alerts, remote.alerts),
  });
  C.uid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

  window.CALC = C;
})();
