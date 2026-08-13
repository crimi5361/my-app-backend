// Résolution de l'année académique "par défaut" pour un site — utilisée par l'Assistant Fondateur
// quand l'utilisateur ne précise pas d'année dans sa question (cas le plus fréquent). Priorité à
// l'année 'en cour' pour ce site ; à défaut (aucune année ouverte), on retombe sur la plus récente
// déjà rattachée au site plutôt que d'échouer.
async function resolveAnneeAcademiqueId(db, siteId) {
  const enCours = await db.query(
    `SELECT a.id FROM anneeacademique a JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
     WHERE s.site_id = $1 AND s.etat = 'en cour' LIMIT 1`,
    [siteId]
  );
  if (enCours.rows.length > 0) return enCours.rows[0].id;

  const derniere = await db.query(
    `SELECT a.id FROM anneeacademique a JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
     WHERE s.site_id = $1 ORDER BY a.annee DESC LIMIT 1`,
    [siteId]
  );
  return derniere.rows.length > 0 ? derniere.rows[0].id : null;
}

module.exports = { resolveAnneeAcademiqueId };
