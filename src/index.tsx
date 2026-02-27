import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import pkg from 'pg';
const { Pool } = pkg;

// 1. データベース接続（エラーハンドリング付き）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = new Hono()

// ログ出力（起動確認用）
console.log("Starting Matsunoki Attendance System...");

// 2. 静的ファイルの配信設定
app.use('/static/*', serveStatic({ root: './public' }))
app.get('/', (c) => c.redirect('/static/index.html'))
app.get('/admin', (c) => c.redirect('/static/admin.html'))

// --- 認証 API ---
app.post('/api/auth', async (c) => c.json({ success: true }))

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

// 3. サーバーの起動設定（Render必須設定）
const port = Number(process.env.PORT) || 3000;

serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0' // Renderで外部接続を許可するために必須
}, (info) => {
  console.log(`✅ Server is running on port ${info.port}`);
});

export default app