// Écriture bas niveau recu + paiement — extraite de appliquerPaiementValide (Chantier Moyens
// Généraux, Phase 2D, 2026-08-19) pour être réutilisée par un paiement qui NE touche PAS la
// scolarité (ex. surplus d'accessoire, cf. controllers/caisse.controller.js::encaisserSurplus).
// appliquerPaiementValide est structurellement couplée à scolarite/historique_inscription — jamais
// réutilisée telle quelle pour un paiement qui n'est pas un paiement de scolarité (règle explicite
// du cahier des charges Phase 2D §3). Seul le PATRON d'écriture (recu + paiement, mêmes colonnes,
// même format de numéro de reçu) est repris ici, sans aucune des colonnes/mises à jour spécifiques
// à la scolarité. typeFrais/referenceTransaction restent NULL par défaut — comportement de
// appliquerPaiementValide strictement inchangé pour ses appelants existants (espèces, Wave).
async function enregistrerPaiementEtRecu(client, {
  montant, methode, effectueParId, emetteurCode,
  etudiantId, anneeAcademiqueId, sessionCaisseId, caisseId,
  referenceTransaction = null, typeFrais = null,
}) {
  const datePaiement = new Date();
  const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const recuResult = await client.query(
    `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
    [numeroRecu, datePaiement, montant, emetteurCode || null]
  );

  const paiementResult = await client.query(
    `INSERT INTO paiement
       (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id, reference_transaction, type_frais)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      montant, datePaiement, methode, effectueParId != null ? String(effectueParId) : null,
      etudiantId, recuResult.rows[0].id, anneeAcademiqueId, sessionCaisseId, caisseId,
      referenceTransaction || null, typeFrais || null,
    ]
  );

  return { paiementId: paiementResult.rows[0].id, recuId: recuResult.rows[0].id, numeroRecu, datePaiement };
}

// Application définitive d'un paiement de SCOLARITÉ déjà validé (montant/solde déjà vérifiés par
// l'appelant, position déjà résolue via scolariteResolution.service.js::resoudrePositionFinanciere).
//
// Logique extraite à l'identique de caisse.controller.js::enregistrerPaiementAnneeEtudiant
// (Phase 4 intégration Wave, 2026-08-18) pour être PARTAGÉE, mot pour mot, entre un paiement
// espèces enregistré directement par un caissier ET un paiement Wave confirmé par webhook — une
// seule règle de calcul scolarite_verse/scolarite_restante/statut_etudiant, jamais deux. Le
// comportement du paiement espèces existant n'est pas modifié : ce fichier ne fait que déplacer
// du code déjà exécuté, sans changer une seule valeur calculée.
async function appliquerPaiementValide(client, {
  position, montant, methode, effectueParId, emetteurCode,
  etudiantId, anneeAcademiqueId, sessionCaisseId, caisseId, referenceTransaction,
}) {
  const nouveauVerse = position.scolariteVerse + montant;
  const nouveauRestant = position.scolariteRestante - montant;
  const nouveauStatut = Math.abs(nouveauRestant) < 0.01 ? 'SOLDE' : 'NON_SOLDE';

  if (position.source === 'scolarite') {
    await client.query(
      `UPDATE scolarite SET scolarite_verse = $1, scolarite_restante = $2, statut_etudiant = $3 WHERE id = $4`,
      [nouveauVerse, nouveauRestant, nouveauStatut, position.ligneId]
    );
  } else {
    await client.query(
      `UPDATE historique_inscription SET scolarite_verse = $1, scolarite_restante = $2, statut_paiement = $3 WHERE id = $4`,
      [nouveauVerse, nouveauRestant, nouveauStatut, position.ligneId]
    );
  }

  const { paiementId, recuId, numeroRecu } = await enregistrerPaiementEtRecu(client, {
    montant, methode, effectueParId, emetteurCode,
    etudiantId, anneeAcademiqueId, sessionCaisseId, caisseId, referenceTransaction,
  });

  return { paiementId, recuId, numeroRecu, nouveauVerse, nouveauRestant, nouveauStatut };
}

module.exports = { appliquerPaiementValide, enregistrerPaiementEtRecu };
