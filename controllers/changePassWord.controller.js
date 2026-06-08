const db = require('../config/db.config');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');


exports.changePassword = async (req, res) => {
  // ── 1. Récupérer et vérifier le token ──────────────────────────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token manquant ou invalide.' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Token expiré ou invalide.' });
  }

  // ── 2. Bloquer les étudiants ───────────────────────────────────────────────
  if (decoded.userType === 'etudiant') {
    return res.status(403).json({
      message: 'Les étudiants ne peuvent pas modifier leur mot de passe via cette interface.',
    });
  }

  // ── 3. Valider le corps de la requête ─────────────────────────────────────
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({
      message: 'Les champs oldPassword et newPassword sont obligatoires.',
    });
  }

  // ── 4. Règles de sécurité (cohérence avec le frontend) ────────────────────
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
  if (!passwordRegex.test(newPassword)) {
    return res.status(400).json({
      message:
        'Le nouveau mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial.',
    });
  }

  if (oldPassword === newPassword) {
    return res.status(400).json({
      message: 'Le nouveau mot de passe doit être différent de l\'ancien.',
    });
  }

  // ── 5. Récupérer l'utilisateur en base ────────────────────────────────────
  try {
    const result = await db.query(
      `SELECT id, nom, email, mot_de_passe, statut
       FROM public.utilisateur
       WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    const utilisateur = result.rows[0];

    // Sécurité supplémentaire : compte toujours actif ?
    if (utilisateur.statut !== 'active') {
      return res.status(403).json({ message: 'Compte inactif. Opération refusée.' });
    }

    // ── 6. Vérifier l'ancien mot de passe ─────────────────────────────────
    const isMatch = await bcrypt.compare(oldPassword, utilisateur.mot_de_passe);
    if (!isMatch) {
      return res.status(401).json({ message: 'Ancien mot de passe incorrect.' });
    }

    // ── 7. Hacher le nouveau mot de passe ─────────────────────────────────
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // ── 8. Mettre à jour en base ───────────────────────────────────────────
    await db.query(
      `UPDATE public.utilisateur
       SET mot_de_passe = $1
       WHERE id = $2`,
      [hashedPassword, utilisateur.id]
    );

    // ── 9. Réponse succès ──────────────────────────────────────────────────
    return res.status(200).json({
      message: 'Mot de passe modifié avec succès.',
    });

  } catch (error) {
    console.error('[changePassword]', error);
    return res.status(500).json({ message: 'Erreur serveur. Veuillez réessayer.' });
  }
};