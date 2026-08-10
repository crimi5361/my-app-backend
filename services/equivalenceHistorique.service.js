// Journal exhaustif des demandes d'équivalence — une seule fonction d'insertion pour éviter
// tout SQL dupliqué à travers le controller. Voir document de conception §4.3 pour le
// vocabulaire complet de `type_evenement`.
exports.enregistrerEvenementHistorique = async (client, { demandeId, type, agentId = null, statutAvant = null, statutApres = null, detail = null }) => {
  await client.query(
    `INSERT INTO demande_equivalence_historique
       (demande_equivalence_id, type_evenement, statut_avant, statut_apres, agent_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [demandeId, type, statutAvant, statutApres, agentId, detail]
  );
};
