// api/check-login.js
// Vérifie le prénom + code d'une cliente en interrogeant la table Airtable
// "SuiviCSR_Clients" — plus besoin de modifier le code source pour ajouter une cliente.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, prenom } = req.body;

    if (!code || !prenom || typeof code !== 'string' || typeof prenom !== 'string') {
      return res.status(400).json({ valid: false });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const AIRTABLE_TABLE = 'SuiviCSR_Clients';

    const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

    // Recherche insensible à la casse sur le code
    const filterFormula = encodeURIComponent(`UPPER({Code})='${code.toUpperCase()}'`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`;

    const airtableRes = await fetch(url, { headers });
    if (!airtableRes.ok) {
      // Problème de config (table absente, token manquant...) — pas une erreur d'identifiants.
      // On répond avec un statut d'erreur explicite pour que le client bascule sur la liste de secours.
      console.error('Airtable check-login indisponible:', airtableRes.status, await airtableRes.text());
      return res.status(502).json({ error: 'Service indisponible' });
    }

    const airtableData = await airtableRes.json();
    const record = (airtableData.records || [])[0];

    if (!record) {
      return res.status(200).json({ valid: false });
    }

    const fields = record.fields;
    const prenomMatch =
      (fields.Prenom || '').trim().toLowerCase() === prenom.trim().toLowerCase();
    const actif = fields.Actif !== false; // true par défaut si la case n'existe pas

    if (!prenomMatch || !actif) {
      return res.status(200).json({ valid: false });
    }

    return res.status(200).json({ valid: true, prenom: fields.Prenom });
  } catch (err) {
    console.error('Erreur check-login:', err);
    return res.status(502).json({ error: 'Service indisponible' });
  }
}
