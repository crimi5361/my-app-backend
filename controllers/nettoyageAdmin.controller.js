// Chantier 11 (2026-08-04) — sous-phase finale, point 3 : outil réservé aux administrateurs
// pour supprimer proprement les dossiers d'admission/réinscription jamais finalisés
// ("en attente"), abandonnés par le candidat ou périmés. Aucune donnée validée n'est jamais
// accessible par ce contrôleur : chaque suppression est gardée par une condition sur le statut,
// vérifiée atomiquement au moment même du DELETE (pas seulement avant), pour ne jamais supprimer
// un dossier qui viendrait d'être validé entre-temps.
const db = require('../config/db.config');

// GET /api/admin/dossiers-en-attente — liste les deux familles de dossiers jamais finalisés.
//
// Cloisonnement par site (correctif 2026-08-20) : un dossier "en attente" appartient au site où le
// candidat/étudiant s'est inscrit (etudiant.site_id) — même principe que le reste du projet (un
// admin du site ABOBO ne doit pas voir/gérer les dossiers en attente du site COCODY).
exports.listerDossiersEnAttente = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const admissions = await db.query(`
      SELECT e.id, e.nom, e.prenoms, e.code_paiement, e.source_inscription, e.date_inscription,
             f.nom AS filiere, n.libelle AS niveau, aa.annee AS annee_academique,
             EXTRACT(DAY FROM now() - e.date_inscription)::int AS anciennete_jours
      FROM etudiant e
      LEFT JOIN filiere f ON f.id = e.id_filiere
      LEFT JOIN niveau n ON n.id = e.niveau_id
      LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
      WHERE e.standing = 'en attente' AND e.site_id = $1
      ORDER BY e.date_inscription ASC
    `, [siteId]);

    const reinscriptions = await db.query(`
      SELECT r.id, r.etudiant_id, r.statut, r.created_at, r.code_paiement,
             e.nom, e.prenoms, e.matricule_iipea,
             n.libelle AS niveau_retenu, aa.annee AS annee_academique,
             EXTRACT(DAY FROM now() - r.created_at)::int AS anciennete_jours
      FROM reinscription r
      JOIN etudiant e ON e.id = r.etudiant_id
      LEFT JOIN niveau n ON n.id = r.niveau_retenu_id
      LEFT JOIN anneeacademique aa ON aa.id = r.anneeacademique_id
      WHERE r.statut IN ('en_attente_paiement', 'non_eligible') AND e.site_id = $1
      ORDER BY r.created_at ASC
    `, [siteId]);

    res.status(200).json({
      success: true,
      data: {
        admissions: admissions.rows.map(r => ({ ...r, anciennete_jours: parseInt(r.anciennete_jours, 10) })),
        reinscriptions: reinscriptions.rows.map(r => ({ ...r, anciennete_jours: parseInt(r.anciennete_jours, 10) })),
      },
    });
  } catch (error) {
    console.error('Erreur listerDossiersEnAttente:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// DELETE /api/admin/dossiers-en-attente/admission/:etudiantId — supprime intégralement une
// admission jamais finalisée (candidature, pièces déclarées, scolarité provisoire, document
// administratif s'il n'est référencé par personne d'autre).
exports.supprimerAdmissionEnAttente = async (req, res) => {
  const client = await db.connect();
  try {
    const etudiantId = parseInt(req.params.etudiantId, 10);
    const siteId = req.user.departement_id;
    if (!Number.isInteger(etudiantId)) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    // Cloisonnement par site (correctif 2026-08-20) — sans ce filtre, un admin pouvait supprimer un
    // dossier d'un autre site en appelant directement l'API avec son id, même après correction de la
    // liste (qui ne l'aurait plus laissé le découvrir, mais ne l'empêchait pas de le cibler).
    const etu = await client.query('SELECT id, scolarite_id, document_id FROM etudiant WHERE id = $1 AND site_id = $2', [etudiantId, siteId]);
    if (etu.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dossier introuvable.' });
    }

    await client.query('BEGIN');

    // Garde-fou atomique : verrouille la ligne et vérifie le statut dans la même transaction
    // (FOR UPDATE) — si le dossier a été validé entre l'ouverture de la page et le clic
    // (concurrence), 0 ligne verrouillée ici, rien n'est supprimé. Les tables filles doivent être
    // vidées AVANT `etudiant` (contrainte de clé étrangère de document_etudiant notamment) — la
    // ligne reste donc volontairement en place jusqu'à la fin, protégée par ce verrou.
    const verrou = await client.query(
      `SELECT id FROM etudiant WHERE id = $1 AND standing = 'en attente' AND site_id = $2 FOR UPDATE`,
      [etudiantId, siteId]
    );
    if (verrou.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: "Ce dossier n'est plus en attente — il ne peut pas être supprimé par cet outil." });
    }

    await client.query('DELETE FROM document_etudiant WHERE etudiant_id = $1', [etudiantId]);
    await client.query('DELETE FROM kit WHERE etudiant_id = $1', [etudiantId]);
    await client.query('DELETE FROM prise_en_charge WHERE etudiant_id = $1', [etudiantId]);
    await client.query('DELETE FROM historique_inscription WHERE etudiant_id = $1', [etudiantId]);

    // Paiements/reçus : un dossier "en attente" n'en a normalement jamais eu, vérifié par
    // prudence plutôt que supposé.
    const paiements = await client.query('DELETE FROM paiement WHERE etudiant_id = $1 RETURNING recu_id', [etudiantId]);
    const recuIds = paiements.rows.map(r => r.recu_id).filter(Boolean);
    if (recuIds.length > 0) {
      await client.query('DELETE FROM recu WHERE id = ANY($1::int[])', [recuIds]);
    }

    await client.query('DELETE FROM etudiant WHERE id = $1', [etudiantId]);

    if (etu.rows[0].scolarite_id) {
      await client.query('DELETE FROM scolarite WHERE id = $1', [etu.rows[0].scolarite_id]);
    }
    if (etu.rows[0].document_id) {
      // Ne supprime le document administratif que si aucun autre étudiant ne le référence.
      const autreRef = await client.query('SELECT 1 FROM etudiant WHERE document_id = $1', [etu.rows[0].document_id]);
      if (autreRef.rows.length === 0) {
        await client.query('DELETE FROM document WHERE id = $1', [etu.rows[0].document_id]);
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Dossier supprimé.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur supprimerAdmissionEnAttente:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// DELETE /api/admin/dossiers-en-attente/reinscription/:reinscriptionId — supprime une demande de
// réinscription jamais finalisée. Ne touche jamais document_etudiant : ces lignes sont partagées
// avec le dossier d'admission d'origine de l'étudiant (pas de lien exclusif à cette demande), les
// supprimer risquerait d'effacer des pièces réelles déjà validées à l'admission.
exports.supprimerReinscriptionEnAttente = async (req, res) => {
  try {
    const reinscriptionId = parseInt(req.params.reinscriptionId, 10);
    const siteId = req.user.departement_id;
    if (!Number.isInteger(reinscriptionId)) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    // Cloisonnement par site (correctif 2026-08-20) — même raison que supprimerAdmissionEnAttente.
    const suppression = await db.query(
      `DELETE FROM reinscription r USING etudiant e
       WHERE r.id = $1 AND r.statut != 'inscrit' AND e.id = r.etudiant_id AND e.site_id = $2
       RETURNING r.id`,
      [reinscriptionId, siteId]
    );
    if (suppression.rowCount === 0) {
      const existe = await db.query(
        `SELECT r.id FROM reinscription r JOIN etudiant e ON e.id = r.etudiant_id WHERE r.id = $1 AND e.site_id = $2`,
        [reinscriptionId, siteId]
      );
      if (existe.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Dossier introuvable.' });
      }
      return res.status(409).json({ success: false, message: 'Ce dossier de réinscription est déjà validé — il ne peut pas être supprimé par cet outil.' });
    }

    res.status(200).json({ success: true, message: 'Dossier de réinscription supprimé.' });
  } catch (error) {
    console.error('Erreur supprimerReinscriptionEnAttente:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
