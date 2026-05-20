# Deprem Takip Push Backend

AFAD'ı her dakika kontrol eder, yeni deprem olduğunda kayıtlı kullanıcılara push bildirimi gönderir.

## Render.com'a Deploy

1. GitHub'a bu klasörü yükle
2. render.com → New → Web Service → GitHub repo'yu bağla
3. Settings:
   - Environment: Node
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy et — URL alırsın (örn: `https://deprem-backend.onrender.com`)

## Endpoints

- `POST /register` — `{ token, minMag }` push token kaydet
- `POST /unregister` — `{ token }` token sil
- `POST /update` — `{ token, minMag }` eşik güncelle
- `GET /` — sağlık kontrolü
