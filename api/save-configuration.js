// api/save-configuration.js
//
// NOUVEAU (25/08/2026) — Écrit une réponse à une question ANCRAGE/RUPTURE dans
// CSR_Configuration, reliée à l'expérience active du client. Suit le même
// pattern que kv-set.js (token Airtable côté serveur, recherche par Code),
// mais résout d'abord l'expérience active du client avant d'écrire.
//
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 3 : accepte un
// cycleId optionnel. S'il est fourni, la réponse est aussi reliée au cycle
// concerné (champ 'Cycle' sur CSR_Configuration) — nécessaire pour que
// get-experience.js puisse distinguer les réponses d'un cycle de celles
// d'un autre au sein de la même expérience. Si absent, comportement
// strictement identique à avant (aucune écriture sur le champ 'Cycle') —
// rétrocompatible avec les anciennes réponses du cycle 1 qui n'en ont pas.
//
// Corps attendu (POST) :
//   { code, etape, question, reponse, sousQuestionRenfort, cycleId }
//   - code                 : le code client (ex. "TEST-FRANCK")
//   - etape                : ex. "A — Ambition", "R — Un frein"
//   - question              : texte de la question posée
//   - reponse               : texte de la réponse du client
//   - sousQuestionRenfort   : booléen, optionnel (identité/déclaration/symbole)
//   - cycleId               : optionnel, ID du cycle CSR_Cycles concerné

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, etape, question, reponse, sousQuestionRenfort, cycleId } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }
    if (!etape || !question || !reponse) {
      return res.status(400).json({ error: 'Étape, question ou réponse manquante' });
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

    // 1. Retrouver le client par son Code, et son expérience active liée.
    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const experienceLinks = clientData.records[0].fields['Expérience active'];
    if (!experienceLinks || experienceLinks.length === 0) {
      // Le client n'a pas encore d'expérience ANCRAGE/RUPTURE configurée —
      // on ne peut pas écrire dans CSR_Configuration sans lien valide.
      return res.status(409).json({
        error: "Aucune expérience active liée à ce client. Configure d'abord une expérience dans CSR_Expériences avant d'envoyer des réponses.",
      });
    }

    const experienceRecordId = experienceLinks[0];

    // 1bis. Si un cycleId est fourni, vérifier qu'il appartient bien à
    //       l'expérience active du client — même garde-fou que save-cycle.js,
    //       pour ne jamais relier une réponse au cycle d'un autre client ou
    //       d'une autre expérience par erreur ou par ID deviné.
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

    // 2. Créer la ligne de réponse dans CSR_Configuration.
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

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur save-configuration:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
