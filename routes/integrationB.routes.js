// ============================================================================
//  Routes d'intégration pour l'Application B — préfixe /api/integration/v1
//
//  Séparées des routes des écrans : refus par défaut, authentification machine de B
//  uniquement (middleware/integrationB.middleware.js), jamais de jeton d'utilisateur.
//  Contrat : docs/architecture/contrat-api-a-b.yaml (dépôt de l'Application B), v0.2.
// ============================================================================

const express = require('express');
const { authentifierApplicationB, probleme } = require('../middleware/integrationB.middleware');
const lecture = require('../services/integrationB/lecture');
const evenements = require('../services/integrationB/evenements');
const assiduite = require('../services/integrationB/assiduite');

const router = express.Router();
const VERSION_CONTRAT = '0.2.0';

/** Chemin → (ressource, scope requis). */
const LECTURES = {
  '/annees-academiques': ['annee_academique', 'referentiel:read'],
  '/semestres': ['semestre', 'referentiel:read'],
  '/campus': ['campus', 'referentiel:read'],
  '/ecoles': ['ecole', 'referentiel:read'],
  '/departements': ['departement', 'referentiel:read'],
  '/filieres': ['filiere', 'referentiel:read'],
  '/niveaux': ['niveau', 'referentiel:read'],
  '/classes': ['classe', 'referentiel:read'],
  '/groupes': ['groupe', 'referentiel:read'],
  '/maquettes': ['maquette', 'referentiel:read'],
  '/suppressions': ['suppression', 'referentiel:read'],
  '/etudiants': ['etudiant', 'etudiants:read'],
  '/appartenances': ['appartenance', 'etudiants:read'],
};

function erreurs(res, erreur, next) {
  if (erreur instanceof lecture.ErreurRequete) {
    return probleme(res, erreur.code === 'INTROUVABLE' ? 404 : 400, erreur.code, erreur.message);
  }
  if (erreur instanceof assiduite.ErreurAssiduite) {
    return probleme(res, 400, erreur.code, erreur.message);
  }
  if (erreur instanceof evenements.ErreurEvenement) {
    return probleme(res, erreur.statut, erreur.code, erreur.message);
  }
  console.error('[integration-b]', erreur);
  return probleme(res, 503, 'INDISPONIBLE', 'Service momentanément indisponible', true);
}

router.get('/sante', authentifierApplicationB(), (req, res) => {
  res.json({ statut: 'disponible', version_contrat: VERSION_CONTRAT, heure_serveur: new Date().toISOString() });
});

for (const [chemin, [ressource, scope]] of Object.entries(LECTURES)) {
  router.get(chemin, authentifierApplicationB(scope), async (req, res, next) => {
    try {
      const contenu = await lecture.page(ressource, req.query);
      const etag = `"${lecture.empreinte(contenu)}"`;
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      return res.json({ ...contenu, genere_le: new Date().toISOString() });
    } catch (erreur) {
      return erreurs(res, erreur, next);
    }
  });
}

router.get('/groupes/:id/effectif', authentifierApplicationB('referentiel:read'), async (req, res, next) => {
  try {
    const resultat = await lecture.effectif(req.params.id);
    return resultat ? res.json(resultat) : probleme(res, 404, 'INTROUVABLE', 'Groupe inconnu');
  } catch (erreur) {
    return erreurs(res, erreur, next);
  }
});

// Assiduité (application de Clovis, même base) : résumé par étudiant sur une période (B15).
router.get('/presences', authentifierApplicationB('assiduite:read'), async (req, res, next) => {
  try {
    return res.json(await assiduite.presences(req.query));
  } catch (erreur) {
    return erreurs(res, erreur, next);
  }
});

for (const [cleRoute, { scope }] of Object.entries(evenements.RECEPTIONS)) {
  router.post(`/evenements/${cleRoute}`, authentifierApplicationB(scope), async (req, res, next) => {
    try {
      const { statutHttp, accuse } = await evenements.recevoir(cleRoute, req.get('Idempotency-Key'), req.body);
      return res.status(statutHttp).json(accuse);
    } catch (erreur) {
      return erreurs(res, erreur, next);
    }
  });
}

router.get('/evenements/:id', authentifierApplicationB(), async (req, res, next) => {
  try {
    const accuse = await evenements.lireAccuse(req.params.id);
    return accuse ? res.json(accuse) : probleme(res, 404, 'INTROUVABLE', 'Inconnu');
  } catch (erreur) {
    return erreurs(res, erreur, next);
  }
});

// Refus par défaut : toute autre route du préfixe est inconnue.
router.use((req, res) => probleme(res, 404, 'INTROUVABLE', 'Route inconnue'));

module.exports = router;
