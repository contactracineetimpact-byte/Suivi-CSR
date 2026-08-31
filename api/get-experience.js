// api/get-experience.js
//
// NOUVEAU (25/08/2026) — Route de lecture seule. Étant donné le code d'un
// client, renvoie le moteur (ANCRAGE/RUPTURE) et l'objectif de son expérience
// active, pour que l'interface sache quel questionnaire afficher.
//
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 3 : les réponses de
// configuration (CSR_Configuration) sont désormais scopées au cycle courant
// plutôt qu'à l'expérience entière. Avant ce correctif, une expérience à
// plusieurs cycles aurait mélangé les réponses de tous ses cycles, et la
// résolution du checkinContext (findByEtape, qui prend la PREMIÈRE
// correspondance) aurait silencieusement continué à utiliser les réponses
// du cycle 1 même après la création d'un cycle 2 avec une nouvelle
// hypothèse. Compatibilité explicitement préservée pour les clients
// mono-cycle existants dont les réponses n'ont jamais eu de lien 'Cycle'
// (voir disambiguation ci-dessous) — non-régression garantie pour eux.
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
    let checkinContext = null;
    let currentCycleId = null;
    if (isLocked) {
      // MIS À JOUR (30/08/2026) — Chantier 12 : élimine le risque de
      // troncature au-delà de 100 lignes. Au lieu de récupérer la table
      // entière (CSR_Cycles / CSR_Configuration, tous clients confondus)
      // puis de filtrer côté serveur, on lit directement les listes de
      // liens déjà présentes sur l'enregistrement expData (récupéré par
      // ID juste au-dessus) — un champ d'enregistrement individuel n'est
      // jamais tronqué, quelle que soit la taille de la table. On ne
      // récupère ensuite QUE les enregistrements réellement liés à cette
      // expérience, via leurs ID exacts (RECORD_ID(), fiable — un
      // filterByFormula basé sur ARRAYJOIN d'un champ lié ne fonctionnerait
      // pas correctement : il compare des noms affichés, pas des ID).
      async function fetchByIds(table, ids) {
        if (!ids || ids.length === 0) return [];
        const formula = 'OR(' + ids.map((id) => `RECORD_ID()='${id}'`).join(',') + ')';
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
        const r = await fetch(url, { headers });
        const d = await r.json();
        return d.records || [];
      }

      const cycleIds = (expData.fields['CSR_Cycles'] || []).map((l) => l.id);
      const matchingCycles = await fetchByIds('CSR_Cycles', cycleIds);
      if (matchingCycles.length > 0) {
        matchingCycles.sort((a, b) => (b.fields['N° cycle'] || 0) - (a.fields['N° cycle'] || 0));
        currentCycleId = matchingCycles[0].id;
      }

      const configIds = (expData.fields['CSR_Configuration'] || []).map((l) => l.id);
      const allAnswersForExperience = await fetchByIds('CSR_Configuration', configIds);
      {

        // Disambiguation : si AU MOINS UNE réponse de cette expérience porte
        // déjà un lien 'Cycle', on suppose que la migration vers le modèle
        // multi-cycle est en cours pour cette expérience, et on scope
        // strictement au cycle courant (currentCycleId) — sinon les
        // anciennes réponses non liées d'un cycle 1 historique pourraient
        // se mélanger à celles d'un cycle 2 fraîchement créé.
        // Si AUCUNE réponse n'a jamais de lien 'Cycle' (expérience restée
        // entièrement legacy, mono-cycle), on garde le comportement
        // d'origine — toutes les réponses de l'expérience — pour ne jamais
        // régresser sur les clients existants.
        const hasAnyCycleLinkedAnswer = allAnswersForExperience.some(
          (r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].length > 0
        );

        let ownAnswers;
        if (hasAnyCycleLinkedAnswer && currentCycleId) {
          ownAnswers = allAnswersForExperience.filter(
            (r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].includes(currentCycleId)
          );
        } else {
          ownAnswers = allAnswersForExperience;
        }

        planAnswers = ownAnswers.map((r) => ({ etape: r.fields['Étape'], reponse: r.fields['Réponse'] }));

        // NOUVEAU (26/08/2026) — Résout le contexte personnalisé du check-in
        // quotidien à partir des réponses réelles du client, pour que
        // l'interface n'ait jamais à deviner le mapping elle-même.
        const findByEtape = (predicate) => {
          const match = ownAnswers.find((r) => predicate(r.fields['Étape'] || ''));
          return match ? match.fields['Réponse'] : null;
        };

        if (moteur === 'ANCRAGE') {
          checkinContext = {
            signal: findByEtape((e) => e.startsWith('C —') || e.startsWith('C -')),
            action: findByEtape((e) => e.includes('Agir')),
            preuve: findByEtape((e) => e.includes('Garder la preuve')),
          };
        } else if (moteur === 'RUPTURE') {
          checkinContext = {
            signal: findByEtape((e) => e.includes('Percevoir le signal') && e.includes('émotion')),
            ancienComportement: findByEtape((e) => e.includes('Percevoir le signal') && e.includes('automatisme')),
            alternative: findByEtape((e) => e.includes('Transformer la réponse')),
            preuve: findByEtape((e) => e.includes('Relever la preuve')),
          };
        }
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
      currentCycleId: currentCycleId,
      planAnswers: planAnswers,
      checkinContext: checkinContext,
    });
  } catch (err) {
    console.error('Erreur get-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
