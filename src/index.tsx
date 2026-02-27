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

console.log("Starting Matsunoki Attendance System...");

// 1. 静的ファイルの配信設定
// トップページにアクセスしたら index.html を、/admin なら admin.html を表示
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/admin', serveStatic({ path: './public/admin.html' }))
// CSSや画像などのための設定
app.use('/*', serveStatic({ root: './public' }))

// --- データ同期 API ---
app.get('/api/sync', async (c) => {
  try {
    const staff = await pool.query('SELECT * FROM staff WHERE active = 1 ORDER BY id ASC');
    const logs = await pool.query('SELECT * FROM logs WHERE deleted = 0 ORDER BY timestamp DESC');
    const settingsRes = await pool.query('SELECT * FROM settings');
    const settings: Record<string, string> = {};
    settingsRes.rows.forEach(row => { settings[row.key] = row.value; });

    return c.json({
      success: true,
      data: { staff: staff.rows, logs: logs.rows, settings: settings }
    });
  } catch (err) {
    console.error("Database Error:", err);
    return c.json({ success: false, message: "Database connection failed" }, 500);
  }
})

// --- 打刻 API ---
app.post('/api/logs', async (c) => {
  const body = await c.req.json();
  try {
    await pool.query(
      'INSERT INTO logs (staff_id, type, timestamp) VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [body.staff_id, body.type]
    );
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

const port = Number(process.env.PORT) || 3000;
serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`✅ Server is running on port ${info.port}`);
});

export default app