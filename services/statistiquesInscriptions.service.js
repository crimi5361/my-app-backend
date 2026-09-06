// Service partagé — source UNIQUE de vérité pour tout ce qui touche à "étudiant officiellement
// inscrit" côté dashboards/statistiques (Chantier Statistiques & Dashboards, 2026-08-18).
//
// RÈGLE MÉTIER (validée) : un étudiant est officiellement inscrit uniquement après finalisation
// de son paiement à la caisse (etudiant.standing = 'Inscrit'). Une admission/réinscription en
// attente de paiement (standing = 'en attente' / reinscription.statut = 'en_attente_paiement')
// n'est JAMAIS comptée comme inscrite. Une prise en charge institutionnelle validée à 100 % EST
// une inscription officielle même à 0 F encaissé (décision utilisateur 2026-08-18) : elle
// traverse le même chemin de validation caisse que n'importe quel paiement, donc comptée ici sans
// traitement spécial — elle n'apparaît en revanche jamais dans les recettes puisque paiement.montant
// vaut 0 pour cette ligne (voir caisse.controller.js::validerPaiementAdmission, commentaire dédié).
//
// Sources :
//   - total inscrits                          -> vue_position_academique.standing = 'Inscrit'
//   - admissions / réinscriptions validées      -> historique_inscription.type_evenement
//     (écrit par TOUS les chemins de finalisation caisse existants : caisse.controller.js et
//     paiyement.controller.js::createPaiement — corrigé le 2026-08-18 pour y écrire aussi, il ne
//     le faisait pas avant, ce qui aurait rendu ce compteur incomplet)
//   - admissions / réinscriptions en attente    -> services/dossiersEnAttente.service.js (réutilisé
//     tel quel, ne pas dupliquer cette définition)
//   - évolution quotidienne des inscriptions    -> historique_inscription.created_at (date réelle de
//     validation, PAS etudiant.date_inscription qui n'est que la date de création du dossier),
//     depuis anneeacademique_site.date_ouverture du site pour l'année sélectionnée
//   - évolution quotidienne des recettes        -> paiement.date_paiement (déjà la bonne source,
//     réutilisée telle quelle depuis dashboardComptabilite.controller.js)
//
// Limite connue (historique, non corrigeable rétroactivement) : tout étudiant finalisé via
// paiyement.controller.js::createPaiement AVANT le correctif du 2026-08-18 n'a aucune ligne
// historique_inscription — il compte correctement dans total_inscrits (vue_position_academique)
// mais est absent d'admissions_validees et de l'évolution quotidienne pour la date réelle où il a
// été finalisé. Aucune reconstitution n'est tentée : on ne devine pas une donnée qui n'existe pas.

function fragmentEcoleFiliere(ecoleId, alias, paramIndex) {
  return ecoleId !== null
    ? `AND ${alias}.departement_id IN (SELECT id FROM departement WHERE ecole_id = $${paramIndex})`
    : '';
}

// Premier jour de l'année académique sélectionnée, POUR CE SITE (le même site peut l'avoir
// ouverte à une date différente d'un autre site — cohérent avec anneeacademique_site).
async function getDateDebutAnnee(client, { siteId, anneeAcademiqueId }) {
  const r = await client.query(
    `SELECT date_ouverture FROM anneeacademique_site WHERE site_id = $1 AND anneeacademique_id = $2`,
    [siteId, anneeAcademiqueId]
  );
  if (r.rows[0]?.date_ouverture) return r.rows[0].date_ouverture;

  // Fallback (site n'a jamais explicitement "ouvert" cette année via annee.controller.js, ex.
  // ancienne donnée) : première trace réelle de finalisation connue pour ce site/année, sinon le
  // 1er janvier de l'année civile en cours — jamais une date arbitraire non justifiée.
  const fallback = await client.query(
    `SELECT MIN(h.created_at) AS premiere
     FROM historique_inscription h JOIN etudiant e ON e.id = h.etudiant_id
     WHERE h.annee_academique_id = $1 AND e.site_id = $2`,
    [anneeAcademiqueId, siteId]
  );
  return fallback.rows[0]?.premiere || new Date(new Date().getFullYear(), 0, 1);
}

// Total d'étudiants officiellement inscrits (définition unique, réutilisée partout).
async function getTotalInscrits(client, { siteId, ecoleId, anneeAcademiqueId }) {
  const cond = ecoleId !== null
    ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
    : '';
  const params = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];
  const r = await client.query(`
    SELECT COUNT(*) AS total
    FROM vue_position_academique e
    WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${cond}
  `, params);
  return parseInt(r.rows[0].total, 10);
}

// Admissions / réinscriptions validées (finalisées à la caisse), sur toute l'année académique.
async function getInscriptionsValidees(client, { siteId, ecoleId, anneeAcademiqueId }) {
  const cond = fragmentEcoleFiliere(ecoleId, 'f', 3);
  const params = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];
  const r = await client.query(`
    SELECT h.type_evenement, COUNT(*) AS total
    FROM historique_inscription h
    JOIN etudiant e ON e.id = h.etudiant_id
    LEFT JOIN filiere f ON f.id = h.id_filiere
    WHERE h.type_evenement IN ('admission', 'reinscription')
      AND h.annee_academique_id = $1 AND e.site_id = $2 ${cond}
    GROUP BY h.type_evenement
  `, params);
  const admissions = parseInt(r.rows.find((x) => x.type_evenement === 'admission')?.total || 0, 10);
  const reinscriptions = parseInt(r.rows.find((x) => x.type_evenement === 'reinscription')?.total || 0, 10);
  return { admissions, reinscriptions, total: admissions + reinscriptions };
}

// Compteurs par période glissante (aujourd'hui/hier/cette semaine/semaine dernière/ce mois),
// mêmes bornes date_trunc que l'ancien code (compatibilité de sens), mais sourcés sur la date
// réelle de validation.
async function getInscriptionsValideesPeriodes(client, { siteId, ecoleId, anneeAcademiqueId }) {
  const cond = fragmentEcoleFiliere(ecoleId, 'f', 3);
  const params = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];
  const r = await client.query(`
    SELECT
      COUNT(*) AS total_annee,
      COUNT(*) FILTER (WHERE h.created_at::date = CURRENT_DATE) AS aujourd_hui,
      COUNT(*) FILTER (WHERE h.created_at::date = CURRENT_DATE - INTERVAL '1 day') AS hier,
      COUNT(*) FILTER (WHERE h.created_at::date >= date_trunc('week', CURRENT_DATE)) AS cette_semaine,
      COUNT(*) FILTER (WHERE h.created_at::date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
                         AND h.created_at::date < date_trunc('week', CURRENT_DATE)) AS semaine_derniere,
      COUNT(*) FILTER (WHERE h.created_at::date >= date_trunc('month', CURRENT_DATE)) AS ce_mois
    FROM historique_inscription h
    JOIN etudiant e ON e.id = h.etudiant_id
    LEFT JOIN filiere f ON f.id = h.id_filiere
    WHERE h.type_evenement IN ('admission', 'reinscription')
      AND h.annee_academique_id = $1 AND e.site_id = $2 ${cond}
  `, params);
  const row = r.rows[0];
  return {
    total_annee: parseInt(row.total_annee, 10),
    aujourd_hui: parseInt(row.aujourd_hui, 10),
    hier: parseInt(row.hier, 10),
    cette_semaine: parseInt(row.cette_semaine, 10),
    semaine_derniere: parseInt(row.semaine_derniere, 10),
    ce_mois: parseInt(row.ce_mois, 10),
  };
}

// Évolution quotidienne des inscriptions validées, depuis le 1er jour de l'année académique
// (pour ce site) jusqu'à aujourd'hui — split Admissions / Réinscriptions / Total.
async function getEvolutionInscriptionsQuotidienne(client, { siteId, ecoleId, anneeAcademiqueId }) {
  const dateDebut = await getDateDebutAnnee(client, { siteId, anneeAcademiqueId });
  const cond = fragmentEcoleFiliere(ecoleId, 'f', 4);
  const params = ecoleId !== null
    ? [anneeAcademiqueId, siteId, dateDebut, ecoleId]
    : [anneeAcademiqueId, siteId, dateDebut];
  const r = await client.query(`
    SELECT h.created_at::date AS jour, h.type_evenement, COUNT(*) AS total
    FROM historique_inscription h
    JOIN etudiant e ON e.id = h.etudiant_id
    LEFT JOIN filiere f ON f.id = h.id_filiere
    WHERE h.type_evenement IN ('admission', 'reinscription')
      AND h.annee_academique_id = $1 AND e.site_id = $2 AND h.created_at::date >= $3::date ${cond}
    GROUP BY h.created_at::date, h.type_evenement
    ORDER BY jour
  `, params);

  const parJour = new Map();
  for (const row of r.rows) {
    const jour = row.jour instanceof Date ? row.jour.toISOString().slice(0, 10) : String(row.jour);
    if (!parJour.has(jour)) parJour.set(jour, { jour, admissions: 0, reinscriptions: 0, total: 0 });
    const entry = parJour.get(jour);
    const n = parseInt(row.total, 10);
    if (row.type_evenement === 'admission') entry.admissions = n; else entry.reinscriptions = n;
    entry.total += n;
  }
  return Array.from(parJour.values()).sort((a, b) => a.jour.localeCompare(b.jour));
}

// Évolution quotidienne des recettes réellement encaissées (déjà la bonne source ailleurs dans
// l'appli — reprise telle quelle, juste bornée à l'année académique complète). Une PEC
// institutionnelle (paiement.montant = 0) n'inflate jamais un total ici.
//
// ✅ Chantier Dashboards financiers par type (2026-08-27) : ajout d'une ventilation par
// `type_frais` (`parType`), calculée dans LA MÊME requête (un seul GROUP BY supplémentaire) pour
// que `total` reste mathématiquement la somme de `parType` — jamais deux requêtes séparées qui
// pourraient diverger. Convention `COALESCE(NULLIF(type_frais,''),'scolarite')` identique à
// caisse.controller.js (buildRapportSession/getSupervisionCaisse), pas une nouvelle règle.
// `{jour, total}` reste inchangé pour tout appelant existant (seul dashboardFondateur.controller.js
// consomme cette fonction à ce jour — vérifié, aucun autre contrôleur ne l'importe) : `parType`
// est un champ strictement additionnel.
async function getEvolutionRecettesQuotidienne(client, { siteId, ecoleId, anneeAcademiqueId }) {
  const dateDebut = await getDateDebutAnnee(client, { siteId, anneeAcademiqueId });
  const ecoleCond = ecoleId !== null
    ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $4))'
    : '';
  const params = ecoleId !== null
    ? [anneeAcademiqueId, siteId, dateDebut, ecoleId]
    : [anneeAcademiqueId, siteId, dateDebut];
  const r = await client.query(`
    SELECT p.date_paiement AS jour,
           COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
           COALESCE(SUM(p.montant), 0) AS total
    FROM paiement p JOIN caisse c ON c.id = p.caisse_id
    WHERE p.annee_academique_id = $1 AND c.site_id = $2 AND p.date_paiement >= $3::date ${ecoleCond}
    GROUP BY p.date_paiement, COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
    ORDER BY p.date_paiement
  `, params);

  const parJour = new Map();
  for (const row of r.rows) {
    const jour = row.jour instanceof Date ? row.jour.toISOString().slice(0, 10) : String(row.jour);
    if (!parJour.has(jour)) parJour.set(jour, { jour, total: 0, parType: {} });
    const entry = parJour.get(jour);
    const montant = parseFloat(row.total);
    entry.total += montant;
    entry.parType[row.type_frais] = montant;
  }
  return Array.from(parJour.values()).sort((a, b) => a.jour.localeCompare(b.jour));
}

// Activité des agents de scolarité (admissions + réinscriptions) — source unique pour les deux
// dashboards (Chantier "Activité des agents", 2026-09-06). Corrige le bug identifié à l'audit :
// etudiant.inscrit_par / etudiant.date_inscription ne sont JAMAIS réécrits par une réinscription
// (controllers/reinscription.controller.js n'écrit ni l'un ni l'autre) — une requête basée dessus
// ne peut donc structurellement jamais voir une réinscription, et attribue à tort tout étudiant
// réinscrit à l'agent de sa toute première admission.
//
// Source retenue : historique_inscription, type_evenement IN ('admission','reinscription')
// UNIQUEMENT — jamais 'cloture' (écrite pour la même réinscription, sur l'ANCIENNE année : la
// compter doublerait chaque réinscription). L'agent et la date sont résolus PAR TYPE d'événement :
//   - admission     -> agent = COALESCE(e.inscrit_par::integer, e.verifie_par)
//                       date  = e.date_inscription
//   - reinscription -> agent = COALESCE(r.traite_par, r.verifie_par), r = reinscription liée via
//                       h.reinscription_id (traite_par = agent scolarité qui a saisi la demande en
//                       interne ; verifie_par = agent scolarité qui a vérifié un dossier venu du
//                       portail web — l'un des deux est toujours renseigné, jamais les deux)
//                       date  = h.created_at (date réelle de validation caisse — jamais
//                       etudiant.annee_academique_id/date_inscription, qui ne reflètent que la
//                       position COURANTE de l'étudiant, cf. vue_position_academique)
// historique_inscription.valide_par n'est JAMAIS utilisé comme agent scolarité ici : c'est l'agent
// de CAISSE qui a validé le paiement (rôle distinct, voir caisse.controller.js).
//
// fenetreJours (optionnel) restreint aux événements dont la date réelle (ci-dessus, jamais
// CURRENT_DATE contre une mauvaise colonne) tombe dans les N derniers jours ; omis = tout
// l'historique de l'année sélectionnée. Un agent sans aucun événement n'apparaît jamais (jointure
// interne sur utilisateur, pas de LEFT JOIN depuis la table utilisateur).
async function getActiviteAgents(client, { siteId, ecoleId, anneeAcademiqueId, fenetreJours }) {
  const params = [anneeAcademiqueId, siteId];
  let ecoleCond = '';
  if (ecoleId !== null) {
    params.push(ecoleId);
    ecoleCond = `AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $${params.length})`;
  }
  let fenetreCond = '';
  if (fenetreJours) {
    params.push(fenetreJours);
    fenetreCond = `AND x.date_evenement::date >= CURRENT_DATE - ($${params.length}::int - 1) * INTERVAL '1 day'`;
  }

  const r = await client.query(`
    SELECT x.agent_id, u.nom AS agent_nom,
      COUNT(*) FILTER (WHERE x.type_evenement = 'admission') AS nouvelles_admissions,
      COUNT(*) FILTER (WHERE x.type_evenement = 'reinscription') AS reinscriptions,
      COUNT(*) AS total
    FROM (
      SELECT
        h.type_evenement,
        CASE WHEN h.type_evenement = 'admission' THEN COALESCE(e.inscrit_par::integer, e.verifie_par)
             ELSE COALESCE(r.traite_par, r.verifie_par) END AS agent_id,
        CASE WHEN h.type_evenement = 'admission' THEN e.date_inscription
             ELSE h.created_at END AS date_evenement
      FROM historique_inscription h
      JOIN etudiant e ON e.id = h.etudiant_id
      LEFT JOIN reinscription r ON r.id = h.reinscription_id
      LEFT JOIN filiere f ON f.id = h.id_filiere
      WHERE h.type_evenement IN ('admission', 'reinscription')
        AND h.annee_academique_id = $1
        AND e.site_id = $2
        ${ecoleCond}
    ) x
    JOIN utilisateur u ON u.id = x.agent_id
    WHERE 1=1 ${fenetreCond}
    GROUP BY x.agent_id, u.nom
    ORDER BY total DESC
  `, params);

  return r.rows.map((row) => ({
    agent_id: row.agent_id,
    agent_nom: row.agent_nom,
    nouvelles_admissions: parseInt(row.nouvelles_admissions, 10),
    reinscriptions: parseInt(row.reinscriptions, 10),
    total: parseInt(row.total, 10),
  }));
}

module.exports = {
  getDateDebutAnnee,
  getTotalInscrits,
  getInscriptionsValidees,
  getInscriptionsValideesPeriodes,
  getEvolutionInscriptionsQuotidienne,
  getEvolutionRecettesQuotidienne,
  getActiviteAgents,
};
