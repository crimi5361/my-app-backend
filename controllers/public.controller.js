const db = require('../config/db.config');
const moment = require('moment');
const bcrypt = require('bcrypt');
const { genererCodeCandidat } = require('../services/codePaiement.service');

// Route publique pour la liste des classes
exports.getListeClassesPublic = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { annee_id, departement_id } = req.query;

    if (!departement_id) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre departement_id est requis'
      });
    }

    // Chantier 6 (2026-08-01) : portail public d'admission — ne doit jamais dépendre de
    // l'existence d'un groupe (un étudiant n'en a plus automatiquement). filiere/niveau/annee
    // viennent désormais directement des colonnes de `classe` (elle les possède déjà — inutile
    // de les déduire d'un étudiant au hasard, ce qui était en plus fragile). L'effectif combine
    // les étudiants déjà groupés (logique inchangée) et ceux sans groupe correspondant aux
    // critères de la classe (nouveau, additif uniquement — cf. classes.controller.js pour le
    // raisonnement détaillé sur pourquoi ces deux branches restent séparées).
    const query = `
      SELECT DISTINCT
        c.id,
        c.nom,
        c.description,
        aa.annee as annee_academique,
        aas.etat as annee_etat,
        (SELECT COUNT(DISTINCT g3.id) FROM groupe g3 WHERE g3.classe_id = c.id) as nombre_groupes,
        (SELECT COUNT(DISTINCT combined.etudiant_id) FROM (
           SELECT e4.id AS etudiant_id FROM etudiant e4
            JOIN groupe g4 ON g4.id = e4.groupe_id
            WHERE g4.classe_id = c.id
           UNION
           SELECT e4b.id FROM etudiant e4b
            WHERE e4b.groupe_id IS NULL
              AND e4b.id_filiere = c.filiere_id AND e4b.niveau_id = c.niveau_id
              AND e4b.annee_academique_id = c.annee_academique_id
              AND e4b.curcus_id IS NOT DISTINCT FROM c.curcus_id
         ) combined) as effectif_total,
        f.nom as filiere,
        n.libelle as niveau,
        (SELECT nom FROM site WHERE id = $2) as departement
      FROM classe c
      LEFT JOIN filiere f ON f.id = c.filiere_id
      LEFT JOIN niveau n ON n.id = c.niveau_id
      LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = aa.id AND aas.site_id = $2
      WHERE ($1::int IS NULL OR aa.id = $1)
      AND (
        EXISTS (
          SELECT 1 FROM etudiant e5
          JOIN groupe g5 ON g5.id = e5.groupe_id
          WHERE g5.classe_id = c.id AND e5.site_id = $2
        )
        OR EXISTS (
          SELECT 1 FROM etudiant e5b
          WHERE e5b.groupe_id IS NULL
            AND e5b.id_filiere = c.filiere_id AND e5b.niveau_id = c.niveau_id
            AND e5b.annee_academique_id = c.annee_academique_id
            AND e5b.curcus_id IS NOT DISTINCT FROM c.curcus_id AND e5b.site_id = $2
        )
      )
      ORDER BY c.nom
    `;

    const result = await client.query(query, [annee_id || null, departement_id]);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération classes publiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des classes'
    });
  } finally {
    client.release();
  }
};

// Route publique pour détail classe
exports.getDetailClassePublic = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    // Chantier 6 : filiere/niveau/annee directement depuis `classe` (plus fiable et plus simple
    // que de les déduire d'un étudiant groupé au hasard) ; effectif_total combine groupés
    // (inchangé) + sans groupe correspondant aux critères (nouveau, additif) — voir
    // classes.controller.js pour le raisonnement détaillé. effectif_groupe (par groupe) reste
    // group-dépendant par nature, inchangé.
    const query = `
      SELECT
        c.id,
        c.nom,
        c.description,
        aa.annee as annee_academique,
        (SELECT etat FROM anneeacademique_site WHERE anneeacademique_id = aa.id ORDER BY (etat = 'en cour') DESC LIMIT 1) as annee_etat,
        f.nom as filiere,
        n.libelle as niveau,
        (SELECT COUNT(DISTINCT combined.etudiant_id) FROM (
           SELECT e4.id AS etudiant_id FROM etudiant e4
            JOIN groupe g4 ON g4.id = e4.groupe_id
            WHERE g4.classe_id = c.id
           UNION
           SELECT e4b.id FROM etudiant e4b
            WHERE e4b.groupe_id IS NULL
              AND e4b.id_filiere = c.filiere_id AND e4b.niveau_id = c.niveau_id
              AND e4b.annee_academique_id = c.annee_academique_id
              AND e4b.curcus_id IS NOT DISTINCT FROM c.curcus_id
         ) combined) as effectif_total,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        COUNT(e_g.id) as effectif_groupe
      FROM classe c
      LEFT JOIN filiere f ON f.id = c.filiere_id
      LEFT JOIN niveau n ON n.id = c.niveau_id
      LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
      LEFT JOIN groupe g ON g.classe_id = c.id
      LEFT JOIN etudiant e_g ON e_g.groupe_id = g.id
      WHERE c.id = $1
      GROUP BY c.id, c.nom, c.description, aa.id, aa.annee, f.nom, n.libelle, g.id, g.nom, g.capacite_max
      ORDER BY g.nom
    `;

    const result = await client.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Classe non trouvée'
      });
    }

    const classe = {
      id: result.rows[0].id,
      nom: result.rows[0].nom,
      description: result.rows[0].description,
      annee_academique: result.rows[0].annee_academique,
      annee_etat: result.rows[0].annee_etat,
      filiere: result.rows[0].filiere,
      niveau: result.rows[0].niveau,
      effectif_total: result.rows[0].effectif_total,
      groupes: result.rows
        .filter(row => row.groupe_id !== null)
        .map(row => ({
          id: row.groupe_id,
          nom: row.groupe_nom,
          capacite_max: row.groupe_capacite,
          effectif: row.effectif_groupe,
          taux_remplissage: row.groupe_capacite > 0 
            ? Math.round((row.effectif_groupe / row.groupe_capacite) * 100) 
            : 0
        }))
    };

    res.status(200).json({
      success: true,
      data: classe
    });

  } catch (error) {
    console.error('Erreur récupération détail classe publique:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des détails de la classe'
    });
  } finally {
    client.release();
  }
};

// Route publique pour détail groupe
exports.getDetailGroupePublic = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    const groupeQuery = `
      SELECT 
        g.id,
        g.nom,
        g.capacite_max,
        c.nom as classe_nom,
        COUNT(e.id) as effectif,
        CASE 
          WHEN g.capacite_max > 0 
          THEN ROUND((COUNT(e.id) * 100.0 / g.capacite_max), 2)
          ELSE 0 
        END as taux_remplissage
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN etudiant e ON e.groupe_id = g.id
      WHERE g.id = $1
      GROUP BY g.id, g.nom, g.capacite_max, c.nom
    `;

    const groupeResult = await client.query(groupeQuery, [id]);

    if (groupeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Groupe non trouvé'
      });
    }

    const groupe = groupeResult.rows[0];

    const etudiantsQuery = `
      SELECT 
          e.id,
          e.matricule_iipea,
          e.nom,
          e.prenoms,
          e.telephone,
          e.contact_parent,
          e.email,
          e.photo_url,
          f.nom as filiere,
          n.libelle as niveau,
          c.type_parcours as cursus, 
          e.statut_scolaire
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN curcus c ON e.curcus_id = c.id  
      WHERE e.groupe_id = $1
      ORDER BY e.nom, e.prenoms
    `;

    const etudiantsResult = await client.query(etudiantsQuery, [id]);

    const response = {
      id: groupe.id,
      nom: groupe.nom,
      capacite_max: groupe.capacite_max,
      effectif: parseInt(groupe.effectif),
      taux_remplissage: parseFloat(groupe.taux_remplissage),
      classe_nom: groupe.classe_nom,
      etudiants: etudiantsResult.rows
    };

    res.status(200).json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error('Erreur récupération détail groupe public:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des détails du groupe'
    });
  } finally {
    client.release();
  }
};

// ─── Préinscription en ligne (site public) ──────────────────────────────────
// Toutes les routes ci-dessous sont montées sans authentification. Elles ne créent que
// des dossiers "web" (voir demanderAdmissionPublic) : standing='en attente', valide_scolarite
// = false, sans aucune pièce justificative ni photo — ces deux points restent exclusivement
// traités par le Service de la Scolarité lors du passage physique de l'étudiant (tour suivant).

// Données de référence groupées pour l'assistant d'inscription (étapes 1-2).
exports.getReferenceDataAdmission = async (req, res) => {
  try {
    const [ecoles, sites, pays, villes, seriesBac, anneesBac, etablissements, parcours] = await Promise.all([
      db.query(`SELECT id, nom, code FROM ecole WHERE statut = 'actif' ORDER BY nom`),
      db.query(`SELECT id, nom FROM site ORDER BY nom`),
      db.query(`SELECT id, code_iso, nom, nationalite FROM pays ORDER BY nom`),
      db.query(`SELECT id, nom FROM ville ORDER BY nom`),
      db.query(`SELECT id, nom FROM serie_bac ORDER BY nom`),
      db.query(`SELECT id, annee AS nom FROM annee_bac ORDER BY annee DESC`),
      db.query(`SELECT id, nom_etablissement, situation_geographique FROM etablissement_origine ORDER BY nom_etablissement`),
      // ✅ Parcours JOUR/SOIR (curcus) : exposée ici (route déjà publique) car GET /api/curcus exige
      // authenticateToken, inutilisable par le portail Web qui n'a pas de session. La ligne
      // "Universitaire" est incluse (comme /api/curcus côté agent) car StepFormation.tsx en a besoin
      // pour résoudre curcus_id automatiquement sur une filière Universitaire ; elle est filtrée côté
      // client pour ne jamais apparaître dans le Select de choix manuel (Jour/Soir).
      db.query(`SELECT id, type_parcours FROM curcus ORDER BY type_parcours`),
    ]);
    res.status(200).json({
      success: true,
      data: {
        ecoles: ecoles.rows,
        sites: sites.rows,
        pays: pays.rows,
        villes: villes.rows,
        seriesBac: seriesBac.rows,
        anneesBac: anneesBac.rows,
        etablissementsOrigine: etablissements.rows,
        parcours: parcours.rows,
      },
    });
  } catch (error) {
    console.error('Erreur getReferenceDataAdmission:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Cascade École → Département (formulaire public, pas de site/année implicite via req.user).
// Chantier "inscription Web Filière-first" (2026-08-02) : ecole_id devient optionnel — omis,
// retourne tous les départements (toutes écoles), nécessaire pour résoudre École/Département
// côté client à partir de la filière choisie, sans cascade préalable. Comportement existant
// (filtré par ecole_id) strictement inchangé quand le paramètre est fourni.
exports.getDepartementsPublic = async (req, res) => {
  try {
    const { ecole_id } = req.query;
    const result = ecole_id
      ? await db.query(
          `SELECT id, nom, sigle, ecole_id FROM departement WHERE ecole_id = $1 ORDER BY nom`,
          [ecole_id]
        )
      : await db.query(`SELECT id, nom, sigle, ecole_id FROM departement ORDER BY nom`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getDepartementsPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Aperçu du tarif avant validation (même calcul que calculerMontantScolarite côté agent).
exports.getTarifPreviewPublic = async (req, res) => {
  try {
    const { niveau_id, statut_scolaire } = req.query;
    if (!niveau_id) {
      return res.status(400).json({ success: false, message: 'Le paramètre niveau_id est requis.' });
    }
    const { calculerMontantScolarite } = require('./tarif.controller');
    const tarif = await calculerMontantScolarite(niveau_id, statut_scolaire || 'Non affecté');
    if (!tarif || tarif.montant === null) {
      return res.status(404).json({ success: false, message: 'Aucun tarif configuré pour ce niveau.' });
    }
    res.status(200).json({ success: true, data: tarif });
  } catch (error) {
    console.error('Erreur getTarifPreviewPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Cascade Département + Site → Filières (avec leurs niveaux imbriqués, pour l'année en cours
// de ce site) — même forme que getAllFilieresTable côté métier, mais site/année ne viennent
// pas de req.user (public) : le site est explicitement choisi par le candidat.
//
// Chantier "inscription Web Filière-first" (2026-08-02) : departement_id devient optionnel —
// omis, retourne les filières de TOUS les départements pour ce site/année (chaque ligne porte
// déjà f.departement_id), nécessaire pour permettre au candidat de choisir directement sa
// filière puis résoudre Département/École côté client, sans cascade préalable. Comportement
// existant (filtré par departement_id) strictement inchangé quand le paramètre est fourni.
exports.getFilieresAvecNiveauxPublic = async (req, res) => {
  try {
    const { departement_id, site_id } = req.query;
    if (!site_id) {
      return res.status(400).json({ success: false, message: 'Le paramètre site_id est requis.' });
    }

    const anneeResult = await db.query(
      `SELECT a.id FROM anneeacademique a
       JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
       WHERE s.etat = 'en cour' AND s.site_id = $1
       LIMIT 1`,
      [site_id]
    );
    const anneeAcademiqueId = anneeResult.rows[0]?.id;
    if (!anneeAcademiqueId) {
      return res.status(404).json({ success: false, message: "Aucune année académique en cours pour ce site." });
    }

    const result = await db.query(
      `SELECT
         f.id, f.nom, f.sigle, f.departement_id,
         tf.id AS typefiliere_id, tf.libelle AS typefiliere_libelle,
         COALESCE(
           json_agg(
             json_build_object('id', n.id, 'libelle', n.libelle, 'prix_formation', n.prix_formation)
           ) FILTER (WHERE n.id IS NOT NULL),
           '[]'
         ) AS niveaux
       FROM filiere f
       JOIN typefiliere tf ON tf.id = f.type_filiere_id
       LEFT JOIN niveau n ON n.filiere_id = f.id AND n.anneeacademique_id = $1 AND n.site_id = $2
       WHERE ($3::int IS NULL OR f.departement_id = $3)
         AND EXISTS (
           SELECT 1 FROM niveau n2
           WHERE n2.filiere_id = f.id AND n2.anneeacademique_id = $1 AND n2.site_id = $2
         )
       GROUP BY f.id, f.nom, f.sigle, f.departement_id, tf.id, tf.libelle
       ORDER BY f.nom`,
      [anneeAcademiqueId, site_id, departement_id || null]
    );
    res.status(200).json({ success: true, data: { anneeAcademiqueId, filieres: result.rows } });
  } catch (error) {
    console.error('Erreur getFilieresAvecNiveauxPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Soumission d'une préinscription en ligne — crée le dossier avec un code de paiement généré
// mais désactivé (valide_scolarite = false), sans aucune pièce jointe ni photo.
exports.demanderAdmissionPublic = async (req, res) => {
  const client = await db.connect();
  try {
    const { etudiant, academique, inscription } = req.body;
    if (!etudiant || !academique || !inscription) {
      return res.status(400).json({ success: false, message: 'Données incomplètes.' });
    }

    const requiredEtudiant = ['nom', 'prenoms', 'date_naissance', 'sexe', 'nationalite', 'telephone', 'email_personnel', 'contact_parent'];
    const requiredAcademique = ['matricule', 'annee_academique_id'];
    const requiredInscription = ['niveau_id', 'id_filiere', 'site_id'];
    const missing = [
      ...requiredEtudiant.filter(f => !etudiant[f]),
      ...requiredAcademique.filter(f => !academique[f]),
      ...requiredInscription.filter(f => !inscription[f]),
    ];
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: 'Champs obligatoires manquants.', missing });
    }
    if (req.body.engagement_accepte !== true) {
      return res.status(400).json({ success: false, message: "L'engagement doit être accepté." });
    }

    await client.query('BEGIN');

    // ✅ Résolution atomique formation+tarif+parcours (services/parcoursProfessionnel.service.js) :
    // même source de vérité que l'admission agent (addEtudiant) — une LICENCE 3 PRO/MASTER PRO
    // exige désormais un curcus_id, exactement comme côté agent et comme en réinscription.
    const { resoudreFormationEtParcours } = require('../services/parcoursProfessionnel.service');
    const resolution = await resoudreFormationEtParcours(client, {
      niveauId: inscription.niveau_id,
      filiereId: inscription.id_filiere,
      curcusId: inscription.curcus_id,
      statutScolaire: academique.statut_scolaire || 'Non affecté',
    });
    if (resolution.erreur) {
      await client.query('ROLLBACK');
      return res.status(resolution.erreur.status).json({
        success: false,
        message: resolution.erreur.status === 409
          ? 'Aucun tarif configuré pour ce niveau. Contactez le Service de la Scolarité.'
          : resolution.erreur.message,
        code: resolution.erreur.code
      });
    }
    const tarif = resolution.tarif;

    let codePaiement = null;
    for (let tentative = 0; tentative < 8 && !codePaiement; tentative++) {
      const candidat = genererCodeCandidat('AD');
      const existe = await client.query('SELECT 1 FROM etudiant WHERE code_paiement = $1', [candidat]);
      if (existe.rows.length === 0) codePaiement = candidat;
    }
    if (!codePaiement) {
      throw new Error("Impossible de générer un code de paiement unique après plusieurs tentatives.");
    }

    const { generateMatriculeIIPEA, generateCodeUnique } = require('./etudiant.controller');
    const cleanName = (str) => str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.').toLowerCase();
    const email = `${cleanName(etudiant.prenoms.split(' ')[0])}.${cleanName(etudiant.nom)}@iipea.com`;
    const hashedPassword = await bcrypt.hash('@elites@', 10);
    const codeUnique = await generateCodeUnique(etudiant.nom, etudiant.prenoms, etudiant.date_naissance);
    const matriculeIipea = await generateMatriculeIIPEA(academique.annee_academique_id, inscription.id_filiere);

    const etudiantResult = await client.query(
      `INSERT INTO etudiant (
         matricule, nom, prenoms, date_naissance, lieu_naissance, pays_naissance, telephone, email,
         email_personnel,
         lieu_residence, contact_parent, nom_parent_1, nom_parent_2, code_unique, annee_bac, serie_bac,
         etablissement_origine, inscrit_par, photo_url, site_id, annee_academique_id, groupe_id,
         niveau_id, statut_scolaire, nationalite, standing, numero_table, sexe, password,
         curcus_id, id_filiere, date_inscription, contact_etudiant, contact_parent_2, matricule_iipea,
         numero_acte_naissance, numero_piece_identite, mention_bac,
         adresse_parent_1, adresse_parent_2, engagement_accepte, code_paiement, nombre_versements_prevu,
         ip_ministere, source_inscription, valide_scolarite
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW(),$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,'web',false)
       RETURNING id`,
      [
        academique.matricule,
        etudiant.nom.toUpperCase(),
        etudiant.prenoms.toUpperCase(),
        moment(etudiant.date_naissance).format('YYYY-MM-DD'),
        etudiant.lieu_naissance,
        etudiant.pays_naissance || null,
        etudiant.telephone,
        email,
        etudiant.email_personnel,
        etudiant.lieu_residence,
        etudiant.contact_parent,
        etudiant.nom_parent_1 || null,
        etudiant.nom_parent_2 || null,
        codeUnique,
        academique.annee_bac || null,
        academique.serie_bac || null,
        academique.etablissement_origine || null,
        null, // inscrit_par : personne — dossier soumis par le candidat lui-même
        null, // photo_url : prise par l'agent lors du passage physique
        inscription.site_id,
        academique.annee_academique_id,
        null, // groupe_id : affecté au moment du paiement en caisse
        inscription.niveau_id,
        tarif.statut_applique,
        etudiant.nationalite,
        'en attente',
        academique.numero_table || null,
        etudiant.sexe,
        hashedPassword,
        inscription.curcus_id || null,
        inscription.id_filiere,
        etudiant.telephone, // contact_etudiant
        etudiant.contact_parent_2 || null,
        matriculeIipea,
        etudiant.numero_acte_naissance || null,
        etudiant.numero_piece_identite || null,
        academique.mention_bac || null,
        etudiant.adresse_parent_1 || null,
        etudiant.adresse_parent_2 || null,
        true, // engagement_accepte
        codePaiement,
        inscription.nombre_versements ? parseInt(inscription.nombre_versements, 10) : null,
        academique.ip_ministere || null,
      ]
    );
    const etudiantId = etudiantResult.rows[0].id;

    // Pièces justificatives : l'étudiant DÉCLARE seulement ce qu'il possède (aucun fichier).
    // `declare_par_etudiant` reste strictement distinct de `fourni` (jamais mis à true ici) —
    // `fourni` ne sera positionné que par l'agent lors de la vérification physique à l'école.
    const pieces = req.body.pieces || {};
    const typesDocResult = await client.query(
      `SELECT id, code FROM type_document WHERE contexte = 'admission' AND code != 'PHOTO'`
    );
    for (const typeDoc of typesDocResult.rows) {
      const declare = pieces[typeDoc.code] === true || pieces[typeDoc.code] === 'true';
      await client.query(
        `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, declare_par_etudiant)
         VALUES ($1, $2, false, $3)`,
        [etudiantId, typeDoc.id, declare]
      );
    }

    const scolariteResult = await client.query(
      `INSERT INTO scolarite (montant_scolarite, scolarite_verse, statut_etudiant)
       VALUES ($1, 0, 'en attente') RETURNING id`,
      [tarif.montant]
    );
    await client.query(`UPDATE etudiant SET scolarite_id = $1 WHERE id = $2`, [scolariteResult.rows[0].id, etudiantId]);

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Votre demande de préinscription a été enregistrée.',
      data: { id: etudiantId, matricule_iipea: matriculeIipea, code_paiement: codePaiement, nom: etudiant.nom.toUpperCase(), prenoms: etudiant.prenoms.toUpperCase() },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur demanderAdmissionPublic:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

exports.getPublicAnneesAcademiques = async (req, res) => {
  const client = await db.connect();

  try {
    const query = `
      SELECT
        a.id,
        a.annee,
        (SELECT etat FROM anneeacademique_site WHERE anneeacademique_id = a.id ORDER BY (etat = 'en cour') DESC LIMIT 1) as etat
      FROM anneeacademique a
      ORDER BY a.annee DESC
    `;

    const result = await client.query(query);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération années:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des années académiques'
    });
  } finally {
    client.release();
  }
};
