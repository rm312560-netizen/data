// 手機版資料庫：SQLite（sql.js），整個檔案存在瀏覽器的 IndexedDB，每次修改後自動存檔
(function () {
  const IDB_NAME = 'tsdata', IDB_STORE = 'files', IDB_KEY = 'data.db';
  let SQL = null, db = null, saveTimer = null;

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet() {
    const d = await idb();
    return new Promise((resolve, reject) => { const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY); r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error); });
  }
  async function idbPut(bytes) {
    const d = await idb();
    return new Promise((resolve, reject) => { const tx = d.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(bytes, IDB_KEY); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS stocks (      -- 股票清單（由電腦版每天上傳到轉接站）
      code TEXT PRIMARY KEY, name TEXT, market TEXT, close REAL, change REAL, shares INTEGER, volume INTEGER
    );
    CREATE TABLE IF NOT EXISTS watchlist (   -- 自選股（與電腦版同步）
      code TEXT PRIMARY KEY, sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holdings (    -- 持股（與電腦版同步）
      uid TEXT PRIMARY KEY, code TEXT NOT NULL, buy_date TEXT NOT NULL, shares INTEGER NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS alerts (      -- 到價提醒（與電腦版同步）
      uid TEXT PRIMARY KEY, code TEXT NOT NULL, direction TEXT NOT NULL, price REAL NOT NULL, created_at TEXT, triggered_at TEXT, hit_price REAL
    );
    CREATE TABLE IF NOT EXISTS reports (     -- 日報（從轉接站下載後存在手機，離線也能看）
      key TEXT PRIMARY KEY, kind TEXT, created_at TEXT, model TEXT, headline TEXT, count INTEGER, json TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `;

  const DB = {
    async open() {
      SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
      const bytes = await idbGet().catch(() => null);
      db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
      db.exec(SCHEMA);
      await DB.saveNow();
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    },
    all(sql, params = []) {
      const st = db.prepare(sql); st.bind(params);
      const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free();
      return rows;
    },
    get(sql, params = []) { return DB.all(sql, params)[0] || null; },
    run(sql, params = []) { db.run(sql, params); DB.save(); },
    exec(sql) { db.exec(sql); DB.save(); },
    // 一次執行多筆（股票清單更新、同步套用）
    batch(fn) { db.exec('BEGIN'); try { fn((sql, p) => db.run(sql, p)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } DB.save(); },
    save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => DB.saveNow(), 400); },
    async saveNow() { clearTimeout(saveTimer); await idbPut(db.export()); },
    setting(key, fallback) { const r = DB.get('SELECT value FROM settings WHERE key = ?', [key]); return r ? JSON.parse(r.value) : fallback; },
    setSetting(key, value) { DB.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]); },
    meta(key, fallback = null) { const r = DB.get('SELECT value FROM meta WHERE key = ?', [key]); return r ? r.value : fallback; },
    setMeta(key, value) { DB.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]); },
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden && db) DB.saveNow(); });
  window.DB = DB;
})();
