// Service partagé — dossiers (admissions + réinscriptions) en attente de paiement, avec
// répartition par origine (`source_inscription`). Ajouté pour donner aux dashboards
// Fondateur/Scolarité/Administrateur la même visibilité que le dashboard Caisse sur cette
// donnée, SANS dupliquer la règle de calcul dans chacun des 3 contrôleurs.
//
// Définitions métier reprises telles quelles de `caisse.controller.js::getDashboardStats` /
// `getInscriptionsEnAttente` (seule source de vérité pour "en attente") :
//   - admission en attente    = etudiant.standing = 'en attente'
//   - réinscription en attente = reinscription.statut = 'en_attente_paiement'
// Le périmètre (site + année académique + école) suit le même schéma que celui déjà utilisé par
// les 3 dashboards eux-mêmes (siteId = req.user.departement_id, anneeAcademiqueId en query
// obligatoire, ecoleId via ecoleScope.service — cumulatif, null = toutes écoles du site).
//
// La colonne `source_inscription` est déjà utilisée ailleurs (Scolarité/Administrateur) avec les
// valeurs 'web'/'agent' — ici on ne fige PAS ces deux valeurs : le résultat reflète dynamiquement
// ce qui existe réellement en base (GROUP BY), pour ne jamais masquer une valeur inattendue.

async function getDossiersEnAttenteParOrigine(client, { siteId, ecoleId, anneeAcademiqueId }) {
  // Admissions : même jointure INNER que Caisse (JOIN filiere/niveau) — une admission "en
  // attente" sans filière/niveau valides n'est de toute façon jamais comptée par Caisse non plus.
  const ecoleCondAdmission = ecoleId !== null
    ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)'
    : '';
  const paramsAdmission = ecoleId !== null
    ? [anneeAcademiqueId, siteId, ecoleId]
    : [anneeAcademiqueId, siteId];

  const admissionQuery = `
    SELECT e.source_inscription AS origine, COUNT(*) AS total
    FROM etudiant e
    JOIN filiere f ON f.id = e.id_filiere
    JOIN niveau niv ON niv.id = e.niveau_id
    WHERE e.standing = 'en attente' AND e.site_id = $2 AND e.annee_academique_id = $1 ${ecoleCondAdmission}
    GROUP BY e.source_inscription
  `;

  // Réinscriptions : même jointure (INNER sur niveau, LEFT sur filiere) que Caisse — reprise à
  // l'identique, y compris le LEFT JOIN qui n'exclut pas un dossier sans id_filiere_retenu tant
  // qu'aucun filtre école n'est appliqué.
  const ecoleCondReinscription = ecoleId !== null
    ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)'
    : '';
  const paramsReinscription = ecoleId !== null
    ? [anneeAcademiqueId, siteId, ecoleId]
    : [anneeAcademiqueId, siteId];

  const reinscriptionQuery = `
    SELECT r.source_inscription AS origine, COUNT(*) AS total
    FROM reinscription r
    JOIN etudiant e ON e.id = r.etudiant_id
    JOIN niveau niv ON niv.id = r.niveau_retenu_id
    LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
    WHERE r.statut = 'en_attente_paiement' AND e.site_id = $2 AND r.anneeacademique_id = $1 ${ecoleCondReinscription}
    GROUP BY r.source_inscription
  `;

  const [admissionResult, reinscriptionResult] = await Promise.all([
    client.query(admissionQuery, paramsAdmission),
    client.query(reinscriptionQuery, paramsReinscription),
  ]);

  const toBloc = (rows) => {
    const par_origine = {};
    let total = 0;
    for (const row of rows) {
      const n = parseInt(row.total, 10);
      par_origine[row.origine] = n;
      total += n;
    }
    return { total, par_origine };
  };

  return {
    admissions: toBloc(admissionResult.rows),
    reinscriptions: toBloc(reinscriptionResult.rows),
  };
}

module.exports = { getDossiersEnAttenteParOrigine };
