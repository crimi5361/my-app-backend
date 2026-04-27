const db = require ('../config/db.config');

exports.getAllAnnees = async (req, res) => {
    try {
        const departement_id = req.query.departement_id || req.user?.departement_id;

        if (!departement_id) {
            return res.status(400).json({ message: "departement_id requis" });
        }

        const result = await db.query(
            `SELECT id, annee, etat, departement_id 
             FROM anneeacademique 
             WHERE departement_id = $1
             ORDER BY annee DESC`,
            [departement_id]
        );

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des annees:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};
//===================================
exports.getAllAnneesValide = async (req, res) => {
    try {
        const result = await db.query (`SELECT id, annee, etat FROM anneeacademique Where etat = 'en cour'`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des annees en cours:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
}


// ─── GET toutes les années d'un département ───────────────────────────────
exports.getAnnees = async (req, res) => {
  try {
    const departement_id = req.query.departement_id || req.user?.departement_id;

    if (!departement_id) {
      return res.status(400).json({ message: "departement_id requis" });
    }

    const result = await db.query(
      `SELECT id, annee, etat, departement_id
       FROM anneeacademique
       WHERE departement_id = $1
       ORDER BY annee DESC`,
      [departement_id]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Erreur getAnnees:", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
};

// ─── POST ajouter une année pour un département ───────────────────────────
exports.addAnnee = async (req, res) => {
  try {
    const { annee, etat } = req.body;
    const departement_id = req.body.departement_id || req.user?.departement_id;

    if (!departement_id) {
      return res.status(400).json({ message: "departement_id requis" });
    }

    // Vérifier s'il existe déjà une année "en cour" pour CE département
    const check = await db.query(
      `SELECT * FROM anneeacademique WHERE etat = 'en cour' AND departement_id = $1`,
      [departement_id]
    );

    if (etat === "en cour" && check.rows.length > 0) {
      return res.status(400).json({
        message:
          "Impossible d'ouvrir une nouvelle année 'en cour' tant que l'année actuelle de ce département n'est pas fermée.",
      });
    }

    // Vérifier que cette année n'existe pas déjà pour ce département
    const dupCheck = await db.query(
      `SELECT * FROM anneeacademique WHERE annee = $1 AND departement_id = $2`,
      [annee, departement_id]
    );

    if (dupCheck.rows.length > 0) {
      return res.status(400).json({
        message: `L'année ${annee} existe déjà pour ce département.`,
      });
    }

    const result = await db.query(
      `INSERT INTO anneeacademique (annee, etat, departement_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [annee, etat, departement_id]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Erreur addAnnee:", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
};

// ─── POST fermer une année ────────────────────────────────────────────────
exports.fermerAnnee = async (req, res) => {
  try {
    const { id } = req.params;
    const departement_id = req.user?.departement_id;

    // Vérifier que l'année appartient bien au département de l'utilisateur
    const check = await db.query(
      `SELECT * FROM anneeacademique WHERE id = $1`,
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Année académique non trouvée." });
    }

    // Si l'utilisateur a un département, vérifier la correspondance
    if (departement_id && check.rows[0].departement_id !== parseInt(departement_id)) {
      return res.status(403).json({
        message: "Vous ne pouvez pas modifier une année d'un autre département.",
      });
    }

    const result = await db.query(
      `UPDATE anneeacademique SET etat = 'fermée' WHERE id = $1 RETURNING *`,
      [id]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Erreur fermerAnnee:", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
};

// ─── POST réouvrir une année ──────────────────────────────────────────────
exports.reouvrirAnnee = async (req, res) => {
  try {
    const { id } = req.params;
    const departement_id = req.user?.departement_id;

    const check = await db.query(
      `SELECT * FROM anneeacademique WHERE id = $1`,
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Année académique non trouvée." });
    }

    const annee = check.rows[0];

    // Vérifier correspondance département
    if (departement_id && annee.departement_id !== parseInt(departement_id)) {
      return res.status(403).json({
        message: "Vous ne pouvez pas modifier une année d'un autre département.",
      });
    }

    // Vérifier qu'il n'y a pas déjà une année "en cour" pour ce département
    const encourCheck = await db.query(
      `SELECT * FROM anneeacademique WHERE etat = 'en cour' AND departement_id = $1 AND id != $2`,
      [annee.departement_id, id]
    );

    if (encourCheck.rows.length > 0) {
      return res.status(400).json({
        message:
          "Impossible de réouvrir : une autre année est déjà 'en cour' pour ce département. Fermez-la d'abord.",
      });
    }

    const result = await db.query(
      `UPDATE anneeacademique SET etat = 'en cour' WHERE id = $1 RETURNING *`,
      [id]
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error("Erreur reouvrirAnnee:", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
};


exports.closeAnnee = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query(
            `UPDATE anneeacademique SET etat = 'terminée' WHERE id = $1`,
            [id]
        );
        res.status(200).json({ message: "Année fermée avec succès." });
    } catch (error) {
        console.error('Erreur lors de la fermeture:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};

exports.reopenAnnee = async (req, res) => {
    try {
        const { id } = req.params;

        // Récupérer le departement_id de l'année qu'on veut rouvrir
        const anneeResult = await db.query(
            `SELECT * FROM anneeacademique WHERE id = $1`,
            [id]
        );

        if (anneeResult.rows.length === 0) {
            return res.status(404).json({ message: "Année académique introuvable." });
        }

        const annee = anneeResult.rows[0];

        // Vérifier qu'aucune année "en cour" n'existe POUR CE MÊME DÉPARTEMENT
        const check = await db.query(
            `SELECT * FROM anneeacademique 
             WHERE etat = 'en cour' 
             AND departement_id = $1
             AND id != $2`,
            [annee.departement_id, id]
        );

        if (check.rows.length > 0) {
            return res.status(400).json({ 
                message: "Une année 'en cour' existe déjà pour ce département." 
            });
        }

        await db.query(
            `UPDATE anneeacademique SET etat = 'en cour' WHERE id = $1`,
            [id]
        );

        res.status(200).json({ message: "Année rouverte avec succès." });

    } catch (error) {
        console.error('Erreur lors de la réouverture:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};