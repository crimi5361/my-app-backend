const db = require('../config/db.config');
const bcrypt = require('bcrypt');
const { getPermissionsDisponiblesPourRole } = require('../services/permission.service');

// Valide qu'une école existe et est active avant de l'affecter à un agent (Chantier 3 —
// convention documentée dans docs/architecture-permissions-ecole.md, jamais codée jusqu'ici).
// ecole_id vide (null/undefined) est un cas valide : vue globale, aucune validation nécessaire.
const validerEcoleActive = async (ecoleId) => {
  if (!ecoleId) return { valide: true };
  const result = await db.query(`SELECT id FROM public.ecole WHERE id = $1 AND statut = 'actif'`, [ecoleId]);
  if (result.rows.length === 0) {
    return { valide: false, message: "École introuvable ou inactive." };
  }
  return { valide: true };
};

// Récupérer tous les utilisateurs
exports.getAllUsers = async (req, res) => {
  try {
    const result = await db.query(`SELECT
            u.id,
            u.nom,
            u.email,
            u.site_id,
            d.nom AS departement,
            u.role_id,
            r.nom AS role,
            u.statut,
            u.code,
            u.ecole_id,
            ec.nom AS ecole_nom
            FROM public.utilisateur u
            JOIN public.site d ON u.site_id = d.id
            JOIN public.role r ON u.role_id = r.id
            LEFT JOIN public.ecole ec ON u.ecole_id = ec.id
`);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des roles:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};


//============================================================================================================

// Ajouter un nouvel utilisateur
exports.createUser = async (req, res) => {
  const { nom, email, departement_id, role_id, ecole_id } = req.body;

  // Validation minimale
  if (!nom || !email || !departement_id || !role_id) {
    return res.status(400).json({ message: 'Champs requis manquants.' });
  }

  try {
    // Vérifie si l'utilisateur existe déjà
    const existingUser = await db.query(
      'SELECT * FROM public.utilisateur WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ message: "L'utilisateur existe déjà." });
    }

    const ecoleValidation = await validerEcoleActive(ecole_id);
    if (!ecoleValidation.valide) {
      return res.status(400).json({ message: ecoleValidation.message });
    }

    // Hasher le mot de passe par défaut
    const hashedPassword = await bcrypt.hash('@elites@', 10); // sel de 10

    // Générer un code aléatoire à 4 chiffres (entre 1000 et 9999)
    const code = Math.floor(1000 + Math.random() * 9000);

    // Insérer l'utilisateur avec le code
    const result = await db.query(
      `INSERT INTO public.utilisateur (nom, email, mot_de_passe, site_id, role_id, statut, code, ecole_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [nom, email, hashedPassword, departement_id, role_id, 'active', code, ecole_id || null]
    );

    res.status(201).json({
      message: 'Utilisateur ajouté avec succès.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Erreur lors de la création de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur lors de la création de l’utilisateur.' });
  }
};

//============================================================================================================

// Modifier le rôle, le site et l'affectation à une école d'un utilisateur existant (Chantier 3 —
// permet de créer, modifier ou retirer (ecole_id = null) l'affectation d'un agent à une école).
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { role_id, departement_id, ecole_id } = req.body;

  if (!role_id || !departement_id) {
    return res.status(400).json({ message: 'role_id et departement_id sont requis.' });
  }

  try {
    const ecoleValidation = await validerEcoleActive(ecole_id);
    if (!ecoleValidation.valide) {
      return res.status(400).json({ message: ecoleValidation.message });
    }

    const result = await db.query(
      `UPDATE public.utilisateur
       SET role_id = $1, site_id = $2, ecole_id = $3
       WHERE id = $4
       RETURNING id, nom, email, role_id, site_id, ecole_id, statut, code`,
      [role_id, departement_id, ecole_id || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    res.status(200).json({
      message: 'Utilisateur mis à jour avec succès.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur lors de la mise à jour de l’utilisateur.' });
  }
};

//============================================================================================================

// Désactivation d'un utilisateur — jamais de suppression physique : le compte reste en base
// (historique, audit, documents déjà émis en son nom) mais son statut passe à 'desactive'.
// Le login le refuse déjà explicitement (auth.controller.js : WHERE u.statut = 'active'), donc
// aucun autre changement n'est nécessaire pour bloquer sa connexion.
exports.deactivateUser = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `UPDATE public.utilisateur SET statut = 'desactive' WHERE id = $1
       RETURNING id, nom, email, statut`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    res.status(200).json({
      message: 'Utilisateur désactivé avec succès.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Erreur lors de la désactivation de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur lors de la désactivation de l’utilisateur.' });
  }
};

//============================================================================================================

// Symétrique de deactivateUser : remet le statut à 'active', ce qui suffit à rouvrir l'accès au
// login (même condition WHERE u.statut = 'active' dans auth.controller.js).
exports.reactivateUser = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `UPDATE public.utilisateur SET statut = 'active' WHERE id = $1
       RETURNING id, nom, email, statut`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    res.status(200).json({
      message: 'Utilisateur réactivé avec succès.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Erreur lors de la réactivation de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur lors de la réactivation de l’utilisateur.' });
  }
};

//============================================================================================================
// Permissions PAR RÔLE (Chantier Moyens Généraux, Phase 1, corrigé le 2026-08-19) — réservé à
// admin, comme le reste de ce fichier (routes/user.routes.js). La création de compte reste
// exclusivement admin (inchangé) ; ces deux endpoints ne font qu'attribuer, à un compte déjà créé,
// des permissions parmi celles disponibles pour SON rôle (voir services/permission.service.js
// pour la distinction rolepermission = catalogue / utilisateur_permission = accès réel).

// Catalogue des permissions disponibles pour le RÔLE de cet utilisateur, avec pour chacune si
// CET utilisateur l'a déjà — jamais les permissions d'un autre rôle. Catalogue vide (rôle sans
// permission configurée, ex. scolarite aujourd'hui) → tableau vide, pas une erreur.
exports.getPermissionsUtilisateur = async (req, res) => {
  const { id } = req.params;
  try {
    const userResult = await db.query(
      `SELECT u.id, r.id AS role_id, r.nom AS role_nom
       FROM utilisateur u JOIN role r ON r.id = u.role_id
       WHERE u.id = $1`,
      [id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }
    const { role_id: roleId, role_nom: roleNom } = userResult.rows[0];

    const catalogue = await getPermissionsDisponiblesPourRole(db, roleId);
    const accordeesResult = await db.query(
      'SELECT permission_id FROM utilisateur_permission WHERE utilisateur_id = $1',
      [id]
    );
    const accordeesIds = new Set(accordeesResult.rows.map((r) => r.permission_id));

    res.status(200).json({
      role: roleNom,
      permissions: catalogue.map((p) => ({ ...p, accorde: accordeesIds.has(p.id) })),
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des permissions de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// Remplace intégralement l'ensemble des permissions accordées à un utilisateur — même geste que
// rolepermission.controller.js::attribuerPermissionsARole (DELETE puis ré-insertion), mais au
// grain utilisateur plutôt que rôle, et transactionnel (jamais un état intermédiaire visible).
// Validation stricte : seules des permissions appartenant au catalogue du RÔLE de cet utilisateur
// peuvent être accordées — le catalogue (rolepermission) est la seule source de vérité de ce qui
// est configurable pour lui, jamais une confiance aveugle dans la liste envoyée par le frontend.
exports.setPermissionsUtilisateur = async (req, res) => {
  const { id } = req.params;
  const { permission_ids } = req.body;

  if (!Array.isArray(permission_ids)) {
    return res.status(400).json({ message: 'permission_ids (tableau) est requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT u.id, r.id AS role_id
       FROM utilisateur u JOIN role r ON r.id = u.role_id
       WHERE u.id = $1 FOR UPDATE OF u`,
      [id]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }
    const roleId = userResult.rows[0].role_id;

    const catalogue = await getPermissionsDisponiblesPourRole(client, roleId);
    const catalogueIds = new Set(catalogue.map((p) => p.id));
    const idsHorsCatalogue = permission_ids.filter((pid) => !catalogueIds.has(pid));
    if (idsHorsCatalogue.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Permission(s) non disponible(s) pour le rôle de cet utilisateur : ${idsHorsCatalogue.join(', ')}.`,
      });
    }

    await client.query('DELETE FROM utilisateur_permission WHERE utilisateur_id = $1', [id]);
    for (const permissionId of permission_ids) {
      await client.query(
        `INSERT INTO utilisateur_permission (utilisateur_id, permission_id, accorde_par)
         VALUES ($1, $2, $3)`,
        [id, permissionId, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Permissions mises à jour avec succès.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de la mise à jour des permissions de l’utilisateur:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
