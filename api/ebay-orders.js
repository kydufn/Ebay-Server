// Holt mit einem Refresh-Token (das der Nutzer im Reseller Center hinterlegt hat) die
// aktuell offenen eBay-Bestellungen. Das Refresh-Token kommt bei jedem Aufruf vom Browser
// mit — der Server speichert nichts dauerhaft.

const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
function regionFromCountry(cc){
  if (cc === 'DE') return 'inland';
  if (cc === 'CH') return 'ch';
  if (EU_COUNTRIES.includes(cc)) return 'eu';
  return 'intl';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { refreshToken } = req.query;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!refreshToken) { res.status(400).json({ error: 'Kein Refresh-Token übergeben. Bitte zuerst bei eBay anmelden.' }); return; }
  if (!clientId || !clientSecret) { res.status(500).json({ error: 'Server-Konfiguration unvollständig.' }); return; }

  try {
    // Schritt 1: Aus dem Refresh-Token ein kurzlebiges Zugriffstoken erzeugen
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.finances',
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      res.status(502).json({ error: 'Konnte kein Zugriffstoken erneuern — Refresh-Token evtl. abgelaufen. Bitte einmal neu bei eBay anmelden.', details: tokenData });
      return;
    }

    // Schritt 2: Offene Bestellungen abrufen
    const ordersRes = await fetch(
      'https://api.ebay.com/sell/fulfillment/v1/order?limit=20&filter=orderfulfillmentstatus:%7BNOT_STARTED|IN_PROGRESS%7D',
      { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
    );
    const ordersData = await ordersRes.json();
    if (!ordersRes.ok) {
      res.status(ordersRes.status).json({ error: 'eBay konnte Bestellungen nicht liefern.', details: ordersData });
      return;
    }

    const orders = (ordersData.orders || []).map(o => {
      const countryCode = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode || '';
      return {
        orderId: o.orderId,
        buyer: o.buyer?.username || '',
        creationDate: o.creationDate,
        currency: o.pricingSummary?.total?.currency || 'EUR',
        shippingCost: Number(o.pricingSummary?.deliveryCost?.value || 0),
        countryCode,
        region: regionFromCountry(countryCode),
        items: (o.lineItems || []).map(li => ({
          title: li.title,
          sku: li.sku || '',
          quantity: li.quantity,
          lineItemPrice: Number(li.total?.value || 0),
        })),
      };
    });

    res.status(200).json({ orders });
  } catch (e) {
    res.status(500).json({ error: 'Unerwarteter Fehler beim Abruf der Bestellungen.', details: String(e) });
  }
};
