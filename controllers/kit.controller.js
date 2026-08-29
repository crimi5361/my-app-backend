// Chantier Kit étudiant (rames + marqueurs) — Phase 1 (2026-08-21).
//
// Indépendant du module Moyens Généraux : n'importe rien de ce module, n'est importé par rien de
// ce module. Le paiement Kit passe exclusivement par l'architecture Caisse existante
// (services/sessionCaisse.service.js, services/paiementEcriture.service.js) — jamais une seconde
// logique de paiement.
const db = require('../config/db.config');
const { isKitSuspenduPourAnnee } = require('../services/kitCampagne.service');
const { validerNiveauExiste, KitEligibiliteError } = require('../services/kitEligibilite.service');
const { getSessionOuverte } = require('../services/sessionCaisse.service');
const { enregistrerPaiementEtRecu } = require('../services/paiementEcriture.service');
const { METHODES_VALIDES_NOUVEAU_PAIEMENT } = require('../services/methodesPaiement.service');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// Montant imposé côté serveur — jamais lu du corps de requête (§3 de la demande : "Le montant ne
// doit jamais être fourni librement par le frontend").
const MONTANT_KIT = 5000;

// Conservé pour compatibilité (déjà consommé ailleurs) — inchangé.
exports.getEtatCampagne = async (req, res) => {
  try {
    const { etudiantId } = req.params;

    const etudiantResult = await db.query(
      'SELECT annee_academique_id FROM etudiant WHERE id = $1',
      [etudiantId]
    );

    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }

    const suspendu = await isKitSuspenduPourAnnee(db, etudiantResult.rows[0].annee_academique_id);

    res.json({ success: true, data: { suspendu } });
  } catch (error) {
    console.error('Erreur récupération état campagne kit:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de l\'état du module kit'
    });
  }
};

// Conservé pour compatibilité (déjà consommé ailleurs) — inchangé. Renvoie la ligne kit la plus
// récente si plusieurs existent (un étudiant peut désormais avoir une ligne par année académique,
// cf. kit_unique_etudiant_annee) — jamais utilisé par le nouveau code, qui utilise
// getEtatKitEtudiant ci-dessous.
exports.getKitByEtudiant = async (req, res) => {
  try {
    const { id } = req.params;

    const kitResult = await db.query(
      'SELECT * FROM kit WHERE etudiant_id = $1 ORDER BY id DESC LIMIT 1',
      [id]
    );

    if (kitResult.rows.length === 0) {
      return res.json({
        success: true,
        data: null
      });
    }

    res.json({
      success: true,
      data: kitResult.rows[0]
    });
  } catch (error) {
    console.error('Erreur récupération kit:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du kit'
    });
  }
};

// État COMPLET et dérivé du Kit pour un étudiant, sur SON année académique courante — un seul
// appel pour que le frontend sache exactement quoi afficher :
//   - suspendu=true → module suspendu pour cette campagne (KIT_ANNEES_SUSPENDUES), rien affiché.
//   - statut='NON_TRAITE' (dérivé, aucune ligne kit) → les 2 choix proposés (apporté / payé).
//   - statut='KIT_APPORTE'|'KIT_PAYE' → déjà traité, affichage en lecture seule.
// Plus d'exemption 1ère année (retirée le 2026-08-29, décision validée) : un étudiant de LICENCE 1
// / BTS 1 / LICENCE 1 PRO est désormais traité exactement comme les autres niveaux éligibles.
exports.getEtatKitEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    const etudiantResult = await db.query(
      'SELECT id, niveau_id, annee_academique_id FROM etudiant WHERE id = $1',
      [id]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const anneeAcademiqueId = etudiant.annee_academique_id;

    if (!anneeAcademiqueId) {
      return res.status(200).json({
        success: true,
        data: { suspendu: false, statut: null, annee_academique_id: null, kit: null },
      });
    }

    const [, suspendu, kitResult] = await Promise.all([
      validerNiveauExiste(db, etudiant.niveau_id),
      isKitSuspenduPourAnnee(db, anneeAcademiqueId),
      db.query(
        `SELECT id, statut, paiement_id, montant, traite_par, date_enregistrement
         FROM kit WHERE etudiant_id = $1 AND annee_academique_id = $2`,
        [id, anneeAcademiqueId]
      ),
    ]);

    const kitRow = kitResult.rows[0] || null;
    const statut = !suspendu ? (kitRow?.statut || 'NON_TRAITE') : null;

    res.status(200).json({
      success: true,
      data: { suspendu, statut, annee_academique_id: anneeAcademiqueId, kit: kitRow },
    });
  } catch (error) {
    if (error instanceof KitEligibiliteError) {
      console.warn(`getEtatKitEtudiant — ${error.code} : ${error.message}`);
      return res.status(404).json({ success: false, code: error.code, message: error.message });
    }
    console.error('Erreur getEtatKitEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Chantier Kit étudiant — Phase 2 (2026-08-21) : régularisation des étudiants déjà inscrits.
//
// Recherche d'étudiants DÉJÀ inscrits ('Inscrit') pour alimenter l'écran Caisse → Gestion des
// Kits — réutilise TEL QUEL le même cloisonnement site/école que
// caisse.controller.js::rechercherEtudiantCaisse (même req.user.departement_id, même
// getEcoleScopeFromUser) : aucune deuxième logique de scoping créée. N'exige jamais au moins
// 2 caractères pour éviter de charger tous les étudiants d'un site (§2 de la demande).
//
// Le statut Kit par ligne n'exclut plus la 1ère année (exemption retirée le 2026-08-29, décision
// validée) — tout étudiant 'Inscrit' est concerné. La ligne kit est jointe avec le même filtre
// k.annee_academique_id = e.annee_academique_id que le correctif appliqué à
// etudiant.controller.js (getEtudiantById/getRecuData) en Phase 1 : un étudiant a désormais une
// ligne kit par année, jamais une jointure non scopée.
exports.rechercherEtudiantsKit = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    // Année académique : celle demandée si fournie, sinon l'année "en cour" du site de l'agent —
    // jamais une valeur qui viendrait juste écraser le filtre sans validation contre le site.
    let anneeAcademiqueId = req.query.annee_academique_id ? parseInt(req.query.annee_academique_id, 10) : null;
    if (!anneeAcademiqueId || Number.isNaN(anneeAcademiqueId)) {
      const anneeCourante = await db.query(
        `SELECT a.id FROM anneeacademique a
         JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
         WHERE s.site_id = $1 AND s.etat = 'en cour' LIMIT 1`,
        [siteId]
      );
      if (anneeCourante.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Aucune année académique en cours pour votre site." });
      }
      anneeAcademiqueId = anneeCourante.rows[0].id;
    }

    const ecoleCond = ecoleId !== null ? 'AND dept.ecole_id = $4' : '';
    const params = ecoleId !== null
      ? [siteId, anneeAcademiqueId, `%${q.trim()}%`, ecoleId]
      : [siteId, anneeAcademiqueId, `%${q.trim()}%`];

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.niveau_id, e.annee_academique_id,
              f.nom AS filiere, n.libelle AS niveau, ec.nom AS ecole, aa.annee AS annee_academique,
              k.statut AS kit_statut
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       JOIN anneeacademique aa ON aa.id = e.annee_academique_id
       LEFT JOIN departement dept ON dept.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = dept.ecole_id
       LEFT JOIN kit k ON k.etudiant_id = e.id AND k.annee_academique_id = e.annee_academique_id
       WHERE e.site_id = $1
         AND e.annee_academique_id = $2
         AND e.standing = 'Inscrit'
         AND (
           e.nom ILIKE $3 OR e.prenoms ILIKE $3 OR e.matricule_iipea ILIKE $3
           OR (e.nom || ' ' || e.prenoms) ILIKE $3
         )
         ${ecoleCond}
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      params
    );

    const suspendu = await isKitSuspenduPourAnnee(db, anneeAcademiqueId);
    const data = result.rows.map((row) => {
      const statut = !suspendu ? (row.kit_statut || 'NON_TRAITE') : null;
      return { ...row, suspendu, statut };
    });

    res.status(200).json({ success: true, data, annee_academique_id: anneeAcademiqueId });
  } catch (error) {
    console.error('Erreur rechercherEtudiantsKit:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Résolution du Kit pour un étudiant sur SON année académique courante — APPORTE (aucun paiement)
// ou PAYE (paiement Caisse distinct, 5000 FCFA imposés, type_frais='kit_ecole', jamais mêlé au
// paiement de scolarité). Un seul traitement possible par (étudiant, année) — kit_unique_etudiant_annee
// est le filet de sécurité définitif contre une course concurrente, jamais seulement ce contrôle
// applicatif.
exports.traiterKit = async (req, res) => {
  const client = await db.connect();
  try {
    const { etudiant_id, mode, methode } = req.body;

    if (!Number.isInteger(etudiant_id)) {
      return res.status(400).json({ success: false, message: 'Un étudiant est requis.' });
    }
    if (!['APPORTE', 'PAYE'].includes(mode)) {
      return res.status(400).json({ success: false, message: "Le mode doit être 'APPORTE' ou 'PAYE'." });
    }
    if (mode === 'PAYE' && (!methode || !METHODES_VALIDES_NOUVEAU_PAIEMENT.includes(methode))) {
      return res.status(400).json({
        success: false,
        message: `Méthode de paiement invalide. Valeurs acceptées : ${METHODES_VALIDES_NOUVEAU_PAIEMENT.join(', ')}.`,
      });
    }

    await client.query('BEGIN');

    // Verrou sur l'étudiant : sérialise les tentatives concurrentes de traitement Kit pour CE
    // même étudiant (même principe que le verrou accessoire d'enregistrerMouvementStock) — la
    // garantie définitive reste la contrainte UNIQUE (etudiant_id, annee_academique_id).
    const etudiantResult = await client.query(
      'SELECT id, niveau_id, annee_academique_id FROM etudiant WHERE id = $1 FOR UPDATE',
      [etudiant_id]
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const anneeAcademiqueId = etudiant.annee_academique_id;
    if (!anneeAcademiqueId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: "Cet étudiant n'est rattaché à aucune année académique." });
    }

    // Plus d'exemption 1ère année (retirée le 2026-08-29, décision validée) — seule la validation
    // d'existence du niveau (indépendante de cette règle métier) est conservée.
    await validerNiveauExiste(client, etudiant.niveau_id);

    const suspendu = await isKitSuspenduPourAnnee(client, anneeAcademiqueId);
    if (suspendu) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Le module Kit est suspendu pour cette année académique.' });
    }

    const dejaTraite = await client.query(
      'SELECT id FROM kit WHERE etudiant_id = $1 AND annee_academique_id = $2',
      [etudiant_id, anneeAcademiqueId]
    );
    if (dejaTraite.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Le Kit de cet étudiant a déjà été traité pour cette année académique.' });
    }

    let paiementId = null;
    let recuInfo = null;
    if (mode === 'PAYE') {
      const session = await getSessionOuverte(client, req.user.id, req.user.departement_id);
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, code: 'CAISSE_FERMEE', message: 'Ouvrez votre caisse avant d\'encaisser le Kit.' });
      }
      const ecrit = await enregistrerPaiementEtRecu(client, {
        montant: MONTANT_KIT,
        methode,
        effectueParId: req.user.id,
        emetteurCode: req.user.code,
        etudiantId: etudiant_id,
        anneeAcademiqueId,
        sessionCaisseId: session.id,
        caisseId: session.caisse_id,
        typeFrais: 'kit_ecole',
      });
      paiementId = ecrit.paiementId;
      recuInfo = { recu_id: ecrit.recuId, numero_recu: ecrit.numeroRecu };
    }

    const statut = mode === 'PAYE' ? 'KIT_PAYE' : 'KIT_APPORTE';
    let insertion;
    try {
      insertion = await client.query(
        `INSERT INTO kit (etudiant_id, montant, deposer, date_enregistrement, annee_academique_id, statut, paiement_id, traite_par)
         VALUES ($1, $2, false, CURRENT_DATE, $3, $4, $5, $6) RETURNING id`,
        [etudiant_id, mode === 'PAYE' ? MONTANT_KIT : 0, anneeAcademiqueId, statut, paiementId, req.user.id]
      );
    } catch (erreurEcriture) {
      await client.query('ROLLBACK');
      if (erreurEcriture.code === '23505') {
        return res.status(409).json({ success: false, message: 'Le Kit de cet étudiant a déjà été traité pour cette année académique.' });
      }
      throw erreurEcriture;
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { kit_id: insertion.rows[0].id, statut, paiement_id: paiementId, ...(recuInfo || {}) },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof KitEligibiliteError) {
      console.warn(`traiterKit — ${error.code} : ${error.message}`);
      return res.status(404).json({ success: false, code: error.code, message: error.message });
    }
    console.error('Erreur traiterKit:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
