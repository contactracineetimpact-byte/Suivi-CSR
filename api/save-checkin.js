// api/save-checkin.js
//
// NOUVEAU (26/08/2026) — Écrit un check-in comportemental quotidien dans
// CSR_Checkins, relié à l'expérience active du client ET à son cycle en
// cours. Autorise plusieurs check-ins par jour (une émotion/signal peut
// apparaître plusieurs fois), mais protège contre le double-clic accidentel
// via une confirmation explicite si une entrée existe déjà aujourd'hui.
//
// Corps attendu (POST) :
//   { code, signal ('Oui'/'Non'), actionRealisee (ANCRAGE, 'Oui'/'Partiellement'/'Non'),
//     interceptionReussie (RUPTURE, 'Oui'/'Non'), retourAncien (bool),
//     cequiSestPasseAvant (texte), obstacle (une des 5 options), noteComplementaire (texte),
//     confirmDuplicate (bool, optionnel) }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const {
      code,
      signal,
      actionRealisee,
      interceptionReussie,
      retourAncien,
      cequiSestPasseAvant,
      obstacle,
      noteComplementaire,
      confirmDuplicate,
    } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';
    const TABLE_CYCLES = 'CSR_Cycles';
    const TABLE_CHECKINS = 'CSR_Checkins';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Client → expérience active.
    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const experienceLinks = clientData.records[0].fields['Expérience active'];
    if (!experienceLinks || experienceLinks.length === 0) {
      return res.status(409).json({ error: "Aucune expérience active liée à ce client." });
    }
    const experienceRecordId = experienceLinks[0];

    const expUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`;
    const expRes = await fetch(expUrl, { headers });
    const expData = await expRes.json();
    const moteurField = expData.fields['Moteur'];
    const moteur = typeof moteurField === 'string' ? moteurField : moteurField && moteurField.name;

    // MIS À JOUR (30/08/2026) — Chantier 12 : élimine le risque de
    // troncature au-delà de 100 lignes — voir get-experience.js pour
    // l'explication complète de la technique (listes de liens déjà
    // présentes sur expData, jamais tronquées, puis récupération ciblée
    // par RECORD_ID()).
    // MIS À JOUR (30/08/2026) — Chantier 12, corrigé le jour même : la
    // première version utilisait filterByFormula=OR(RECORD_ID()=...), qui
    // s'est révélée ne pas fonctionner en production. Remplacé par une
    // récupération individuelle de chaque enregistrement par son URL
    // directe — voir get-experience.js pour l'explication complète.
    async function fetchByIds(table, ids) {
      if (!ids || ids.length === 0) return [];
      const results = await Promise.all(
        ids.map(async (id) => {
          const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${id}`, { headers });
          if (!r.ok) return null;
          return r.json();
        })
      );
      return results.filter(Boolean);
    }

    // 2. Résoudre le cycle en cours (le plus récent de cette expérience).
    const cyclesIds = expData.fields['CSR_Cycles'] || [];
    const matchingCycles = await fetchByIds('CSR_Cycles', cyclesIds);
    if (matchingCycles.length === 0) {
      return res.status(409).json({ error: "Aucun cycle en cours pour cette expérience." });
    }
    matchingCycles.sort((a, b) => (b.fields['N° cycle'] || 0) - (a.fields['N° cycle'] || 0));
    const cycleRecordId = matchingCycles[0].id;

    // 3. Anti-doublon accidentel : si une entrée existe déjà aujourd'hui pour
    //    cette expérience et que le client n'a pas explicitement confirmé
    //    vouloir en ajouter une seconde, on prévient plutôt que d'écrire.
    const todayStr = new Date().toISOString().slice(0, 10);
    if (!confirmDuplicate) {
      const checkinsIds = expData.fields['CSR_Checkins'] || [];
      const checkinsData = { records: await fetchByIds('CSR_Checkins', checkinsIds) };
      const todayEntries = (checkinsData.records || []).filter((r) => {
        const links = r.fields['Expérience'];
        const horodatage = r.fields['Horodatage'];
        return (
          Array.isArray(links) &&
          links.includes(experienceRecordId) &&
          horodatage &&
          horodatage.slice(0, 10) === todayStr
        );
      });
      if (todayEntries.length > 0) {
        return res.status(409).json({
          alreadyCheckedInToday: true,
          count: todayEntries.length,
          error: "Un check-in existe déjà aujourd'hui pour cette expérience. Renvoie la requête avec confirmDuplicate:true pour en ajouter un second.",
        });
      }
    }

    // 4. Construire les champs selon le moteur.
    const fields = {
      Expérience: [experienceRecordId],
      Cycle: [cycleRecordId],
      Horodatage: new Date().toISOString(),
    };
    if (signal !== undefined) fields['Signal émotionnel apparu'] = signal;
    if (moteur === 'ANCRAGE' && actionRealisee !== undefined) fields['Action réalisée'] = actionRealisee;
    if (moteur === 'RUPTURE' && interceptionReussie !== undefined) fields['Interception réussie'] = interceptionReussie;
    if (retourAncien !== undefined) fields['Retour à l\'ancien comportement'] = !!retourAncien;
    if (cequiSestPasseAvant !== undefined) fields['Ce qui s\'est passé juste avant'] = cequiSestPasseAvant;
    if (obstacle !== undefined) fields['Obstacle'] = obstacle;
    if (noteComplementaire !== undefined) fields['Note complémentaire'] = noteComplementaire;

    const createRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CHECKINS}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('Échec création CSR_Checkins:', errText);
      throw new Error('Échec écriture Airtable');
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur save-checkin:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
