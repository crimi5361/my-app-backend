// Module Gestion des Enseignants (2026-08-11) — Espace Ressources Humaines (§3.2).
//
// Les RH portent trois responsabilités distinctes :
//   • publier des offres, exposées ensuite au site institutionnel (controllers/publicEnseignant) ;
//   • trancher les candidatures reçues (directes ou transmises par un Chargé Pédagogique) ;
//   • à l'acceptation, ouvrir les accès de l'enseignant et fixer ses conditions contractuelles.
const db = require('../config/db.config');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Un enseignant recruté existe sous trois formes complémentaires, créées d'un bloc :
//   enseignant  → l'entité métier du module ;
//   professeur  → le référentiel historique consommé par `enseignement` et les notes ;
//   utilisateur → le compte de connexion au portail (rôle 'enseignant').
const ROLE_ENSEIGNANT = 'enseignant';

/**
 * Mot de passe initial imprévisible, remis une seule fois aux RH pour transmission.
 * Volontairement différent du '@elites@' en dur de user.controller : un compte externe
 * (hors ERP) ne doit pas partager le mot de passe par défaut des agents internes.
 */
function genererMotDePasseTemporaire() {
  return crypto.randomBytes(6).toString('base64url');
}

// ---------------------------------------------------------------------------
//  Offres d'emploi (§3.2 Sourcing)
// ---------------------------------------------------------------------------

exports.getOffres = async (req, res) => {
  try {
    const { statut } = req.query;
    const result = await db.query(
      `SELECT o.*, f.nom AS filiere, n.libelle AS niveau, si.nom AS site_nom,
              u.nom AS publiee_par_nom, b.intitule AS besoin_intitule,
              (SELECT COUNT(*)::int FROM candidature_enseignant c WHERE c.offre_id = o.id) AS nb_candidatures
       FROM offre_emploi_enseignant o
       LEFT JOIN filiere f ON f.id = o.filiere_id
       LEFT JOIN niveau n ON n.id = o.niveau_id
       LEFT JOIN site si ON si.id = o.site_id
       LEFT JOIN utilisateur u ON u.id = o.publiee_par
       LEFT JOIN besoin_enseignant b ON b.id = o.besoin_id
       WHERE ($1::varchar IS NULL OR o.statut = $1)
       ORDER BY o.created_at DESC`,
      [statut || null]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getOffres:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createOffre = async (req, res) => {
  try {
    const {
      titre, description, specialite, besoin_id, filiere_id, niveau_id, site_id,
      type_contrat, volume_horaire_indicatif, profil_recherche, date_cloture, statut,
    } = req.body;

    if (!titre?.trim()) {
      return res.status(400).json({ success: false, message: "L'intitulé de l'offre est obligatoire." });
    }
    const statutInitial = statut === 'publiee' ? 'publiee' : 'brouillon';

    const result = await db.query(
      `INSERT INTO offre_emploi_enseignant
         (reference, titre, description, specialite, besoin_id, filiere_id, niveau_id, site_id,
          type_contrat, volume_horaire_indicatif, profil_recherche, date_publication,
          date_cloture, statut, publiee_par)
       VALUES ('OFF-' || TO_CHAR(now(), 'YY') || '-' || LPAD(nextval('offre_reference_seq')::text, 4, '0'),
               $1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'vacataire'), $9, $10,
               CASE WHEN $12::varchar = 'publiee' THEN CURRENT_DATE ELSE NULL END, $11, $12::varchar, $13)
       RETURNING *`,
      [
        titre.trim(), description?.trim() || null, specialite?.trim() || null,
        besoin_id || null, filiere_id || null, niveau_id || null,
        site_id || req.user.departement_id || null, type_contrat || null,
        volume_horaire_indicatif || null, profil_recherche?.trim() || null,
        date_cloture || null, statutInitial, req.user.id,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur createOffre:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateOffre = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      titre, description, specialite, besoin_id, filiere_id, niveau_id, site_id,
      type_contrat, volume_horaire_indicatif, profil_recherche, date_cloture,
    } = req.body;

    if (!titre?.trim()) {
      return res.status(400).json({ success: false, message: "L'intitulé de l'offre est obligatoire." });
    }

    const result = await db.query(
      `UPDATE offre_emploi_enseignant
       SET titre = $1, description = $2, specialite = $3, besoin_id = $4, filiere_id = $5,
           niveau_id = $6, site_id = $7, type_contrat = COALESCE($8, type_contrat),
           volume_horaire_indicatif = $9, profil_recherche = $10, date_cloture = $11,
           updated_at = now()
       WHERE id = $12 RETURNING *`,
      [
        titre.trim(), description?.trim() || null, specialite?.trim() || null,
        besoin_id || null, filiere_id || null, niveau_id || null, site_id || null,
        type_contrat || null, volume_horaire_indicatif || null,
        profil_recherche?.trim() || null, date_cloture || null, id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Offre introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur updateOffre:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutOffre = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['brouillon', 'publiee', 'cloturee'].includes(statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.' });
    }

    // date_publication n'est posée qu'à la première publication : re-publier une offre
    // clôturée ne doit pas effacer sa date d'origine.
    //
    // Le cast explicite `$1::varchar` est indispensable : sans lui, PostgreSQL déduit un type
    // depuis `SET statut = $1` (varchar) et un autre depuis la comparaison dans le CASE (text),
    // et rejette la requête entière (42P08).
    const result = await db.query(
      `UPDATE offre_emploi_enseignant
       SET statut = $1::varchar,
           date_publication = CASE WHEN $1::varchar = 'publiee' AND date_publication IS NULL
                                   THEN CURRENT_DATE ELSE date_publication END,
           updated_at = now()
       WHERE id = $2 RETURNING *`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Offre introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutOffre:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Candidatures (§3.2 Traitement — phase 2)
// ---------------------------------------------------------------------------

/** Saisie d'une candidature reçue hors ligne (courrier, remise en main propre). */
exports.createCandidatureInterne = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      nom, prenoms, email, telephone, date_naissance, genre, nationalite, grade,
      specialite, annees_experience, lettre_motivation, offre_id, filieres, diplomes,
    } = req.body;

    if (!nom?.trim() || !prenoms?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, message: 'Nom, prénoms et email sont obligatoires.' });
    }

    await client.query('BEGIN');
    const candidature = await client.query(
      `INSERT INTO candidature_enseignant
         (reference, nom, prenoms, email, telephone, date_naissance, genre, nationalite,
          grade, specialite, annees_experience, lettre_motivation, offre_id, source, statut)
       VALUES ('CAND-' || TO_CHAR(now(), 'YY') || '-' || LPAD(nextval('candidature_reference_seq')::text, 5, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'saisie_interne', 'transmise_rh')
       RETURNING *`,
      [
        nom.trim(), prenoms.trim(), email.trim().toLowerCase(), telephone?.trim() || null,
        date_naissance || null, genre || null, nationalite?.trim() || null,
        grade?.trim() || null, specialite?.trim() || null,
        annees_experience ?? null, lettre_motivation?.trim() || null, offre_id || null,
      ]
    );
    const candidatureId = candidature.rows[0].id;

    for (const filiereId of filieres || []) {
      await client.query(
        `INSERT INTO candidature_filiere (candidature_id, filiere_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [candidatureId, filiereId]
      );
    }
    for (const d of diplomes || []) {
      if (!d?.intitule?.trim()) continue;
      await client.query(
        `INSERT INTO candidature_diplome (candidature_id, intitule, etablissement, annee_obtention)
         VALUES ($1, $2, $3, $4)`,
        [candidatureId, d.intitule.trim(), d.etablissement?.trim() || null, d.annee_obtention || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: candidature.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur createCandidatureInterne:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

/**
 * Acceptation d'une candidature (§3.2 Onboarding) — opération tout-ou-rien :
 * profil enseignant, ligne professeur, compte de connexion et changement de statut de
 * la candidature sont posés dans la même transaction. Un enseignant à moitié créé
 * (profil sans accès, ou l'inverse) serait invisible et impossible à rattraper depuis
 * l'interface.
 *
 * Le mot de passe temporaire n'est retourné qu'ici, une seule fois : il n'est stocké
 * que haché.
 */
exports.validerCandidature = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { site_id, ecole_id, commentaire } = req.body;

    await client.query('BEGIN');

    const candidature = await client.query(
      `SELECT * FROM candidature_enseignant WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (candidature.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Candidature introuvable.' });
    }
    const c = candidature.rows[0];

    if (c.statut === 'validee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Cette candidature a déjà été acceptée.' });
    }
    if (c.statut === 'refusee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Cette candidature a été refusée : elle ne peut plus être acceptée.' });
    }

    const emailNormalise = c.email.trim().toLowerCase();
    const dejaUtilise = await client.query(
      `SELECT 1 FROM utilisateur WHERE lower(email) = $1
       UNION ALL SELECT 1 FROM enseignant WHERE lower(email) = $1`,
      [emailNormalise]
    );
    if (dejaUtilise.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `L'adresse ${emailNormalise} est déjà rattachée à un compte existant. Corrigez l'email de la candidature avant de l'accepter.`,
      });
    }

    const roleEnseignant = await client.query(`SELECT id FROM role WHERE nom = $1`, [ROLE_ENSEIGNANT]);
    if (roleEnseignant.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, message: "Le rôle 'enseignant' est absent de la base." });
    }

    const siteId = site_id || req.user.departement_id;
    if (!siteId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Le site de rattachement est requis.' });
    }

    const motDePasse = genererMotDePasseTemporaire();
    const motDePasseHache = await bcrypt.hash(motDePasse, 10);

    const utilisateur = await client.query(
      `INSERT INTO utilisateur (nom, email, mot_de_passe, site_id, role_id, statut, code, ecole_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7) RETURNING id`,
      [
        `${c.nom} ${c.prenoms}`.trim(), emailNormalise, motDePasseHache, siteId,
        roleEnseignant.rows[0].id, String(Math.floor(1000 + Math.random() * 9000)),
        ecole_id || null,
      ]
    );

    const professeur = await client.query(
      `INSERT INTO professeur (nom, prenom, statut) VALUES ($1, $2, 'Actif') RETURNING id`,
      [c.nom, c.prenoms]
    );

    const enseignant = await client.query(
      `INSERT INTO enseignant
         (matricule, candidature_id, professeur_id, utilisateur_id, nom, prenoms, email,
          telephone, grade, specialite, cv_path, site_id, ecole_id)
       VALUES ('ENS' || TO_CHAR(now(), 'YY') || LPAD(nextval('enseignant_matricule_seq')::text, 4, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        c.id, professeur.rows[0].id, utilisateur.rows[0].id, c.nom, c.prenoms, emailNormalise,
        c.telephone, c.grade, c.specialite, c.cv_path, siteId, ecole_id || null,
      ]
    );

    await client.query(
      `UPDATE candidature_enseignant
       SET statut = 'validee', commentaire_rh = $1, rh_valideur_id = $2,
           date_decision = now(), updated_at = now()
       WHERE id = $3`,
      [commentaire?.trim() || null, req.user.id, id]
    );

    await client.query('COMMIT');
    res.status(200).json({
      success: true,
      data: enseignant.rows[0],
      // Remis une seule fois : à communiquer à l'enseignant, non rejouable.
      acces: { identifiant: emailNormalise, mot_de_passe_temporaire: motDePasse },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur validerCandidature:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la création du profil enseignant.' });
  } finally {
    client.release();
  }
};

exports.refuserCandidature = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif } = req.body;
    if (!motif?.trim()) {
      return res.status(400).json({ success: false, message: 'Un motif de refus est requis.' });
    }

    const result = await db.query(
      `UPDATE candidature_enseignant
       SET statut = 'refusee', motif_refus = $1, rh_valideur_id = $2,
           date_decision = now(), updated_at = now()
       WHERE id = $3 AND statut <> 'validee'
       RETURNING *`,
      [motif.trim(), req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Candidature introuvable ou déjà acceptée (le profil enseignant existe : désactivez-le plutôt).',
      });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur refuserCandidature:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Enseignants recrutés
// ---------------------------------------------------------------------------

exports.getEnseignants = async (req, res) => {
  try {
    const { statut, annee_id } = req.query;
    const result = await db.query(
      `SELECT e.id, e.matricule, e.nom, e.prenoms, e.email, e.telephone, e.grade,
              e.specialite, e.cv_path, e.date_recrutement, e.statut, e.site_id, e.ecole_id,
              si.nom AS site_nom, ec.nom AS ecole_nom,
              ct.id AS contrat_id, ct.taux_horaire, ct.volume_horaire_global,
              ct.type_contrat, ct.statut AS contrat_statut,
              (SELECT COUNT(*)::int FROM contrat_classe cc WHERE cc.contrat_id = ct.id) AS nb_classes
       FROM enseignant e
       LEFT JOIN site si ON si.id = e.site_id
       LEFT JOIN ecole ec ON ec.id = e.ecole_id
       LEFT JOIN contrat_enseignant ct ON ct.enseignant_id = e.id
            AND ct.statut = 'actif' AND ($2::int IS NULL OR ct.annee_academique_id = $2)
       WHERE ($1::varchar IS NULL OR e.statut = $1)
       ORDER BY e.nom, e.prenoms`,
      [statut || null, annee_id || null]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getEnseignants:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getEnseignant = async (req, res) => {
  try {
    const { id } = req.params;
    const enseignant = await db.query(
      `SELECT e.*, si.nom AS site_nom, ec.nom AS ecole_nom, u.email AS identifiant,
              u.statut AS compte_statut, ce.reference AS candidature_reference
       FROM enseignant e
       LEFT JOIN site si ON si.id = e.site_id
       LEFT JOIN ecole ec ON ec.id = e.ecole_id
       LEFT JOIN utilisateur u ON u.id = e.utilisateur_id
       LEFT JOIN candidature_enseignant ce ON ce.id = e.candidature_id
       WHERE e.id = $1`,
      [id]
    );
    if (enseignant.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Enseignant introuvable.' });
    }

    const contrats = await db.query(
      `SELECT ct.*, aa.annee AS annee_academique, u.nom AS etabli_par_nom,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT('id', cl.id, 'nom', cl.nom))
                  FILTER (WHERE cl.id IS NOT NULL), '[]'
              ) AS classes
       FROM contrat_enseignant ct
       LEFT JOIN anneeacademique aa ON aa.id = ct.annee_academique_id
       LEFT JOIN utilisateur u ON u.id = ct.etabli_par
       LEFT JOIN contrat_classe cc ON cc.contrat_id = ct.id
       LEFT JOIN classe cl ON cl.id = cc.classe_id
       WHERE ct.enseignant_id = $1
       GROUP BY ct.id, aa.annee, u.nom
       ORDER BY ct.created_at DESC`,
      [id]
    );

    res.status(200).json({
      success: true,
      data: { ...enseignant.rows[0], contrats: contrats.rows },
    });
  } catch (error) {
    console.error('Erreur getEnseignant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Désactivation : le profil et le compte de connexion suivent le même sort. */
exports.setStatutEnseignant = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['actif', 'inactif'].includes(statut)) {
      return res.status(400).json({ success: false, message: "Le statut doit être 'actif' ou 'inactif'." });
    }

    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE enseignant SET statut = $1, updated_at = now() WHERE id = $2
       RETURNING id, utilisateur_id, professeur_id`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Enseignant introuvable.' });
    }
    const { utilisateur_id, professeur_id } = result.rows[0];

    if (utilisateur_id) {
      await client.query(`UPDATE utilisateur SET statut = $1 WHERE id = $2`,
        [statut === 'actif' ? 'active' : 'inactive', utilisateur_id]);
    }
    if (professeur_id) {
      await client.query(`UPDATE professeur SET statut = $1 WHERE id = $2`,
        [statut === 'actif' ? 'Actif' : 'Inactif', professeur_id]);
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur setStatutEnseignant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

/** Régénère un mot de passe temporaire (enseignant ayant perdu ses accès). */
exports.reinitialiserAcces = async (req, res) => {
  try {
    const { id } = req.params;
    const enseignant = await db.query(
      `SELECT e.utilisateur_id, u.email FROM enseignant e
       JOIN utilisateur u ON u.id = e.utilisateur_id WHERE e.id = $1`,
      [id]
    );
    if (enseignant.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Cet enseignant n'a pas de compte rattaché." });
    }

    const motDePasse = genererMotDePasseTemporaire();
    await db.query(`UPDATE utilisateur SET mot_de_passe = $1 WHERE id = $2`,
      [await bcrypt.hash(motDePasse, 10), enseignant.rows[0].utilisateur_id]);

    res.status(200).json({
      success: true,
      acces: { identifiant: enseignant.rows[0].email, mot_de_passe_temporaire: motDePasse },
    });
  } catch (error) {
    console.error('Erreur reinitialiserAcces:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Contrats (§3.2 Onboarding et Contrat)
// ---------------------------------------------------------------------------

exports.getContrats = async (req, res) => {
  try {
    const { annee_id, statut } = req.query;
    const result = await db.query(
      `SELECT ct.*, e.matricule, e.nom, e.prenoms, e.grade, e.specialite,
              aa.annee AS annee_academique,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT('id', cl.id, 'nom', cl.nom))
                  FILTER (WHERE cl.id IS NOT NULL), '[]'
              ) AS classes,
              (ct.taux_horaire * ct.volume_horaire_global)::numeric(14,2) AS cout_previsionnel
       FROM contrat_enseignant ct
       JOIN enseignant e ON e.id = ct.enseignant_id
       LEFT JOIN anneeacademique aa ON aa.id = ct.annee_academique_id
       LEFT JOIN contrat_classe cc ON cc.contrat_id = ct.id
       LEFT JOIN classe cl ON cl.id = cc.classe_id
       WHERE ($1::int IS NULL OR ct.annee_academique_id = $1)
         AND ($2::varchar IS NULL OR ct.statut = $2)
       GROUP BY ct.id, e.id, aa.annee
       ORDER BY ct.created_at DESC`,
      [annee_id || null, statut || null]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getContrats:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createContrat = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      enseignant_id, annee_academique_id, type_contrat, taux_horaire,
      volume_horaire_global, date_debut, date_fin, observations, classes,
    } = req.body;

    if (!enseignant_id || !annee_academique_id || taux_horaire == null || volume_horaire_global == null) {
      return res.status(400).json({
        success: false,
        message: 'Enseignant, année, taux horaire et volume horaire global sont obligatoires.',
      });
    }
    if (!Array.isArray(classes) || classes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Définissez au moins une classe d'intervention : sans elle, le Chargé Pédagogique ne pourra pas planifier cet enseignant.",
      });
    }

    await client.query('BEGIN');
    const contrat = await client.query(
      `INSERT INTO contrat_enseignant
         (enseignant_id, annee_academique_id, type_contrat, taux_horaire, volume_horaire_global,
          date_debut, date_fin, observations, etabli_par)
       VALUES ($1, $2, COALESCE($3, 'vacataire'), $4, $5, COALESCE($6, CURRENT_DATE), $7, $8, $9)
       RETURNING *`,
      [
        enseignant_id, annee_academique_id, type_contrat || null, taux_horaire,
        volume_horaire_global, date_debut || null, date_fin || null,
        observations?.trim() || null, req.user.id,
      ]
    );

    for (const classeId of classes) {
      await client.query(
        `INSERT INTO contrat_classe (contrat_id, classe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [contrat.rows[0].id, classeId]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: contrat.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Cet enseignant a déjà un contrat actif pour cette année académique. Modifiez-le ou clôturez-le d\'abord.',
      });
    }
    console.error('Erreur createContrat:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.updateContrat = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const {
      type_contrat, taux_horaire, volume_horaire_global, date_debut, date_fin,
      observations, classes,
    } = req.body;

    await client.query('BEGIN');
    const contrat = await client.query(
      `UPDATE contrat_enseignant
       SET type_contrat = COALESCE($1, type_contrat), taux_horaire = COALESCE($2, taux_horaire),
           volume_horaire_global = COALESCE($3, volume_horaire_global),
           date_debut = COALESCE($4, date_debut), date_fin = $5,
           observations = $6, updated_at = now()
       WHERE id = $7 RETURNING *`,
      [
        type_contrat || null, taux_horaire ?? null, volume_horaire_global ?? null,
        date_debut || null, date_fin || null, observations?.trim() || null, id,
      ]
    );
    if (contrat.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Contrat introuvable.' });
    }

    if (Array.isArray(classes)) {
      // Retirer une classe déjà planifiée laisserait des séances rattachées à un
      // enseignant qui n'a plus le droit d'y intervenir : on refuse plutôt que
      // d'invalider silencieusement l'emploi du temps existant.
      const retirees = await client.query(
        `SELECT cl.nom FROM contrat_classe cc
         JOIN classe cl ON cl.id = cc.classe_id
         WHERE cc.contrat_id = $1 AND NOT (cc.classe_id = ANY($2::int[]))
           AND EXISTS (
             SELECT 1 FROM seance_edt s
             JOIN contrat_enseignant ct ON ct.id = $1
             WHERE s.classe_id = cc.classe_id AND s.enseignant_id = ct.enseignant_id
               AND s.statut <> 'annulee'
           )`,
        [id, classes]
      );
      if (retirees.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: `Impossible de retirer ${retirees.rows.map((r) => r.nom).join(', ')} : des séances y sont déjà planifiées pour cet enseignant.`,
        });
      }

      await client.query(`DELETE FROM contrat_classe WHERE contrat_id = $1`, [id]);
      for (const classeId of classes) {
        await client.query(
          `INSERT INTO contrat_classe (contrat_id, classe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, classeId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: contrat.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur updateContrat:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.setStatutContrat = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['actif', 'suspendu', 'termine'].includes(statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.' });
    }
    const result = await db.query(
      `UPDATE contrat_enseignant SET statut = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contrat introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Un autre contrat est déjà actif pour cet enseignant sur cette année académique.',
      });
    }
    console.error('Erreur setStatutContrat:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Affectations des Chargés Pédagogiques (§3.1 « Gestion des affectations »)
// ---------------------------------------------------------------------------

exports.getChargesPedagogiques = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.nom, u.email, u.statut, si.nom AS site_nom,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'id', acp.id, 'filiere_id', f.id, 'filiere', f.nom,
                  'niveau_id', n.id, 'niveau', n.libelle
                )) FILTER (WHERE acp.id IS NOT NULL), '[]'
              ) AS affectations
       FROM utilisateur u
       JOIN role r ON r.id = u.role_id
       LEFT JOIN site si ON si.id = u.site_id
       LEFT JOIN affectation_charge_pedagogique acp ON acp.utilisateur_id = u.id
       LEFT JOIN filiere f ON f.id = acp.filiere_id
       LEFT JOIN niveau n ON n.id = acp.niveau_id
       WHERE r.nom = 'charge_pedagogique'
       GROUP BY u.id, si.nom
       ORDER BY u.nom`
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getChargesPedagogiques:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.affecterChargePedagogique = async (req, res) => {
  try {
    const { utilisateur_id, filiere_id, niveau_id } = req.body;
    if (!utilisateur_id || !filiere_id) {
      return res.status(400).json({ success: false, message: 'Chargé Pédagogique et filière sont obligatoires.' });
    }

    const result = await db.query(
      `INSERT INTO affectation_charge_pedagogique (utilisateur_id, filiere_id, niveau_id, affecte_par)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [utilisateur_id, filiere_id, niveau_id || null, req.user.id]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Cette affectation existe déjà.' });
    }
    console.error('Erreur affecterChargePedagogique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.retirerAffectation = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `DELETE FROM affectation_charge_pedagogique WHERE id = $1 RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Affectation introuvable.' });
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erreur retirerAffectation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Tableau de bord RH
// ---------------------------------------------------------------------------

exports.getDashboard = async (req, res) => {
  try {
    const { annee_id } = req.query;

    const [candidatures, offres, enseignants, contrats, recentes, masse, aDecider] = await Promise.all([
      db.query(`SELECT statut, COUNT(*)::int AS total FROM candidature_enseignant GROUP BY statut`),
      db.query(`SELECT statut, COUNT(*)::int AS total FROM offre_emploi_enseignant GROUP BY statut`),
      db.query(`SELECT statut, COUNT(*)::int AS total FROM enseignant GROUP BY statut`),
      db.query(
        `SELECT ct.statut, COUNT(*)::int AS total FROM contrat_enseignant ct
         WHERE ($1::int IS NULL OR ct.annee_academique_id = $1) GROUP BY ct.statut`,
        [annee_id || null]
      ),
      db.query(
        `SELECT ce.id, ce.reference, ce.nom, ce.prenoms, ce.specialite, ce.statut, ce.created_at,
                o.titre AS offre_titre
         FROM candidature_enseignant ce
         LEFT JOIN offre_emploi_enseignant o ON o.id = ce.offre_id
         ORDER BY ce.created_at DESC LIMIT 10`
      ),
      // Engagement prévisionnel : taux horaire × volume contractualisé, l'indicateur
      // financier que les RH pilotent réellement.
      db.query(
        `SELECT COALESCE(SUM(ct.taux_horaire * ct.volume_horaire_global), 0)::numeric(14,2) AS total,
                COALESCE(SUM(ct.volume_horaire_global), 0)::int AS heures
         FROM contrat_enseignant ct
         WHERE ct.statut = 'actif' AND ($1::int IS NULL OR ct.annee_academique_id = $1)`,
        [annee_id || null]
      ),
      // §3.2 : attendent une décision RH les dossiers transmis par un Chargé Pédagogique ET
      // ceux déposés directement sur une offre publiée. Même définition que l'onglet
      // « À décider » de l'écran Candidatures — les deux doivent afficher le même nombre.
      db.query(
        `SELECT COUNT(*)::int AS total FROM candidature_enseignant
         WHERE statut = 'transmise_rh' OR (statut = 'recue' AND offre_id IS NOT NULL)`
      ),
    ]);

    const parStatut = (rows) => rows.reduce((acc, r) => ({ ...acc, [r.statut]: r.total }), {});

    res.status(200).json({
      success: true,
      data: {
        candidatures: parStatut(candidatures.rows),
        a_decider: aDecider.rows[0].total,
        offres: parStatut(offres.rows),
        enseignants: parStatut(enseignants.rows),
        contrats: parStatut(contrats.rows),
        engagement: masse.rows[0],
        candidatures_recentes: recentes.rows,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboard RH:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
