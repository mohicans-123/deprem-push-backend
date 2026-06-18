const express = require('express');
const fetch = require('node-fetch');
const { Expo } = require('expo-server-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const expo = new Expo();
const PORT = process.env.PORT || 3000;

// Basit dosya tabanlı kullanıcı veritabanı
const DB_FILE = '/tmp/users.json';
const SEEN_FILE = '/tmp/seen.json';

function loadJSON(file, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultValue;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

let users      = loadJSON(DB_FILE, {});     // { token: { minMag } }
let seenEqIds  = new Set(loadJSON(SEEN_FILE, []));

// Push token kaydet
app.post('/register', (req, res) => {
  const { token, minMag = 4 } = req.body || {};
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz token' });
  }
  users[token] = { minMag: parseFloat(minMag) };
  saveJSON(DB_FILE, users);
  console.log(`Yeni kullanıcı: ${token.slice(0, 25)}... (M≥${minMag})`);
  res.json({ ok: true });
});

// Kullanıcıyı sil
app.post('/unregister', (req, res) => {
  const { token } = req.body || {};
  delete users[token];
  saveJSON(DB_FILE, users);
  res.json({ ok: true });
});

// Eşik güncelleme
app.post('/update', (req, res) => {
  const { token, minMag } = req.body || {};
  if (users[token]) {
    users[token].minMag = parseFloat(minMag);
    saveJSON(DB_FILE, users);
  }
  res.json({ ok: true });
});

// Sağlık kontrolü
app.get('/', (req, res) => {
  res.json({ status: 'ok', users: Object.keys(users).length, seen: seenEqIds.size });
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

  const tokens = Object.keys(users);
  if (tokens.length === 0) {
    return res.json({ ok: true, sent: 0, message: 'Hiç kullanıcı yok' });
  }

  const messages = tokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    priority: 'high',
  }));

  let sent = 0;
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'ok') sent++;
        else if (ticket.details?.error === 'DeviceNotRegistered') {
          delete users[chunk[i].to];
        }
      });
    } catch (e) {
      console.error('Duyuru hatası:', e.message);
    }
  }

  saveJSON(DB_FILE, users);
  console.log(`📢 Duyuru gönderildi: ${sent}/${tokens.length}`);
  res.json({ ok: true, sent, total: tokens.length });
});

// AFAD'dan veri çek
async function fetchAfad() {
  try {
    const now = new Date();
    const start = new Date(now - 30 * 60 * 1000); // son 30 dakika
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

  const newQuakes = data.filter(q => !seenEqIds.has(q.eventID));

  for (const q of newQuakes) {
    seenEqIds.add(q.eventID);
    const mag = parseFloat(q.magnitude);
    const location = q.location || 'Konum bilinmiyor';

    console.log(`📡 Yeni deprem: M${mag} - ${location}`);

    // Eşiği bu büyüklük veya altında olan kullanıcılara push gönder
    const targets = Object.entries(users)
      .filter(([_, u]) => mag >= u.minMag)
      .map(([token]) => token);

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
        // Geçersiz token'ları temizle
        tickets.forEach((ticket, i) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            const badToken = chunk[i].to;
            delete users[badToken];
          }
        });
      } catch (e) {
        console.error('Push hatası:', e.message);
      }
    }

    console.log(`✓ ${targets.length} kullanıcıya gönderildi`);
  }

  // Seen ID'leri kaydet (son 1000)
  if (newQuakes.length > 0) {
    const arr = [...seenEqIds];
    if (arr.length > 1000) seenEqIds = new Set(arr.slice(-1000));
    saveJSON(SEEN_FILE, [...seenEqIds]);
    saveJSON(DB_FILE, users);
  }
}

// 60 saniyede bir kontrol
setInterval(checkAndNotify, 60 * 1000);
checkAndNotify(); // Başlangıçta da çalıştır

app.listen(PORT, () => {
  console.log(`Server hazır, port ${PORT}`);
});
