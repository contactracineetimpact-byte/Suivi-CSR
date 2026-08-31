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
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 1/3 :
//   - N° cycle et Nom du cycle sont désormais calculés côté serveur à la
//     création (jamais fournis par le client, même si envoyés — ignorés).
//     La recherche par nom exact a été retirée : elle pouvait faire
//     correspondre par erreur un nouveau cycle à un ancien du même nom et
//     écraser ses données. Sans cette recherche, la création ne peut plus
//     jamais cibler un enregistrement existant par accident.
//   - Le verrouillage de l'expérience (Configuration -> Active) ne se
//     déclenche désormais que si c'était réellement le tout premier cycle
//     de cette expérience (compteur de cycles existants à zéro avant cette
//     création) — pas simplement "aucun cycleId fourni", qui serait vrai
//     pour chaque nouveau cycle, pas seulement le premier.
//   - Une soumission de bilan dont decisionSuivante === 'Suspendre' fait
//     passer l'expérience liée au statut 'En pause' (jamais 'Abandonné').
//
// Corps attendu (POST), tous les champs de mesure sont optionnels :
//   { code, cycleId?, dateDebut, dateFin,
//     actionsPrevues, facilite, identite, alignement, resultatObserve,
//     decisionSuivante, realiteObservee, resultat,
//     facteurFaciliteDifficulte, comportementIdentitaireObserve,
//     justificationAlignement, apprentissage }
// nomCycle/numeroCycle ne sont plus lus depuis le corps de la requête : ils
// sont toujours calculés par le serveur à la création.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const {
      code,
      cycleId,
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
    //    directement. On vérifie quand même que ce cycle appartient bien à
    //    l'expérience active du client, pour ne jamais laisser une requête
    //    modifier le cycle d'un autre client par erreur ou par ID deviné.
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
    }

    // 2bis. Si aucun cycleId n'est fourni, c'est une création : on calcule
    //    N° cycle / Nom du cycle côté serveur, jamais depuis le corps de la
    //    requête. On récupère pour cela tous les cycles déjà liés à cette
    //    expérience — le compteur obtenu ici sert aussi, plus bas, à savoir
    //    si c'est réellement le premier cycle de l'expérience (et donc s'il
    //    faut déclencher le verrouillage Configuration -> Active).
    let numeroCycleCalcule = null;
    let nomCycleCalcule = null;
    let isFirstCycleOfExperience = false;

    if (!existingCycleId) {
      // MIS À JOUR (30/08/2026) — Chantier 12 : élimine le risque de
      // troncature au-delà de 100 lignes sur cette logique critique (un
      // mauvais calcul de numérotation pourrait écraser un cycle
      // existant). On lit la liste des cycles liés directement sur
      // l'enregistrement de l'expérience (jamais tronquée, quelle que
      // soit la taille globale de CSR_Cycles), puis on récupère
      // précisément ces enregistrements par leur ID — voir
      // get-experience.js pour l'explication complète de la technique.
      const TABLE_EXPERIENCES = 'CSR_Expériences';
      const expUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`;
      const expRes = await fetch(expUrl, { headers });
      const expData = await expRes.json();
      const cyclesIds = (expData.fields && expData.fields['CSR_Cycles']) ? expData.fields['CSR_Cycles'] : [];

      // MIS À JOUR (30/08/2026) — Chantier 12, corrigé le jour même : la
      // première version utilisait filterByFormula=OR(RECORD_ID()=...),
      // qui s'est révélée ne pas fonctionner en production. Remplacé par
      // une récupération individuelle de chaque cycle par son URL directe
      // — voir get-experience.js pour l'explication complète. Particulièrement
      // important ici : une liste de cycles incomplète casserait le calcul
      // du prochain numéro.
      const cyclesDeCetteExperience = (
        await Promise.all(
          cyclesIds.map(async (id) => {
            const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}/${id}`, { headers });
            if (!r.ok) return null;
            return r.json();
          })
        )
      ).filter(Boolean);
      const maxNumero = cyclesDeCetteExperience.reduce(
        (max, r) => Math.max(max, r.fields['N° cycle'] || 0),
        0
      );
      numeroCycleCalcule = maxNumero + 1;
      nomCycleCalcule = 'Cycle ' + numeroCycleCalcule;
      isFirstCycleOfExperience = cyclesDeCetteExperience.length === 0;
    }

    // Ne pousser dans le payload que les champs réellement fournis (ou
    // calculés), pour ne jamais écraser une valeur déjà enregistrée avec un
    // champ vide non renseigné dans cet appel précis.
    const fields = {};
    if (!existingCycleId) {
      fields['Nom du cycle'] = nomCycleCalcule;
      fields['N° cycle'] = numeroCycleCalcule;
    }
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

    const TABLE_EXPERIENCES = 'CSR_Expériences';

    // Verrouillage côté serveur : la CRÉATION du tout premier cycle de
    // l'expérience (pas la création d'un cycle 2, 3... et pas une mise à
    // jour) fait passer l'expérience de "Configuration" à "Test en cours"
    // — c'est ce statut, lu par get-experience, qui décide si le client
    // revoit le questionnaire ou son plan verrouillé. isFirstCycleOfExperience
    // garantit que ce PATCH ne se déclenche qu'une seule fois par expérience,
    // jamais pour les cycles suivants.
    if (!existingCycleId && isFirstCycleOfExperience) {
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { Statut: 'Test en cours' } }),
      }).catch((e) => console.error('Échec verrouillage statut expérience:', e));
    }

    // NOUVEAU (30/08/2026) — Une soumission de bilan (mise à jour d'un
    // cycle existant via cycleId) dont la décision est "Suspendre" met
    // l'expérience liée en pause. C'est la SEULE des six décisions qui
    // déclenche un changement de statut automatique — toutes les autres
    // n'ont aucun effet ici, conformément au modèle validé.
    //
    // MIS À JOUR (30/08/2026) — Cette écriture est critique pour la
    // traçabilité comportementale : le cycle peut être enregistré avec
    // succès (bilan, décision) alors que le statut de l'expérience échoue
    // à se mettre à jour (ex. option de statut manquante côté Airtable).
    // On ne doit jamais répondre "success" sans distinguer ce cas — le
    // résultat de ce PATCH est donc explicitement vérifié et remonté dans
    // la réponse, jamais avalé silencieusement par un .catch().
    let statutExperienceMiseAJour = { tentee: false, succes: null, erreur: null };

    if (existingCycleId && decisionSuivante === 'Suspendre') {
      statutExperienceMiseAJour.tentee = true;
      try {
        const statutRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ fields: { Statut: 'En pause' } }),
        });
        if (statutRes.ok) {
          statutExperienceMiseAJour.succes = true;
        } else {
          const statutErrText = await statutRes.text();
          console.error('Échec passage en pause de l\'expérience:', statutErrText);
          statutExperienceMiseAJour.succes = false;
          statutExperienceMiseAJour.erreur = statutErrText;
        }
      } catch (e) {
        console.error('Erreur réseau passage en pause de l\'expérience:', e);
        statutExperienceMiseAJour.succes = false;
        statutExperienceMiseAJour.erreur = String(e);
      }
    }

    return res.status(200).json({
      success: true,
      updated: !!existingCycleId,
      cycleId: existingCycleId || opData.id,
      numeroCycle: numeroCycleCalcule,
      nomCycle: nomCycleCalcule,
      statutExperienceMiseAJour,
    });
  } catch (err) {
    console.error('Erreur save-cycle:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
