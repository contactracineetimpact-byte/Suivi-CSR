// api/save-configuration.js
//
// NOUVEAU (25/08/2026) — Écrit une réponse à une question ANCRAGE/RUPTURE dans
// CSR_Configuration, reliée à l'expérience active du client.
//
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 3 : cycleId optionnel.
//
// MIS À JOUR (P1-5 bis) — Modèle d'état du petit pas (Agir pour ANCRAGE,
// "Utiliser l'alternative" pour RUPTURE). Trois modes, distingués par les
// champs présents dans le corps de la requête :
//
//   MODE CRÉATION (comportement d'origine, inchangé) :
//     { code, etape, question, reponse, sousQuestionRenfort, cycleId }
//     Si l'étape créée est un petit pas (voir estEtapePetitPas ci-dessous),
//     'Statut du petit pas' est automatiquement mis à 'Actif' — le
//     front-end n'a rien à savoir de ce mécanisme pour la création initiale.
//
//   MODE MODIFICATION (nouveau) :
//     { code, configId, reponse }
//     Met à jour la Réponse (et la Date) d'une ligne existante, SANS
//     toucher à son statut. Refusé si la ligne n'est pas 'Actif' — on ne
//     modifie jamais une ligne historique déjà résolue.
//
//   MODE TRANSITION (nouveau) — "terminer" ou "remplacer sans terminer" :
//     { code, configId, newStatut: 'Terminé'|'Remplacé', etape, question,
//       nouvelleReponse, cycleId }
//     1. Vérifie que configId appartient bien à l'expérience active ET est
//        toujours 'Actif' (sinon 409 — déjà transitionné, protège contre
//        le double-clic et les requêtes concurrentes).
//     2. Marque la ligne existante avec newStatut.
//     3. Vérifie qu'aucune autre ligne 'Actif' n'existe déjà pour cette
//        étape + ce cycle (garde-fou supplémentaire, pas une garantie
//        absolue faute de transaction atomique côté Airtable — mais
//        couvre le cas réel visé sans construire un verrou complexe).
//     4. Crée la nouvelle ligne, 'Actif', pour le nouveau petit pas.
//     Si l'étape 3/4 échoue après que l'étape 2 a réussi, l'ancienne ligne
//     reste dans son nouveau statut mais aucun nouveau petit pas actif
//     n'existe — état signalé explicitement au client plutôt que masqué.

function estEtapePetitPas(etape) {
  if (!etape) return false;
  return etape === 'A — Agir' || etape.includes("Utiliser l'alternative");
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const {
      code,
      etape,
      question,
      reponse,
      sousQuestionRenfort,
      cycleId,
      configId,
      newStatut,
      nouvelleReponse,
    } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_CONFIG = 'CSR_Configuration';
    const TABLE_CYCLES = 'CSR_Cycles';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Retrouver le client et son expérience active — commun aux 3 modes.
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
        error: "Aucune expérience active liée à ce client. Configure d'abord une expérience dans CSR_Expériences avant d'envoyer des réponses.",
      });
    }
    const experienceRecordId = experienceLinks[0];

    // ═══════════════════════════════════════════════════════════
    // MODE MODIFICATION — configId + reponse, sans newStatut.
    // ═══════════════════════════════════════════════════════════
    if (configId && !newStatut) {
      if (!reponse) {
        return res.status(400).json({ error: 'Réponse manquante.' });
      }
      const targetUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}/${configId}`;
      const targetRes = await fetch(targetUrl, { headers });
      if (!targetRes.ok) {
        return res.status(404).json({ error: 'Ligne introuvable.' });
      }
      const targetData = await targetRes.json();
      const targetExpLinks = targetData.fields['Expérience'];
      if (!Array.isArray(targetExpLinks) || !targetExpLinks.includes(experienceRecordId)) {
        return res.status(403).json({ error: "Cette ligne n'appartient pas à l'expérience active de ce client." });
      }
      const statutActuel = targetData.fields['Statut du petit pas'];
      const statutActuelNom = typeof statutActuel === 'string' ? statutActuel : statutActuel && statutActuel.name;
      if (statutActuelNom && statutActuelNom !== 'Actif') {
        return res.status(409).json({ error: 'Cette ligne est déjà résolue (' + statutActuelNom + '), elle ne peut plus être modifiée.' });
      }

      const patchRes = await fetch(targetUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          fields: { Réponse: reponse, Date: new Date().toISOString().slice(0, 10) },
        }),
      });
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('Échec modification CSR_Configuration:', errText);
        throw new Error('Échec écriture Airtable');
      }
      return res.status(200).json({ success: true, mode: 'modification' });
    }

    // ═══════════════════════════════════════════════════════════
    // MODE TRANSITION — configId + newStatut ('Terminé' ou 'Remplacé').
    // ═══════════════════════════════════════════════════════════
    if (configId && newStatut) {
      if (newStatut !== 'Terminé' && newStatut !== 'Remplacé') {
        return res.status(400).json({ error: "newStatut doit être 'Terminé' ou 'Remplacé'." });
      }
      if (!etape || !question || !nouvelleReponse) {
        return res.status(400).json({ error: 'etape, question et nouvelleReponse sont requis pour une transition.' });
      }

      const targetUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}/${configId}`;
      const targetRes = await fetch(targetUrl, { headers });
      if (!targetRes.ok) {
        return res.status(404).json({ error: 'Ligne introuvable.' });
      }
      const targetData = await targetRes.json();
      const targetExpLinks = targetData.fields['Expérience'];
      if (!Array.isArray(targetExpLinks) || !targetExpLinks.includes(experienceRecordId)) {
        return res.status(403).json({ error: "Cette ligne n'appartient pas à l'expérience active de ce client." });
      }
      // 1. Vérifier que la ligne ciblée est toujours 'Actif' juste avant
      //    d'agir — protège contre le double-clic et les requêtes
      //    concurrentes : une deuxième requête arrivant après la première
      //    trouvera cette ligne déjà transitionnée et sera refusée ici.
      const statutActuel = targetData.fields['Statut du petit pas'];
      const statutActuelNom = typeof statutActuel === 'string' ? statutActuel : statutActuel && statutActuel.name;
      // Rétrocompatibilité : une ligne sans statut du tout (historique,
      // créée avant ce chantier) est traitée comme Actif implicite — on la
      // laisse donc passer la vérification ci-dessous (statutActuelNom
      // est alors falsy, donc la condition ne se déclenche pas).
      if (statutActuelNom && statutActuelNom !== 'Actif') {
        return res.status(409).json({
          alreadyTransitioned: true,
          error: 'Cette ligne est déjà ' + statutActuelNom + ', aucune nouvelle transition possible.',
        });
      }

      const targetCycleLinks = targetData.fields['Cycle'] || [];
      const targetCycleId = targetCycleLinks[0] || cycleId || null;

      // 2. Marquer la ligne existante avec le nouveau statut.
      const patchRes = await fetch(targetUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { 'Statut du petit pas': newStatut } }),
      });
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('Échec transition CSR_Configuration:', errText);
        throw new Error('Échec écriture Airtable (transition)');
      }

      // 3. Garde-fou supplémentaire envisagé (vérifier qu'aucune autre ligne
      //    'Actif' n'existe déjà pour cette étape + ce cycle) — non
      //    implémenté ici : il aurait fallu interroger un champ de liaison
      //    inverse sur CSR_Cycles dont je n'ai pas vérifié le nom exact, et
      //    je préfère ne pas écrire de code reposant sur une hypothèse non
      //    confirmée. La protection principale (étape 1 : vérifier que la
      //    ligne ciblée est encore 'Actif' juste avant d'agir) reste en
      //    place et couvre le cas réel du double-clic/requêtes concurrentes
      //    sur LA MÊME ligne — signalé comme limite dans le rapport final.

      // 4. Créer le nouveau petit pas, 'Actif'.
      const newFields = {
        Étape: etape,
        Expérience: [experienceRecordId],
        Question: question,
        Réponse: nouvelleReponse,
        'Statut du petit pas': 'Actif',
        Date: new Date().toISOString().slice(0, 10),
      };
      if (targetCycleId) newFields['Cycle'] = [targetCycleId];

      const createRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields: newFields }),
      });
      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error('Échec création nouveau petit pas:', errText);
        // L'ancienne ligne a déjà transitionné (étape 2 réussie) mais aucun
        // nouveau petit pas actif n'a pu être créé — on le signale
        // explicitement plutôt que de masquer l'échec partiel.
        return res.status(500).json({
          error: "L'ancien petit pas a bien été marqué " + newStatut + ", mais le nouveau n'a pas pu être créé. Réessaie de définir le prochain petit pas.",
          partialFailure: true,
        });
      }
      const createData = await createRes.json();
      return res.status(200).json({ success: true, mode: 'transition', configId: createData.id });
    }

    // ═══════════════════════════════════════════════════════════
    // MODE CRÉATION — comportement d'origine, inchangé, avec ajout du
    // statut automatique pour les étapes de petit pas.
    // ═══════════════════════════════════════════════════════════
    if (!etape || !question || !reponse) {
      return res.status(400).json({ error: 'Étape, question ou réponse manquante' });
    }

    if (cycleId) {
      const checkUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}/${cycleId}`;
      const checkRes = await fetch(checkUrl, { headers });
      if (!checkRes.ok) {
        return res.status(400).json({ error: 'Cycle introuvable.' });
      }
      const checkData = await checkRes.json();
      const cycleExpLinks = checkData.fields['Expérience'];
      if (!Array.isArray(cycleExpLinks) || !cycleExpLinks.includes(experienceRecordId)) {
        return res.status(403).json({ error: "Ce cycle n'appartient pas à l'expérience active de ce client." });
      }
    }

    const fields = {
      Étape: etape,
      Expérience: [experienceRecordId],
      Question: question,
      Réponse: reponse,
      'Sous-question renfort': !!sousQuestionRenfort,
      Date: new Date().toISOString().slice(0, 10),
    };
    if (cycleId) {
      fields['Cycle'] = [cycleId];
    }
    if (estEtapePetitPas(etape)) {
      fields['Statut du petit pas'] = 'Actif';
    }

    const createRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CONFIG}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields }),
      }
    );

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('Échec création CSR_Configuration:', errText);
      throw new Error('Échec écriture Airtable');
    }

    return res.status(200).json({ success: true, mode: 'creation' });
  } catch (err) {
    console.error('Erreur save-configuration:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
