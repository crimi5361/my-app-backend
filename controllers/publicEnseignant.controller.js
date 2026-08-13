// Module Gestion des Enseignants (2026-08-11) — porte d'entrée publique.
//
// C'est par ici que les candidatures arrivent : le site institutionnel affiche les offres
// publiées et poste le formulaire de candidature. Aucune authentification, donc :
//   • seules les données strictement nécessaires au formulaire sont exposées (pas les
//     commentaires internes, pas les besoins, pas les décisions) ;
//   • rien de ce que le candidat envoie ne détermine son statut : toute candidature entre
//     en 'recue' et suit le workflow §4 (CP puis RH).
const db = require('../config/db.config');

/** Offres actuellement ouvertes, dans la forme attendue par une page « Nous recrutons ». */
exports.getOffresPubliques = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.reference, o.titre, o.description, o.specialite, o.type_contrat,
              o.volume_horaire_indicatif, o.profil_recherche, o.date_publication, o.date_cloture,
              f.nom AS filiere, n.libelle AS niveau, si.nom AS site
       FROM offre_emploi_enseignant o
       LEFT JOIN filiere f ON f.id = o.filiere_id
       LEFT JOIN niveau n ON n.id = o.niveau_id
       LEFT JOIN site si ON si.id = o.site_id
       WHERE o.statut = 'publiee'
         AND (o.date_cloture IS NULL OR o.date_cloture >= CURRENT_DATE)
       ORDER BY o.date_publication DESC NULLS LAST, o.created_at DESC`
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getOffresPubliques:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getOffrePublique = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.id, o.reference, o.titre, o.description, o.specialite, o.type_contrat,
              o.volume_horaire_indicatif, o.profil_recherche, o.date_publication, o.date_cloture,
              f.nom AS filiere, n.libelle AS niveau, si.nom AS site
       FROM offre_emploi_enseignant o
       LEFT JOIN filiere f ON f.id = o.filiere_id
       LEFT JOIN niveau n ON n.id = o.niveau_id
       LEFT JOIN site si ON si.id = o.site_id
       WHERE o.reference = $1 AND o.statut = 'publiee'`,
      [req.params.reference]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Offre introuvable ou clôturée.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur getOffrePublique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Filières proposables dans le formulaire (le candidat indique celles qu'il vise). */
exports.getFilieresPubliques = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.id, f.nom, f.sigle, d.nom AS departement
       FROM filiere f
       LEFT JOIN departement d ON d.id = f.departement_id
       ORDER BY f.nom`
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getFilieresPubliques:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Dépôt d'une candidature (multipart : champ `cv`, champs `diplomes[]`).
 *
 * `filieres` et `diplomes` arrivent en JSON encodé dans le FormData — un FormData ne
 * transporte que des chaînes et des fichiers.
 */
exports.deposerCandidature = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      nom, prenoms, email, telephone, date_naissance, genre, nationalite,
      grade, specialite, annees_experience, lettre_motivation, offre_reference,
    } = req.body;

    if (!nom?.trim() || !prenoms?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, message: 'Nom, prénoms et email sont obligatoires.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }

    const analyserListe = (valeur) => {
      if (!valeur) return [];
      try {
        const parsed = typeof valeur === 'string' ? JSON.parse(valeur) : valeur;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const filieres = analyserListe(req.body.filieres);
    const diplomes = analyserListe(req.body.diplomes);

    const emailNormalise = email.trim().toLowerCase();

    await client.query('BEGIN');

    // Une même personne ne doit pas saturer la bannette en renvoyant dix fois le même
    // dossier ; en revanche, re-postuler après un refus (ou sur une autre offre) reste légitime.
    const enCours = await client.query(
      `SELECT reference FROM candidature_enseignant
       WHERE lower(email) = $1 AND statut IN ('recue', 'preselectionnee', 'transmise_rh')
       LIMIT 1`,
      [emailNormalise]
    );
    if (enCours.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Une candidature est déjà en cours d'examen pour cette adresse (référence ${enCours.rows[0].reference}).`,
      });
    }

    let offreId = null;
    if (offre_reference) {
      const offre = await client.query(
        `SELECT id FROM offre_emploi_enseignant
         WHERE reference = $1 AND statut = 'publiee'
           AND (date_cloture IS NULL OR date_cloture >= CURRENT_DATE)`,
        [offre_reference]
      );
      if (offre.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: "Cette offre n'est plus ouverte aux candidatures." });
      }
      offreId = offre.rows[0].id;
    }

    const cv = req.files?.cv?.[0] || null;
    const candidature = await client.query(
      `INSERT INTO candidature_enseignant
         (reference, nom, prenoms, email, telephone, date_naissance, genre, nationalite,
          grade, specialite, annees_experience, cv_path, cv_original_name,
          lettre_motivation, offre_id, source, statut)
       VALUES ('CAND-' || TO_CHAR(now(), 'YY') || '-' || LPAD(nextval('candidature_reference_seq')::text, 5, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'portail_public', 'recue')
       RETURNING id, reference`,
      [
        nom.trim(), prenoms.trim(), emailNormalise, telephone?.trim() || null,
        date_naissance || null, ['M', 'F', 'Autre'].includes(genre) ? genre : null,
        nationalite?.trim() || null, grade?.trim() || null, specialite?.trim() || null,
        Number.isFinite(Number(annees_experience)) ? Number(annees_experience) : null,
        cv ? `/uploads/candidatures/${cv.filename}` : null,
        cv ? cv.originalname : null,
        lettre_motivation?.trim() || null, offreId,
      ]
    );
    const candidatureId = candidature.rows[0].id;

    for (const filiereId of filieres) {
      // Ignorer silencieusement un id inexistant : le formulaire public ne doit pas
      // permettre de sonder la base par essais successifs.
      await client.query(
        `INSERT INTO candidature_filiere (candidature_id, filiere_id)
         SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM filiere WHERE id = $2)
         ON CONFLICT DO NOTHING`,
        [candidatureId, filiereId]
      );
    }

    const fichiersDiplomes = req.files?.diplomes || [];
    for (let i = 0; i < diplomes.length; i += 1) {
      const d = diplomes[i];
      if (!d?.intitule?.trim()) continue;
      const fichier = fichiersDiplomes[i];
      await client.query(
        `INSERT INTO candidature_diplome (candidature_id, intitule, etablissement, annee_obtention, fichier_path)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          candidatureId, d.intitule.trim(), d.etablissement?.trim() || null,
          Number.isFinite(Number(d.annee_obtention)) ? Number(d.annee_obtention) : null,
          fichier ? `/uploads/candidatures/${fichier.filename}` : null,
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      message: 'Votre candidature a bien été enregistrée. Elle sera examinée par nos équipes.',
      reference: candidature.rows[0].reference,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur deposerCandidature:', error);
    res.status(500).json({ success: false, message: "Erreur lors de l'enregistrement de la candidature." });
  } finally {
    client.release();
  }
};

/** Suivi par référence — permet au candidat de savoir où en est son dossier. */
exports.suivreCandidature = async (req, res) => {
  try {
    const { reference } = req.params;
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, message: "L'email utilisé lors du dépôt est requis." });
    }

    // La référence seule ne suffit pas : la recouper avec l'email évite qu'une référence
    // devinée expose l'état du dossier de quelqu'un d'autre.
    const result = await db.query(
      `SELECT reference, nom, prenoms, statut, created_at, date_decision
       FROM candidature_enseignant
       WHERE reference = $1 AND lower(email) = $2`,
      [reference, String(email).trim().toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune candidature ne correspond à ces informations.' });
    }

    // Les statuts internes (bannette CP, transmission) n'ont pas à être exposés au candidat.
    const ETAT_PUBLIC = {
      recue: 'Reçue',
      preselectionnee: 'En cours d\'examen',
      transmise_rh: 'En cours d\'examen',
      validee: 'Acceptée',
      refusee: 'Non retenue',
    };
    const c = result.rows[0];
    res.status(200).json({
      success: true,
      data: {
        reference: c.reference,
        candidat: `${c.prenoms} ${c.nom}`,
        etat: ETAT_PUBLIC[c.statut] || 'En cours d\'examen',
        depose_le: c.created_at,
        decide_le: c.date_decision,
      },
    });
  } catch (error) {
    console.error('Erreur suivreCandidature:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
