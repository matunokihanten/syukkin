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
  const { password } = await c.req.json();
  if (password === '1234') return c.json({ success: true });
  return c.json({ success: false }, 401);
});

// --- B. 同期 API ---
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

// --- C. 打刻 API (index.html用) ---
app.post('/api/clock', async (c) => {
  try {
    const { staff_name, type } = await c.req.json();
    const res = await pool.query(
      'INSERT INTO logs (staff_id, type, timestamp) SELECT id, $1, CURRENT_TIMESTAMP FROM staff WHERE name = $2 RETURNING *',
      [type, staff_name]
    );
    const log = res.rows[0];
    log.staff_name = staff_name;
    return c.json({ success: true, log });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- D. 履歴修正 API (admin.html用) ---
app.post('/api/logs/update', async (c) => {
  try {
    const { logs } = await c.req.json();
    for (const log of logs) {
      if (log.deleted) {
        await pool.query('UPDATE logs SET deleted = 1 WHERE id = $1', [log.id]);
      } else if (log.id) {
        await pool.query('UPDATE logs SET timestamp = $1 WHERE id = $2', [log.timestamp, log.id]);
      }
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- E. スタッフ・設定更新 API ---
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
  } catch (err) { return c.json({ success: false }, 500); }
});

app.post('/api/settings/update', async (c) => {
  try {
    const { settings } = await c.req.json();
    for (const [key, value] of Object.entries(settings)) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
    }
    return c.json({ success: true });
  } catch (err) { return c.json({ success: false }, 500); }
});

// --- F. JSONインポート API (新機能：データ復旧用) ---
app.post('/api/import', async (c) => {
  try {
    const data = await c.req.json();
    await pool.query('BEGIN');
    await pool.query('TRUNCATE TABLE logs, staff, settings RESTART IDENTITY');
    
    for (const s of data.staff_ext || []) {
      await pool.query('INSERT INTO staff (name, break_start, break_end) VALUES ($1, $2, $3)', [s.name, s.breakStart, s.breakEnd]);
    }
    for (const log of data.logs || []) {
      await pool.query('INSERT INTO logs (id, staff_id, type, timestamp, deleted) SELECT $1, id, $2, $3, $4 FROM staff WHERE name = $5', 
        [log.id, log.type, log.ts, log.deleted || 0, log.staff]);
    }
    await pool.query('COMMIT');
    return c.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    return c.json({ success: false, error: err.message }, 500);
  }
});

// --- G. 静的ファイル配信 ---
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/admin', serveStatic({ path: './public/admin.html' }))
app.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`✅ Server is running on port ${info.port}`);
});

export default app
