// AUTOMATIK-ENDPOINT — das Herzstück der Automatisierung.
// Wird regelmäßig von cron-job.org aufgerufen (z. B. alle 15 Minuten) oder manuell
// über den "Jetzt synchronisieren"-Knopf im Reseller Center.
//
// Ablauf bei jedem Aufruf:
//   1. Datenbank aus Upstash Redis laden (dieselbe, die das Reseller Center nutzt)
//   2. Neue eBay-Bestellungen abrufen (die letzten 50, egal ob schon versendet)
//   3. Jede noch nicht gebuchte Bestellung automatisch buchen:
//      Produkt zuordnen oder neu anlegen, echte Gebühr von eBay holen,
//      Bestand reduzieren, Gewinn berechnen
//   4. Datenbank zurückschreiben
//   5. Für jeden neuen Verkauf eine Discord-Nachricht senden
//
// Aufruf: GET /api/sync?secret=DEIN_SECRET

// ---------- Redis-Helfer ----------
function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return { url, token };
}
async function redisGet(key) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.result ?? null;
}
async function redisSet(key, value) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/set/${key}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: value,
  });
  if (!res.ok) throw new Error('Redis SET fehlgeschlagen: ' + res.status);
}

// ---------- Kalkulation (identisch zur Logik im Reseller Center) ----------
function calcSale({ ek = 0, vk = 0, fee = 0, shipIn = 0, ship = 0, pack = 0, extra = 0, qty = 1, feeAmountOverride = null, kleinunternehmer = true, fixedOrderFee = 0 }) {
  ek = Number(ek) || 0; vk = Number(vk) || 0; fee = Number(fee) || 0; shipIn = Number(shipIn) || 0;
  ship = Number(ship) || 0; pack = Number(pack) || 0; extra = Number(extra) || 0; qty = Number(qty) || 1;
  const artikelBrutto = vk * qty;
  const brutto = artikelBrutto + shipIn;
  const ustAmount = kleinunternehmer ? 0 : brutto - brutto / 1.19;
  const feeIsActual = feeAmountOverride !== null && feeAmountOverride !== undefined;
  const feeAmount = feeIsActual ? Number(feeAmountOverride) : brutto * fee / 100;
  const fixedFee = feeIsActual ? 0 : Number(fixedOrderFee) || 0; // in der echten Gebühr schon enthalten
  const netto = brutto - ustAmount - feeAmount - fixedFee - ship - pack - extra;
  const wareneinsatz = ek * qty;
  const gewinn = netto - wareneinsatz;
  const margin = brutto ? gewinn / brutto * 100 : 0;
  const roi = wareneinsatz ? gewinn / wareneinsatz * 100 : 0;
  return { artikelBrutto, shipIn, brutto, ustAmount, feeAmount, feeIsActual, fixedFee, ship, extra, netto, wareneinsatz, gewinn, margin, roi };
}

// ---------- Weitere Helfer ----------
const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
function regionFromCountry(cc) {
  if (cc === 'DE') return 'inland';
  if (cc === 'CH') return 'ch';
  if (EU.includes(cc)) return 'eu';
  return 'intl';
}
function uid() {
  try { return crypto.randomUUID(); } catch (e) { return Math.random().toString(36).slice(2, 12); }
}
function productFee(p, settings) {
  return (p && p.fee !== undefined && p.fee !== null && p.fee !== '') ? Number(p.fee) : Number(settings.defaultFee) || 0;
}
function getShip(p, db) {
  return db.shipping.find(s => s.id === p?.shippingId) || db.shipping[0] || { price: 0 };
}
function eur(n) { return (Number(n) || 0).toFixed(2).replace('.', ',') + ' €'; }

// Kurzlebiges Nutzer-Zugriffstoken aus dem Refresh-Token erzeugen
async function getUserToken(refreshToken) {
  const basicAuth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.finances',
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Refresh-Token abgelaufen oder ungültig — bitte im Reseller Center neu bei eBay anmelden.');
  return data.access_token;
}

// Anwendungs-Token (für Artikeldaten/Bilder über die Browse API)
async function getAppToken() {
  const basicAuth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  const data = await res.json();
  return res.ok ? data.access_token : null;
}

// Produktbild über die Browse API nachladen (best effort)
async function fetchItemImage(legacyItemId, appToken) {
  if (!legacyItemId || !appToken) return '';
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`,
      { headers: { 'Authorization': `Bearer ${appToken}`, 'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE' } }
    );
    if (!res.ok) return '';
    const data = await res.json();
    return data.image?.imageUrl || '';
  } catch (e) { return ''; }
}

// Echte, tatsächlich abgezogene Gebühr einer Bestellung (Finances API, best effort)
async function fetchActualFee(orderId, userToken) {
  try {
    const res = await fetch(
      `https://apiz.ebay.com/sell/finances/v1/transaction?filter=orderId:${encodeURIComponent(orderId)}&limit=10`,
      { headers: { 'Authorization': `Bearer ${userToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const saleTx = (data.transactions || []).find(t => t.transactionType === 'SALE');
    if (saleTx && saleTx.totalFeeAmount?.value !== undefined) return Number(saleTx.totalFeeAmount.value);
    return null;
  } catch (e) { return null; }
}

// Discord-Nachricht senden (best effort — Fehler brechen den Sync nicht ab)
async function sendDiscord(webhookUrl, { title, productName, qty, vk, gewinn, stock, isNew, region }) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: title,
          color: gewinn >= 0 ? 0x4FAE7B : 0xE8664F,
          fields: [
            { name: 'Produkt', value: productName.slice(0, 250), inline: false },
            { name: 'Menge', value: String(qty), inline: true },
            { name: 'Verkaufspreis', value: eur(vk), inline: true },
            { name: 'Gewinn', value: eur(gewinn), inline: true },
            { name: 'Lagerbestand jetzt', value: `${stock} Stk.`, inline: true },
            { name: 'Region', value: region, inline: true },
            ...(isNew ? [{ name: '⚠ Hinweis', value: 'Neues Produkt automatisch angelegt — Einkaufspreis im Reseller Center nachtragen!', inline: false }] : []),
          ],
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) { /* still — Discord-Fehler stoppen nichts */ }
}

// ---------- Hauptablauf ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!process.env.SYNC_SECRET || req.query.secret !== process.env.SYNC_SECRET) {
    res.status(401).json({ error: 'Falsches oder fehlendes Secret.' });
    return;
  }
  const { url, token } = redisConfig();
  if (!url || !token) {
    res.status(500).json({ error: 'Keine Datenbank verbunden (Vercel → Storage → Upstash Redis anlegen und verbinden).' });
    return;
  }

  try {
    // 1. Datenbank laden
    const raw = await redisGet('reseller-db');
    if (!raw) {
      res.status(400).json({ error: 'Noch keine Daten auf dem Server. Bitte zuerst im Reseller Center die Automatisierung aktivieren (lädt deine Daten hoch).' });
      return;
    }
    const db = JSON.parse(raw);
    const refreshToken = db.settings?.ebay?.refreshToken;
    if (!refreshToken) {
      res.status(400).json({ error: 'Kein Refresh-Token in den Einstellungen. Bitte im Reseller Center bei eBay anmelden und Token speichern.' });
      return;
    }

    // 2. Bestellungen abrufen (die letzten 50, neueste zuerst)
    const userToken = await getUserToken(refreshToken);
    const ordersRes = await fetch('https://api.ebay.com/sell/fulfillment/v1/order?limit=50', {
      headers: { 'Authorization': `Bearer ${userToken}` },
    });
    const ordersData = await ordersRes.json();
    if (!ordersRes.ok) {
      res.status(502).json({ error: 'eBay konnte Bestellungen nicht liefern.', details: ordersData });
      return;
    }

    const settings = db.settings || {};
    const kleinunternehmer = settings.kleinunternehmer !== false;
    const fixedOrderFee = settings.fixedOrderFee ?? 0;
    let appToken = null; // wird nur geholt, wenn ein neues Produkt ein Bild braucht
    const booked = [];

    // 3. Jede Bestellposition prüfen und ggf. buchen
    for (const o of (ordersData.orders || [])) {
      const countryCode = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode || '';
      const region = regionFromCountry(countryCode);
      const shippingCost = Number(o.pricingSummary?.deliveryCost?.value || 0);
      const lineItems = o.lineItems || [];

      // Echte Gebühr einmal pro Bestellung holen (nicht pro Position)
      let actualFee = null;
      let actualFeeUsed = false;

      for (let ii = 0; ii < lineItems.length; ii++) {
        const li = lineItems[ii];
        const already = (db.sales || []).some(s => s.ebayOrderId === o.orderId && (s.ebayLineItemId ? s.ebayLineItemId === li.lineItemId : true));
        if (already) continue;

        if (actualFee === null && !actualFeeUsed) {
          actualFee = await fetchActualFee(o.orderId, userToken);
        }

        const qty = li.quantity || 1;
        const vk = qty ? Number(li.total?.value || 0) / qty : Number(li.total?.value || 0);
        const shipIn = ii === 0 ? shippingCost : 0;
        const feeOverride = (ii === 0 && actualFee !== null) ? actualFee : null;
        if (feeOverride !== null) actualFeeUsed = true;

        // Produkt zuordnen (Titel-Ähnlichkeit) oder automatisch neu anlegen
        let p = (db.products || []).find(prod => prod.name && (
          li.title.toLowerCase().includes(prod.name.toLowerCase()) ||
          prod.name.toLowerCase().includes(li.title.toLowerCase())
        ));
        let isNew = false;
        if (!p) {
          if (!appToken) appToken = await getAppToken();
          const image = await fetchItemImage(li.legacyItemId, appToken);
          p = {
            id: uid(), name: li.title, category: '', supplier: '', brand: '',
            ek: 0, vk, stock: 0, weight: 0, shippingId: db.shipping?.[0]?.id,
            ebay: '', ean: li.sku || '', image, needsReview: true,
          };
          db.products.push(p);
          isNew = true;
        }

        const ship = getShip(p, db).price;
        const fee = productFee(p, settings);
        const c = calcSale({
          ek: p.ek, vk, fee, shipIn, ship, pack: settings.packaging || 0, extra: 0, qty,
          feeAmountOverride: feeOverride, kleinunternehmer, fixedOrderFee,
        });

        p.stock = Math.max(0, (Number(p.stock) || 0) - qty);
        db.sales.push({
          id: uid(), date: o.creationDate || new Date().toISOString(),
          productId: p.id, productName: p.name,
          platform: 'eBay', region, qty, vk, fee, ship, shipIn,
          ek: p.ek, cancelled: false, source: 'auto',
          ebayOrderId: o.orderId, ebayLineItemId: li.lineItemId, buyer: o.buyer?.username || '',
          ...c,
        });
        booked.push({ productName: p.name, qty, vk, gewinn: c.gewinn, stock: p.stock, isNew, region });
      }
    }

    // 4. Datenbank zurückschreiben (nur wenn sich etwas geändert hat)
    if (booked.length > 0) {
      await redisSet('reseller-db', JSON.stringify(db));
    }

    // 5. Discord-Meldungen senden
    const REGION_LABEL = { inland: 'Inland (DE)', eu: 'EU', ch: 'Schweiz', intl: 'International' };
    for (const b of booked) {
      await sendDiscord(settings.discordWebhook, {
        title: '🛒 Neuer Verkauf automatisch gebucht',
        productName: b.productName, qty: b.qty, vk: b.vk, gewinn: b.gewinn,
        stock: b.stock, isNew: b.isNew, region: REGION_LABEL[b.region] || b.region,
      });
    }

    res.status(200).json({
      ok: true,
      geprüft: (ordersData.orders || []).length,
      neuGebucht: booked.length,
      details: booked.map(b => `${b.productName} ×${b.qty} → Gewinn ${eur(b.gewinn)}, Bestand jetzt ${b.stock}`),
    });
  } catch (e) {
    res.status(500).json({ error: 'Sync fehlgeschlagen.', details: String(e.message || e) });
  }
};
