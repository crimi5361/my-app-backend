// Chantier Kit étudiant — Phase statistiques (2026-08-21). Service centralisé de comptage, unique
// source utilisée par les 4 dashboards (Fondateur, Administrateur, Comptabilité, Caisse) — aucune
// deuxième logique de calcul écrite dans un contrôleur. Ne modifie RIEN du fonctionnement du
// module Kit lui-même (paiement, régularisation) : lecture seule.
//
// Éligibilité dérivée avec la MÊME constante NIVEAUX_PREMIERE_ANNEE que
// services/kitEligibilite.service.js (estPremiereAnnee) — jamais une deuxième liste de niveaux
// exemptés récrite ici, jamais niveau.ordre (confirmé non fiable, cf. audit Phase 1).
//
// Convention de comptage "payés" : identique à celle déjà établie en Phase 1 dans
// caisse.controller.js::getDashboardStats et StatDashboard.controller.js::getDashboardStats —
// une ligne historique (deposer=true, statut NULL, avant la Phase 1) compte comme "payée", jamais
// comme "apportée" (l'ancien système ne distinguait pas les deux cas, `deposer=true` signifiait
// concrètement "kit acheté à l'école"). Le MONTANT, en revanche, ne provient JAMAIS de cette
// ancienne ligne (elle n'a pas de paiement Caisse réel derrière) — uniquement de
// paiement.type_frais = 'kit_ecole' via kit.paiement_id, conformément à la demande explicite
// ("Ce montant doit provenir exclusivement des vrais paiements Caisse").
const { NIVEAUX_PREMIERE_ANNEE } = require('./kitEligibilite.service');

async function getStatistiquesKit(executor, { siteId, anneeAcademiqueId, ecoleId = null }) {
  if (!siteId) throw new Error('siteId requis.');
  if (!anneeAcademiqueId) throw new Error('anneeAcademiqueId requis.');

  const ecoleCondCompte = ecoleId !== null
    ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $4)'
    : '';
  const paramsCompte = ecoleId !== null
    ? [siteId, anneeAcademiqueId, NIVEAUX_PREMIERE_ANNEE, ecoleId]
    : [siteId, anneeAcademiqueId, NIVEAUX_PREMIERE_ANNEE];

  // Seuls les étudiants réellement inscrits (standing = 'Inscrit') sont comptés — jamais les
  // dossiers en attente (§4 de la demande).
  const compteResult = await executor.query(
    `SELECT
        COUNT(*) FILTER (WHERE UPPER(TRIM(n.libelle)) <> ALL($3::text[])) AS eligibles,
        COUNT(*) FILTER (WHERE UPPER(TRIM(n.libelle)) = ANY($3::text[])) AS exemptes,
        COUNT(*) FILTER (WHERE UPPER(TRIM(n.libelle)) <> ALL($3::text[]) AND k.statut = 'KIT_APPORTE') AS apportes,
        COUNT(*) FILTER (WHERE UPPER(TRIM(n.libelle)) <> ALL($3::text[]) AND (k.statut = 'KIT_PAYE' OR (k.deposer = true AND k.statut IS NULL))) AS payes
     FROM etudiant e
     JOIN niveau n ON n.id = e.niveau_id
     JOIN filiere f ON f.id = e.id_filiere
     LEFT JOIN kit k ON k.etudiant_id = e.id AND k.annee_academique_id = e.annee_academique_id
     WHERE e.site_id = $1 AND e.annee_academique_id = $2 AND e.standing = 'Inscrit'
     ${ecoleCondCompte}`,
    paramsCompte
  );

  const row = compteResult.rows[0];
  const eligibles = parseInt(row.eligibles, 10);
  const exemptes = parseInt(row.exemptes, 10);
  const apportes = parseInt(row.apportes, 10);
  const payes = parseInt(row.payes, 10);

  const ecoleCondMontant = ecoleId !== null
    ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)'
    : '';
  const paramsMontant = ecoleId !== null ? [siteId, anneeAcademiqueId, ecoleId] : [siteId, anneeAcademiqueId];

  const montantResult = await executor.query(
    `SELECT COALESCE(SUM(p.montant), 0) AS total
     FROM kit k
     JOIN paiement p ON p.id = k.paiement_id
     JOIN etudiant e ON e.id = k.etudiant_id
     JOIN filiere f ON f.id = e.id_filiere
     WHERE k.statut = 'KIT_PAYE' AND p.type_frais = 'kit_ecole'
       AND e.site_id = $1 AND e.annee_academique_id = $2 AND e.standing = 'Inscrit'
       ${ecoleCondMontant}`,
    paramsMontant
  );

  return {
    eligibles,
    exemptes,
    apportes,
    payes,
    // Cohérence structurelle (§1 de la demande) : dérivé, jamais requêté séparément — garantie par
    // kit_paiement_coherent + kit_unique_etudiant_annee (migration 039) qu'un étudiant éligible est
    // soit sans ligne kit, soit KIT_APPORTE, soit "payé" (statut ou compatibilité historique),
    // jamais dans deux catégories à la fois.
    sans_kit: eligibles - apportes - payes,
    montant_total_paye: parseFloat(montantResult.rows[0].total),
  };
}

module.exports = { getStatistiquesKit };
