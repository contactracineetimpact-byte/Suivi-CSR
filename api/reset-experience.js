// api/reset-experience.js
//
// NOUVEAU (25/08/2026) — Action admin, réservée à Franck (protégée par un
// secret, même principe que send-checkins). Archive l'expérience active
// d'un client (Statut -> "Abandonné") et retire le lien "Expérience active"
// sur sa fiche, pour lui permettre de choisir un nouveau moteur.
//
// MIS À JOUR (Chantier "Réinitialiser une expérience") — Deux modes,
// UNE SEULE logique serveur :
//
//   MODE ADMIN : { code, secret } avec secret === RESET_EXPERIENCE_SECRET
//   (comportement historique, conservé pour l'usage PowerShell existant).
//
//   MODE CLIENT : { code } sans secret, ou avec un secret absent — même
//   mécanisme d'authentification que toutes les autres routes déjà
//   exposées côté client (save-configuration.js, get-experience.js) :
//   le serveur résout l'expérience active à partir du `code` fourni,
//   JAMAIS d'un experienceId envoyé par le navigateur. Un client ne peut
//   donc jamais cibler l'expérience d'un autre client.
//
// SÉCURITÉ — un `secret` fourni mais incorrect est explicitement rejeté
// (401), jamais traité comme un mode client silencieux.
//
// RÈGLE DE STATUT (nouvelle, appliquée aux deux modes) — seule une
// expérience au statut exact "Test en cours" peut être réinitialisée.
// Toute autre valeur (En pause, Abandonné, Consolidé, ou absence de
// statut) est refusée explicitement, sans aucune écriture.
//
// L'ancien enregistrement CSR_Expériences n'est jamais supprimé : il reste
// consultable comme historique, juste détaché du client. Aucune donnée
// liée (CSR_Cycles, CSR_Configuration, CSR_Checkins) n'est jamais touchée.
//
// Corps attendu (POST) : { code, secret? }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, secret } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }

    // Un secret fourni doit être exact — jamais un repli silencieux vers
    // le mode client en cas de faute de frappe ou de tentative invalide.
    if (secret !== undefined && secret !== process.env.RESET_EXPERIENCE_SECRET) {
      return res.status(401).json({ error: 'Non autorisé' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const clientRecord = clientData.records[0];
    const experienceLinks = clientRecord.fields['Expérience active'];

    if (!experienceLinks || experienceLinks.length === 0) {
      return res.status(409).json({ error: 'Aucune expérience active à réinitialiser.' });
    }

    // Toujours résolu depuis la fiche client elle-même — jamais depuis une
    // valeur envoyée par le navigateur.
    const experienceRecordId = experienceLinks[0];

    // Lecture du statut réel avant toute écriture.
    const expUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${experienceRecordId}`;
    const expRes = await fetch(expUrl, { headers });
    if (!expRes.ok) {
      return res.status(404).json({ error: 'Expérience introuvable.' });
    }
    const expData = await expRes.json();
    const statutField = expData.fields['Statut'];
    const statutNom = typeof statutField === 'string' ? statutField : (statutField && statutField.name) || null;

    if (statutNom !== 'Test en cours') {
      return res.status(409).json({
        error: statutNom
          ? `Cette expérience est actuellement "${statutNom}" — seule une expérience "Test en cours" peut être réinitialisée.`
          : "Cette expérience n'a pas de statut valide pour une réinitialisation.",
      });
    }

    // 1. Archiver l'ancienne expérience (jamais supprimée).
    const archiveRes = await fetch(expUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { Statut: 'Abandonné' } }),
    });
    if (!archiveRes.ok) {
      const errText = await archiveRes.text();
      console.error('Échec archivage expérience:', errText);
      return res.status(500).json({ error: "Échec de l'archivage. Rien n'a été modifié." });
    }

    // 2. Retirer le lien côté client, pour qu'il puisse en choisir une nouvelle.
    const unlinkRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}/${clientRecord.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ fields: { 'Expérience active': [] } }) }
    );
    if (!unlinkRes.ok) {
      const errText = await unlinkRes.text();
      console.error('Échec déliaison client:', errText);
      // L'expérience est déjà archivée à ce stade — on ne prétend jamais
      // que l'opération est terminée si cette seconde écriture échoue.
      return res.status(500).json({
        error: "L'expérience a bien été archivée, mais le retrait du lien actif a échoué. Recharge la page : si le problème persiste, préviens Franck.",
        partialFailure: true,
        archivedExperienceId: experienceRecordId,
      });
    }

    return res.status(200).json({ success: true, archivedExperienceId: experienceRecordId });
  } catch (err) {
    console.error('Erreur reset-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
