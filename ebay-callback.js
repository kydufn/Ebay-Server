// Nimmt den Code entgegen, den eBay nach dem Login des Nutzers an die RuName-Adresse
// schickt, und tauscht ihn gegen ein Refresh-Token — das ist der Schlüssel, mit dem das
// Reseller Center danach dauerhaft (ohne erneuten Login) Bestellungen abrufen kann.
// Das Refresh-Token wird NICHT auf dem Server gespeichert, sondern nur einmal angezeigt —
// der Nutzer kopiert es sich selbst ins Reseller Center.

module.exports = async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    res.status(400).send(`<h2>eBay hat den Zugriff abgelehnt</h2><p>${error}</p>`);
    return;
  }
  if (!code) {
    res.status(400).send('<h2>Kein Code von eBay erhalten.</h2>');
    return;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    res.status(500).send('<h2>Server-Konfiguration unvollständig.</h2><p>EBAY_CLIENT_ID, EBAY_CLIENT_SECRET und EBAY_RUNAME müssen als Umgebungsvariablen gesetzt sein.</p>');
    return;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ruName,
      }).toString(),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      res.status(502).send(`<h2>eBay hat kein Token ausgestellt</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:-apple-system,sans-serif;max-width:600px;margin:40px auto;padding:0 16px;line-height:1.6">
        <h2>✅ Verbindung mit eBay erfolgreich</h2>
        <p>Kopiere den Wert unten komplett und trag ihn im Reseller Center unter
        <b>Einstellungen → eBay-Anbindung</b> in das Feld "Refresh-Token" ein.</p>
        <textarea readonly style="width:100%;height:120px;padding:10px;font-family:monospace;font-size:13px"
          onclick="this.select()">${tokenData.refresh_token}</textarea>
        <p style="color:#888;font-size:13px">Das ist wie ein Passwort — nicht öffentlich teilen.
        Gültig ca. 18 Monate, danach einmal wiederholen.</p>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('<h2>Unerwarteter Fehler</h2><pre>' + String(e) + '</pre>');
  }
};
