import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// CORSとAPIルート設定
app.use('/api/*', cors())

// 静的ファイル配信
app.use('/static/*', serveStatic({ root: './public' }))

// ルートパス - 打刻画面
app.get('/', serveStatic({ path: './public/static/index.html' }))

// 管理画面
app.get('/admin', serveStatic({ path: './public/static/admin.html' }))

// ===== API エンドポイント =====

// スタッフ一覧取得
app.get('/api/staff', async (c) => {
  try {
    const { DB } = c.env
    const result = await DB.prepare(
      'SELECT id, name, emp_id, break_start, break_end FROM staff WHERE active = 1 ORDER BY id'
    ).all()
    
    return c.json({ success: true, staff: result.results })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// 打刻ログ全件取得
app.get('/api/logs', async (c) => {
  try {
    const { DB } = c.env
    const result = await DB.prepare(
      'SELECT * FROM logs WHERE deleted = 0 ORDER BY timestamp DESC'
    ).all()
    
    return c.json({ success: true, logs: result.results })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// システム設定取得
app.get('/api/settings', async (c) => {
  try {
    const { DB } = c.env
    const result = await DB.prepare('SELECT key, value FROM settings').all()
    
    const settings: Record<string, string> = {}
    result.results.forEach((row: any) => {
      settings[row.key] = row.value
    })
    
    return c.json({ success: true, settings })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// データ全件取得（同期用）
app.get('/api/sync', async (c) => {
  try {
    const { DB } = c.env
    
    // スタッフ取得
    const staffResult = await DB.prepare(
      'SELECT id, name, emp_id, break_start, break_end FROM staff WHERE active = 1 ORDER BY id'
    ).all()
    
    // ログ取得
    const logsResult = await DB.prepare(
      'SELECT * FROM logs WHERE deleted = 0 ORDER BY timestamp DESC'
    ).all()
    
    // 設定取得
    const settingsResult = await DB.prepare('SELECT key, value FROM settings').all()
    const settings: Record<string, string> = {}
    settingsResult.results.forEach((row: any) => {
      settings[row.key] = row.value
    })
    
    return c.json({
      success: true,
      data: {
        staff: staffResult.results,
        logs: logsResult.results,
        settings,
        last_updated: new Date().toISOString()
      }
    })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// 打刻登録
app.post('/api/clock', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { staff_name, type } = body
    
    if (!staff_name || !type) {
      return c.json({ success: false, error: 'Missing parameters' }, 400)
    }
    
    // スタッフIDの取得
    const staffResult = await DB.prepare(
      'SELECT id FROM staff WHERE name = ? AND active = 1'
    ).bind(staff_name).first()
    
    if (!staffResult) {
      return c.json({ success: false, error: 'Staff not found' }, 404)
    }
    
    const staff_id = staffResult.id
    const logId = Date.now()
    const now = new Date().toISOString()
    
    await DB.prepare(
      'INSERT INTO logs (id, staff_id, staff_name, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(logId, staff_id, staff_name, type, now, logId).run()
    
    return c.json({
      success: true,
      log: {
        id: logId,
        staff_id,
        staff_name,
        type,
        timestamp: now,
        updated_at: logId
      }
    })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// ログ更新（管理画面用）
app.post('/api/logs/update', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { logs } = body
    
    if (!Array.isArray(logs)) {
      return c.json({ success: false, error: 'Invalid logs format' }, 400)
    }
    
    // トランザクション的に処理
    const batch = []
    
    for (const log of logs) {
      if (log.deleted) {
        batch.push(
          DB.prepare('UPDATE logs SET deleted = 1 WHERE id = ?').bind(log.id)
        )
      } else if (log.id && log.timestamp) {
        batch.push(
          DB.prepare(
            'UPDATE logs SET timestamp = ?, updated_at = ? WHERE id = ?'
          ).bind(log.timestamp, Date.now(), log.id)
        )
      } else if (!log.id && log.staff_name && log.type && log.timestamp) {
        // 新規ログ
        const newId = Date.now() + Math.random()
        const staffResult = await DB.prepare(
          'SELECT id FROM staff WHERE name = ? AND active = 1'
        ).bind(log.staff_name).first()
        
        if (staffResult) {
          batch.push(
            DB.prepare(
              'INSERT INTO logs (id, staff_id, staff_name, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(newId, staffResult.id, log.staff_name, log.type, log.timestamp, Date.now())
          )
        }
      }
    }
    
    await DB.batch(batch)
    
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// スタッフ管理
app.post('/api/staff/update', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { staff } = body
    
    if (!Array.isArray(staff)) {
      return c.json({ success: false, error: 'Invalid staff format' }, 400)
    }
    
    const batch = []
    
    for (const s of staff) {
      if (s.id) {
        // 既存スタッフ更新
        batch.push(
          DB.prepare(
            'UPDATE staff SET emp_id = ?, break_start = ?, break_end = ? WHERE id = ?'
          ).bind(s.emp_id || '', s.break_start || '', s.break_end || '', s.id)
        )
      } else if (s.name) {
        // 新規スタッフ追加
        batch.push(
          DB.prepare(
            'INSERT OR IGNORE INTO staff (name, emp_id, break_start, break_end) VALUES (?, ?, ?, ?)'
          ).bind(s.name, s.emp_id || '', s.break_start || '', s.break_end || '')
        )
      }
    }
    
    await DB.batch(batch)
    
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// スタッフ削除
app.post('/api/staff/delete', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { id } = body
    
    if (!id) {
      return c.json({ success: false, error: 'Missing staff ID' }, 400)
    }
    
    await DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(id).run()
    
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// 設定更新
app.post('/api/settings/update', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { settings } = body
    
    if (!settings || typeof settings !== 'object') {
      return c.json({ success: false, error: 'Invalid settings format' }, 400)
    }
    
    const batch = []
    
    for (const [key, value] of Object.entries(settings)) {
      batch.push(
        DB.prepare(
          'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).bind(key, String(value))
      )
    }
    
    await DB.batch(batch)
    
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// バックアップ作成
app.post('/api/backup', async (c) => {
  try {
    const { DB } = c.env
    
    // 全データ取得
    const staffResult = await DB.prepare('SELECT * FROM staff').all()
    const logsResult = await DB.prepare('SELECT * FROM logs WHERE deleted = 0').all()
    const settingsResult = await DB.prepare('SELECT * FROM settings').all()
    
    const backupData = JSON.stringify({
      staff: staffResult.results,
      logs: logsResult.results,
      settings: settingsResult.results,
      created_at: new Date().toISOString()
    })
    
    await DB.prepare(
      'INSERT INTO backups (backup_data, created_at) VALUES (?, CURRENT_TIMESTAMP)'
    ).bind(backupData).run()
    
    // 古いバックアップを削除（最新30件のみ保持）
    await DB.prepare(
      'DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 30)'
    ).run()
    
    return c.json({ success: true, backup: backupData })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

// 認証チェック
app.post('/api/auth', async (c) => {
  try {
    const { DB } = c.env
    const body = await c.req.json()
    const { password } = body
    
    const result = await DB.prepare(
      "SELECT value FROM settings WHERE key = 'adminPassword'"
    ).first()
    
    const isValid = result && result.value === password
    
    return c.json({ success: isValid })
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500)
  }
})

export default app
