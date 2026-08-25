// api/reset-experience.js
//
// NOUVEAU (25/08/2026) — Action admin, réservée à Franck (protégée par un
// secret, même principe que send-checkins). Archive l'expérience active
// d'un client (Statut -> "Abandonné") et retire le lien "Expérience active"
// sur sa fiche, pour lui permettre de choisir un nouveau moteur.
//
// L'ancien enregistrement CSR_Expériences n'est jamais supprimé : il reste
// consultable comme historique, juste détaché du client.
//
// Corps attendu (POST) : { code, secret }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, secret } = req.body;

    if (secret !== process.env.RESET_EXPERIENCE_SECRET) {
      return res.status(401).json({ error: 'Non autorisé' });
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const clientRecord = clientData.records[0];
    const experienceLinks = clientRecord.fields['Expérience active'];

    if (!experienceLinks || experienceLinks.length === 0) {
      return res.status(409).json({ error: 'Aucune expérience active à réinitialiser.' });
    }

    const experienceRecordId = experienceLinks[0];

    // 1. Archiver l'ancienne expérience (jamais supprimée).
    const archiveRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ fields: { Statut: 'Abandonné' } }) }
    );
    if (!archiveRes.ok) {
      const errText = await archiveRes.text();
      console.error('Échec archivage expérience:', errText);
      throw new Error('Échec archivage');
    }

    // 2. Retirer le lien côté client, pour qu'il puisse en choisir une nouvelle.
    const unlinkRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}/${clientRecord.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ fields: { 'Expérience active': [] } }) }
    );
    if (!unlinkRes.ok) {
      const errText = await unlinkRes.text();
      console.error('Échec déliaison client:', errText);
      throw new Error('Échec déliaison');
    }

    return res.status(200).json({ success: true, archivedExperienceId: experienceRecordId });
  } catch (err) {
    console.error('Erreur reset-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
