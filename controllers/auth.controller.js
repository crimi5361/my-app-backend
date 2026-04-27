const db = require('../config/db.config'); 
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

exports.login = async (req, res) => {
  const { email, mot_de_passe } = req.body;

  try {
    // 1. D'abord vérifier dans la table utilisateur
    let result = await db.query(
      `SELECT u.id, u.nom, u.email, u.mot_de_passe, r.nom AS role, u.code,
              d.id AS departement_id, d.nom AS departement_nom
       FROM utilisateur u
       JOIN role r ON u.role_id = r.id
       JOIN departement d ON u.departement_id = d.id
       WHERE u.email = $1 AND u.statut = 'active'`,
      [email]
    );

    let utilisateur = null;
    let userType = 'utilisateur';

    // 2. Si pas trouvé dans utilisateur, vérifier dans etudiant
    if (result.rows.length === 0) {
      result = await db.query(
        `SELECT id, nom, prenoms, email, password as mot_de_passe, 
                matricule as code, departement_id,
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

    // 5. Générer le token avec le type d'utilisateur
    const token = jwt.sign(
      { 
        id: utilisateur.id, 
        role: userType === 'etudiant' ? 'etudiant' : utilisateur.role,
        code: utilisateur.code,
        departement_id: utilisateur.departement_id,
        userType: userType
      },
      process.env.JWT_SECRET,
      { expiresIn: '48h' }
    );

    // 6. Préparer la réponse selon le type d'utilisateur
    const responseData = {
      token,
      user: {
        id: utilisateur.id,
        nom: utilisateur.nom,
        email: utilisateur.email,
        role: userType === 'etudiant' ? 'etudiant' : utilisateur.role,
        code: utilisateur.code,
        userType: userType,
        departement: {
          id: utilisateur.departement_id,
          nom: userType === 'etudiant' ? 'Étudiant' : utilisateur.departement_nom
        }
      }
    };

    // 7. Ajouter les infos spécifiques aux étudiants
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