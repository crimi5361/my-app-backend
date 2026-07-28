const db = require('../config/db.config');
const PVController = require('./PV.controller');
const PaiementEspaceController = require('./PaiementEespaceetudiant.controller');
const {
  getAnneeEnCoursPourSite,
  trouverOrientationsFiliere,
  traiterDemandeReinscription,
  evaluerEligibiliteReinscription,
  determinerChangementDeCycle,
  afficherFicheReinscription,
  IDENTITE_FIELDS
} = require('./reinscription.controller');
const { requiertChoixParcours } = require('../services/parcoursProfessionnel.service');
const { determinerOptionsVersements } = require('../services/echeancier.service');

// ✅ Protection d'accès : jamais reposer uniquement sur l'id — le matricule_iipea (déjà connu du
// candidat qui a cliqué sur SON propre résultat de recherche) doit correspondre exactement.
const matriculeCorrespond = (etudiant, matriculeFourni) =>
  !!matriculeFourni && !!etudiant?.matricule_iipea
  && etudiant.matricule_iipea.trim().toUpperCase() === String(matriculeFourni).trim().toUpperCase();

// ─── GET recherche publique d'un dossier étudiant à réinscrire ─────────────
// Ne retourne QUE les champs strictement nécessaires à l'identification (jamais la situation
// académique/financière) — ces données détaillées ne sont chargées qu'après sélection explicite,
// via getSituationReinscriptionPublic, qui exige en plus une confirmation de matricule.
exports.rechercherEtudiantReinscriptionPublic = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              f.nom AS filiere, n.libelle AS niveau
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       WHERE e.standing = 'Inscrit'
         AND (
           e.nom ILIKE $1 OR e.prenoms ILIKE $1 OR e.matricule_iipea ILIKE $1
           OR (e.nom || ' ' || e.prenoms) ILIKE $1
           OR (e.prenoms || ' ' || e.nom) ILIKE $1
         )
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      [`%${q.trim()}%`]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherEtudiantReinscriptionPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET situation complète d'un étudiant avant réinscription ──────────────
exports.getSituationReinscriptionPublic = async (req, res) => {
  try {
    const { id } = req.params;
    const { matricule_iipea } = req.query;

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url, e.statut_scolaire,
              e.niveau_id, e.id_filiere, e.site_id,
              n.libelle AS niveau_libelle, n.niveau_suivant_id,
              f.nom AS filiere_nom, f.departement_id, tf.libelle AS type_filiere_libelle,
              d.nom AS departement_nom, d.ecole_id,
              ec.nom AS ecole_nom,
              s.nom AS site_nom
       FROM etudiant e
       JOIN niveau n ON n.id = e.niveau_id
       JOIN filiere f ON f.id = e.id_filiere
       LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       JOIN site s ON s.id = e.site_id
       WHERE e.id = $1 AND e.standing = 'Inscrit'`,
      [id]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    if (!matriculeCorrespond(etudiant, matricule_iipea)) {
      return res.status(403).json({ success: false, message: 'Matricule IIPEA invalide pour ce dossier.' });
    }

    const anneeCible = await getAnneeEnCoursPourSite(etudiant.site_id);

    const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(etudiant.id);
    let situationAcademique = null;
    let academiqueErreur = null;
    try {
      situationAcademique = await PVController.calculerResultatsAnnuelsEtudiant(etudiant.id);
    } catch (err) {
      academiqueErreur = err.message;
    }

    // ✅ Moteur de décision unique (services/… → reinscription.controller.js::evaluerEligibiliteReinscription) —
    // jamais recalculé ici : ce sont les DEUX seules conditions qui pilotent tout ce qui suit.
    const { financierConforme, academiqueValide } = evaluerEligibiliteReinscription(situationAcademique, situationFinanciere);

    const { calculerMontantScolarite } = require('./tarif.controller');

    // "Redoublement" : toujours le même niveau/filière — seulement bloqué si la scolarité n'est
    // pas soldée (le contrôle académique n'a jamais empêché un redoublement).
    let redoublement = null;
    if (financierConforme) {
      const tarifRedoublement = await calculerMontantScolarite(etudiant.niveau_id, etudiant.statut_scolaire, 'reinscription');
      redoublement = {
        niveau_id: etudiant.niveau_id,
        filiere_id: etudiant.id_filiere,
        niveau_libelle: etudiant.niveau_libelle,
        filiere_nom: etudiant.filiere_nom,
        parcours_requis: requiertChoixParcours(etudiant.type_filiere_libelle, etudiant.niveau_libelle),
        tarif: tarifRedoublement,
        versements_options: determinerOptionsVersements(tarifRedoublement?.montant)
      };
    }

    // "Progression" : niveau successeur configuré, ET académiquement autorisé (ADMIS/DÉROGÉ),
    // ET financièrement conforme. Le garde-fou Accès Master strict (ADMIS uniquement, DÉROGÉ
    // insuffisant) reste appliqué en plus du garde académique général.
    let niveauProposeRow = null;
    if (etudiant.niveau_suivant_id) {
      const r = await db.query(`SELECT n.id, n.libelle, n.filiere_id FROM niveau n WHERE n.id = $1`, [etudiant.niveau_suivant_id]);
      niveauProposeRow = r.rows[0] || null;
    }
    const cibleEstMaster = /^MASTER/i.test(niveauProposeRow?.libelle || '');
    const actuelEstLicence = /^LICENCE/i.test(etudiant.niveau_libelle || '');
    if (niveauProposeRow && cibleEstMaster && actuelEstLicence && situationAcademique?.decision !== 'ADMIS') {
      niveauProposeRow = null;
    }
    if (!financierConforme || !academiqueValide) {
      niveauProposeRow = null;
    }

    let progression = null;
    if (niveauProposeRow) {
      let orientations = [];
      if (anneeCible) {
        orientations = await trouverOrientationsFiliere(
          etudiant.id_filiere, niveauProposeRow.libelle, anneeCible.id, etudiant.site_id
        );
      }
      // ✅ Statut/tarif calculés avec le même moteur que la soumission (determinerChangementDeCycle)
      // — jamais etudiant.statut_scolaire brut : un changement de cycle (ex. Licence 3 → Master 1)
      // doit déjà afficher le tarif "Non affecté" ici, avant même que l'étudiant ne soumette.
      const orientationsResolues = await Promise.all(orientations.map(async (o) => {
        const changementCycleOrientation = determinerChangementDeCycle({
          niveauActuelLibelle: etudiant.niveau_libelle, niveauRetenuLibelle: niveauProposeRow.libelle,
          filiereActuelleId: etudiant.id_filiere, filiereRetenueId: o.filiere_id,
          orientationsValides: orientations
        });
        const statutOrientation = changementCycleOrientation ? 'Non affecté' : etudiant.statut_scolaire;
        const tarifOrientation = await calculerMontantScolarite(o.niveau_id, statutOrientation, 'reinscription');
        return {
          niveau_id: o.niveau_id,
          filiere_id: o.filiere_id,
          niveau_libelle: niveauProposeRow.libelle,
          filiere_nom: o.nom,
          parcours_requis: requiertChoixParcours(etudiant.type_filiere_libelle, niveauProposeRow.libelle),
          tarif: tarifOrientation,
          versements_options: determinerOptionsVersements(tarifOrientation?.montant)
        };
      }));

      const filiereProgressionId = niveauProposeRow.filiere_id ?? etudiant.id_filiere;
      const changementCycleProgression = determinerChangementDeCycle({
        niveauActuelLibelle: etudiant.niveau_libelle, niveauRetenuLibelle: niveauProposeRow.libelle,
        filiereActuelleId: etudiant.id_filiere, filiereRetenueId: filiereProgressionId,
        orientationsValides: orientations
      });
      const statutProgression = changementCycleProgression ? 'Non affecté' : etudiant.statut_scolaire;
      const tarifProgression = await calculerMontantScolarite(niveauProposeRow.id, statutProgression, 'reinscription');
      progression = {
        niveau_id: niveauProposeRow.id,
        filiere_id: filiereProgressionId,
        niveau_libelle: niveauProposeRow.libelle,
        filiere_nom: etudiant.filiere_nom,
        parcours_requis: requiertChoixParcours(etudiant.type_filiere_libelle, niveauProposeRow.libelle),
        tarif: tarifProgression,
        versements_options: determinerOptionsVersements(tarifProgression?.montant),
        orientations: orientationsResolues
      };
    }

    // ✅ Cas particulier BTS 2 → Licence 3 PRO (portail Web uniquement) : uniquement les filières
    // Professionnelles disposant d'un niveau LICENCE 3 PRO, site + année cible de l'étudiant —
    // aucune table de correspondance, aucune restriction de département (choix confirmé). Soumis
    // aux mêmes gardes financier/académique que la progression (c'en est une variante).
    const bts2Structurel = /^BTS\s*2$/i.test((etudiant.niveau_libelle || '').trim());
    let bts2L3pro = null;
    if (bts2Structurel && financierConforme && academiqueValide && anneeCible) {
      const parcoursRequisL3Pro = requiertChoixParcours('Professionnelles', 'LICENCE 3 PRO');
      const filieresResult = await db.query(
        `SELECT DISTINCT f.id AS filiere_id, f.nom, n.id AS niveau_id
         FROM niveau n
         JOIN filiere f ON f.id = n.filiere_id
         JOIN typefiliere tf ON tf.id = f.type_filiere_id
         WHERE n.libelle = 'LICENCE 3 PRO' AND tf.libelle = 'Professionnelles'
           AND n.site_id = $1 AND n.anneeacademique_id = $2
         ORDER BY f.nom`,
        [etudiant.site_id, anneeCible.id]
      );
      const filieresResolues = await Promise.all(filieresResult.rows.map(async (f) => {
        // ✅ BTS 2 → Licence 3 PRO force "Non affecté" quel que soit le filiere_id (même règle que
        // la soumission, cf. determinerChangementDeCycle) — évite l'incohérence historique où le
        // statut n'était rebasculé que pour certaines filières selon un partage fortuit de filiere_id.
        const changementCycleL3Pro = determinerChangementDeCycle({
          niveauActuelLibelle: etudiant.niveau_libelle, niveauRetenuLibelle: 'LICENCE 3 PRO',
          filiereActuelleId: etudiant.id_filiere, filiereRetenueId: f.filiere_id,
          orientationsValides: []
        });
        const statutL3Pro = changementCycleL3Pro ? 'Non affecté' : etudiant.statut_scolaire;
        const tarifL3Pro = await calculerMontantScolarite(f.niveau_id, statutL3Pro, 'reinscription');
        return {
          niveau_id: f.niveau_id,
          filiere_id: f.filiere_id,
          niveau_libelle: 'LICENCE 3 PRO',
          filiere_nom: f.nom,
          parcours_requis: parcoursRequisL3Pro,
          tarif: tarifL3Pro,
          versements_options: determinerOptionsVersements(tarifL3Pro?.montant)
        };
      }));
      bts2L3pro = { filieres: filieresResolues };
    }

    const parcoursResult = await db.query(
      `SELECT id, type_parcours FROM curcus WHERE type_parcours != 'Universitaire' ORDER BY type_parcours`
    );

    const reinscriptionExistante = anneeCible
      ? (await db.query(
          `SELECT id, statut, code_paiement, niveau_retenu_id, id_filiere_retenu, curcus_id,
                  valide_scolarite, motif_non_eligibilite
           FROM reinscription WHERE etudiant_id = $1 AND anneeacademique_id = $2`,
          [etudiant.id, anneeCible.id]
        )).rows[0] || null
      : null;

    res.status(200).json({
      success: true,
      data: {
        etudiant: {
          id: etudiant.id, nom: etudiant.nom, prenoms: etudiant.prenoms,
          matricule_iipea: etudiant.matricule_iipea, photo_url: etudiant.photo_url,
          statut_scolaire: etudiant.statut_scolaire,
          niveau_id: etudiant.niveau_id, id_filiere: etudiant.id_filiere,
          type_filiere_actuel: etudiant.type_filiere_libelle
        },
        hierarchie: {
          ecole: etudiant.ecole_nom, departement: etudiant.departement_nom,
          filiere: etudiant.filiere_nom, niveau: etudiant.niveau_libelle, site: etudiant.site_nom
        },
        situation_financiere: situationFinanciere,
        situation_academique: situationAcademique,
        situation_academique_erreur: academiqueErreur,
        financierement_bloque: !financierConforme,
        progression_autorisee: academiqueValide,
        options: { redoublement, progression, bts2_l3pro: bts2L3pro },
        parcours_options: parcoursResult.rows,
        annee_cible: anneeCible,
        reinscription_existante: reinscriptionExistante
      }
    });
  } catch (error) {
    console.error('Erreur getSituationReinscriptionPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST demander la réinscription depuis le portail Web ──────────────────
// Aucun document ni photo collecté ici (voir page Vérification) — appelle le même moteur
// métier que l'agent (traiterDemandeReinscription, mode='creation', sourceInscription='web').
exports.demanderReinscriptionPublic = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      matricule_iipea, niveau_retenu_id, id_filiere, curcus_id,
      nombre_versements_prevu, modalite_paiement, identite, pieces
    } = req.body;

    const etudiantResult = await client.query(
      `SELECT id, matricule_iipea FROM etudiant WHERE id = $1 AND standing = 'Inscrit'`,
      [req.params.id]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    if (!matriculeCorrespond(etudiantResult.rows[0], matricule_iipea)) {
      return res.status(403).json({ success: false, message: 'Matricule IIPEA invalide pour ce dossier.' });
    }

    // ✅ Blocage immédiat si scolarité non soldée : aucune ligne reinscription ne doit être créée
    // dans ce cas (portail Web uniquement — l'agent conserve son comportement actuel, qui
    // enregistre toujours la demande avec un motif). Même moteur de décision que la situation.
    const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(req.params.id);
    const { financierConforme } = evaluerEligibiliteReinscription(null, situationFinanciere);
    if (!financierConforme) {
      return res.status(409).json({
        success: false,
        code: 'SCOLARITE_NON_SOLDEE',
        message: `Votre scolarité de l'année précédente n'est pas entièrement soldée. Il vous reste ${situationFinanciere.scolarite_restante.toLocaleString('fr-FR')} FCFA à régler. Veuillez vous présenter au service de la Caisse afin de régulariser votre situation avant toute demande de réinscription.`
      });
    }

    const identiteFields = Object.fromEntries(IDENTITE_FIELDS.map(f => [f, identite?.[f] || null]));

    const result = await traiterDemandeReinscription(client, {
      etudiantId: req.params.id,
      niveauRetenuId: niveau_retenu_id,
      idFiliereChoisie: id_filiere,
      curcusId: curcus_id,
      nombreVersementsPrevu: nombre_versements_prevu,
      modalitePaiement: modalite_paiement,
      identiteFields,
      photoUrl: null,
      traitePar: null,
      sourceInscription: 'web',
      mode: 'creation'
    });

    if (result.erreur) {
      return res.status(result.erreur.status).json({
        success: false,
        ...(result.erreur.code ? { code: result.erreur.code } : {}),
        message: result.erreur.message
      });
    }

    // ✅ Déclaration des pièces par l'étudiant — même modèle que demanderAdmissionPublic
    // (declare_par_etudiant uniquement, jamais fourni). Ne boucle QUE sur les codes présents
    // dans la déclaration reçue (jamais tout le catalogue), pour ne jamais écraser silencieusement
    // une déclaration déjà faite à l'admission sur un document non présenté à cette étape.
    // Upsert : la ligne document_etudiant peut déjà exister (créée à l'admission).
    if (pieces && typeof pieces === 'object') {
      for (const [code, valeur] of Object.entries(pieces)) {
        const typeDocResult = await client.query(
          `SELECT id FROM type_document WHERE code = $1 AND contexte IN ('admission', 'reinscription')`,
          [code]
        );
        if (typeDocResult.rows.length === 0) continue;
        const typeDocId = typeDocResult.rows[0].id;
        const declare = valeur === true || valeur === 'true';
        const updateResult = await client.query(
          `UPDATE document_etudiant SET declare_par_etudiant = $1 WHERE etudiant_id = $2 AND type_document_id = $3`,
          [declare, req.params.id, typeDocId]
        );
        if (updateResult.rowCount === 0) {
          await client.query(
            `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, declare_par_etudiant) VALUES ($1, $2, false, $3)`,
            [req.params.id, typeDocId, declare]
          );
        }
      }
    }

    res.status(200).json({
      success: true,
      message: result.eligible
        ? 'Votre demande de réinscription a été enregistrée : elle doit être validée par le Service de la Scolarité avant activation du paiement.'
        : "Votre demande de réinscription a été enregistrée, mais votre dossier n'est pas éligible au paiement pour le moment.",
      data: {
        reinscription_id: result.reinscriptionId,
        etudiant_id: req.params.id,
        niveau_retenu_id,
        montant_annuel: result.montantAnnuel,
        statut: result.statutDossier,
        eligible: result.eligible,
        code_paiement: result.codePaiement,
        motif_non_eligibilite: result.motifNonEligibilite
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur demanderReinscriptionPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ─── GET fiche de réinscription (accès public, matricule vérifié) ──────────
// Réutilise telle quelle reinscriptionController.afficherFicheReinscription (aucune modification
// du contrôleur ni du template EJS) — n'ajoute que le contrôle d'accès par matricule, absent de
// la route agent (protégée par authenticateToken à la place).
exports.getFicheReinscriptionPublic = async (req, res) => {
  try {
    const { reinscriptionId } = req.params;
    const { matricule_iipea } = req.query;

    const result = await db.query(
      `SELECT e.matricule_iipea FROM reinscription r JOIN etudiant e ON e.id = r.etudiant_id WHERE r.id = $1`,
      [reinscriptionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Dossier de réinscription introuvable.');
    }
    if (!matriculeCorrespond(result.rows[0], matricule_iipea)) {
      return res.status(403).send('Matricule IIPEA invalide pour ce dossier.');
    }

    return afficherFicheReinscription(req, res);
  } catch (error) {
    console.error('Erreur getFicheReinscriptionPublic:', error);
    res.status(500).send('Erreur serveur.');
  }
};

// ─── GET fiche de situation — dossier bloqué pour scolarité non soldée ─────
// Aucune ligne `reinscription` n'existe dans ce cas (la demande n'est jamais créée, voir
// demanderReinscriptionPublic) — la fiche est donc générée directement depuis `etudiant` +
// `scolarite`, sans dépendre du mécanisme fiche_reinscription.ejs existant.
exports.getFicheSituationBloqueePublic = async (req, res) => {
  try {
    const { id } = req.params;
    const { matricule_iipea } = req.query;

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea,
              f.nom AS filiere_nom, n.libelle AS niveau_libelle, s.nom AS site_nom,
              sc.montant_scolarite, sc.scolarite_verse, sc.scolarite_restante
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       JOIN site s ON s.id = e.site_id
       LEFT JOIN scolarite sc ON sc.id = e.scolarite_id
       WHERE e.id = $1 AND e.standing = 'Inscrit'`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Étudiant introuvable.');
    }
    const etudiant = result.rows[0];
    if (!matriculeCorrespond(etudiant, matricule_iipea)) {
      return res.status(403).send('Matricule IIPEA invalide pour ce dossier.');
    }

    res.render('fiche_situation_reinscription', {
      etudiant,
      dateGeneration: new Date()
    });
  } catch (error) {
    console.error('Erreur getFicheSituationBloqueePublic:', error);
    res.status(500).send('Erreur serveur.');
  }
};
