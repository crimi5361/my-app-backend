// ============================================================================
//  Authentification machine de l'Application B (contrat d'intégration v0.2, décision T1)
//
//  B signe lui-même un JWT RS256 de 5 minutes avec sa clé privée ; A le vérifie avec la clé
//  publique de B, rangée dans sa configuration. A ne stocke aucun secret ; retirer la clé
//  publique révoque B. Ces routes ne renseignent jamais req.user : B n'est pas un utilisateur.
//
//  Configuration (.env.local / .env.production) :
//    CLES_PUBLIQUES_APPLICATION_B = chemin d'un fichier JSON { "<kid>": "<PEM>" , ... }
//      (plusieurs clés pendant une rotation) — ou CLE_PUBLIQUE_APPLICATION_B (PEM seul, kid libre).
// ============================================================================

const fs = require('fs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db.config');

const EMETTEUR = 'iipea-application-b';
const AUDIENCE = 'iipea-application-a-integration';

function probleme(res, statut, code, titre, reessayable = false) {
  return res
    .status(statut)
    .type('application/problem+json')
    .send(JSON.stringify({ title: titre, status: statut, code, reessayable }));
}

let clesEnCache = null;

/** Clés publiques de B par `kid` (lues une fois). */
function clesPubliques() {
  if (clesEnCache) return clesEnCache;
  const cles = {};
  if (process.env.CLES_PUBLIQUES_APPLICATION_B) {
    Object.assign(cles, JSON.parse(fs.readFileSync(process.env.CLES_PUBLIQUES_APPLICATION_B, 'utf8')));
  }
  if (process.env.CLE_PUBLIQUE_APPLICATION_B) {
    cles['*'] = process.env.CLE_PUBLIQUE_APPLICATION_B.replace(/\\n/g, '\n');
  }
  clesEnCache = cles;
  return cles;
}

/** Pour les tests : force la relecture de la configuration. */
function oublierCles() {
  clesEnCache = null;
}

/** Enregistre le `jti` ; faux s'il a déjà servi (rejeu). Purge au passage les jetons expirés. */
async function premierUsage(jti, expireLe) {
  await pool.query('DELETE FROM integration_b_jeton_vu WHERE expire_le < now()');
  const resultat = await pool.query(
    'INSERT INTO integration_b_jeton_vu (jti, expire_le) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [jti, expireLe]
  );
  return resultat.rowCount === 1;
}

/**
 * Middleware : `authentifierApplicationB('referentiel:read')`. Sans scope requis (santé,
 * accusés), le jeton doit seulement être valide.
 */
function authentifierApplicationB(scopeRequis = '') {
  return async (req, res, next) => {
    const entete = req.headers.authorization || '';
    if (!entete.startsWith('Bearer ')) return probleme(res, 401, 'JETON_ABSENT', 'Jeton absent');
    const jeton = entete.slice('Bearer '.length);

    const decode = jwt.decode(jeton, { complete: true });
    const kid = decode && decode.header && decode.header.kid;
    if (!kid) return probleme(res, 401, 'JETON_INVALIDE', 'Identifiant de clé (kid) absent');
    const cles = clesPubliques();
    const cle = cles[kid] || cles['*'];
    if (!cle) return probleme(res, 401, 'JETON_INVALIDE', 'Clé inconnue');

    let charge;
    try {
      charge = jwt.verify(jeton, cle, {
        algorithms: ['RS256'],
        issuer: EMETTEUR,
        audience: AUDIENCE,
      });
    } catch (erreur) {
      return probleme(res, 401, 'JETON_INVALIDE', 'Jeton invalide');
    }
    if (!charge.jti || !charge.exp || !charge.iat) {
      return probleme(res, 401, 'JETON_INVALIDE', 'Revendications obligatoires absentes');
    }
    try {
      if (!(await premierUsage(charge.jti, new Date(charge.exp * 1000)))) {
        return probleme(res, 401, 'JETON_REJOUE', 'Jeton déjà utilisé');
      }
    } catch (erreur) {
      return next(erreur);
    }
    const scopes = String(charge.scope || '').split(' ').filter(Boolean);
    if (scopeRequis && !scopes.includes(scopeRequis)) {
      return probleme(res, 403, 'SCOPE_INSUFFISANT', 'Scope insuffisant');
    }
    req.applicationB = { kid, scopes };
    return next();
  };
}

module.exports = { authentifierApplicationB, oublierCles, probleme, EMETTEUR, AUDIENCE };
