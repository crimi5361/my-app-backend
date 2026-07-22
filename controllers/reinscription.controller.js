const db = require('../config/db.config');
const PVController = require('./PV.controller');
const PaiementEspaceController = require('./PaiementEespaceetudiant.controller');
const TarifController = require('./tarif.controller');
const { validatePhotoFile } = require('./etudiant.controller');
const { affecterClasseEtGroupe } = require('../services/classeGroupe.service');
const { avecRetryCodeUnique } = require('../services/codePaiement.service');

const IDENTITE_FIELDS = [
  'telephone', 'email', 'lieu_residence', 'contact_parent', 'contact_parent_2',
  'adresse_parent_1', 'adresse_parent_2', 'numero_acte_naissance', 'numero_piece_identite',
  'mention_bac', 'session_bac'
];

// Année académique "en cour" pour un site donné — jamais laissée au choix de l'agent.
const getAnneeEnCoursPourSite = async (siteId) => {
  const result = await db.query(
    `SELECT a.id, a.annee FROM anneeacademique a
     JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
     WHERE s.site_id = $1 AND s.etat = 'en cour'
     LIMIT 1`,
    [siteId]
  );
  return result.rows[0] || null;
};

// ─── GET recherche d'étudiant par nom / prénoms / matricule IIPEA ──────────
exports.rechercherEtudiant = async (req, res) => {
  try {
    const { q } = req.query;
    const siteId = req.user?.departement_id;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site non identifié pour votre compte.' });
    }

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              f.nom AS filiere, n.libelle AS niveau
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       WHERE e.site_id = $1
         AND e.standing = 'Inscrit'
         AND (
           e.nom ILIKE $2 OR e.prenoms ILIKE $2 OR e.matricule_iipea ILIKE $2
           OR (e.nom || ' ' || e.prenoms) ILIKE $2
           OR (e.prenoms || ' ' || e.nom) ILIKE $2
         )
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      [siteId, `%${q.trim()}%`]
    );

    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET dossier complet d'un étudiant pour réinscription ──────────────────
exports.getDossierReinscription = async (req, res) => {
  try {
    const { id } = req.params;

    const etudiantResult = await db.query(
      `SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.date_naissance, e.photo_url,
              e.telephone, e.email, e.lieu_residence, e.contact_parent, e.contact_parent_2,
              e.nom_parent_1, e.nom_parent_2, e.adresse_parent_1, e.adresse_parent_2,
              e.numero_acte_naissance, e.numero_piece_identite, e.mention_bac, e.session_bac,
              e.engagement_accepte, e.ip_ministere, e.statut_scolaire,
              e.niveau_id, e.id_filiere, e.site_id, e.annee_academique_id, e.scolarite_id,
              n.libelle AS niveau_libelle, n.niveau_suivant_id,
              f.nom AS filiere_nom, f.departement_id,
              d.nom AS departement_nom, d.ecole_id,
              ec.nom AS ecole_nom,
              s.nom AS site_nom
       FROM etudiant e
       JOIN niveau n ON n.id = e.niveau_id
       JOIN filiere f ON f.id = e.id_filiere
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       JOIN site s ON s.id = e.site_id
       WHERE e.id = $1`,
      [id]
    );

    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    // Niveau proposé (successeur configuré, même filière) + tarif associé
    let niveauPropose = null;
    if (etudiant.niveau_suivant_id) {
      const niveauProposeResult = await db.query(
        `SELECT n.id, n.libelle, n.filiere_id FROM niveau n WHERE n.id = $1`,
        [etudiant.niveau_suivant_id]
      );
      niveauPropose = niveauProposeResult.rows[0] || null;
      if (niveauPropose) {
        niveauPropose.tarif = await TarifController.calculerMontantScolarite(niveauPropose.id, etudiant.statut_scolaire, 'reinscription');
      }
    }

    // Situation financière / académique de l'année en cours (services réutilisés)
    const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(etudiant.id);

    let situationAcademique = null;
    let academiqueErreur = null;
    try {
      situationAcademique = await PVController.calculerResultatsAnnuelsEtudiant(etudiant.id);
    } catch (err) {
      academiqueErreur = err.message;
    }

    // Progression suggérée : ADMIS/DÉROGÉ → niveau supérieur ; sinon redoublement
    let niveauRetenuPropose = etudiant.niveau_id;
    if (situationAcademique && ['ADMIS', 'DÉROGÉ'].includes(situationAcademique.decision) && niveauPropose) {
      niveauRetenuPropose = niveauPropose.id;
    }

    // Année académique cible : toujours l'année "en cour" du site, jamais un choix manuel
    const anneeCible = await getAnneeEnCoursPourSite(etudiant.site_id);

    const reinscriptionExistante = await db.query(
      `SELECT * FROM reinscription WHERE etudiant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [etudiant.id]
    );

    const tarifNiveauActuel = await TarifController.calculerMontantScolarite(etudiant.niveau_id, etudiant.statut_scolaire, 'reinscription');

    res.status(200).json({
      success: true,
      data: {
        etudiant,
        hierarchie: {
          ecole: etudiant.ecole_nom,
          departement: etudiant.departement_nom,
          filiere: etudiant.filiere_nom,
          niveau: etudiant.niveau_libelle,
          site: etudiant.site_nom
        },
        situation_financiere: situationFinanciere,
        situation_academique: situationAcademique,
        situation_academique_erreur: academiqueErreur,
        niveau_propose: niveauPropose,
        niveau_retenu_propose: niveauRetenuPropose,
        tarif_niveau_actuel: tarifNiveauActuel,
        annee_cible: anneeCible,
        reinscription_existante: reinscriptionExistante.rows[0] || null
      }
    });
  } catch (error) {
    console.error('Erreur getDossierReinscription:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST demander la réinscription (agent) ─────────────────────────────────
// Étapes 1-2-3 du nouveau workflow : l'agent saisit le dossier, le système vérifie les
// conditions académiques + financières, et — si éligible — génère un code de paiement et
// bascule le dossier en 'en_attente_paiement'. Contrairement à l'ancien finaliserReinscription,
// AUCUNE mise à jour de niveau/année/filière/classe/groupe/standing n'est faite ici : ces
// changements ne deviennent définitifs qu'à la validation du paiement en caisse
// (voir validerPaiementReinscription dans caisse.controller.js).
exports.demanderReinscription = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { niveau_retenu_id, id_filiere, nombre_versements_prevu, modalite_paiement } = req.body;

    if (!niveau_retenu_id) {
      return res.status(400).json({ success: false, message: 'Le niveau retenu est requis.' });
    }

    const etudiantResult = await client.query('SELECT * FROM etudiant WHERE id = $1', [id]);
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    // Année cible déterminée côté serveur (jamais fournie par le client)
    const anneeCible = await getAnneeEnCoursPourSite(etudiant.site_id);
    if (!anneeCible) {
      return res.status(409).json({ success: false, message: "Aucune année académique en cours pour ce site." });
    }

    const existingResult = await client.query(
      `SELECT * FROM reinscription WHERE etudiant_id = $1 AND anneeacademique_id = $2 FOR UPDATE`,
      [id, anneeCible.id]
    );
    const existing = existingResult.rows[0] || null;
    if (existing && existing.statut === 'inscrit') {
      return res.status(409).json({
        success: false,
        code: 'DEJA_INSCRIT',
        message: "Cet étudiant est déjà réinscrit et son paiement a déjà été validé pour cette année académique."
      });
    }

    const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(id);
    let situationAcademique = null;
    try {
      situationAcademique = await PVController.calculerResultatsAnnuelsEtudiant(id);
    } catch (err) {
      console.warn('Résultats académiques indisponibles pour réinscription:', err.message);
    }

    const niveauActuelResult = await client.query('SELECT niveau_suivant_id FROM niveau WHERE id = $1', [etudiant.niveau_id]);
    const niveauProposeId = niveauActuelResult.rows[0]?.niveau_suivant_id || niveau_retenu_id;

    // Changement de cycle : filière différente de l'actuelle → bascule automatique en Non affecté
    const changementDeCycle = !!id_filiere && parseInt(id_filiere, 10) !== etudiant.id_filiere;
    const statutFinal = changementDeCycle ? 'Non affecté' : etudiant.statut_scolaire;

    // Montant calculé côté serveur (jamais fourni par le client) à partir de la grille de tarifs.
    // contexte='reinscription' : un étudiant déjà Affecté qui progresse dans le même cycle
    // conserve l'ancien tarif (150 000) — un changement de cycle a déjà basculé statutFinal sur
    // "Non affecté" ci-dessus, donc cette distinction ne s'applique jamais dans ce cas.
    const tarifApplicable = await TarifController.calculerMontantScolarite(niveau_retenu_id, statutFinal, 'reinscription');
    const montantAnnuel = tarifApplicable ? tarifApplicable.montant : null;

    // Éligibilité : financièrement conforme (soldé) ET année académique validée (ADMIS/DÉROGÉ)
    // — même critère que celui déjà utilisé pour suggérer la progression de niveau.
    const financierConforme = !situationFinanciere || situationFinanciere.is_solde;
    const academiqueValide = !!situationAcademique && ['ADMIS', 'DÉROGÉ'].includes(situationAcademique.decision);
    const eligible = financierConforme && academiqueValide && montantAnnuel !== null;

    const motifs = [];
    if (!financierConforme) {
      motifs.push(`Scolarité de l'année précédente non soldée (reste à payer : ${situationFinanciere.scolarite_restante} FCFA).`);
    }
    if (!academiqueValide) {
      motifs.push(`Année académique non validée (décision : ${situationAcademique?.decision || 'non évaluée'}).`);
    }
    if (montantAnnuel === null) {
      motifs.push("Aucun tarif configuré pour ce niveau.");
    }
    const motifNonEligibilite = motifs.length > 0 ? motifs.join(' ') : null;

    // Photo (webcam ou remplacement) — optionnelle, appliquée immédiatement : une correction
    // de fiche d'identité n'a pas de raison d'attendre le passage en caisse.
    let photoUrl = null;
    const photoFile = Array.isArray(req.files) ? req.files.find(f => f.fieldname === 'photo') : null;
    if (photoFile) {
      const validation = validatePhotoFile(photoFile);
      if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
      }
      photoUrl = `/uploads/photos/${photoFile.filename}`;
    }

    await client.query('BEGIN');

    // Champs d'identité éditables + photo — appliqués tout de suite, indépendamment de
    // l'éligibilité au paiement (utile pour compléter les anciennes fiches incomplètes).
    const identiteValues = IDENTITE_FIELDS.map(f => req.body[f] || null);
    await client.query(
      `UPDATE etudiant SET
         photo_url = COALESCE($1, photo_url),
         telephone = COALESCE($2, telephone),
         email = COALESCE($3, email),
         lieu_residence = COALESCE($4, lieu_residence),
         contact_parent = COALESCE($5, contact_parent),
         contact_parent_2 = COALESCE($6, contact_parent_2),
         adresse_parent_1 = COALESCE($7, adresse_parent_1),
         adresse_parent_2 = COALESCE($8, adresse_parent_2),
         numero_acte_naissance = COALESCE($9, numero_acte_naissance),
         numero_piece_identite = COALESCE($10, numero_piece_identite),
         mention_bac = COALESCE($11, mention_bac),
         session_bac = COALESCE($12, session_bac)
       WHERE id = $13`,
      [photoUrl, ...identiteValues, id]
    );

    const decisionAcademique = situationAcademique?.decision || 'NON_EVALUE';
    const versementsPrevu = nombre_versements_prevu ? parseInt(nombre_versements_prevu, 10) : null;

    let codePaiement = null;
    let statutDossier;
    if (eligible) {
      statutDossier = 'en_attente_paiement';
      // Réutilise le code déjà attribué à une précédente demande non finalisée (l'étudiant
      // a pu revenir corriger son dossier) plutôt que d'en régénérer un nouveau à chaque fois.
      codePaiement = existing && existing.code_paiement ? existing.code_paiement : null;
    } else {
      statutDossier = 'non_eligible';
    }

    const upsertOnce = async (code) => client.query(
      `INSERT INTO reinscription (
         etudiant_id, anneeacademique_id, niveau_precedent_id, niveau_propose_id, niveau_retenu_id,
         moyenne_annuelle, credits_valides, credits_total, decision_academique, matieres_a_reprendre,
         scolarite_soldee, montant_restant_precedent, montant_annuel_nouveau, statut, traite_par,
         code_paiement, nombre_versements_prevu, modalite_paiement, motif_non_eligibilite,
         id_filiere_retenu, statut_scolaire_retenu
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (etudiant_id, anneeacademique_id) DO UPDATE SET
         niveau_retenu_id = EXCLUDED.niveau_retenu_id,
         moyenne_annuelle = EXCLUDED.moyenne_annuelle,
         credits_valides = EXCLUDED.credits_valides,
         credits_total = EXCLUDED.credits_total,
         decision_academique = EXCLUDED.decision_academique,
         matieres_a_reprendre = EXCLUDED.matieres_a_reprendre,
         scolarite_soldee = EXCLUDED.scolarite_soldee,
         montant_restant_precedent = EXCLUDED.montant_restant_precedent,
         montant_annuel_nouveau = EXCLUDED.montant_annuel_nouveau,
         statut = EXCLUDED.statut,
         traite_par = EXCLUDED.traite_par,
         code_paiement = EXCLUDED.code_paiement,
         nombre_versements_prevu = EXCLUDED.nombre_versements_prevu,
         modalite_paiement = EXCLUDED.modalite_paiement,
         motif_non_eligibilite = EXCLUDED.motif_non_eligibilite,
         id_filiere_retenu = EXCLUDED.id_filiere_retenu,
         statut_scolaire_retenu = EXCLUDED.statut_scolaire_retenu,
         updated_at = now()
       RETURNING id`,
      [
        id, anneeCible.id, etudiant.niveau_id, niveauProposeId, niveau_retenu_id,
        situationAcademique?.moyenne_generale ?? null, situationAcademique?.credits_valides ?? null,
        situationAcademique?.credits_total ?? null, decisionAcademique,
        situationAcademique ? JSON.stringify(situationAcademique.ecue_a_reprendre) : null,
        situationFinanciere?.is_solde ?? false, situationFinanciere?.scolarite_restante ?? 0,
        montantAnnuel, statutDossier, req.user?.id || null,
        code, versementsPrevu, modalite_paiement || null, motifNonEligibilite,
        changementDeCycle ? parseInt(id_filiere, 10) : etudiant.id_filiere, statutFinal
      ]
    );

    let reinscriptionId;
    if (eligible && !codePaiement) {
      const result = await avecRetryCodeUnique('RI', async (candidat) => {
        const r = await upsertOnce(candidat);
        codePaiement = candidat;
        return r;
      });
      reinscriptionId = result.rows[0].id;
    } else {
      const result = await upsertOnce(codePaiement);
      reinscriptionId = result.rows[0].id;
    }

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: eligible
        ? 'Demande de réinscription enregistrée : en attente de paiement en caisse.'
        : "Demande de réinscription enregistrée : dossier non éligible au paiement pour le moment.",
      data: {
        reinscription_id: reinscriptionId,
        etudiant_id: id,
        anneeacademique_id: anneeCible.id,
        niveau_retenu_id,
        montant_annuel: montantAnnuel,
        statut: statutDossier,
        eligible,
        code_paiement: codePaiement,
        motif_non_eligibilite: motifNonEligibilite,
        changement_de_cycle: changementDeCycle
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur demanderReinscription:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ─── GET fiche récapitulative imprimable (éligible ou non éligible) ────────
exports.afficherFicheReinscription = async (req, res) => {
  try {
    const { reinscriptionId } = req.params;
    const { calculerEcheancier } = require('../services/echeancier.service');

    const result = await db.query(
      `SELECT r.*, e.nom, e.prenoms, e.matricule_iipea, e.date_naissance, e.lieu_naissance,
              f.nom AS filiere_nom, f.sigle AS filiere_sigle, n.libelle AS niveau_libelle, a.annee
       FROM reinscription r
       JOIN etudiant e ON e.id = r.etudiant_id
       LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
       JOIN niveau n ON n.id = r.niveau_retenu_id
       JOIN anneeacademique a ON a.id = r.anneeacademique_id
       WHERE r.id = $1`,
      [reinscriptionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Dossier de réinscription introuvable.');
    }
    const dossier = result.rows[0];

    // Historique de l'année précédente : tant que le paiement n'est pas validé, l'état courant
    // de l'étudiant n'a pas encore été écrasé — c'est directement l'ancienne situation. Une fois
    // payé, on relit la trace figée au moment de CETTE validation (historique_inscription).
    let historique = null;
    if (dossier.statut === 'en_attente_paiement' || dossier.statut === 'non_eligible') {
      const etudiantActuel = await db.query(
        `SELECT a.annee, f.nom AS filiere_nom, n.libelle AS niveau_libelle, tf.libelle AS type_filiere,
                g.nom AS groupe_nom, c.nom AS classe_nom, e.statut_scolaire,
                s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant
         FROM etudiant e
         JOIN niveau n ON n.id = e.niveau_id
         JOIN filiere f ON f.id = e.id_filiere
         LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
         LEFT JOIN anneeacademique a ON a.id = e.annee_academique_id
         LEFT JOIN groupe g ON g.id = e.groupe_id
         LEFT JOIN classe c ON c.id = g.classe_id
         LEFT JOIN scolarite s ON s.id = e.scolarite_id
         WHERE e.id = $1`,
        [dossier.etudiant_id]
      );
      historique = etudiantActuel.rows[0] || null;
    } else {
      const histResult = await db.query(
        `SELECT a.annee, f.nom AS filiere_nom, n.libelle AS niveau_libelle, tf.libelle AS type_filiere,
                g.nom AS groupe_nom, c.nom AS classe_nom, h.statut_scolaire,
                h.montant_scolarite, h.scolarite_verse, h.scolarite_restante, h.statut_paiement,
                h.decision_academique, h.moyenne_annuelle
         FROM historique_inscription h
         JOIN niveau n ON n.id = h.niveau_id
         LEFT JOIN filiere f ON f.id = h.id_filiere
         LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
         LEFT JOIN anneeacademique a ON a.id = h.annee_academique_id
         LEFT JOIN groupe g ON g.id = h.groupe_id
         LEFT JOIN classe c ON c.id = g.classe_id
         WHERE h.etudiant_id = $1 AND h.created_at < $2
         ORDER BY h.created_at DESC LIMIT 1`,
        [dossier.etudiant_id, dossier.created_at]
      );
      historique = histResult.rows[0] || null;
    }

    const echeancier = calculerEcheancier({
      montantTotal: dossier.montant_annuel_nouveau,
      nombreVersementsPrevu: dossier.nombre_versements_prevu,
      paiementsEffectues: [],
      dateDepart: dossier.created_at,
    });

    // Rattrapages : dossier.matieres_a_reprendre (jsonb) contient une entrée par ECUE non validée,
    // avec l'UE parente (ue_libelle) — on en déduit la liste des UE concernées par déduplication.
    const matieresAReprendre = dossier.matieres_a_reprendre || [];
    const ecueEnRattrapage = matieresAReprendre.map(m => m.matiere_nom).filter(Boolean);
    const uesEnRattrapage = [...new Set(matieresAReprendre.map(m => m.ue_libelle).filter(Boolean))];

    // Professionnelle/Technique : seule la moyenne annuelle est affichée (pas de logique crédits/UE).
    // Universitaire/Classique (et par défaut) : crédits obtenus + moyenne annuelle.
    const estFiliereProfessionnelle = ['Professionnelle', 'Technique'].includes(historique?.type_filiere);

    res.render('fiche_reinscription', {
      dossier, historique, echeancier,
      ecueEnRattrapage, uesEnRattrapage, estFiliereProfessionnelle
    });
  } catch (error) {
    console.error('Erreur afficherFicheReinscription:', error);
    res.status(500).send('Erreur serveur lors de la génération de la fiche.');
  }
};
