// 目標配置與再平衡（電腦版、手機版共用同一份；改這裡後要複製到 mobile/app/rebal-core.js）
// holdings：[{ code, shares }]（同一檔可多筆），targets：[{ code, pct }]，prices：{ 代號: 現價 }，cash：這次要投入的錢
// mode：'buy' 只用新的錢買、不賣；'both' 買賣一起調整到目標。step：1 零股、1000 整股。fee：{ rate, disc, min }
(function (root) {
  const fee = (n, p, c) => n > 0 ? Math.max(c.min, Math.floor(n * p * c.rate * c.disc + 1e-9)) : 0;
  function rebalance({ holdings, targets, prices, cash = 0, mode = 'buy', step = 1, feeCfg, names = () => '' }) {
    const sh = {};
    for (const h of holdings) sh[h.code] = (sh[h.code] || 0) + h.shares;
    const tg = Object.fromEntries(targets.filter(t => t.code && t.pct > 0).map(t => [t.code, t.pct]));
    const codes = [...new Set([...Object.keys(tg), ...Object.keys(sh)])];
    const rows = codes.map(code => ({ code, name: names(code), price: prices[code] || 0, shares: sh[code] || 0, tgt: tg[code] || 0, qty: 0, fee: 0 }));
    rows.forEach(r => { r.value = r.shares * r.price; });
    const total = rows.reduce((s, r) => s + r.value, 0), sumT = rows.reduce((s, r) => s + r.tgt, 0) || 100;
    const after = total + cash;
    rows.forEach(r => { r.desired = after * r.tgt / sumT; });
    const missing = rows.filter(r => !(r.price > 0)).map(r => r.code);
    const ok = rows.filter(r => r.price > 0);
    let left = cash;
    if (mode === 'both') {
      // 每檔直接調到目標（四捨五入到交易單位）；賣出的錢可以拿來買
      for (const r of ok) r.qty = Math.round((r.desired - r.value) / r.price / step) * step;
      const tax = r => /^00/.test(r.code) ? 0.001 : 0.003;
      for (const r of ok) r.fee = r.qty > 0 ? fee(r.qty, r.price, feeCfg) : r.qty < 0 ? fee(-r.qty, r.price, feeCfg) + Math.floor(-r.qty * r.price * tax(r)) : 0;
      left = cash - ok.reduce((s, r) => s + r.qty * r.price + r.fee, 0);
      // 錢不夠就從最超過目標的買單減少
      while (left < 0) {
        const r = ok.filter(x => x.qty > 0).sort((a, b) => (b.value + b.qty * b.price - b.desired) - (a.value + a.qty * a.price - a.desired))[0];
        if (!r) break;
        const before = r.qty * r.price + r.fee;
        r.qty -= step; r.fee = fee(r.qty, r.price, feeCfg);
        left += before - (r.qty * r.price + r.fee);
      }
    } else {
      // 只買：先依缺口比例分配，再把剩下的錢一單位一單位補給離目標最遠的
      const need = ok.map(r => Math.max(0, r.desired - r.value)), sumNeed = need.reduce((s, v) => s + v, 0);
      ok.forEach((r, i) => {
        if (!sumNeed) return;
        const budget = Math.min(need[i], cash * need[i] / sumNeed);
        let n = Math.floor(budget / (r.price * (1 + feeCfg.rate * feeCfg.disc)) / step) * step;
        while (n > 0 && n * r.price + fee(n, r.price, feeCfg) > budget) n -= step;
        r.qty = n; r.fee = fee(n, r.price, feeCfg);
      });
      left = cash - ok.reduce((s, r) => s + r.qty * r.price + r.fee, 0);
      for (let guard = 0; guard < 200000; guard++) {
        const cand = ok.filter(r => r.tgt > 0).map(r => {
          const add = step * r.price + fee(r.qty + step, r.price, feeCfg) - r.fee;
          return { r, add, gap: (r.desired - (r.value + r.qty * r.price)) / (r.desired || 1) };
        }).filter(x => x.add <= left && x.gap > 0).sort((a, b) => b.gap - a.gap)[0];
        if (!cand) break;
        cand.r.qty += step; left -= cand.add; cand.r.fee = fee(cand.r.qty, cand.r.price, feeCfg);
      }
    }
    const afterTotal = rows.reduce((s, r) => s + (r.shares + r.qty) * r.price, 0);
    for (const r of rows) {
      r.curPct = total ? r.value / total * 100 : 0;
      r.newValue = (r.shares + r.qty) * r.price;
      r.newPct = afterTotal ? r.newValue / afterTotal * 100 : 0;
      r.dev = r.curPct - (r.tgt / sumT * 100);
      r.amount = r.qty * r.price;
    }
    rows.sort((a, b) => b.tgt - a.tgt || b.value - a.value);
    return { rows, total, afterTotal, cash, left: Math.round(left), fees: rows.reduce((s, r) => s + r.fee, 0), sumTarget: targets.reduce((s, t) => s + (+t.pct || 0), 0), missing };
  }
  const api = { rebalance };
  if (typeof module !== 'undefined') module.exports = api; else root.REBAL = api;
})(typeof window !== 'undefined' ? window : globalThis);
