// Zentraler Datenspeicher für das Reseller Center (Upstash Redis, angelegt über Vercel → Storage).
// GET  /api/db?secret=XYZ   -> gibt die komplette Datenbank als JSON zurück
// POST /api/db?secret=XYZ   -> speichert die im Body geschickte Datenbank
//
// Das Secret schützt deine Daten — es muss als Umgebungsvariable SYNC_SECRET in Vercel
// hinterlegt sein und im Reseller Center unter Einstellungen eingetragen werden.

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return { url, token };
}

async function redisGet(key) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result ?? null; // Upstash liefert { result: "..." } oder { result: null }
}

async function redisSet(key, value) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  });
  if (!res.ok) throw new Error('Redis SET fehlgeschlagen: ' + res.status);
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!process.env.SYNC_SECRET) {
    res.status(500).json({ error: 'Server fehlt Konfiguration: SYNC_SECRET nicht gesetzt.' });
    return;
  }
  if (req.query.secret !== process.env.SYNC_SECRET) {
    res.status(401).json({ error: 'Falsches oder fehlendes Secret.' });
    return;
  }
  const { url, token } = redisConfig();
  if (!url || !token) {
    res.status(500).json({ error: 'Keine Datenbank verbunden. Bitte in Vercel unter Storage eine Upstash-Redis-Datenbank anlegen und mit dem Projekt verbinden.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const value = await redisGet('reseller-db');
      res.status(200).json({ db: value ? JSON.parse(value) : null });
      return;
    }
    if (req.method === 'POST') {
      // Vercel parst JSON-Bodies automatisch in req.body
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!body || body === 'null' || body === '{}') {
        res.status(400).json({ error: 'Leerer Datensatz — wird zum Schutz nicht gespeichert.' });
        return;
      }
      await redisSet('reseller-db', body);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (e) {
    res.status(500).json({ error: 'Datenbank-Fehler.', details: String(e) });
  }
};
