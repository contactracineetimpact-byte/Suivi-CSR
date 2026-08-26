// api/get-cycle-summary.js
//
// NOUVEAU (26/08/2026) — Route de lecture seule. Étant donné le code d'un
// client, renvoie l'expérience active et son cycle le plus récent, pour
// afficher l'écran d'introduction du bilan de fin de cycle (nom de
// l'expérience, moteur, durée, dates).
//
// Appel : GET /api/get-cycle-summary?code=TEST-FRANCK

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
    const TABLE_CYCLES = 'CSR_Cycles';

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
      return res.status(200).json({ hasCycle: false });
    }

    const experienceRecordId = experienceLinks[0];
    const expUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`;
    const expRes = await fetch(expUrl, { headers });
    const expData = await expRes.json();

    if (!expRes.ok) {
      return res.status(200).json({ hasCycle: false });
    }

    const moteurField = expData.fields['Moteur'];
    const moteur = typeof moteurField === 'string' ? moteurField : moteurField && moteurField.name;
    const nomExperience = expData.fields['Nom expérience'] || null;

    // Cherche les cycles liés à cette expérience, garde le plus récent
    // (le plus grand "N° cycle" — pas de tri natif nécessaire côté Airtable
    // pour un si petit volume par client).
    const cyclesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}?pageSize=100`;
    const cyclesRes = await fetch(cyclesUrl, { headers });
    const cyclesData = await cyclesRes.json();

    const matching = (cyclesData.records || []).filter(
      (r) => Array.isArray(r.fields['Expérience']) && r.fields['Expérience'].includes(experienceRecordId)
    );

    if (matching.length === 0) {
      return res.status(200).json({ hasCycle: false, moteur, nomExperience, experienceId: experienceRecordId });
    }

    matching.sort((a, b) => (b.fields['N° cycle'] || 0) - (a.fields['N° cycle'] || 0));
    const latest = matching[0];

    // Un cycle est considéré "déjà évalué" si le champ Décision suivante a
    // été rempli — c'est ce qui signe la fin du bilan.
    const decisionField = latest.fields['Décision suivante'];
    const alreadyEvaluated = !!decisionField;

    return res.status(200).json({
      hasCycle: true,
      cycleId: latest.id,
      nomCycle: latest.fields['Nom du cycle'] || null,
      numeroCycle: latest.fields['N° cycle'] || null,
      dateDebut: latest.fields['Date début'] || null,
      dateFin: latest.fields['Date fin'] || null,
      actionsPrevues: latest.fields['Actions prévues'] || null,
      alreadyEvaluated,
      moteur,
      nomExperience,
      experienceId: experienceRecordId,
      bilan: alreadyEvaluated
        ? {
            realiteObservee: latest.fields['Réalité observée'] || null,
            resultat: latest.fields['Résultat'] || null,
            resultatObserve: latest.fields['Résultat observé'] || null,
            facilite: latest.fields['Facilité'] || null,
            facteurFaciliteDifficulte:
              (latest.fields['Facteur facilité/difficulté'] && latest.fields['Facteur facilité/difficulté'].name) || null,
            identite: latest.fields['Identité'] || null,
            comportementIdentitaireObserve: latest.fields['Comportement identitaire observé'] || null,
            alignement: latest.fields['Alignement perçu'] || null,
            justificationAlignement: latest.fields['Justification alignement'] || null,
            apprentissage: latest.fields['Apprentissage'] || null,
            decisionSuivante: (decisionField && decisionField.name) || null,
          }
        : null,
    });
  } catch (err) {
    console.error('Erreur get-cycle-summary:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
