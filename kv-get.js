// api/kv-get.js
// Récupère toutes les données enregistrées pour une cliente (par son code).
// Retourne un objet { data: { "seances_CODE": [...], "actions_CODE": {...}, "routine_CODE": {...} } }

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const AIRTABLE_TABLE = 'SuiviCSR_KV';

    const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${filterFormula}`;

    const airtableRes = await fetch(url, { headers });
    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Erreur Airtable:', errText);
      return res.status(502).json({ error: 'Erreur lors de la récupération' });
    }

    const airtableData = await airtableRes.json();
    const data = {};

    (airtableData.records || []).forEach((record) => {
      const key = record.fields.DataKey;
      const rawValue = record.fields.Value;
      if (key && rawValue) {
        try {
          data[key] = JSON.parse(rawValue);
        } catch (e) {
          // valeur corrompue, ignorée
        }
      }
    });

    return res.status(200).json({ data });
  } catch (err) {
    console.error('Erreur kv-get:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
