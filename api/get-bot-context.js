// api/get-bot-context.js
//
// NOUVEAU (Chantier C — Bot Telegram) — Route dédiée, minimale, réservée au
// bot (score-csr). Ne remplace pas get-experience.js, pensée pour un usage
// différent : un appelant serveur, pas l'interface client.
//
// Option C validée : plutôt qu'un appel direct à get-experience.js (couplage
// réseau fragile entre deux projets Vercel distincts) ou une duplication de
// resolvePetitPas() dans le dépôt score-csr (risque de divergence entre deux
// dépôts), cette route vit dans suivi-csr et expose un contrat minimal.
//
// LIMITE ASSUMÉE, à signaler honnêtement : la résolution du petit pas actif
// ci-dessous reproduit l'algorithme déjà présent dans get-experience.js,
// mais À L'INTÉRIEUR DU MÊME DÉPÔT (suivi-csr) — ce n'est plus la
// duplication cross-repo que l'Option B posait comme problème, mais ce
// n'est pas non plus une unification complète (un module partagé unique
// importé par les deux routes). Un refactor plus poussé pourrait extraire
// cette logique dans un fichier commun ; non fait ici pour ne pas toucher à
// get-experience.js, déjà testé et stable, dans ce chantier.
//
// Sécurité : protégée par son propre secret (BOT_CONTEXT_SECRET), distinct
// de celui du bot lui-même — un appelant qui connaîtrait un secret ne doit
// pas automatiquement avoir accès à l'autre.
//
// Appel : GET /api/get-bot-context?code=TEST-FRANCK&secret=...

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  if (req.query.secret !== process.env.BOT_CONTEXT_SECRET) {
    return res.status(401).json({
      error: 'Non autorisé',
      debug_secretRecu: req.query.secret || null,
      debug_secretAttenduExiste: !!process.env.BOT_CONTEXT_SECRET,
      debug_secretAttenduLongueur: process.env.BOT_CONTEXT_SECRET ? process.env.BOT_CONTEXT_SECRET.length : 0,
    });
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
    const TABLE_CHECKINS = 'CSR_Checkins';

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
    if (!expRes.ok) {
      return res.status(200).json({ hasExperience: false });
    }
    const expData = await expRes.json();

    const moteurField = expData.fields['Moteur'];
    const moteur = typeof moteurField === 'string' ? moteurField : moteurField && moteurField.name;
    const statutField = expData.fields['Statut'];
    const statut = typeof statutField === 'string' ? statutField : statutField && statutField.name;

    const isLocked = !!statut && statut !== 'En triage' && statut !== 'Configuration';

    let petitPas = null;
    let currentCycleId = null;
    let lastCheckinDate = null;

    if (isLocked) {
      async function fetchByIds(table, ids) {
        if (!ids || ids.length === 0) return [];
        const results = await Promise.all(
          ids.map(async (id) => {
            const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}/${id}`, { headers });
            return r.ok ? r.json() : null;
          })
        );
        return results.filter(Boolean);
      }

      const cycleIds = expData.fields['CSR_Cycles'] || [];
      const matchingCycles = await fetchByIds('CSR_Cycles', cycleIds);
      if (matchingCycles.length > 0) {
        matchingCycles.sort((a, b) => (b.fields['N° cycle'] || 0) - (a.fields['N° cycle'] || 0));
        currentCycleId = matchingCycles[0].id;
      }

      const configIds = expData.fields['CSR_Configuration'] || [];
      const allAnswersForExperience = await fetchByIds('CSR_Configuration', configIds);
      const hasAnyCycleLinkedAnswer = allAnswersForExperience.some(
        (r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].length > 0
      );
      const ownAnswers = (hasAnyCycleLinkedAnswer && currentCycleId)
        ? allAnswersForExperience.filter((r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].includes(currentCycleId))
        : allAnswersForExperience;

      function resolvePetitPas(etapePredicate) {
        const lignes = ownAnswers.filter((r) => etapePredicate(r.fields['Étape'] || ''));
        if (lignes.length === 0) return null;
        const avecStatutActif = lignes.find((r) => {
          const s = r.fields['Statut du petit pas'];
          const sNom = typeof s === 'string' ? s : s && s.name;
          return sNom === 'Actif';
        });
        if (avecStatutActif) {
          return { reponse: avecStatutActif.fields['Réponse'] };
        }
        const sansStatut = lignes.filter((r) => !r.fields['Statut du petit pas']);
        if (sansStatut.length === 1) {
          return { reponse: sansStatut[0].fields['Réponse'] };
        }
        if (sansStatut.length > 1) {
          sansStatut.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
          return { reponse: sansStatut[0].fields['Réponse'] };
        }
        return null;
      }

      petitPas = moteur === 'ANCRAGE'
        ? resolvePetitPas((e) => e === 'A — Agir')
        : moteur === 'RUPTURE'
          ? resolvePetitPas((e) => e.includes("Utiliser l'alternative"))
          : null;

      // Date du dernier point du jour (CSR_Checkins) pour ce cycle — sert
      // uniquement à adapter le TON du Message 1 ("ça fait quelques jours"),
      // jamais à déduire si une action a eu lieu ou non.
      if (currentCycleId) {
        const checkinsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CHECKINS}?pageSize=100`;
        const checkinsRes = await fetch(checkinsUrl, { headers });
        if (checkinsRes.ok) {
          const checkinsData = await checkinsRes.json();
          const cycleCheckins = (checkinsData.records || []).filter(
            (r) => Array.isArray(r.fields['Cycle']) && r.fields['Cycle'].includes(currentCycleId)
          );
          if (cycleCheckins.length > 0) {
            cycleCheckins.sort((a, b) => new Date(b.fields['Horodatage'] || 0) - new Date(a.fields['Horodatage'] || 0));
            lastCheckinDate = (cycleCheckins[0].fields['Horodatage'] || '').slice(0, 10) || null;
          }
        }
      }
    }

    return res.status(200).json({
      hasExperience: true,
      moteur: moteur || null,
      statut: statut || null,
      locked: isLocked,
      petitPas: petitPas,
      lastCheckinDate: lastCheckinDate,
    });
  } catch (err) {
    console.error('Erreur get-bot-context:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
