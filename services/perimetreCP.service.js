// Module Gestion des Enseignants (2026-08-11) — périmètre du Chargé Pédagogique.
//
// Règle §4 du cahier des charges : « Le Chargé Pédagogique ne gère que les filières
// (ex: BTS 1) qui lui sont rattachées. » Ce périmètre est stocké dans
// affectation_charge_pedagogique sous forme de couples (filiere_id, niveau_id) où
// niveau_id NULL signifie « toute la filière ».
//
// Toute la logique de filtrage vit ici : les contrôleurs ne doivent jamais reconstruire
// la condition à la main, sous peine de la voir diverger d'un écran à l'autre (le
// problème déjà rencontré avec PAGE_PERMISSIONS côté frontend).
const db = require('../config/db.config');

// L'administrateur voit tout : il n'a pas d'affectation et ne doit pas se retrouver
// avec un périmètre vide.
const A_ACCES_GLOBAL = (role) => role === 'admin' || role === 'rh';

/**
 * Fragment SQL réutilisable qui restreint une requête au périmètre du CP connecté.
 *
 * @param {object} req            requête Express (req.user renseigné par auth.middleware)
 * @param {string} aliasFiliere   expression SQL donnant la filière de la ligne (ex: 'c.filiere_id')
 * @param {string} aliasNiveau    expression SQL donnant le niveau de la ligne (ex: 'c.niveau_id')
 * @param {number} indexParam     numéro du prochain paramètre libre ($n)
 * @returns {{ clause: string, params: any[] }} clause déjà préfixée de ' AND ' ou vide
 */
function clausePerimetre(req, aliasFiliere, aliasNiveau, indexParam) {
  if (A_ACCES_GLOBAL(req.user?.role)) return { clause: '', params: [] };

  return {
    clause: ` AND EXISTS (
      SELECT 1 FROM affectation_charge_pedagogique acp
      WHERE acp.utilisateur_id = $${indexParam}
        AND acp.filiere_id = ${aliasFiliere}
        AND (acp.niveau_id IS NULL OR acp.niveau_id = ${aliasNiveau})
    )`,
    params: [req.user.id],
  };
}

/** Filières et niveaux rattachés au CP, pour alimenter les sélecteurs de ses écrans. */
async function getPerimetre(req) {
  if (A_ACCES_GLOBAL(req.user?.role)) {
    const result = await db.query(
      `SELECT f.id AS filiere_id, f.nom AS filiere, f.sigle,
              NULL::int AS niveau_id, NULL::varchar AS niveau
       FROM filiere f ORDER BY f.nom`
    );
    return { global: true, lignes: result.rows };
  }

  const result = await db.query(
    `SELECT acp.id, f.id AS filiere_id, f.nom AS filiere, f.sigle,
            n.id AS niveau_id, n.libelle AS niveau
     FROM affectation_charge_pedagogique acp
     JOIN filiere f ON f.id = acp.filiere_id
     LEFT JOIN niveau n ON n.id = acp.niveau_id
     WHERE acp.utilisateur_id = $1
     ORDER BY f.nom, n.ordre NULLS FIRST`,
    [req.user.id]
  );
  return { global: false, lignes: result.rows };
}

/**
 * Garde à appeler avant toute écriture portant sur une classe : vérifie que la classe
 * appartient bien au périmètre du CP connecté. Retourne null si l'accès est permis,
 * sinon un message d'erreur prêt à renvoyer en 403.
 */
async function verifierClasseDansPerimetre(req, classeId) {
  if (A_ACCES_GLOBAL(req.user?.role)) return null;

  const result = await db.query(
    `SELECT 1 FROM classe c
     WHERE c.id = $1 AND EXISTS (
       SELECT 1 FROM affectation_charge_pedagogique acp
       WHERE acp.utilisateur_id = $2
         AND acp.filiere_id = c.filiere_id
         AND (acp.niveau_id IS NULL OR acp.niveau_id = c.niveau_id)
     )`,
    [classeId, req.user.id]
  );
  return result.rows.length > 0
    ? null
    : "Cette classe ne relève pas de votre périmètre.";
}

/** Même garde, pour un couple filière/niveau saisi directement (besoins, offres). */
async function verifierFiliereDansPerimetre(req, filiereId, niveauId) {
  if (A_ACCES_GLOBAL(req.user?.role)) return null;

  const result = await db.query(
    `SELECT 1 FROM affectation_charge_pedagogique acp
     WHERE acp.utilisateur_id = $1
       AND acp.filiere_id = $2
       AND (acp.niveau_id IS NULL OR $3::int IS NULL OR acp.niveau_id = $3)`,
    [req.user.id, filiereId, niveauId || null]
  );
  return result.rows.length > 0
    ? null
    : "Cette filière ne relève pas de votre périmètre.";
}

module.exports = {
  clausePerimetre,
  getPerimetre,
  verifierClasseDansPerimetre,
  verifierFiliereDansPerimetre,
  A_ACCES_GLOBAL,
};
