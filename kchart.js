// K 線圖＋技術指標（電腦版與手機版共用同一份；改這裡後要複製到 mobile/app/kchart.js）
// 用法：const c = KChart(容器, { load: () => Promise<{t,o,h,l,c,v}>, colors: () => ({ up, down, fg, muted, line, bg }), stealth: () => bool, height });
//       c.live(price) 用即時價更新最後一根；c.destroy()
// 資料是 10 年日 K，週 K、月 K 在這裡合成（Yahoo 的週、月 K 最後一根不完整）。
(function () {
  const LS = 'kchart';
  const store = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
  const save = s => { try { localStorage.setItem(LS, JSON.stringify(s)); } catch {} };
  const MA_C = ['#f59e0b', '#3b82f6', '#a855f7', '#14b8a6'], MA_N = [5, 10, 20, 60];

  // ---------- 指標 ----------
  const sma = (a, n) => { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
  const ema = (a, n) => { const o = []; const k = 2 / (n + 1); a.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; };
  function boll(c, n = 20, m = 2) {
    const mid = sma(c, n), up = [], dn = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] == null) { up.push(null); dn.push(null); continue; }
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n); up.push(mid[i] + m * sd); dn.push(mid[i] - m * sd);
    }
    return { mid, up, dn };
  }
  function kd(d, n = 9) {
    const K = [], D = []; let k = 50, dd = 50;
    for (let i = 0; i < d.c.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) { hi = Math.max(hi, d.h[j]); lo = Math.min(lo, d.l[j]); }
      const rsv = hi > lo ? (d.c[i] - lo) / (hi - lo) * 100 : 50;
      k = k * 2 / 3 + rsv / 3; dd = dd * 2 / 3 + k / 3;
      K.push(i >= n - 1 ? k : null); D.push(i >= n - 1 ? dd : null);
    }
    return { K, D };
  }
  function rsi(c, n) {
    const o = [null]; let up = 0, dn = 0;
    for (let i = 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1], u = Math.max(ch, 0), w = Math.max(-ch, 0);
      if (i <= n) { up += u / n; dn += w / n; } else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + w) / n; }
      o.push(i >= n ? (dn === 0 ? 100 : 100 - 100 / (1 + up / dn)) : null);
    }
    return o;
  }
  function macd(c) {
    const e1 = ema(c, 12), e2 = ema(c, 26), dif = e1.map((v, i) => v - e2[i]), sig = ema(dif, 9);
    return { dif, sig, osc: dif.map((v, i) => v - sig[i]) };
  }
  // 日 K 合成週 K（週一開始）、月 K
  function group(d, iv) {
    if (iv === 'd') return d;
    const o = { t: [], o: [], h: [], l: [], c: [], v: [] };
    let key = null;
    for (let i = 0; i < d.t.length; i++) {
      const t = d.t[i];
      let k = t.slice(0, 7);
      if (iv === 'w') { const x = new Date(`${t}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); k = x.toISOString().slice(0, 10); }
      if (k !== key) { key = k; o.t.push(t); o.o.push(d.o[i]); o.h.push(d.h[i]); o.l.push(d.l[i]); o.c.push(d.c[i]); o.v.push(d.v[i]); continue; }
      const j = o.t.length - 1;
      o.t[j] = t; o.h[j] = Math.max(o.h[j], d.h[i]); o.l[j] = Math.min(o.l[j], d.l[i]); o.c[j] = d.c[i]; o.v[j] += d.v[i];
    }
    return o;
  }

  window.KChart = function (root, opt) {
    if (!document.getElementById('kc-style')) { const el = document.createElement('style'); el.id = 'kc-style'; el.textContent = KChart.css; document.head.appendChild(el); }
    const st = Object.assign({ iv: 'd', ov: 'ma', ind: 'kd' }, store());
    const H = opt.height || 400;
    root.innerHTML = `<div class="kc-bar">
        <div class="kc-seg" data-g="iv"><button data-v="d">日K</button><button data-v="w">週K</button><button data-v="m">月K</button></div>
        <div class="kc-seg" data-g="ov"><button data-v="ma">均線</button><button data-v="boll">布林</button></div>
        <div class="kc-seg" data-g="ind"><button data-v="kd">KD</button><button data-v="rsi">RSI</button><button data-v="macd">MACD</button></div>
        <div class="kc-seg kc-zoom"><button data-z="-1" title="縮小（看更多根）">－</button><button data-z="1" title="放大">＋</button></div>
      </div><div class="kc-info"></div><canvas class="kc-cv" style="width:100%;height:${H}px;display:block;touch-action:pan-y"></canvas>
      <div class="kc-msg">載入中…</div>`;
    const cv = root.querySelector('canvas'), info = root.querySelector('.kc-info'), msg = root.querySelector('.kc-msg');
    let raw = null, D = null, I = {}, count = 0, end = 0, hover = -1, W = 0;
    const RG = 52;                                     // 右邊座標軸寬度
    const syncBar = () => root.querySelectorAll('.kc-seg[data-g]').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(st[g.dataset.g] === b.dataset.v))));

    function compute() {
      D = group(raw, st.iv);
      const c = D.c;
      I = { ma: MA_N.map(n => sma(c, n)), boll: boll(c), kd: kd(D), rsi: [rsi(c, 6), rsi(c, 12)], macd: macd(c), vma: sma(D.v, 5) };
      const def = (cv.clientWidth || W) < 500 ? 70 : 120;
      count = Math.min(D.t.length, st.iv === 'd' ? def : Math.round(def * 0.8));
      end = D.t.length;
    }
    function load() {
      msg.hidden = false; msg.textContent = '載入中…';
      opt.load().then(d => {
        if (!d?.t?.length) throw new Error('查不到歷史股價');
        raw = d; msg.hidden = true; compute(); draw();
      }).catch(e => { msg.hidden = false; msg.textContent = `K 線讀取失敗：${e.message}`; });
    }
    const fmtN = (v, d) => v == null ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
    const dg = p => p >= 1000 ? 0 : p >= 100 ? 1 : 2;

    function draw() {
      if (!D) return;
      const dpr = window.devicePixelRatio || 1;
      W = cv.clientWidth;
      if (!W) return;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const C = opt.colors(), bw = opt.stealth && opt.stealth();
      const up = bw ? C.fg : C.up, dn = bw ? C.fg : C.down;
      g.clearRect(0, 0, W, H);
      g.font = '11px ui-monospace, Consolas, monospace';
      const pw = W - RG;
      const p1 = { y: 4, h: Math.round(H * 0.58) }, p2 = { y: p1.y + p1.h + 18, h: Math.round(H * 0.13) }, p3 = { y: 0, h: 0 };
      p3.y = p2.y + p2.h + 18; p3.h = H - p3.y - 16;
      count = Math.max(15, Math.min(count, D.t.length)); end = Math.max(count, Math.min(end, D.t.length));
      const s = end - count, step = pw / count, body = Math.max(1, step * 0.68);
      const X = i => (i - s + 0.5) * step;
      const vis = (arr, a = s, b = end) => arr.slice(a, b).filter(v => v != null);

      // 價格區
      let hi = Math.max(...D.h.slice(s, end)), lo = Math.min(...D.l.slice(s, end));
      const lines = st.ov === 'ma' ? I.ma : [I.boll.up, I.boll.mid, I.boll.dn];
      for (const ln of lines) { const v = vis(ln); if (v.length) { hi = Math.max(hi, ...v); lo = Math.min(lo, ...v); } }
      const pad = (hi - lo) * 0.06 || hi * 0.01;
      const Y = v => p1.y + (hi + pad - v) / (hi - lo + 2 * pad) * p1.h;
      grid(g, p1, hi + pad, lo - pad, C, Y, pw, dg(hi));
      for (let i = s; i < end; i++) {
        const o = D.o[i], c = D.c[i], isUp = c > o || (c === o && i > 0 && c >= D.c[i - 1]);
        g.strokeStyle = g.fillStyle = isUp ? up : dn;
        const x = X(i);
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, Y(D.h[i])); g.lineTo(Math.round(x) + 0.5, Y(D.l[i])); g.lineWidth = 1; g.stroke();
        const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c)), hh = Math.max(1, y2 - y1);
        // 黑白模式：漲用空心、跌用實心
        if (bw && isUp) { g.fillStyle = C.bg; g.fillRect(x - body / 2, y1, body, hh); g.strokeRect(x - body / 2 + 0.5, y1 + 0.5, body - 1, hh - 1); }
        else g.fillRect(x - body / 2, y1, body, hh);
      }
      lines.forEach((ln, k) => line(g, ln, s, end, X, Y, bw ? C.muted : (st.ov === 'ma' ? MA_C[k] : ['#a855f7', '#3b82f6', '#a855f7'][k]), bw && k % 2 ? [4, 3] : null));
      // 區間最高、最低
      let hiI = s, loI = s;
      for (let i = s; i < end; i++) { if (D.h[i] > D.h[hiI]) hiI = i; if (D.l[i] < D.l[loI]) loI = i; }
      g.fillStyle = C.muted;
      for (const [i, v, dy] of [[hiI, D.h[hiI], -3], [loI, D.l[loI], 12]]) {
        const txt = fmtN(v, dg(v)), x = X(i), right = x > pw * 0.7;
        g.textAlign = right ? 'right' : 'left';
        g.fillText(right ? `${txt} →` : `← ${txt}`, right ? x - 2 : x + 2, Y(v) + dy);
      }
      g.textAlign = 'left';

      // 成交量
      const vmax = Math.max(...D.v.slice(s, end), 1);
      const VY = v => p2.y + p2.h - v / vmax * p2.h;
      sep(g, p2.y - 9, pw, C);
      for (let i = s; i < end; i++) {
        const isUp = D.c[i] >= D.o[i];
        g.fillStyle = isUp ? up : dn; g.globalAlpha = bw && isUp ? 0.35 : 0.75;
        g.fillRect(X(i) - body / 2, VY(D.v[i]), body, p2.y + p2.h - VY(D.v[i]));
      }
      g.globalAlpha = 1;
      line(g, I.vma, s, end, X, VY, bw ? C.muted : MA_C[0]);
      g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(fmtN(vmax, 0), W - 2, p2.y + 9); g.textAlign = 'left';

      // 指標
      sep(g, p3.y - 9, pw, C);
      let IY;
      if (st.ind === 'macd') {
        const m = I.macd, v = [...vis(m.dif), ...vis(m.sig), ...vis(m.osc)], mx = Math.max(...v.map(Math.abs), 0.01);
        IY = x => p3.y + p3.h / 2 - x / mx * p3.h / 2;
        g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, IY(0) + 0.5); g.lineTo(pw, IY(0) + 0.5); g.stroke();
        for (let i = s; i < end; i++) { g.fillStyle = m.osc[i] >= 0 ? up : dn; g.globalAlpha = 0.6; const y0 = IY(0), y = IY(m.osc[i]); g.fillRect(X(i) - body / 2, Math.min(y0, y), body, Math.abs(y - y0)); }
        g.globalAlpha = 1;
        line(g, m.dif, s, end, X, IY, bw ? C.fg : MA_C[0]); line(g, m.sig, s, end, X, IY, bw ? C.muted : MA_C[1], bw ? [4, 3] : null);
      } else {
        IY = x => p3.y + (100 - x) / 100 * p3.h;
        g.strokeStyle = C.line; g.setLineDash([2, 3]);
        for (const lv of st.ind === 'kd' ? [20, 80] : [30, 70]) { g.beginPath(); g.moveTo(0, Math.round(IY(lv)) + 0.5); g.lineTo(pw, Math.round(IY(lv)) + 0.5); g.stroke(); g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(lv, W - 2, IY(lv) + 4); }
        g.setLineDash([]); g.textAlign = 'left';
        const [a, b] = st.ind === 'kd' ? [I.kd.K, I.kd.D] : I.rsi;
        line(g, a, s, end, X, IY, bw ? C.fg : MA_C[0]); line(g, b, s, end, X, IY, bw ? C.muted : MA_C[1], bw ? [4, 3] : null);
      }

      // 日期
      g.fillStyle = C.muted;
      let last = '', lastX = -99;
      for (let i = s; i < end; i++) {
        const t = D.t[i], k = st.iv === 'd' ? t.slice(0, 7) : t.slice(0, 4);
        if (k !== last && X(i) - lastX > 56) { if (last) { g.fillText(st.iv === 'd' ? `${+t.slice(5, 7)}月` : t.slice(0, 4), X(i) + 2, H - 3); g.strokeStyle = C.line; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(Math.round(X(i)) + 0.5, p1.y); g.lineTo(Math.round(X(i)) + 0.5, H - 14); g.stroke(); g.globalAlpha = 1; lastX = X(i); } last = k; }
      }

      // 十字線
      const i = hover >= s && hover < end ? hover : end - 1;
      if (hover >= s && hover < end) {
        g.strokeStyle = C.muted; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(Math.round(X(i)) + 0.5, p1.y); g.lineTo(Math.round(X(i)) + 0.5, H - 14); g.stroke(); g.setLineDash([]);
      }
      // 指標數值寫在區塊左上
      g.font = '11px ui-monospace, Consolas, monospace';
      const lab = (y, parts) => { let x = 4; for (const [t, col] of parts) { g.fillStyle = col; g.fillText(t, x, y); x += g.measureText(t).width + 8; } };
      lab(p2.y - 0, [[`量 ${fmtN(D.v[i], 0)}`, C.muted], [`5日均量 ${fmtN(I.vma[i], 0)}`, bw ? C.muted : MA_C[0]]]);
      const c1 = bw ? C.fg : MA_C[0], c2 = bw ? C.muted : MA_C[1];
      lab(p3.y, st.ind === 'kd' ? [[`K ${fmtN(I.kd.K[i], 1)}`, c1], [`D ${fmtN(I.kd.D[i], 1)}`, c2]]
        : st.ind === 'rsi' ? [[`RSI6 ${fmtN(I.rsi[0][i], 1)}`, c1], [`RSI12 ${fmtN(I.rsi[1][i], 1)}`, c2]]
        : [[`DIF ${fmtN(I.macd.dif[i], 2)}`, c1], [`MACD ${fmtN(I.macd.sig[i], 2)}`, c2], [`OSC ${fmtN(I.macd.osc[i], 2)}`, C.muted]]);

      // 上方文字：日期、開高低收、漲跌、均線值
      const prev = i > 0 ? D.c[i - 1] : D.o[i], ch = D.c[i] - prev, pct = prev ? ch / prev * 100 : 0, d = dg(D.c[i]);
      const cc = ch > 0 ? 'up' : ch < 0 ? 'down' : '';
      const sg = ch > 0 ? '+' : ch < 0 ? '-' : '';
      const mv = st.ov === 'ma' ? MA_N.map((n, k) => `<span style="color:${bw ? 'inherit' : MA_C[k]}">MA${n} ${fmtN(I.ma[k][i], d)}</span>`).join('')
        : `<span style="color:${bw ? 'inherit' : '#a855f7'}">上軌 ${fmtN(I.boll.up[i], d)}</span><span style="color:${bw ? 'inherit' : '#3b82f6'}">中軌 ${fmtN(I.boll.mid[i], d)}</span><span style="color:${bw ? 'inherit' : '#a855f7'}">下軌 ${fmtN(I.boll.dn[i], d)}</span>`;
      info.innerHTML = `<div><b>${D.t[i]}${st.iv === 'w' ? ' 週' : st.iv === 'm' ? ' 月' : ''}</b><span>開 ${fmtN(D.o[i], d)}</span><span>高 ${fmtN(D.h[i], d)}</span><span>低 ${fmtN(D.l[i], d)}</span><span>收 <b class="${cc}">${fmtN(D.c[i], d)}</b></span><span class="${cc}">${sg}${fmtN(Math.abs(ch), d)}（${sg}${fmtN(Math.abs(pct), 2)}%）</span></div><div class="kc-ma">${mv}</div>`;
    }
    function grid(g, p, top, bot, C, Y, pw, d) {
      g.strokeStyle = C.line; g.fillStyle = C.muted; g.textAlign = 'right'; g.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const v = top - (top - bot) * k / 4, y = Math.round(Y(v)) + 0.5;
        g.globalAlpha = 0.6; g.beginPath(); g.moveTo(0, y); g.lineTo(pw, y); g.stroke(); g.globalAlpha = 1;
        g.fillText(fmtN(v, d), W - 2, y + 4);
      }
      g.textAlign = 'left';
    }
    function sep(g, y, pw, C) { g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); g.stroke(); }
    function line(g, a, s, e, X, Y, col, dash) {
      g.strokeStyle = col; g.lineWidth = 1.2; g.setLineDash(dash || []); g.beginPath();
      let on = false;
      for (let i = s; i < e; i++) { if (a[i] == null) { on = false; continue; } const x = X(i), y = Y(a[i]); if (on) g.lineTo(x, y); else { g.moveTo(x, y); on = true; } }
      g.stroke(); g.setLineDash([]); g.lineWidth = 1;
    }

    // ---------- 操作：滑鼠移動看數值、拖曳平移、滾輪／雙指縮放 ----------
    const idxAt = x => D ? Math.floor(x / ((W - RG) / count)) + end - count : -1;
    const pts = new Map();
    let drag = null, pinch = null;
    function zoom(f, x) {
      if (!D) return;
      const pw = W - RG, at = x == null ? 1 : Math.min(1, Math.max(0, x / pw));
      const n = Math.round(Math.max(15, Math.min(D.t.length, count / f)));
      const anchor = end - count + at * count;
      end = Math.round(anchor + (1 - at) * n); count = n; draw();
    }
    cv.addEventListener('pointerdown', e => {
      pts.set(e.pointerId, e.offsetX);
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.abs(a - b) || 1, count, end }; drag = null; return; }
      drag = { x: e.offsetX, end, moved: false, touch: e.pointerType !== 'mouse' };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      if (!D) return;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e.offsetX);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()], f = (Math.abs(a - b) || 1) / pinch.d;
        count = pinch.count; end = pinch.end; zoom(f, (a + b) / 2); return;
      }
      if (drag) {
        const dx = e.offsetX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) { end = Math.round(drag.end - dx / ((W - RG) / count)); hover = drag.touch ? -1 : idxAt(e.offsetX); draw(); return; }
      }
      if (e.pointerType === 'mouse') { hover = idxAt(e.offsetX); draw(); }
    });
    const up = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (drag && !drag.moved && drag.touch) { const i = idxAt(e.offsetX); hover = hover === i ? -1 : i; draw(); }   // 手機：點一下看那一根，再點同一根取消
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !drag) { hover = -1; draw(); } });
    cv.addEventListener('wheel', e => { if (!D) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX); }, { passive: false });
    root.querySelector('.kc-bar').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.z) return zoom(b.dataset.z > 0 ? 1.4 : 1 / 1.4);
      const g = b.closest('[data-g]').dataset.g;
      st[g] = b.dataset.v; save({ iv: st.iv, ov: st.ov, ind: st.ind }); syncBar();
      if (g === 'iv' && raw) { hover = -1; compute(); }
      draw();
    });
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    syncBar(); load();
    return {
      // 即時價更新最後一根（當天日 K 還沒收盤）
      live(price, day) {
        if (!raw || !(price > 0)) return;
        const n = raw.t.length - 1;
        if (raw.t[n] !== day) return;
        if (raw.c[n] === price) return;
        raw.c[n] = price; raw.h[n] = Math.max(raw.h[n], price); raw.l[n] = Math.min(raw.l[n], price);
        compute2();
      },
      redraw: draw,
      destroy() { ro.disconnect(); root.innerHTML = ''; },
    };
    function compute2() { const c = count, e = end, len = D.t.length; compute(); count = c; end = e === len ? D.t.length : e; draw(); }
  };
  KChart.css = `
.kc-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.kc-seg { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.kc-seg button { border: 0; background: none; color: var(--muted); font: inherit; font-size: .78rem; padding: 4px 9px; cursor: pointer; }
.kc-seg button + button { border-left: 1px solid var(--line); }
.kc-seg button[aria-pressed="true"] { background: var(--fg); color: var(--panel, #fff); font-weight: 600; }
.kc-zoom { margin-left: auto; }
.kc-info { font-size: .78rem; font-variant-numeric: tabular-nums; min-height: 2.6em; margin-bottom: 2px; }
.kc-info > div { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.kc-info .kc-ma { font-size: .74rem; }
.kc-msg { color: var(--muted); font-size: .85rem; padding: 8px 0; }
.kc-cv { cursor: crosshair; user-select: none; -webkit-user-select: none; }`;
})();
