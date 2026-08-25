// api/save-cycle.js
//
// NOUVEAU (25/08/2026) — Crée ou met à jour un cycle de test (3-5 jours) dans
// CSR_Cycles, relié à l'expérience active du client. Même pattern que
// save-configuration.js : résout d'abord le client puis son expérience active.
//
// Corps attendu (POST) :
//   { code, nomCycle, numeroCycle, dateDebut, dateFin, actionsPrevues,
//     facilite, identite, alignement, resultatObserve, decisionSuivante }
//
// Tous les champs de mesure (facilite/identite/alignement) sont optionnels à
// la création du cycle — ils sont typiquement remplis à la FIN du cycle de
// test, pas au moment où le cycle démarre. Ce endpoint sert donc aux deux
// usages : créer le cycle au départ, puis le mettre à jour avec les mesures.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const {
      code,
      nomCycle,
      numeroCycle,
      dateDebut,
      dateFin,
      actionsPrevues,
      facilite,
      identite,
      alignement,
      resultatObserve,
      decisionSuivante,
    } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_CYCLES = 'CSR_Cycles';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Retrouver le client et son expérience active.
    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const experienceLinks = clientData.records[0].fields['Expérience active'];
    if (!experienceLinks || experienceLinks.length === 0) {
      return res.status(409).json({
        error: "Aucune expérience active liée à ce client.",
      });
    }

    const experienceRecordId = experienceLinks[0];

    // 2. Chercher si un cycle du même nom existe déjà pour cette expérience
    //    (permet d'appeler cette route deux fois : création puis mise à jour
    //    des mesures à la fin du cycle, sans créer de doublon).
    let existingCycleId = null;
    if (nomCycle) {
      const cycleFilter = encodeURIComponent(
        `AND({Nom du cycle}='${nomCycle}', FIND('${experienceRecordId}', ARRAYJOIN({Expérience})))`
      );
      const searchCycleUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}?filterByFormula=${cycleFilter}&maxRecords=1`;
      const searchCycleRes = await fetch(searchCycleUrl, { headers });
      const searchCycleData = await searchCycleRes.json();
      if (searchCycleData.records && searchCycleData.records.length > 0) {
        existingCycleId = searchCycleData.records[0].id;
      }
    }

    // Ne pousser dans le payload que les champs réellement fournis, pour ne
    // jamais écraser une valeur déjà enregistrée avec un champ vide non
    // renseigné dans cet appel précis.
    const fields = {};
    if (nomCycle !== undefined) fields['Nom du cycle'] = nomCycle;
    if (numeroCycle !== undefined) fields['N° cycle'] = numeroCycle;
    if (dateDebut !== undefined) fields['Date début'] = dateDebut;
    if (dateFin !== undefined) fields['Date fin'] = dateFin;
    if (actionsPrevues !== undefined) fields['Actions prévues'] = actionsPrevues;
    if (facilite !== undefined) fields['Facilité'] = facilite;
    if (identite !== undefined) fields['Identité'] = identite;
    if (alignement !== undefined) fields['Alignement perçu'] = alignement;
    if (resultatObserve !== undefined) fields['Résultat observé'] = resultatObserve;
    if (decisionSuivante !== undefined) fields['Décision suivante'] = decisionSuivante;

    if (!existingCycleId) {
      fields['Expérience'] = [experienceRecordId];
    }

    let opRes;
    if (existingCycleId) {
      opRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}/${existingCycleId}`,
        { method: 'PATCH', headers, body: JSON.stringify({ fields }) }
      );
    } else {
      opRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields }),
      });
    }

    if (!opRes.ok) {
      const errText = await opRes.text();
      console.error('Échec écriture CSR_Cycles:', errText);
      throw new Error('Échec écriture Airtable');
    }

    return res.status(200).json({ success: true, updated: !!existingCycleId });
  } catch (err) {
    console.error('Erreur save-cycle:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
