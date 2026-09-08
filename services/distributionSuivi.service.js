// Chantier "Suivi des distributions" — Phase 1 backend (2026-09-07), suite de l'audit lecture
// seule validé le même jour. Service DÉDIÉ au nouvel écran « Suivi des distributions » —
// distinct et indépendant de :
//   - stockMoyensGeneraux.service.js::getEtudiantsServis (KPI dashboard existant, binaire
//     "a au moins une distribution" — inchangée, non réutilisée ici, sa définition ne bouge pas) ;
//   - distribution.controller.js::getHistorique (journal des remises, part de `distribution`,
//     inchangé — ne peut structurellement pas montrer un étudiant sans aucune remise).
//
// Objectif différent : partir des ÉTUDIANTS INSCRITS (vue_position_academique, jamais `etudiant`
// seul) et déterminer, PAR ARTICLE DÛ, si chacun a tout reçu — jamais un simple COUNT(distribution)
// qui confondrait "a reçu un seul accessoire sur quatre" avec "a tout reçu".
//
// Historique : vue_position_academique expose, pour l'année demandée, soit la position COURANTE
// de l'étudiant (s'il y est encore), soit sa position HISTORIQUE reconstituée depuis
// historique_inscription (événement 'cloture') s'il a depuis été réinscrit vers une autre année —
// un étudiant réinscrit en 2026-2027 reste donc retrouvable sur 2025-2026 sans aucun traitement
// spécial ici, cette garantie vient de la vue elle-même.
//
// Performance : 1 ligne par étudiant, aucun N+1. Les accessoires "dus" par niveau et "reçus" par
// étudiant sont chacun calculés en UNE agrégation (CTE), jamais recalculés par étudiant en boucle,
// puis jointes par niveau_libelle / etudiant_id — aucun produit cartésien avec les étudiants.

function construireFiltresEtudiant({ siteId, ecoleId, filiereId, niveauId, groupeId, search }, params) {
  const clauses = [
    'e.annee_academique_id = $1',
    'e.site_id = $2',
    "e.standing = 'Inscrit'",
  ];
  if (ecoleId !== null) {
    params.push(ecoleId);
    clauses.push(`e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${params.length})`);
  }
  if (filiereId) {
    params.push(filiereId);
    clauses.push(`e.id_filiere = $${params.length}`);
  }
  if (niveauId) {
    params.push(niveauId);
    clauses.push(`e.niveau_id = $${params.length}`);
  }
  if (groupeId) {
    params.push(groupeId);
    clauses.push(`e.groupe_id = $${params.length}`);
  }
  if (search && search.trim().length >= 2) {
    params.push(`%${search.trim()}%`);
    const idx = params.length;
    clauses.push(`(e.nom ILIKE $${idx} OR e.prenoms ILIKE $${idx} OR e.matricule_iipea ILIKE $${idx} OR (e.nom || ' ' || e.prenoms) ILIKE $${idx})`);
  }
  return clauses;
}

// Étudiants inscrits pour l'année demandée (vue_position_academique) + statut de distribution
// calculé par comparaison "accessoires dus pour ce niveau/cette année" vs "accessoires réellement
// reçus gratuitement (est_supplementaire = false) cette même année" — jamais recalculé par
// étudiant, deux agrégats séparés (dus_agg, recus_agg) joints ensuite par clé.
//
// dateDebut/dateFin (optionnels) : ne restreignent QUE la liste des étudiants affichés (au moins
// une remise dans la fenêtre), sur distribution.date_remise — n'affectent JAMAIS le calcul
// accessoires_dus/accessoires_recus/statut_distribution, qui restent cumulatifs sur toute l'année
// (répondre à "en est-il à jour aujourd'hui" et "qui a été servi aujourd'hui" sont deux questions
// distinctes, jamais mélangées dans un seul chiffre).
async function getSuiviDistributions(client, {
  siteId, ecoleId, anneeAcademiqueId,
  dateDebut = null, dateFin = null, statut = null,
  filiereId = null, niveauId = null, groupeId = null, search = null,
  page = 1, limit = 20,
}) {
  const params = [anneeAcademiqueId, siteId];
  const whereEtudiant = construireFiltresEtudiant({ siteId, ecoleId, filiereId, niveauId, groupeId, search }, params);

  let dateExistsCond = '';
  if (dateDebut) {
    params.push(dateDebut);
    dateExistsCond += ` AND dd2.date_remise >= $${params.length}`;
  }
  if (dateFin) {
    params.push(dateFin);
    dateExistsCond += ` AND dd2.date_remise <= $${params.length}::date + INTERVAL '1 day'`;
  }
  const dateFilterClause = (dateDebut || dateFin)
    ? `AND EXISTS (SELECT 1 FROM distribution dd2 WHERE dd2.etudiant_id = e.id AND dd2.annee_academique_id = $1 ${dateExistsCond})`
    : '';

  const baseCTE = `
    WITH dus_par_niveau AS (
      -- Une ligne par (niveau, accessoire dû) réellement applicable pour l'année demandée — DISTINCT
      -- pour ne jamais compter deux fois un accessoire couvert à la fois par une règle spécifique au
      -- niveau ET par une règle tous_niveaux=true (cas non observé en donnée réelle, géré par
      -- prudence). Table minuscule (niveaux × règles), sans rapport avec le volume d'étudiants.
      SELECT DISTINCT n.libelle AS niveau_libelle, r.accessoire_id
      FROM niveau n
      JOIN regle_distribution_accessoire r
        ON r.annee_academique_id = $1 AND r.actif = true
        AND (r.tous_niveaux = true OR r.niveau_libelle = n.libelle)
      JOIN accessoire a ON a.id = r.accessoire_id AND a.distribuable_etudiant = true AND a.actif = true
    ),
    dus_agg AS (
      SELECT niveau_libelle, COUNT(*) AS dus FROM dus_par_niveau GROUP BY niveau_libelle
    ),
    recus_agg AS (
      -- est_supplementaire = false : un surplus payant déjà acheté ne doit jamais compter comme la
      -- dotation gratuite due (même règle que distribution.controller.js::getAccessoiresEligibles).
      SELECT ld.etudiant_id, COUNT(DISTINCT ld.accessoire_id) AS recus
      FROM ligne_distribution ld
      WHERE ld.annee_academique_id = $1 AND ld.est_supplementaire = false
      GROUP BY ld.etudiant_id
    ),
    derniere_distribution AS (
      -- 1 ligne par étudiant (la plus récente) — l'agent affiché ne multiplie jamais les lignes
      -- même si un étudiant a reçu ses accessoires en plusieurs passages.
      SELECT DISTINCT ON (d.etudiant_id) d.etudiant_id, d.date_remise, u.nom AS agent_nom
      FROM distribution d
      JOIN utilisateur u ON u.id = d.agent_id
      WHERE d.annee_academique_id = $1
      ORDER BY d.etudiant_id, d.date_remise DESC
    ),
    base AS (
      SELECT
        e.id, e.matricule_iipea, e.nom, e.prenoms, e.telephone,
        f.nom AS filiere, n.libelle AS niveau, g.nom AS groupe,
        COALESCE(da.dus, 0) AS accessoires_dus,
        COALESCE(ra.recus, 0) AS accessoires_recus,
        dd.date_remise, dd.agent_nom AS agent_remise,
        CASE
          WHEN COALESCE(da.dus, 0) = 0 THEN 'AUCUN_ACCESSOIRE_PREVU'
          WHEN COALESCE(ra.recus, 0) = 0 THEN 'NON_RECUPERE'
          WHEN ra.recus < da.dus THEN 'PARTIELLEMENT_RECUPERE'
          ELSE 'RECUPERE'
        END AS statut_distribution
      FROM vue_position_academique e
      JOIN filiere f ON f.id = e.id_filiere
      JOIN niveau n ON n.id = e.niveau_id
      LEFT JOIN groupe g ON g.id = e.groupe_id
      LEFT JOIN dus_agg da ON da.niveau_libelle = n.libelle
      LEFT JOIN recus_agg ra ON ra.etudiant_id = e.id
      LEFT JOIN derniere_distribution dd ON dd.etudiant_id = e.id
      WHERE ${whereEtudiant.join(' AND ')} ${dateFilterClause}
    )
  `;

  let statutCond = '';
  if (statut) {
    params.push(statut);
    statutCond = `WHERE statut_distribution = $${params.length}`;
  }

  const countResult = await client.query(`${baseCTE} SELECT COUNT(*) AS total FROM base ${statutCond}`, params);
  const total = parseInt(countResult.rows[0].total, 10);

  const dataResult = await client.query(
    `${baseCTE} SELECT * FROM base ${statutCond} ORDER BY nom, prenoms LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit]
  );

  return {
    rows: dataResult.rows.map((r) => ({
      ...r,
      accessoires_dus: parseInt(r.accessoires_dus, 10),
      accessoires_recus: parseInt(r.accessoires_recus, 10),
    })),
    total,
  };
}

module.exports = { getSuiviDistributions, construireFiltresEtudiant };
