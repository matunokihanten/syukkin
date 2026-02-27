import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import pkg from 'pg';

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = new Hono()

// --- A. データー一括アップロード API (新機能) ---
app.post('/api/import', async (c) => {
  try {
    const { staff_ext, logs, settings } = await c.req.json();
    
    // トランザクション開始（一気に処理）
    await pool.query('BEGIN');
    await pool.query('TRUNCATE TABLE logs, staff, settings RESTART IDENTITY');

    // スタッフ登録
    for (const s of staff_ext) {
      await pool.query('INSERT INTO staff (name, break_start, break_end) VALUES ($1, $2, $3)', [s.name, s.breakStart, s.breakEnd]);
    }

    // 設定登録
    for (const [key, value] of Object.entries(settings)) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, value]);
    }

    // ログ登録
    for (const log of logs) {
      await pool.query(
        'INSERT INTO logs (staff_id, type, timestamp, deleted) SELECT id, $1, $2, $3 FROM staff WHERE name = $4',
        [log.type, log.ts, log.deleted || 0, log.staff]
      );
    }

    await pool.query('COMMIT');
    return c.json({ success: true, message: '全データーのインポートに成功しました' });
  } catch (err) {
    await pool.query('ROLLBACK');
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- B. その他の基本 API (以前の修正を含む) ---
app.get('/api/sync', async (c) => {
  try {
    const staff = await pool.query('SELECT * FROM staff ORDER BY id ASC');
    const logs = await pool.query('SELECT * FROM logs WHERE deleted = 0 ORDER BY timestamp DESC');
    const settingsRes = await pool.query('SELECT * FROM settings');
    const settings = {};
    settingsRes.rows.forEach(row => { settings[row.key] = row.value; });
    return c.json({ success: true, data: { staff: staff.rows, logs: logs.rows, settings } });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/clock', async (c) => {
  const { staff_name, type } = await c.req.json();
  const res = await pool.query(
    'INSERT INTO logs (staff_id, type, timestamp) SELECT id, $1, CURRENT_TIMESTAMP FROM staff WHERE name = $2 RETURNING *',
    [type, staff_name]
  );
  return c.json({ success: true, log: res.rows[0] });
});

// 静的ファイル
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/admin', serveStatic({ path: './public/admin.html' }))
app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
export default app
