// api/create-experience.js
//
// NOUVEAU (25/08/2026) — Le client choisit lui-même ANCRAGE ou RUPTURE (guidé
// en direct par Franck pendant la séance). Cette route crée l'expérience
// correspondante et la lie au client, une seule fois.
//
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 2 : une nouvelle
// expérience peut désormais être créée alors qu'une expérience est déjà
// liée, mais UNIQUEMENT si son statut est 'En pause', 'Consolidé' ou
// 'Abandonné' (liste blanche stricte — tout le reste refuse, y compris un
// statut absent/inconnu, par sécurité). L'ancienne expérience n'est JAMAIS
// modifiée : ni son statut, ni ses champs, ni ses cycles liés — seul le
// lien 'Expérience active' du client est remplacé, et seulement après
// confirmation que la nouvelle expérience a bien été créée.
//
// MIS À JOUR (30/08/2026) — Modèle multi-cycle, Chantier 3 : ajout du
// paramètre optionnel consoliderAncienne. Quand le client déclenche
// explicitement "Changer d'expérience" depuis l'État D (cycle terminé et
// déjà évalué), l'ancienne expérience peut encore être 'Test en cours' —
// aucune décision de bilan autre que 'Suspendre' ne change son statut
// automatiquement. Ce paramètre autorise donc un contournement CIBLÉ et
// VÉRIFIÉ de la liste blanche : on ne l'accepte que si on confirme
// soi-même, côté serveur, que le cycle le plus récent de l'ancienne
// expérience est réellement évalué (Décision suivante renseignée) — jamais
// sur la seule foi de ce que le client prétend. Si la vérification échoue,
// refus normal. Si elle réussit : création + liaison comme d'habitude, puis
// — et seulement après liaison confirmée réussie — l'ancienne expérience
// passe à 'Consolidé'. Jamais l'inverse (consolider avant de savoir si la
// création réussit), pour ne jamais clôturer une expérience pour rien si la
// nouvelle création échoue.
//
// Corps attendu (POST) : { code, moteur, objectif, consoliderAncienne }
// moteur doit être exactement "ANCRAGE" ou "RUPTURE".
// consoliderAncienne : booléen optionnel, false par défaut.

const STATUTS_PERMETTANT_NOUVELLE_EXPERIENCE = ['En pause', 'Consolidé', 'Abandonné'];

function extractSelectName(field) {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field.name) return field.name;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const { code, moteur, objectif, consoliderAncienne } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Code manquant' });
    }
    if (moteur !== 'ANCRAGE' && moteur !== 'RUPTURE') {
      return res.status(400).json({ error: 'Moteur invalide' });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE = process.env.AIRTABLE_BASE || 'app9uUXCxNdjb0m9X';
    const TABLE_CLIENTS = 'SuiviCSR_Clients';
    const TABLE_EXPERIENCES = 'CSR_Expériences';
    const TABLE_CYCLES = 'CSR_Cycles';

    const headers = {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // 1. Retrouver le client.
    const filterFormula = encodeURIComponent(`{Code}='${code}'`);
    const clientUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}?filterByFormula=${filterFormula}&maxRecords=1`;
    const clientRes = await fetch(clientUrl, { headers });
    const clientData = await clientRes.json();

    if (!clientData.records || clientData.records.length === 0) {
      return res.status(404).json({ error: 'Client introuvable' });
    }

    const clientRecord = clientData.records[0];

    // 2. Si une expérience est déjà liée, son statut décide si une nouvelle
    //    expérience peut être créée. Liste blanche stricte : seuls 'En
    //    pause', 'Consolidé' et 'Abandonné' l'autorisent. 'Configuration',
    //    'Test en cours', 'Changé de moteur', ou tout statut absent/non
    //    reconnu refusent — jamais l'inverse (pas de liste noire), pour que
    //    tout cas non prévu reste bloquant par défaut.
    const existingLinks = clientRecord.fields['Expérience active'];
    let existingExperienceId = null;
    let doitConsoliderApresLiaison = false;

    if (existingLinks && existingLinks.length > 0) {
      existingExperienceId = existingLinks[0];
      const existingExpUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${existingExperienceId}`;
      const existingExpRes = await fetch(existingExpUrl, { headers });

      if (!existingExpRes.ok) {
        // Lecture du statut impossible : on ne suppose rien, on refuse.
        return res.status(409).json({
          error: "Impossible de créer une nouvelle expérience : le statut de l'expérience actuelle n'est pas reconnu.",
        });
      }

      const existingExpData = await existingExpRes.json();
      const existingStatut = extractSelectName(existingExpData.fields['Statut']);

      if (!STATUTS_PERMETTANT_NOUVELLE_EXPERIENCE.includes(existingStatut)) {
        // NOUVEAU (30/08/2026) — Contournement ciblé pour "Changer
        // d'expérience" depuis l'État D : vérifié, jamais supposé.
        let bypassAutorise = false;
        if (consoliderAncienne === true) {
          // MIS À JOUR (30/08/2026) — Chantier 12 : élimine le risque de
          // troncature au-delà de 100 lignes — voir get-experience.js pour
          // l'explication complète. existingExpData est déjà récupéré par
          // ID juste au-dessus ; sa liste de cycles liés n'est jamais
          // tronquée, quelle que soit la taille globale de CSR_Cycles.
          const cyclesIds = (existingExpData.fields['CSR_Cycles'] || []).map((l) => l.id);
          // MIS À JOUR (30/08/2026) — Chantier 12, corrigé le jour même : la
          // première version utilisait filterByFormula=OR(RECORD_ID()=...),
          // qui s'est révélée ne pas fonctionner en production. Remplacé par
          // une récupération individuelle par URL directe — voir
          // get-experience.js pour l'explication complète.
          const matchingCycles = (
            await Promise.all(
              cyclesIds.map(async (id) => {
                const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CYCLES}/${id}`, { headers });
                if (!r.ok) return null;
                return r.json();
              })
            )
          ).filter(Boolean);
          if (matchingCycles.length > 0) {
            matchingCycles.sort((a, b) => (b.fields['N° cycle'] || 0) - (a.fields['N° cycle'] || 0));
            const latestCycle = matchingCycles[0];
            const decisionName = extractSelectName(latestCycle.fields['Décision suivante']);
            if (!!decisionName) {
              bypassAutorise = true;
              doitConsoliderApresLiaison = true;
            }
          }
        }

        if (!bypassAutorise) {
          if (existingStatut === 'Configuration' || existingStatut === 'Test en cours') {
            return res.status(409).json({
              error: "Une expérience est déjà active pour ce client. Termine ou mets en pause l'expérience actuelle avant d'en créer une nouvelle.",
            });
          }
          if (existingStatut === 'Changé de moteur') {
            return res.status(409).json({
              error: 'Cette expérience ne permet pas encore de créer une nouvelle expérience depuis cet état.',
            });
          }
          // Statut absent, vide, ou toute valeur non reconnue.
          return res.status(409).json({
            error: "Impossible de créer une nouvelle expérience : le statut de l'expérience actuelle n'est pas reconnu.",
          });
        }
        // bypassAutorise === true : le cycle le plus récent de l'ancienne
        // expérience est confirmé évalué — on poursuit, l'ancienne sera
        // consolidée après liaison réussie (jamais avant).
      }
      // Statut autorisé (whitelist normale, ou bypass vérifié ci-dessus) :
      // on poursuit. L'ancienne expérience n'est touchée nulle part dans ce
      // qui suit avant l'étape 5 — ni son statut, ni ses champs, ni ses
      // cycles.
    }

    const prenom = clientRecord.fields['Prenom'] || clientRecord.fields['Prénom'] || code;

    // 3. Créer la nouvelle expérience.
    const createExpRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fields: {
            'Nom expérience': prenom + ' — ' + moteur,
            Moteur: moteur,
            'Version protocole': moteur + '_v1',
            Objectif: objectif || '',
            Statut: 'Configuration',
            'Date création': new Date().toISOString().slice(0, 10),
          },
        }),
      }
    );

    if (!createExpRes.ok) {
      // La création a échoué : on ne touche à rien côté client, l'ancien
      // lien (s'il existait) reste exactement tel quel.
      const errText = await createExpRes.text();
      console.error('Échec création CSR_Expériences:', errText);
      throw new Error('Échec création expérience');
    }

    const createExpData = await createExpRes.json();
    const experienceRecordId = createExpData.id;

    // 4. Lier la nouvelle expérience au client — remplace l'ancien lien
    //    (s'il y en avait un) par la nouvelle, en un seul PATCH. On
    //    n'exécute cette étape qu'après confirmation que la création
    //    ci-dessus a bien réussi.
    const updateClientRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_CLIENTS}/${clientRecord.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          fields: { 'Expérience active': [experienceRecordId] },
        }),
      }
    );

    if (!updateClientRes.ok) {
      // La nouvelle expérience existe bel et bien (elle a été créée avec
      // succès à l'étape 3), mais la liaison au client a échoué. On ne
      // prétend jamais que tout a réussi dans ce cas — on expose l'ID de
      // l'expérience orpheline pour que le problème reste traçable plutôt
      // que silencieux. L'ancienne expérience n'est PAS consolidée dans ce
      // cas — la liaison n'ayant pas réussi, rien ne doit être clôturé.
      const errText = await updateClientRes.text();
      console.error('Échec liaison client -> expérience:', errText);
      return res.status(207).json({
        success: false,
        experienceCreee: true,
        experienceId: experienceRecordId,
        liaisonClientReussie: false,
        error: "L'expérience a été créée mais n'a pas pu être liée au client. Intervention manuelle nécessaire.",
      });
    }

    // 5. Consolidation de l'ancienne expérience — uniquement si demandée ET
    //    vérifiée à l'étape 2, ET seulement maintenant que la création ET la
    //    liaison ont toutes deux réussi. Un échec ici est signalé
    //    explicitement plutôt qu'avalé : la nouvelle expérience est bel et
    //    bien active pour le client, mais l'ancienne resterait alors dans un
    //    statut non consolidé jusqu'à correction manuelle.
    let ancienneConsolideeAvecSucces = null;
    if (doitConsoliderApresLiaison && existingExperienceId) {
      const consolideRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_EXPERIENCES}/${existingExperienceId}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ fields: { Statut: 'Consolidé' } }),
        }
      );
      ancienneConsolideeAvecSucces = consolideRes.ok;
      if (!consolideRes.ok) {
        const errText = await consolideRes.text();
        console.error('Échec consolidation ancienne expérience:', errText);
      }
    }

    return res.status(200).json({
      success: true,
      experienceId: experienceRecordId,
      moteur: moteur,
      ancienneExperienceId: existingExperienceId,
      ancienneConsolideeAvecSucces: ancienneConsolideeAvecSucces,
    });
  } catch (err) {
    console.error('Erreur create-experience:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
