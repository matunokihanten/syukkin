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

// --- A. 認証 API ---
app.post('/api/auth', async (c) => {
  try {
    const { password } = await c.req.json();
    if (password === '1234') return c.json({ success: true });
    return c.json({ success: false, message: 'パスワードが違います' }, 401);
  } catch (e) {
    return c.json({ success: false, message: '通信エラー' }, 400);
  }
});

// --- B. データ同期 API (JOINを追加して名前を取得) ---
app.get('/api/sync', async (c) => {
  try {
    const staffRes = await pool.query('SELECT * FROM staff ORDER BY id ASC');
    // logsテーブルにstaffテーブルを結合してstaff_nameを取得
    const logsRes = await pool.query(`
      SELECT l.*, s.name as staff_name 
      FROM logs l 
      JOIN staff s ON l.staff_id = s.id 
      WHERE l.deleted = 0 
      ORDER BY l.timestamp DESC
    `);
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
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- C. 打刻 API ---
app.post('/api/clock', async (c) => {
  try {
    const { staff_name, type } = await c.req.json();
    const res = await pool.query(
      'INSERT INTO logs (staff_id, type, timestamp) SELECT id, $1, CURRENT_TIMESTAMP FROM staff WHERE name = $2 RETURNING *',
      [type, staff_name]
    );
    if (res.rowCount === 0) throw new Error('スタッフが見つかりません');
    const log = res.rows[0];
    log.staff_name = staff_name;
    return c.json({ success: true, log });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- D. 履歴更新 API (タイムスタンプ形式の修正) ---
app.post('/api/logs/update', async (c) => {
  try {
    const { logs } = await c.req.json();
    for (const log of logs) {
      if (log.deleted) {
        await pool.query('UPDATE logs SET deleted = 1 WHERE id = $1', [log.id]);
      } else if (log.id && !String(log.id).includes('.')) {
        // 既存データの更新
        await pool.query('UPDATE logs SET timestamp = $1 WHERE id = $2', [log.timestamp, log.id]);
      } else {
        // 新規追加 (スタッフ名からIDを引いて挿入)
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

// --- E. 設定・スタッフ管理 API ---
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
  } catch (err) { return c.json({ success: false }, 500); }
});

app.post('/api/staff/update', async (c) => {
  try {
    const { staff } = await c.req.json();
    for (const s of staff) {
      if (s.id) {
        await pool.query('UPDATE staff SET name=$1, break_start=$2, break_end=$3, emp_id=$4 WHERE id=$5', [s.name, s.break_start, s.break_end, s.emp_id, s.id]);
      } else {
        await pool.query('INSERT INTO staff (name, break_start, break_end, emp_id) VALUES ($1, $2, $3, $4)', [s.name, s.break_start, s.break_end, s.emp_id]);
      }
    }
    return c.json({ success: true });
  } catch (err) { return c.json({ success: false }, 500); }
});

// 不足していた削除APIを追加
app.post('/api/staff/delete', async (c) => {
  try {
    const { id } = await c.req.json();
    await pool.query('DELETE FROM staff WHERE id = $1', [id]);
    return c.json({ success: true });
  } catch (err) { return c.json({ success: false }, 500); }
});

// --- F. ルーティング ---
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/admin', serveStatic({ path: './public/admin.html' }))
app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port: port, hostname: '0.0.0.0' });

export default app
