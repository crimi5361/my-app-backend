// Chantier "Projection des listes de classes prévisionnelles" (2026-09-05) — voir
// services/projectionGroupes.service.js pour la logique métier complète et
// migrations/sql/043_projection_groupes.sql pour le contexte. Ce controller ne fait que valider
// les entrées HTTP, résoudre le site de l'agent connecté (cloisonnement) et déléguer au service —
// aucune requête SQL directe ici.
const projectionService = require('../services/projectionGroupes.service');

// GET /api/projections-groupes/niveaux-cibles?filiereId=&anneeCibleId=
// Alimente le sélecteur "Niveau" du frontend — ne propose que les niveaux de POURSUITE (L2, L3,
// BTS2...), jamais les niveaux d'entrée (L1, BTS1, Master 1), déterminé dynamiquement via
// niveau_suivant_id (voir service), jamais une liste de libellés codée en dur.
exports.listerNiveauxCibles = async (req, res) => {
  try {
    const { filiereId, anneeCibleId } = req.query;
    const siteId = req.user?.departement_id;
    if (!siteId) {
      return res.status(400).json({ success: false, message: "Site de l'agent introuvable" });
    }
    if (!filiereId || !anneeCibleId) {
      return res.status(400).json({ success: false, message: 'filiereId et anneeCibleId sont requis.' });
    }

    const niveaux = await projectionService.listerNiveauxCibles({
      filiereId: parseInt(filiereId, 10),
      anneeCibleId: parseInt(anneeCibleId, 10),
      siteId,
    });
    res.status(200).json({ success: true, data: niveaux });
  } catch (err) {
    console.error('Erreur listerNiveauxCibles:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: err.message });
  }
};

// POST /api/projections-groupes/generer
// Génère (ou régénère — DELETE+INSERT dans la même transaction, voir service) la projection pour
// (filière, niveau cible, année cible). niveauSourceId est optionnel : à fournir uniquement si la
// résolution automatique via niveau_suivant_id échoue (filière générique sans chaînage direct —
// voir service, ne bloque jamais silencieusement).
exports.genererProjection = async (req, res) => {
  try {
    const { filiereId, niveauCibleId, anneeCibleId, niveauSourceId } = req.body || {};
    const siteId = req.user?.departement_id;
    const utilisateurId = req.user?.id;
    if (!siteId) {
      return res.status(400).json({ success: false, message: "Site de l'agent introuvable" });
    }
    if (!filiereId || !niveauCibleId || !anneeCibleId) {
      return res.status(400).json({ success: false, message: 'filiereId, niveauCibleId et anneeCibleId sont requis.' });
    }

    const resultat = await projectionService.genererProjection({
      filiereId: parseInt(filiereId, 10),
      niveauCibleId: parseInt(niveauCibleId, 10),
      anneeCibleId: parseInt(anneeCibleId, 10),
      niveauSourceId: niveauSourceId ? parseInt(niveauSourceId, 10) : null,
      siteId,
      utilisateurId,
    });
    res.status(200).json({ success: true, data: resultat });
  } catch (err) {
    console.error('Erreur genererProjection:', err);
    res.status(400).json({ success: false, message: err.message });
  }
};

// GET /api/projections-groupes?filiereId=&niveauCibleId=&anneeCibleId=
// Lecture pure — ne recalcule JAMAIS les décisions ADMIS/AJOURNÉ (déjà figées à la génération),
// seul le statut de réinscription est recalculé à la lecture (voir service).
exports.getProjection = async (req, res) => {
  try {
    const { filiereId, niveauCibleId, anneeCibleId } = req.query;
    const siteId = req.user?.departement_id;
    if (!siteId) {
      return res.status(400).json({ success: false, message: "Site de l'agent introuvable" });
    }
    if (!filiereId || !niveauCibleId || !anneeCibleId) {
      return res.status(400).json({ success: false, message: 'filiereId, niveauCibleId et anneeCibleId sont requis.' });
    }

    const resultat = await projectionService.getProjection({
      filiereId: parseInt(filiereId, 10),
      niveauCibleId: parseInt(niveauCibleId, 10),
      anneeCibleId: parseInt(anneeCibleId, 10),
      siteId,
    });

    if (!resultat) {
      return res.status(404).json({ success: false, message: 'Aucune projection générée pour cette combinaison.', code: 'PROJECTION_NOT_FOUND' });
    }

    const groupes = resultat.lignes.map((ligne) => ({
      id: ligne.id,
      nom: ligne.nom_groupe,
      ordre: ligne.ordre,
      capaciteReference: ligne.capacite_reference,
      etudiants: resultat.etudiantsParLigne.get(ligne.id) || [],
    }));

    res.status(200).json({
      success: true,
      data: {
        projection: resultat.projection,
        groupes,
      },
    });
  } catch (err) {
    console.error('Erreur getProjection:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: err.message });
  }
};
