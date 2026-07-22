const db = require('../config/db.config');

// Règle métier (2026-07-18) : pour un étudiant Affecté À LA NOUVELLE ADMISSION, la scolarité
// est toujours 210 000 FCFA. Un étudiant déjà Affecté qui se RÉINSCRIT (même cycle, situation
// financière et académique conformes) conserve l'ancien tarif — voir montant_affecte_reinscription
// ci-dessous. Le statut "Affecté" (bachelier affecté par l'État) ne concerne que les filières
// classiques — BTS 1/2 et Licence 1/2/3 non-Pro. Tous les niveaux Master et toutes les filières
// "Pro" (Licence Pro, Master Pro) sont exclusivement payantes : toujours "Non affecté", quel que
// soit le statut réel ou le contexte (admission/réinscription), comme le reste de la grille
// tarifaire officielle.
const MONTANT_AFFECTE_NOUVELLE_ADMISSION = 210000;
// Ancien tarif Affecté, conservé pour les réinscriptions (progression normale, pas de
// changement de cycle) — distinct du tarif nouvelle admission pour rester évolutif : un futur
// réajustement de l'un ou l'autre montant se fait en base (colonne tarif), pas dans ce fichier.
const MONTANT_AFFECTE_REINSCRIPTION = 150000;
// Montants fixés explicitement (dérogent au prix_formation saisi à la création de la filière) —
// correction demandée par l'utilisateur pour ces deux niveaux précis.
const LIBELLE_MONTANT_FIXE = {
  'LICENCE 1 PRO': 250000,
  'LICENCE 2 PRO': 350000,
};
const estToujoursNonAffecte = (libelleNormalise) =>
  libelleNormalise.includes('PRO') || libelleNormalise.startsWith('MASTER');

// Crée (si absent) le tarif d'un niveau à partir de son libellé et de son prix_formation —
// appelée automatiquement à chaque création/recréation de niveau (voir filieres.controller.js)
// pour que le montant de la scolarité soit toujours disponible, y compris pour une filière
// tout juste créée sur une nouvelle année académique. N'écrase jamais un tarif déjà paramétré
// manuellement (ON CONFLICT DO NOTHING) — utiliser updateTarif pour corriger un montant existant.
exports.ensureTarifForNiveau = async (niveauId, libelle, prixFormation, dbClient = db) => {
  const normalized = String(libelle || '').trim().toUpperCase();
  const toujoursNonAffecte = estToujoursNonAffecte(normalized);
  const montantFixe = LIBELLE_MONTANT_FIXE[normalized];

  const montantAffecte = toujoursNonAffecte ? null : MONTANT_AFFECTE_NOUVELLE_ADMISSION;
  const montantAffecteReinscription = toujoursNonAffecte ? null : MONTANT_AFFECTE_REINSCRIPTION;
  const montantNonAffecte = montantFixe !== undefined ? montantFixe : (parseFloat(prixFormation) || 0);

  await dbClient.query(
    `INSERT INTO tarif (niveau_id, montant_affecte, montant_affecte_reinscription, montant_non_affecte, toujours_non_affecte)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (niveau_id) DO NOTHING`,
    [niveauId, montantAffecte, montantAffecteReinscription, montantNonAffecte, toujoursNonAffecte]
  );
};

// Calcule le montant de scolarité applicable pour un niveau, un statut d'orientation et un
// contexte. contexte='nouvelle_admission' (défaut) utilise le tarif Affecté courant (210 000) ;
// contexte='reinscription' utilise l'ancien tarif Affecté conservé pour les étudiants qui
// progressent dans le même cycle (150 000) — un changement de cycle bascule statutOrientation
// sur 'Non affecté' en amont (reinscription.controller.js), donc cette distinction ne s'applique
// jamais à un changement de cycle, seulement à une progression normale d'un étudiant déjà Affecté.
// Réutilisable par les contrôleurs (admission, réinscription) sans passer par HTTP.
exports.calculerMontantScolarite = async (niveauId, statutOrientation, contexte = 'nouvelle_admission') => {
  const result = await db.query(
    'SELECT montant_affecte, montant_affecte_reinscription, montant_non_affecte, toujours_non_affecte FROM tarif WHERE niveau_id = $1',
    [niveauId]
  );
  if (result.rows.length === 0) return null;

  const tarif = result.rows[0];
  const estAffecte = statutOrientation === 'Affecté' && !tarif.toujours_non_affecte;
  const montantAffecteApplicable = contexte === 'reinscription' ? tarif.montant_affecte_reinscription : tarif.montant_affecte;
  const montant = estAffecte ? montantAffecteApplicable : tarif.montant_non_affecte;
  return {
    montant: montant !== null ? parseFloat(montant) : null,
    statut_applique: estAffecte ? 'Affecté' : 'Non affecté',
    toujours_non_affecte: tarif.toujours_non_affecte,
  };
};

exports.getTarifByNiveau = async (req, res) => {
  try {
    const { niveauId } = req.params;
    const { statut } = req.query;

    const tarifInfo = await exports.calculerMontantScolarite(niveauId, statut || 'Non affecté');
    if (!tarifInfo) {
      return res.status(404).json({ success: false, message: 'Aucun tarif configuré pour ce niveau.' });
    }
    res.status(200).json({ success: true, data: tarifInfo });
  } catch (error) {
    console.error('Erreur getTarifByNiveau:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getAllTarifs = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.id, t.niveau_id, n.libelle AS niveau_libelle, f.nom AS filiere_nom,
              t.montant_affecte, t.montant_affecte_reinscription, t.montant_non_affecte, t.toujours_non_affecte
       FROM tarif t
       JOIN niveau n ON n.id = t.niveau_id
       JOIN filiere f ON f.id = n.filiere_id
       ORDER BY f.nom, n.libelle`
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getAllTarifs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateTarif = async (req, res) => {
  try {
    const { id } = req.params;
    const { montant_affecte, montant_affecte_reinscription, montant_non_affecte, toujours_non_affecte } = req.body;

    if (montant_non_affecte === undefined) {
      return res.status(400).json({ success: false, message: 'montant_non_affecte est requis.' });
    }

    const result = await db.query(
      `UPDATE tarif SET montant_affecte = $1, montant_affecte_reinscription = $2, montant_non_affecte = $3, toujours_non_affecte = $4, updated_at = now()
       WHERE id = $5 RETURNING *`,
      [montant_affecte ?? null, montant_affecte_reinscription ?? null, montant_non_affecte, !!toujours_non_affecte, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tarif introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur updateTarif:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
