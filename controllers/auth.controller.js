const db = require('../config/db.config');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { getPermissionsUtilisateur } = require('../services/permission.service');

exports.login = async (req, res) => {
  const { email, mot_de_passe } = req.body;

  try {
    // 1. D'abord vérifier dans la table utilisateur
    let result = await db.query(
      `SELECT u.id, u.nom, u.email, u.mot_de_passe, r.nom AS role, u.code,
              d.id AS departement_id, d.nom AS departement_nom, u.ecole_id
       FROM utilisateur u
       JOIN role r ON u.role_id = r.id
       JOIN site d ON u.site_id = d.id
       WHERE u.email = $1 AND u.statut = 'active'`,
      [email]
    );

    let utilisateur = null;
    let userType = 'utilisateur';

    // 2. Si pas trouvé dans utilisateur, vérifier dans etudiant
    if (result.rows.length === 0) {
      result = await db.query(
        `SELECT id, nom, prenoms, email, password as mot_de_passe,
                matricule as code, site_id as departement_id,
                statut_scolaire as statut
         FROM etudiant
         WHERE email = $1 AND standing = 'Inscrit'`,
        [email]
      );

      if (result.rows.length > 0) {
        utilisateur = result.rows[0];
        userType = 'etudiant';
      }
    } else {
      utilisateur = result.rows[0];
    }

    // 3. Si aucun utilisateur trouvé
    if (!utilisateur) {
      return res.status(401).json({ message: 'Utilisateur non trouvé ou inactif.' });
    }

    // 4. Vérifier le mot de passe
    const isMatch = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe);
    if (!isMatch) {
      return res.status(401).json({ message: 'Mot de passe incorrect.' });
    }

    // 5. Permissions individuelles (Chantier Moyens Généraux, Phase 1, 2026-08-19) — jamais pour
    // un compte etudiant, ne concerne que les agents (table utilisateur). Calculées une fois ici
    // et réutilisées à la fois dans le JWT (pour les middlewares backend) et dans le corps de
    // réponse (pour l'affichage/masquage côté frontend) — jamais deux sources de vérité.
    const permissions = userType === 'etudiant' ? [] : await getPermissionsUtilisateur(db, utilisateur.id);

    // 6. Générer le token avec le type d'utilisateur
    const token = jwt.sign(
      {
        id: utilisateur.id,
        role: userType === 'etudiant' ? 'etudiant' : utilisateur.role,
        code: utilisateur.code,
        departement_id: utilisateur.departement_id,
        // Cloisonnement par école (Chantier 3, cf. docs/architecture-permissions-ecole.md) —
        // concerne uniquement les agents (table utilisateur) ; toujours absent pour un etudiant.
        ecole_id: userType === 'etudiant' ? null : utilisateur.ecole_id,
        userType: userType,
        permissions
      },
      process.env.JWT_SECRET,
      { expiresIn: '48h' }
    );

    // 7. Préparer la réponse selon le type d'utilisateur
    const responseData = {
      token,
      user: {
        id: utilisateur.id,
        nom: utilisateur.nom,
        email: utilisateur.email,
        role: userType === 'etudiant' ? 'etudiant' : utilisateur.role,
        code: utilisateur.code,
        userType: userType,
        permissions,
        departement: {
          id: utilisateur.departement_id,
          nom: userType === 'etudiant' ? 'Étudiant' : utilisateur.departement_nom
        }
      }
    };

    // 8. Ajouter les infos spécifiques aux étudiants
    if (userType === 'etudiant') {
      responseData.user.prenoms = utilisateur.prenoms;
      responseData.user.statut = utilisateur.statut;
    }

    res.status(200).json(responseData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// GET /api/auth/me — Correction 2026-08-21 (synchronisation immédiate des permissions). Le JWT est
// signé une seule fois à la connexion et reste valable 48h ; ses `permissions` embarquées se figent
// donc dès l'instant de la connexion et ne reflètent plus un retrait/ajout fait par un admin en
// cours de session (cf. docs — un utilisateur déjà connecté gardait l'usage de stock.voir après que
// l'admin le lui retire, jusqu'à déconnexion/reconnexion). Cet endpoint recalcule les permissions
// RÉELLES depuis utilisateur_permission (même fonction que login, jamais une deuxième logique) —
// le frontend l'appelle périodiquement pour se resynchroniser, sans jamais avoir besoin de
// réémettre un token. req.user.id/role viennent du JWT déjà vérifié (authenticateToken) : cet
// endpoint ne fait qu'authentifier QUI appelle, jamais QUELS accès il a — ça, c'est toujours
// recalculé ici.
exports.me = async (req, res) => {
  try {
    if (req.user.role === 'etudiant') {
      const result = await db.query(
        `SELECT id, nom, prenoms, email, matricule AS code, site_id AS departement_id, statut_scolaire AS statut
         FROM etudiant WHERE id = $1`,
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Compte introuvable.' });
      }
      const etudiant = result.rows[0];
      return res.status(200).json({
        user: {
          id: etudiant.id,
          nom: etudiant.nom,
          prenoms: etudiant.prenoms,
          email: etudiant.email,
          role: 'etudiant',
          code: etudiant.code,
          userType: 'etudiant',
          statut: etudiant.statut,
          permissions: [],
          departement: { id: etudiant.departement_id, nom: 'Étudiant' },
        },
        permissions: [],
      });
    }

    const result = await db.query(
      `SELECT u.id, u.nom, u.email, r.nom AS role, u.code, u.statut,
              d.id AS departement_id, d.nom AS departement_nom, u.ecole_id
       FROM utilisateur u
       JOIN role r ON u.role_id = r.id
       JOIN site d ON u.site_id = d.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Compte introuvable.' });
    }
    const utilisateur = result.rows[0];
    // Réévalue aussi la désactivation d'un compte en cours de session — même principe que pour
    // les permissions : le JWT ne doit jamais rester la source de vérité au-delà de l'instant de
    // sa signature. Un compte désactivé par un admin pendant une session active perd donc
    // immédiatement l'accès, sans attendre l'expiration du token.
    if (utilisateur.statut !== 'active') {
      return res.status(403).json({ message: 'Ce compte a été désactivé.' });
    }

    const permissions = await getPermissionsUtilisateur(db, utilisateur.id);

    res.status(200).json({
      user: {
        id: utilisateur.id,
        nom: utilisateur.nom,
        email: utilisateur.email,
        role: utilisateur.role,
        code: utilisateur.code,
        userType: 'utilisateur',
        permissions,
        departement: { id: utilisateur.departement_id, nom: utilisateur.departement_nom },
        ecole_id: utilisateur.ecole_id,
      },
      permissions,
    });
  } catch (error) {
    console.error('Erreur /api/auth/me:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};