// Vérification des permissions individuelles (Chantier Moyens Généraux, Phase 1, 2026-08-19).
// Complète authorizeRoles SANS le remplacer : le rôle détermine l'appartenance à un module
// (ex. authorizeRoles('admin', 'moyens_generaux')), la permission détermine précisément ce que
// CE compte peut faire à l'intérieur — deux collaborateurs peuvent partager le même rôle avec des
// permissions différentes. Les deux middlewares sont donc chaînés sur chaque route protégée,
// jamais l'un à la place de l'autre.
//
// admin garde toujours un accès complet, sans jamais avoir besoin d'une ligne
// utilisateur_permission — même convention que authorizeRoles('admin', ...) partout ailleurs
// dans ce projet (l'admin n'est jamais géré comme un cas particulier de collaborateur restreint).
//
// Correction 2026-08-21 (synchronisation immédiate des permissions) : ces deux middlewares NE
// FONT PLUS confiance à req.user.permissions (peuplé par middleware/auth.middleware.js depuis le
// JWT) — le JWT est signé une seule fois à la connexion et reste valable 48h, donc un retrait/
// ajout de permission par un admin en cours de session ne s'y reflétait jamais avant expiration ou
// reconnexion. Chaque vérification requiert désormais un aller-retour à utilisateur_permission
// (même fonction que controllers/auth.controller.js::login/me, jamais une deuxième logique) : le
// JWT continue de servir à identifier QUI appelle (id/role), plus jamais QUELS accès il a — cette
// question est toujours retranchée sur l'état actuel de la base. req.user.permissions reste peuplé
// côté auth.middleware.js pour compatibilité mais n'est plus lu ici.
const db = require('../config/db.config');
const { getPermissionsUtilisateur } = require('../services/permission.service');

const requirePermission = (code) => async (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  try {
    const permissions = await getPermissionsUtilisateur(db, req.user.id);
    if (!permissions.includes(code)) {
      return res.status(403).json({
        message: 'Accès refusé : permission insuffisante',
        permissionRequise: code,
      });
    }
    next();
  } catch (error) {
    console.error('Erreur requirePermission:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const requireAnyPermission = (...codes) => async (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  try {
    const permissions = await getPermissionsUtilisateur(db, req.user.id);
    if (!codes.some((code) => permissions.includes(code))) {
      return res.status(403).json({
        message: 'Accès refusé : permission insuffisante',
        permissionsRequises: codes,
      });
    }
    next();
  } catch (error) {
    console.error('Erreur requireAnyPermission:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

module.exports = { requirePermission, requireAnyPermission };
