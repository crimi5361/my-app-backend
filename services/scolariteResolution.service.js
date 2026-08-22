// Résolution de la position financière d'un étudiant pour une année académique donnée.
// Même règle que celle déjà utilisée par caisse.controller.js::enregistrerPaiementAnneeEtudiant
// (verrouillage FOR UPDATE, bascule scolarité courante / historique_inscription selon que
// l'année demandée est l'année en cours de l'étudiant ou une année déjà quittée) — extraite ici
// pour être réutilisée par l'initiation ET la future confirmation d'un paiement Wave (phases 3
// et 4) sans dupliquer cette logique une troisième fois. Comportement identique à l'original,
// simple lecture (avec verrou) — n'écrit jamais rien, contrairement à l'original qui enchaînait
// avec l'UPDATE/INSERT : chaque appelant reste responsable de ses propres écritures.

class PositionFinanciereError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'PositionFinanciereError';
    this.code = code || 'POSITION_FINANCIERE_ERROR';
    this.status = status || 400;
  }
}

async function resoudrePositionFinanciere(client, { etudiantId, siteId, ecoleId, anneeAcademiqueId }) {
  const ecoleCond = ecoleId !== null
    ? 'AND id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))'
    : '';
  const params = ecoleId !== null ? [etudiantId, siteId, ecoleId] : [etudiantId, siteId];

  const etudiantResult = await client.query(
    `SELECT id, annee_academique_id, scolarite_id FROM etudiant WHERE id = $1 AND site_id = $2 ${ecoleCond} FOR UPDATE`,
    params
  );
  if (etudiantResult.rows.length === 0) {
    throw new PositionFinanciereError('Étudiant introuvable.', { code: 'ETUDIANT_INTROUVABLE', status: 404 });
  }
  const etudiant = etudiantResult.rows[0];
  const isAnneeCourante = Number(etudiant.annee_academique_id) === Number(anneeAcademiqueId);

  if (isAnneeCourante) {
    if (!etudiant.scolarite_id) {
      throw new PositionFinanciereError('Aucune scolarité active pour cet étudiant.', { code: 'SCOLARITE_ABSENTE', status: 500 });
    }
    const scolariteResult = await client.query('SELECT * FROM scolarite WHERE id = $1 FOR UPDATE', [etudiant.scolarite_id]);
    const scolarite = scolariteResult.rows[0];
    return {
      etudiantId: etudiant.id,
      source: 'scolarite',
      ligneId: scolarite.id,
      scolariteVerse: parseFloat(scolarite.scolarite_verse),
      scolariteRestante: parseFloat(scolarite.scolarite_restante),
      statutEtudiant: scolarite.statut_etudiant,
      isAnneeCourante: true,
    };
  }

  const historiqueResult = await client.query(
    `SELECT * FROM historique_inscription WHERE etudiant_id = $1 AND annee_academique_id = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [etudiantId, anneeAcademiqueId]
  );
  if (historiqueResult.rows.length === 0) {
    throw new PositionFinanciereError('Aucun historique trouvé pour cette année académique.', { code: 'HISTORIQUE_INTROUVABLE', status: 404 });
  }
  const historique = historiqueResult.rows[0];
  return {
    etudiantId: etudiant.id,
    source: 'historique_inscription',
    ligneId: historique.id,
    scolariteVerse: parseFloat(historique.scolarite_verse),
    scolariteRestante: parseFloat(historique.scolarite_restante),
    statutEtudiant: historique.statut_paiement,
    isAnneeCourante: false,
  };
}

module.exports = { PositionFinanciereError, resoudrePositionFinanciere };
