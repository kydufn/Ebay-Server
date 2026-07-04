// Kleiner, sicherer Vermittler zwischen deinem Reseller Center (Browser) und der eBay Browse API.
// Läuft als Vercel Serverless Function. Deine App ID / Cert ID stehen NUR hier als
// Umgebungsvariablen auf dem Server, nie im Browser-Code.
//
// Aufruf z.B.: https://DEIN-PROJEKT.vercel.app/api/ebay-item?url=https://www.ebay.de/itm/123456789012

module.exports = async function handler(req, res) {
  // Erlaubt Aufrufe aus dem Browser (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url, legacyItemId } = req.query;

  // eBay-Artikelnummer entweder direkt übergeben oder aus einem Link herausziehen
  let itemId = legacyItemId;
  if (!itemId && url) {
    const match = String(url).match(/(\d{9,15})/); // eBay-Artikelnummern sind lange Zahlenfolgen
    if (match) itemId = match[1];
  }
  if (!itemId) {
    res.status(400).json({ error: 'Konnte keine eBay-Artikelnummer im Link finden. Bitte Link prüfen.' });
    return;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const marketplace = process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE';

  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'Server fehlt Konfiguration: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET nicht gesetzt.' });
    return;
  }

  try {
    // Schritt 1: Anwendungs-Token holen (Client Credentials Grant, kein Nutzer-Login nötig)
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      res.status(502).json({ error: 'eBay hat kein Zugriffstoken ausgestellt.', details: tokenData });
      return;
    }

    // Schritt 2: Artikeldaten abrufen
    const itemRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(itemId)}`,
      {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'X-EBAY-C-MARKETPLACE-ID': marketplace,
        },
      }
    );
    const itemData = await itemRes.json();
    if (!itemRes.ok) {
      res.status(itemRes.status).json({ error: 'eBay konnte den Artikel nicht finden.', details: itemData });
      return;
    }

    // Nur die Felder zurückgeben, die das Reseller Center wirklich braucht
    res.status(200).json({
      itemId,
      title: itemData.title || '',
      categoryPath: itemData.categoryPath || '',
      categoryId: itemData.categoryId || '',
      condition: itemData.condition || '',
      price: itemData.price?.value || '',
      currency: itemData.price?.currency || '',
      quantity: itemData.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity ?? '',
      image: itemData.image?.imageUrl || '',
      itemWebUrl: itemData.itemWebUrl || url,
    });
  } catch (e) {
    res.status(500).json({ error: 'Unerwarteter Fehler beim Abruf von eBay.', details: String(e) });
  }
}
