// api/get-cycle-summary.js
//
// NOUVEAU (26/08/2026) — Route de lecture seule. Étant donné le code d'un
// client, renvoie l'expérience active et son cycle le plus récent, pour
// afficher l'écran d'introduction du bilan de fin de cycle (nom de
// l'expérience, moteur, durée, dates).
//
// MIS À JOUR (30/08/2026) — Chantier 5 (Progression 60 jours) : la réponse
// inclut désormais aussi `cycles`, un résumé léger de TOUS les cycles de
// l'expérience active (pas seulement le plus récent). Ces données étaient
// déjà entièrement récupérées en mémoire (`matching`, ci-dessous) pour en
// extraire le dernier — aucun appel Airtable supplémentaire. Purement
// additif : aucun champ existant retiré ni modifié, la réponse reste
// rétrocompatible avec l'écran de bilan qui consomme déjà cette route.
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

    // NOUVEAU (30/08/2026) — Résumé léger de tous les cycles, du plus
    // ancien au plus récent (ordre naturel de lecture d'une timeline).
    // Réutilise `matching`, déjà entièrement chargé ci-dessus.
    function extractSelectNameLight(field) {
      if (!field) return null;
      if (typeof field === 'string') return field;
      if (typeof field === 'object' && field.name) return field.name;
      return null;
    }
    const cycles = matching
      .slice()
      .sort((a, b) => (a.fields['N° cycle'] || 0) - (b.fields['N° cycle'] || 0))
      .map((c) => {
        const decision = extractSelectNameLight(c.fields['Décision suivante']);
        return {
          cycleId: c.id,
          nomCycle: c.fields['Nom du cycle'] || null,
          numeroCycle: c.fields['N° cycle'] || null,
          dateDebut: c.fields['Date début'] || null,
          dateFin: c.fields['Date fin'] || null,
          actionsPrevues: c.fields['Actions prévues'] || null,
          alreadyEvaluated: !!decision,
          apprentissage: c.fields['Apprentissage'] || null,
          decisionSuivante: decision,
        };
      });

    // NOUVEAU (30/08/2026) — Chantier 8 : « Ce qui a changé ». Compare la
    // première et la dernière réponse du client sur exactement 2 questions
    // stables (objectif + action), identiques d'un cycle à l'autre pour un
    // même moteur (libellés en dur dans QUESTIONS_ANCRAGE/RUPTURE côté
    // client — vérifiés stables avant d'écrire ce code). Aucune
    // interprétation : on affiche seulement si les deux réponses existent,
    // proviennent bien de deux cycles distincts, et diffèrent textuellement.
    let evolutions = [];
    if (cycles.length >= 2) {
      const ETAPES_COMPARABLES =
        moteur === 'ANCRAGE'
          ? [{ etape: 'A — Ambition', label: 'objectif' }, { etape: 'A — Agir', label: 'action' }]
          : moteur === 'RUPTURE'
          ? [{ etape: 'R — Résultat recherché', label: 'objectif' }, { etape: 'U — Utiliser l\'alternative', label: 'action' }]
          : [];

      if (ETAPES_COMPARABLES.length > 0) {
        const premierCycleId = cycles[0].cycleId;
        const dernierCycleId = cycles[cycles.length - 1].cycleId;

        const TABLE_CONFIG = 'CSR_Configuration';
        const configUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}?pageSize=100`;
        const configRes = await fetch(configUrl, { headers });
        const configData = await configRes.json();
        const configRecords = (configData.records || []).filter(
          (r) => Array.isArray(r.fields['Expérience']) && r.fields['Expérience'].includes(experienceRecordId)
        );

        const findReponse = (etape, cycleId) => {
          const rec = configRecords.find(
            (r) => r.fields['Étape'] === etape && Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].includes(cycleId)
          );
          return rec ? { reponse: rec.fields['Réponse'] || null, question: rec.fields['Question'] || null } : null;
        };

        evolutions = ETAPES_COMPARABLES.map(({ etape, label }) => {
          const premiere = findReponse(etape, premierCycleId);
          const derniere = findReponse(etape, dernierCycleId);
          if (!premiere || !derniere || !premiere.reponse || !derniere.reponse) return null;
          if (premiere.reponse.trim() === derniere.reponse.trim()) return null; // pas de fausse évolution
          return {
            label,
            question: derniere.question || premiere.question || null,
            premiereCycleLabel: cycles[0].nomCycle,
            premiereReponse: premiere.reponse,
            derniereCycleLabel: cycles[cycles.length - 1].nomCycle,
            derniereReponse: derniere.reponse,
          };
        }).filter(Boolean);
      }
    }


    // Extraction défensive : un champ singleSelect renvoie normalement un
    // objet {id, color, name}, mais on tolère aussi une chaîne brute pour
    // ne jamais planter sur un format inattendu.
    function extractSelectName(field) {
      if (!field) return null;
      if (typeof field === 'string') return field;
      if (typeof field === 'object' && field.name) return field.name;
      return null;
    }
    const decisionName = extractSelectName(latest.fields['Décision suivante']);
    const alreadyEvaluated = !!decisionName;

    // NOUVEAU (27/08/2026) — Calcul du taux spécifique au moteur, à partir
    // des vraies données de CSR_Checkins pour CE cycle précis. Le client n'a
    // jamais à faire ce calcul lui-même. Si aucun point du jour n'existe
    // encore pour ce cycle, l'indicateur reste absent plutôt que simulé.
    const TABLE_CHECKINS = 'CSR_Checkins';
    const checkinsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CHECKINS}?pageSize=100`;
    const checkinsRes = await fetch(checkinsUrl, { headers });
    const checkinsData = await checkinsRes.json();
    const cycleCheckins = (checkinsData.records || []).filter(
      (r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].includes(latest.id)
    );

    let indicateur = null;
    let citations = [];
    // NOUVEAU (30/08/2026) — Chantier 7 : nombre brut d'observations
    // enregistrées pour ce cycle, distinct de "signaux identifiés"
    // (indicateur.total, qui filtre déjà sur Signal='Oui'). Donnée déjà
    // en mémoire (cycleCheckins), aucun appel supplémentaire.
    const totalObservations = cycleCheckins.length;
    if (cycleCheckins.length > 0) {
      const opportunites = cycleCheckins.filter(
        (r) => extractSelectName(r.fields['Signal émotionnel apparu']) === 'Oui'
      );

      // NOUVEAU (30/08/2026) — Chantier 7 : citations réelles du client
      // ("Ce qui s'est passé juste avant"), issues du même cycleCheckins
      // déjà chargé ci-dessus pour l'indicateur — aucun appel Airtable
      // supplémentaire. Mots du client tels quels, jamais reformulés ;
      // maximum 2, les plus récentes, uniquement si non vides.
      citations = cycleCheckins
        .filter((r) => r.fields['Ce qui s\'est passé juste avant'] && r.fields['Ce qui s\'est passé juste avant'].trim())
        .sort((a, b) => new Date(b.fields['Horodatage'] || 0) - new Date(a.fields['Horodatage'] || 0))
        .slice(0, 2)
        .map((r) => r.fields['Ce qui s\'est passé juste avant'].trim());

      // NOUVEAU (28/08/2026) — Seuil de prudence statistique. Aucun seuil
      // méthodologiquement défini n'existait ailleurs dans le code ; celui-ci
      // (5) est choisi simplement parce qu'il correspond à la durée standard
      // d'un cycle (3-5 jours) déjà utilisée partout dans la méthode — donc
      // à peu près une opportunité par jour de cycle, pas un chiffre arbitraire
      // sorti d'un calcul statistique. En dessous, on affiche un message
      // prudent plutôt qu'un pourcentage qui donnerait une fausse impression
      // de certitude sur très peu de données.
      const SEUIL_MINIMUM_OBSERVATIONS = 5;

      if (opportunites.length > 0 && opportunites.length < SEUIL_MINIMUM_OBSERVATIONS) {
        indicateur = {
          insuffisant: true,
          observations: opportunites.length,
          seuil: SEUIL_MINIMUM_OBSERVATIONS,
        };
      } else if (opportunites.length >= SEUIL_MINIMUM_OBSERVATIONS) {
        if (moteur === 'ANCRAGE') {
          const reussies = opportunites.filter((r) => extractSelectName(r.fields['Action réalisée']) === 'Oui');
          indicateur = {
            type: "Combien de fois tu as réussi",
            valeur: reussies.length,
            total: opportunites.length,
            pourcentage: Math.round((reussies.length / opportunites.length) * 100),
            avertissement: 'Ce chiffre repose sur ce que tu as toi-même rapporté — pas sur une mesure automatique de tous les moments où le signal est apparu.',
          };
        } else if (moteur === 'RUPTURE') {
          const reussies = opportunites.filter((r) => extractSelectName(r.fields['Interception réussie']) === 'Oui');
          indicateur = {
            type: "Combien de fois tu as réussi à ne pas le faire",
            valeur: reussies.length,
            total: opportunites.length,
            pourcentage: Math.round((reussies.length / opportunites.length) * 100),
            avertissement: 'Ce chiffre repose sur ce que tu as toi-même rapporté — pas sur une mesure automatique de tous les moments où le signal est apparu.',
          };
        }
      }
    }

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
      indicateur,
      citations,
      totalObservations,
      evolutions,
      cycles,
      bilan: alreadyEvaluated
        ? {
            realiteObservee: latest.fields['Réalité observée'] || null,
            resultat: latest.fields['Résultat'] || null,
            resultatObserve: latest.fields['Résultat observé'] || null,
            facilite: latest.fields['Facilité'] || null,
            facteurFaciliteDifficulte: extractSelectName(latest.fields['Facteur facilité/difficulté']),
            identite: latest.fields['Identité'] || null,
            comportementIdentitaireObserve: latest.fields['Comportement identitaire observé'] || null,
            alignement: latest.fields['Alignement perçu'] || null,
            justificationAlignement: latest.fields['Justification alignement'] || null,
            apprentissage: latest.fields['Apprentissage'] || null,
            decisionSuivante: decisionName,
          }
        : null,
    });
  } catch (err) {
    console.error('Erreur get-cycle-summary:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
