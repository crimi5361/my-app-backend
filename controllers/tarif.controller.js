const db = require('../config/db.config');

// Règle métier (2026-07-18, affinée le 2026-08-21 — chantier tarification PRO) : pour un
// étudiant Affecté À LA NOUVELLE ADMISSION sur un niveau NON professionnel (BTS 1/2, Licence
// 1/2/3 non-Pro), la scolarité est 210 000 FCFA. Un étudiant déjà Affecté qui se RÉINSCRIT (même
// cycle, situation financière et académique conformes) conserve l'ancien tarif — voir
// montant_affecte_reinscription ci-dessous. Master et les niveaux "Pro" au-delà de Licence 1/2
// restent exclusivement payants : toujours "Non affecté".
//
// EXCEPTION (chantier 2026-08-21) : LICENCE 1 PRO et LICENCE 2 PRO sortent de cette exclusion —
// un étudiant Affecté y est désormais autorisé, à un tarif STANDARD dédié
// (TARIFS_AFFECTE_PRO_STANDARD), avec surcharge possible par filière via `tarif.montant_affecte`
// (écran d'administration existant, PUT /api/tarif/:id via FiliereParcoursDrawer.tsx) — aucun
// champ "filière reconnue" créé : une filière a un tarif spécifique simplement quand son
// montant_affecte diffère du standard pour ce niveau.
const MONTANT_AFFECTE_NOUVELLE_ADMISSION = 210000;
// Ancien tarif Affecté, conservé pour les réinscriptions (progression normale, pas de
// changement de cycle) — distinct du tarif nouvelle admission pour rester évolutif : un futur
// réajustement de l'un ou l'autre montant se fait en base (colonne tarif), pas dans ce fichier.
const MONTANT_AFFECTE_REINSCRIPTION = 150000;
// Tarifs standards Affecté pour LICENCE 1 PRO / LICENCE 2 PRO — valeur de DÉPART à la création
// automatique d'un tarif (ensureTarifForNiveau), jamais réécrits une fois configurés (ON CONFLICT
// DO NOTHING). Une filière reconnue à tarif spécifique s'obtient en corrigeant montant_affecte
// via updateTarif, jamais en modifiant ce dictionnaire (qui reste le standard société entier).
// N'intervient JAMAIS dans montant_non_affecte (qui repose uniquement sur prix_formation, comme
// tout autre niveau — l'ancien hardcode qui l'imposait ici, indépendamment de la filière, était
// la cause du chantier).
const TARIFS_AFFECTE_PRO_STANDARD = {
  'LICENCE 1 PRO': 250000,
  'LICENCE 2 PRO': 350000,
};
const estToujoursNonAffecte = (libelleNormalise) =>
  (libelleNormalise.includes('PRO') && !(libelleNormalise in TARIFS_AFFECTE_PRO_STANDARD))
  || libelleNormalise.startsWith('MASTER');

// Chantier tarification PRO — administration (2026-08-21) : le tarif Affecté STANDARD d'un
// niveau (avant toute surcharge filière), exposé en lecture pour que l'écran d'administration
// (FiliereParcoursDrawer.tsx) affiche "Tarif standard : 250 000 FCFA" sans jamais dupliquer cette
// connaissance côté frontend — le backend reste l'unique source de vérité, y compris pour ce
// texte informatif. Retourne null si le niveau est "toujours Non affecté" (aucun tarif Affecté
// n'est possible, quelle que soit la filière).
exports.getMontantAffecteStandard = (libelle) => {
  const normalized = String(libelle || '').trim().toUpperCase();
  if (estToujoursNonAffecte(normalized)) return null;
  return TARIFS_AFFECTE_PRO_STANDARD[normalized] !== undefined
    ? TARIFS_AFFECTE_PRO_STANDARD[normalized]
    : MONTANT_AFFECTE_NOUVELLE_ADMISSION;
};

// Crée (si absent) le tarif d'un niveau à partir de son libellé et de son prix_formation —
// appelée automatiquement à chaque création/recréation de niveau (voir filieres.controller.js)
// pour que le montant de la scolarité soit toujours disponible, y compris pour une filière
// tout juste créée sur une nouvelle année académique. N'écrase jamais un tarif déjà paramétré
// manuellement (ON CONFLICT DO NOTHING) — utiliser updateTarif pour corriger un montant existant.
//
// `tarifSource` (optionnel, chantier 2026-08-21 §8 — duplication d'année) : le tarif du niveau
// DUPLIQUÉ (année précédente), transmis par filieres.controller.js::dupliquerNiveauxDeFiliere.
// Si ce niveau source porte une configuration Affecté SPÉCIFIQUE pour LICENCE 1 PRO / LICENCE 2
// PRO (montant_affecte non nul ET différent du standard, toujours_non_affecte=false), elle est
// reportée telle quelle sur le nouveau tarif plutôt que de repartir du standard — évite de perdre
// silencieusement une configuration filière volontaire (ex. ASSISTANAT DE DIRECTION) à chaque
// nouvelle année. Si le tarif source était simplement le standard (ou absent/non spécifique), ce
// n'est PAS considéré comme une configuration spécifique : le nouveau tarif repart du standard.
exports.ensureTarifForNiveau = async (niveauId, libelle, prixFormation, dbClient = db, tarifSource = null) => {
  const normalized = String(libelle || '').trim().toUpperCase();
  const toujoursNonAffecte = estToujoursNonAffecte(normalized);
  const standardProAffecte = TARIFS_AFFECTE_PRO_STANDARD[normalized];

  let montantAffecte = toujoursNonAffecte
    ? null
    : (standardProAffecte !== undefined ? standardProAffecte : MONTANT_AFFECTE_NOUVELLE_ADMISSION);
  // Aucune valeur de réinscription n'est inventée pour LICENCE 1/2 PRO (aucun montant métier
  // fourni à ce jour) — reste NULL tant qu'un administrateur ne la configure pas explicitement ;
  // la réinscription refuse alors proprement (voir reinscription.controller.js) plutôt que
  // d'utiliser un montant arbitraire.
  let montantAffecteReinscription = toujoursNonAffecte
    ? null
    : (standardProAffecte !== undefined ? null : MONTANT_AFFECTE_REINSCRIPTION);

  if (!toujoursNonAffecte && standardProAffecte !== undefined && tarifSource) {
    const sourceEstSpecifique = tarifSource.montant_affecte !== null
      && tarifSource.montant_affecte !== undefined
      && !tarifSource.toujours_non_affecte
      && parseFloat(tarifSource.montant_affecte) !== standardProAffecte;
    if (sourceEstSpecifique) {
      montantAffecte = parseFloat(tarifSource.montant_affecte);
      montantAffecteReinscription = (tarifSource.montant_affecte_reinscription !== null && tarifSource.montant_affecte_reinscription !== undefined)
        ? parseFloat(tarifSource.montant_affecte_reinscription)
        : null;
    }
  }

  const montantNonAffecte = parseFloat(prixFormation) || 0;

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
