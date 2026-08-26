// Console d'administration de l'assistante (2026-08-26).
//
// À QUI CET ÉCRAN S'ADRESSE, ET À QUI IL NE S'ADRESSE PAS.
//
// Ces routes sont réservées à l'ADMINISTRATEUR. Le fondateur, qui a pourtant
// accès à tout le reste de l'assistante, n'y entre pas — et ce n'est pas une
// précaution de principe. Il ne doit rien savoir de la technique qui le sert :
// ni le modèle, ni le fournisseur, ni les crédits, ni la facturation. Une alerte
// « il reste 40 questions » affichée devant lui trahirait en un coup d'œil tout
// ce que le prompt s'applique à ne pas dire.
//
// Le contrôleur ne fait que valider et poser le contexte de sécurité — le site
// vient du JWT, jamais du corps de la requête. Tout le calcul est dans les
// services.
const credits = require('../services/assistantCredits.service');

/** Le site de l'appelant, refusé plutôt que deviné s'il manque. */
function siteDe(req, res) {
  const siteId = req.user?.departement_id;
  if (!siteId) {
    res.status(400).json({ success: false, message: 'Aucun site rattaché à ce compte.' });
    return null;
  }
  return siteId;
}

/** État des crédits : rechargé, consommé, solde estimé, seuil, coût par question. */
exports.credits = async (req, res) => {
  const siteId = siteDe(req, res);
  if (!siteId) return undefined;
  try {
    const [etat, recharges] = await Promise.all([
      credits.getEtatCredits(siteId),
      credits.listerRecharges(siteId, 20),
    ]);
    return res.json({ success: true, credits: etat, recharges });
  } catch (error) {
    console.error('[console] crédits :', error.message);
    return res.status(500).json({ success: false, message: 'Lecture des crédits impossible.' });
  }
};

/**
 * Enregistre une recharge déclarée.
 *
 * LE MONTANT EST EN DOLLARS, l'unité dans laquelle le fournisseur facture. On ne
 * convertit pas à la saisie : figer un taux de change dans l'historique rendrait
 * tout recalcul impossible le jour où il bouge.
 */
exports.ajouterRecharge = async (req, res) => {
  const siteId = siteDe(req, res);
  if (!siteId) return undefined;

  const montant = Number(req.body?.montant_usd);
  if (!Number.isFinite(montant) || montant <= 0) {
    return res.status(400).json({ success: false, message: 'Le montant rechargé doit être un nombre positif, en dollars.' });
  }
  // Une date future serait une faute de saisie, pas une intention : la refuser
  // évite un solde qui se met à compter une consommation antérieure au crédit.
  const date = req.body?.date_recharge || null;
  if (date && Number.isNaN(Date.parse(date))) {
    return res.status(400).json({ success: false, message: 'Date de recharge illisible.' });
  }
  if (date && new Date(date) > new Date()) {
    return res.status(400).json({ success: false, message: 'La date de recharge ne peut pas être dans le futur.' });
  }

  try {
    const ligne = await credits.ajouterRecharge({
      siteId,
      utilisateurId: req.user.id,
      montantUsd: montant,
      dateRecharge: date,
      note: req.body?.note,
    });
    const etat = await credits.getEtatCredits(siteId);
    return res.status(201).json({ success: true, recharge: ligne, credits: etat });
  } catch (error) {
    console.error('[console] recharge :', error.message);
    return res.status(500).json({ success: false, message: "La recharge n'a pas pu être enregistrée." });
  }
};

/** Règle le seuil d'alerte, en pourcentage du total rechargé. */
exports.majSeuil = async (req, res) => {
  const siteId = siteDe(req, res);
  if (!siteId) return undefined;

  const seuil = Number(req.body?.seuil_pourcentage);
  if (!Number.isFinite(seuil) || seuil < 1 || seuil > 100) {
    return res.status(400).json({ success: false, message: 'Le seuil doit être un pourcentage entre 1 et 100.' });
  }

  try {
    const valeur = await credits.majSeuil(siteId, req.user.id, seuil);
    const etat = await credits.getEtatCredits(siteId);
    return res.json({ success: true, seuil_pourcentage: valeur, credits: etat });
  } catch (error) {
    console.error('[console] seuil :', error.message);
    return res.status(500).json({ success: false, message: "Le seuil n'a pas pu être enregistré." });
  }
};
