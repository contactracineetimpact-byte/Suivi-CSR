// api/get-experience.js
//
// NOUVEAU (25/08/2026) — Route de lecture seule. Étant donné le code d'un
// client, renvoie le moteur (ANCRAGE/RUPTURE) et l'objectif de son expérience
// active, pour que l'interface sache quel questionnaire afficher.
//
// Appel : GET /api/get-experience?code=TEST-FRANCK

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
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';

    const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const experienceLinks = clientData.records[0].fields['Expérience active'];
    if (!experienceLinks || experienceLinks.length === 0) {
      return res.status(200).json({ hasExperience: false });
    }

    const experienceRecordId = experienceLinks[0];
    const expUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`;
    const expRes = await fetch(expUrl, { headers });
    const expData = await expRes.json();

    if (!expRes.ok) {
      return res.status(200).json({ hasExperience: false });
    }

    const moteurField = expData.fields['Moteur'];
    const moteur = typeof moteurField === 'string' ? moteurField : moteurField && moteurField.name;
    const statutField = expData.fields['Statut'];
    const statut = typeof statutField === 'string' ? statutField : statutField && statutField.name;

    // Verrouillage décidé côté serveur : tant que le statut est "En triage" ou
    // "Configuration", le plan n'est pas encore généré, le client répond au
    // questionnaire. Dès que le statut avance (typiquement "Test en cours"
    // une fois le premier cycle créé), l'expérience est verrouillée — on
    // renvoie alors les réponses déjà enregistrées pour affichage en lecture
    // seule, sans jamais dépendre du navigateur du client pour cette décision.
    const isLocked = !!statut && statut !== 'En triage' && statut !== 'Configuration';

    let planAnswers = null;
    if (isLocked) {
      const TABLE_CONFIG = 'CSR_Configuration';
      const configUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}?pageSize=100`;
      const configRes = await fetch(configUrl, { headers });
      const configData = await configRes.json();
      if (configData.records) {
        planAnswers = configData.records
          .filter((r) => Array.isArray(r.fields['Expérience']) && r.fields['Expérience'].includes(experienceRecordId))
          .map((r) => ({ etape: r.fields['Étape'], reponse: r.fields['Réponse'] }));
      }
    }

    return res.status(200).json({
      hasExperience: true,
      experienceId: experienceRecordId,
      moteur: moteur || null,
      objectif: expData.fields['Objectif'] || null,
      nomExperience: expData.fields['Nom expérience'] || null,
      statut: statut || null,
      locked: isLocked,
      planAnswers: planAnswers,
    });
  } catch (err) {
    console.error('Erreur get-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
