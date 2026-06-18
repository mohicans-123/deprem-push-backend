const express = require('express');
const fetch = require('node-fetch');
const { Expo } = require('expo-server-sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const expo = new Expo();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Tabloları oluştur (ilk başlatmada)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      token TEXT PRIMARY KEY,
      min_mag REAL NOT NULL DEFAULT 4,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_events (
      event_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Eski seen kayıtları sil (son 7 gün yeterli)
  await pool.query(`DELETE FROM seen_events WHERE created_at < NOW() - INTERVAL '7 days'`);
  console.log('Veritabanı hazır');
}

// Push token kaydet (varsa güncelle)
app.post('/register', async (req, res) => {
  const { token, minMag = 4 } = req.body || {};
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz token' });
  }
  try {
    await pool.query(
      `INSERT INTO users (token, min_mag) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET min_mag = $2`,
      [token, parseFloat(minMag)]
    );
    console.log(`Kullanıcı kayıt: ${token.slice(0, 25)}... (M≥${minMag})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Register hatası:', e.message);
    res.status(500).json({ ok: false });
  }
});

// Kullanıcıyı sil
app.post('/unregister', async (req, res) => {
  const { token } = req.body || {};
  try {
    await pool.query(`DELETE FROM users WHERE token = $1`, [token]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Eşik güncelleme
app.post('/update', async (req, res) => {
  const { token, minMag } = req.body || {};
  try {
    await pool.query(
      `UPDATE users SET min_mag = $1 WHERE token = $2`,
      [parseFloat(minMag), token]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Sağlık kontrolü
app.get('/', async (req, res) => {
  try {
    const u = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
    const s = await pool.query(`SELECT COUNT(*)::int AS c FROM seen_events`);
    res.json({ status: 'ok', users: u.rows[0].c, seen: s.rows[0].c });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Admin: tüm kullanıcılara duyuru gönder
app.post('/announce', async (req, res) => {
  const { secret, title, body } = req.body || {};
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Yetkisiz' });
  }
  if (!title || !body) {
    return res.status(400).json({ ok: false, error: 'title ve body gerekli' });
  }
  try {
    const result = await pool.query(`SELECT token FROM users`);
    const tokens = result.rows.map(r => r.token);
    if (tokens.length === 0) {
      return res.json({ ok: true, sent: 0, message: 'Hiç kullanıcı yok' });
    }
    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title, body,
      priority: 'high',
    }));
    let sent = 0;
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < tickets.length; i++) {
          if (tickets[i].status === 'ok') sent++;
          else if (tickets[i].details?.error === 'DeviceNotRegistered') {
            await pool.query(`DELETE FROM users WHERE token = $1`, [chunk[i].to]);
          }
        }
      } catch (e) {
        console.error('Duyuru hatası:', e.message);
      }
    }
    console.log(`📢 Duyuru: ${sent}/${tokens.length}`);
    res.json({ ok: true, sent, total: tokens.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AFAD'dan veri çek
async function fetchAfad() {
  try {
    const now = new Date();
    const start = new Date(now - 30 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 19);
    const url = `https://servisnet.afad.gov.tr/apigateway/deprem/apiv2/event/filter?start=${fmt(start)}&end=${fmt(now)}&minmag=0&maxmag=10&limit=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AFAD HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('AFAD hatası:', e.message);
    return [];
  }
}

// Yeni depremleri kontrol et ve push gönder
async function checkAndNotify() {
  const data = await fetchAfad();
  if (!Array.isArray(data) || data.length === 0) return;

  for (const q of data) {
    // Daha önce görüldü mü?
    const seen = await pool.query(`SELECT 1 FROM seen_events WHERE event_id = $1`, [q.eventID]);
    if (seen.rowCount > 0) continue;

    await pool.query(`INSERT INTO seen_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`, [q.eventID]);

    const mag = parseFloat(q.magnitude);
    const location = q.location || 'Konum bilinmiyor';
    console.log(`📡 Yeni deprem: M${mag} - ${location}`);

    // Eşiği bu büyüklük altındaki tüm kullanıcılar
    const result = await pool.query(`SELECT token FROM users WHERE min_mag <= $1`, [mag]);
    const targets = result.rows.map(r => r.token);
    if (targets.length === 0) continue;

    const messages = targets.map(token => ({
      to: token,
      sound: 'default',
      title: `⚠️ M${mag.toFixed(1)} Deprem`,
      body: `${location} - Derinlik: ${q.depth} km`,
      data: { eqId: q.eventID, location, mag, depth: q.depth },
      priority: 'high',
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < tickets.length; i++) {
          if (tickets[i].status === 'error' && tickets[i].details?.error === 'DeviceNotRegistered') {
            await pool.query(`DELETE FROM users WHERE token = $1`, [chunk[i].to]);
          }
        }
      } catch (e) {
        console.error('Push hatası:', e.message);
      }
    }
    console.log(`✓ ${targets.length} kullanıcıya gönderildi`);
  }
}

// Başlat
async function start() {
  try {
    await initDB();
    setInterval(checkAndNotify, 60 * 1000);
    checkAndNotify();
    app.listen(PORT, () => {
      console.log(`Server hazır, port ${PORT}`);
    });
  } catch (e) {
    console.error('Başlatma hatası:', e);
    process.exit(1);
  }
}

start();
