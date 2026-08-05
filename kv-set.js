// api/kv-set.js
// Écrit (crée ou met à jour) une donnée pour une cliente donnée dans Airtable.
// Le token Airtable reste côté serveur, jamais exposé au navigateur.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, dataKey, value } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }
    if (!dataKey || typeof dataKey !== 'string') {
      return res.status(400).json({ error: 'Clé manquante' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const AIRTABLE_TABLE = 'SuiviCSR_KV';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Cherche si un enregistrement existe déjà pour ce code + cette clé
    const filterFormula = encodeURIComponent(`AND({Code}='${code}',{DataKey}='${dataKey}')`);
    const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`;

    const searchRes = await fetch(searchUrl, { headers });
    const searchData = await searchRes.json();

    const valueStr = value === null ? '' : JSON.stringify(value);

    if (searchData.records && searchData.records.length > 0) {
      // Met à jour l'enregistrement existant
      const recordId = searchData.records[0].id;
      const updateRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            fields: { Value: valueStr, UpdatedAt: new Date().toISOString() },
          }),
        }
      );
      if (!updateRes.ok) throw new Error('Échec mise à jour Airtable');
    } else {
      // Crée un nouvel enregistrement
      const createRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            fields: {
              Code: code,
              DataKey: dataKey,
              Value: valueStr,
              UpdatedAt: new Date().toISOString(),
            },
          }),
        }
      );
      if (!createRes.ok) throw new Error('Échec création Airtable');
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur kv-set:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
