// api/create-experience.js
//
// NOUVEAU (25/08/2026) — Le client choisit lui-même ANCRAGE ou RUPTURE (guidé
// en direct par Franck pendant la séance). Cette route crée l'expérience
// correspondante et la lie au client, une seule fois.
//
// Corps attendu (POST) : { code, moteur, objectif }
// moteur doit être exactement "ANCRAGE" ou "RUPTURE".

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, moteur, objectif } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }
    if (moteur !== 'ANCRAGE' && moteur !== 'RUPTURE') {
      return res.status(400).json({ error: 'Moteur invalide' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Retrouver le client.
    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const clientRecord = clientData.records[0];

    // Sécurité : si une expérience est déjà liée, on ne la remplace jamais
    // depuis cette route — le verrouillage se décide côté Franck, dans
    // Airtable, pas via un appel client qu'on pourrait rejouer par erreur.
    const existingLinks = clientRecord.fields['Expérience active'];
    if (existingLinks && existingLinks.length > 0) {
      return res.status(409).json({
        error: 'Une expérience est déjà active pour ce client. Contacte Franck pour la modifier.',
      });
    }

    const prenom = clientRecord.fields['Prenom'] || clientRecord.fields['Prénom'] || code;

    // 2. Créer l'expérience.
    const createExpRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fields: {
            'Nom expérience': prenom + ' — ' + moteur,
            Moteur: moteur,
            'Version protocole': moteur + '_v1',
            Objectif: objectif || '',
            Statut: 'Configuration',
            'Date création': new Date().toISOString().slice(0, 10),
          },
        }),
      }
    );

    if (!createExpRes.ok) {
      const errText = await createExpRes.text();
      console.error('Échec création CSR_Expériences:', errText);
      throw new Error('Échec création expérience');
    }

    const createExpData = await createExpRes.json();
    const experienceRecordId = createExpData.id;

    // 3. Lier l'expérience au client.
    const updateClientRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}/${clientRecord.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          fields: { 'Expérience active': [experienceRecordId] },
        }),
      }
    );

    if (!updateClientRes.ok) {
      const errText = await updateClientRes.text();
      console.error('Échec liaison client -> expérience:', errText);
      throw new Error('Échec liaison client');
    }

    return res.status(200).json({ success: true, experienceId: experienceRecordId, moteur: moteur });
  } catch (err) {
    console.error('Erreur create-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
