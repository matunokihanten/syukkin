import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import pkg from 'pg';

const { Pool } = pkg;

// 1. データベース接続設定 (SSL必須)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = new Hono()

// ログ出力
console.log("Starting Matsunoki Attendance System...");

// --- A. 認証 API ---
app.post('/api/auth', async (c) => {
  try {
    const { password } = await c.req.json();
    // 管理画面のパスワードを '1234' に設定
    if (password === '1234') {
      return c.json({ success: true });
    }
    return c.json({ success: false, message: 'パスワードが違います' }, 401);
  } catch (e) {
    return c.json({ success: false, message: '通信エラー' }, 400);
  }
});

// --- B. データ同期 API (index.html & admin.html 両方で使用) ---
app.get('/api/sync', async (c) => {
  try {
    const staffRes = await pool.query('SELECT * FROM staff ORDER BY id ASC');
    const logsRes = await pool.query('SELECT * FROM logs WHERE deleted = 0 ORDER BY timestamp DESC');
    const settingsRes = await pool.query('SELECT * FROM settings');
    
    const settings = {};
    settingsRes.rows.forEach(row => { settings[row.key] = row.value; });

    return c.json({
      success: true,
      data: {
        staff: staffRes.rows,
        logs: logsRes.rows,
        settings: settings
      }
    });
  } catch (err) {
    console.error("Sync Error:", err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- C. 打刻 API (index.html 専用) ---
app.post('/api/clock', async (c) => {
  try {
    const { staff_name, type } = await c.req.json();
    const res = await pool.query(
      'INSERT INTO logs (staff_id, type, timestamp) SELECT id, $1, CURRENT_TIMESTAMP FROM staff WHERE name = $2 RETURNING *',
      [type, staff_name]
    );
    
    if (res.rowCount === 0) throw new Error('スタッフが見つかりません');
    
    const log = res.rows[0];
    log.staff_name = staff_name; // フロントエンドが期待する形に合わせる
    
    return c.json({ success: true, log });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- D. 履歴の保存・削除 API (admin.html 専用) ---
app.post('/api/logs/update', async (c) => {
  try {
    const { logs } = await c.req.json();
    for (const log of logs) {
      if (log.deleted) {
        await pool.query('UPDATE logs SET deleted = 1 WHERE id = $1', [log.id]);
      } else if (log.id) {
        await pool.query('UPDATE logs SET timestamp = $1 WHERE id = $2', [log.timestamp, log.id]);
      } else {
        // 新規追加
        await pool.query(
          'INSERT INTO logs (staff_id, type, timestamp) SELECT id, $1, $2 FROM staff WHERE name = $3',
          [log.type, log.timestamp, log.staff_name]
        );
      }
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- E. 設定・スタッフ更新 API (admin.html 専用) ---
app.post('/api/settings/update', async (c) => {
  try {
    const { settings } = await c.req.json();
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value]
      );
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

app.post('/api/staff/update', async (c) => {
  try {
    const { staff } = await c.req.json();
    for (const s of staff) {
      if (s.id) {
        await pool.query('UPDATE staff SET name=$1, break_start=$2, break_end=$3 WHERE id=$4', [s.name, s.break_start, s.break_end, s.id]);
      } else {
        await pool.query('INSERT INTO staff (name, break_start, break_end) VALUES ($1, $2, $3)', [s.name, s.break_start, s.break_end]);
      }
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

// --- F. 静的ファイルとルーティング ---
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/admin', serveStatic({ path: './public/admin.html' }))
app.use('/*', serveStatic({ root: './public' }))

// サーバー起動
const port = Number(process.env.PORT) || 3000;
serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`✅ Server is running on port ${info.port}`);
});

export default app
