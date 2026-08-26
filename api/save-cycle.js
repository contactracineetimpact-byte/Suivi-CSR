// api/save-cycle.js
//
// NOUVEAU (25/08/2026) — Crée ou met à jour un cycle de test (3-5 jours) dans
// CSR_Cycles, relié à l'expérience active du client.
//
// MIS À JOUR (26/08/2026) — Ajout des champs du bilan de fin de cycle
// (Réalité observée, Résultat, Facteur facilité/difficulté, Comportement
// identitaire observé, Justification alignement, Apprentissage), et support
// d'un ciblage direct par cycleId (utilisé par l'écran de bilan, qui connaît
// déjà l'ID exact du cycle via get-cycle-summary — plus fiable que la
// recherche par nom pour une mise à jour de fin de cycle).
//
// Corps attendu (POST), tous les champs de mesure sont optionnels :
//   { code, cycleId?, nomCycle, numeroCycle, dateDebut, dateFin,
//     actionsPrevues, facilite, identite, alignement, resultatObserve,
//     decisionSuivante, realiteObservee, resultat,
//     facteurFaciliteDifficulte, comportementIdentitaireObserve,
//     justificationAlignement, apprentissage }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const {
      code,
      cycleId,
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
      realiteObservee,
      resultat,
      facteurFaciliteDifficulte,
      comportementIdentitaireObserve,
      justificationAlignement,
      apprentissage,
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

    // 2. Cible du cycle : si cycleId est fourni explicitement (cas du bilan
    //    de fin de cycle, qui connaît déjà l'ID exact), on l'utilise
    //    directement — plus fiable qu'une recherche par nom. On vérifie
    //    quand même que ce cycle appartient bien à l'expérience active du
    //    client, pour ne jamais laisser une requête modifier le cycle d'un
    //    autre client par erreur ou par ID deviné.
    let existingCycleId = null;

    if (cycleId) {
      const checkUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}/${cycleId}`;
      const checkRes = await fetch(checkUrl, { headers });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const links = checkData.fields['Expérience'];
        if (Array.isArray(links) && links.includes(experienceRecordId)) {
          existingCycleId = cycleId;
        } else {
          return res.status(403).json({ error: "Ce cycle n'appartient pas à l'expérience active de ce client." });
        }
      }
    } else if (nomCycle) {
      // Recherche par nom uniquement quand aucun cycleId n'est fourni
      // (cas de la création initiale du cycle depuis le questionnaire).
      const cycleFilter = encodeURIComponent(`{Nom du cycle}='${nomCycle}'`);
      const searchCycleUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}?filterByFormula=${cycleFilter}&returnFieldsByFieldId=false`;
      const searchCycleRes = await fetch(searchCycleUrl, { headers });
      const searchCycleData = await searchCycleRes.json();
      if (searchCycleData.records && searchCycleData.records.length > 0) {
        const match = searchCycleData.records.find((r) => {
          const links = r.fields['Expérience'];
          return Array.isArray(links) && links.includes(experienceRecordId);
        });
        if (match) existingCycleId = match.id;
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
    if (realiteObservee !== undefined) fields['Réalité observée'] = realiteObservee;
    if (resultat !== undefined) fields['Résultat'] = resultat;
    if (facteurFaciliteDifficulte !== undefined) fields['Facteur facilité/difficulté'] = facteurFaciliteDifficulte;
    if (comportementIdentitaireObserve !== undefined) fields['Comportement identitaire observé'] = comportementIdentitaireObserve;
    if (justificationAlignement !== undefined) fields['Justification alignement'] = justificationAlignement;
    if (apprentissage !== undefined) fields['Apprentissage'] = apprentissage;

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

    const opData = await opRes.json();

    // Verrouillage côté serveur : la CRÉATION du premier cycle (pas sa mise à
    // jour ultérieure) fait passer l'expérience de "Configuration" à "Test en
    // cours" — c'est ce statut, lu par get-experience, qui décide si le
    // client revoit le questionnaire ou son plan verrouillé.
    if (!existingCycleId) {
      const TABLE_EXPERIENCES = 'CSR_Expériences';
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { Statut: 'Test en cours' } }),
      }).catch((e) => console.error('Échec verrouillage statut expérience:', e));
    }

    return res.status(200).json({ success: true, updated: !!existingCycleId, cycleId: existingCycleId || opData.id });
  } catch (err) {
    console.error('Erreur save-cycle:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
