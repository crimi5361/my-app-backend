const db = require('../config/db.config');
const { ensureTarifForNiveau } = require('./tarif.controller');
const { getSiteFromUser, getAnneeAcademiqueEnCoursPourSite } = require('./filieres.controller');

exports.getNiveauxByFiliere = async (req, res) => {
    try {
        const { filiereId } = req.params; // récupération de l'ID depuis l'URL
        const { site_id, anneeacademique_id } = req.query;

        const conditions = ['filiere_id = $1'];
        const params = [filiereId];

        if (site_id) {
            params.push(site_id);
            conditions.push(`site_id = $${params.length}`);
        }
        if (anneeacademique_id) {
            params.push(anneeacademique_id);
            conditions.push(`anneeacademique_id = $${params.length}`);
        }

        const result = await db.query(`
            SELECT id, libelle, prix_formation, type_filiere, filiere_id, site_id, anneeacademique_id
            FROM niveau
            WHERE ${conditions.join(' AND ')}
        `, params);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des niveaux :', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};

// Liste des niveaux réellement configurés (un par filière), pour l'année académique
// demandée — auparavant réduits en un seul par libellé via DISTINCT ON, ce qui masquait
// les 9/10 des niveaux existants (chaque filière a son propre niveau "LICENCE 1", etc.).
exports.getAllNiveau = async (req, res) => {
    try {
        const { site_id, anneeacademique_id } = req.query;

        const conditions = [];
        const params = [];
        if (site_id) {
            params.push(site_id);
            conditions.push(`n.site_id = $${params.length}`);
        }
        if (anneeacademique_id) {
            params.push(anneeacademique_id);
            conditions.push(`n.anneeacademique_id = $${params.length}`);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await db.query(`
           SELECT
                n.id,
                n.libelle,
                n.prix_formation,
                n.filiere_id,
                n.site_id,
                n.anneeacademique_id,
                f.nom AS filiere_nom,
                f.sigle AS filiere_sigle,
                tf.description AS typefiliere_description,
                tf.libelle AS typefiliere_libelle
            FROM niveau n
            LEFT JOIN typefiliere tf ON n.type_filiere IS NOT NULL AND n.type_filiere ~ '^[0-9]+$' AND CAST(n.type_filiere AS INT) = tf.id
            LEFT JOIN filiere f ON f.id = n.filiere_id
            ${whereClause}
            ORDER BY f.nom, n.libelle;
        `, params);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des niveaux :', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
}

// ─── POST créer un niveau isolé sur une filière existante ─────────────────────
// Contrairement à createFiliere (qui crée filière + niveaux d'un coup, pour la saisie initiale),
// cette route permet d'ajouter un niveau à une filière déjà existante sans recréer les autres —
// utilisée par la nouvelle vue "parcours" de l'administration.
exports.createNiveau = async (req, res) => {
    const { filiere_id, libelle, prix_formation, ordre, niveau_suivant_id, parcour } = req.body;

    if (!filiere_id || !libelle) {
        return res.status(400).json({ message: 'filiere_id et libelle sont requis.' });
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const siteId = getSiteFromUser(req);
        const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId, client);

        const filiereCheck = await client.query('SELECT id, type_filiere_id FROM filiere WHERE id = $1', [filiere_id]);
        if (filiereCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Filière introuvable.' });
        }

        const niveauResult = await client.query(`
            INSERT INTO niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere, ordre, niveau_suivant_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, libelle, prix_formation, filiere_id, site_id, anneeacademique_id, ordre, niveau_suivant_id
        `, [
            libelle, prix_formation || 0, filiere_id, siteId, anneeAcademiqueId,
            String(filiereCheck.rows[0].type_filiere_id), ordre || null, niveau_suivant_id || null
        ]);
        const niveau = niveauResult.rows[0];

        await ensureTarifForNiveau(niveau.id, niveau.libelle, niveau.prix_formation, client);

        // Maquette créée en best-effort si un parcours est fourni (même vérification de doublon
        // que POST /api/maquettes/create-maquettes) — ne bloque jamais la création du niveau.
        if (parcour) {
            const existingMaquette = await client.query(
                'SELECT id FROM maquette WHERE filiere_id = $1 AND niveau_id = $2 AND anneeacademique_id = $3 AND parcour = $4',
                [filiere_id, niveau.id, anneeAcademiqueId, parcour]
            );
            if (existingMaquette.rows.length === 0) {
                await client.query(
                    'INSERT INTO maquette (filiere_id, niveau_id, anneeacademique_id, parcour, date_creation) VALUES ($1, $2, $3, $4, NOW())',
                    [filiere_id, niveau.id, anneeAcademiqueId, parcour]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Niveau créé avec succès.', niveau });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erreur createNiveau:', error);
        res.status(500).json({ message: error.message || 'Erreur serveur.' });
    } finally {
        client.release();
    }
};

// ─── PUT modifier un niveau EN PLACE (jamais de DELETE+recréation) ────────────
// L'id du niveau ne change jamais : contrairement à l'ancien comportement de updateFiliere,
// aucune référence existante (etudiant.niveau_id, classe.niveau_id, inscription_annuelle.niveau_id,
// maquette.niveau_id...) n'est cassée par une modification de libellé/prix/ordre/succession.
// niveau_suivant_id est remplacé tel quel (pas de COALESCE) : envoyer explicitement la valeur
// actuelle si elle ne doit pas changer, null pour la retirer.
exports.updateNiveau = async (req, res) => {
    const { id } = req.params;
    const { libelle, prix_formation, ordre, niveau_suivant_id } = req.body;

    if (niveau_suivant_id && parseInt(niveau_suivant_id, 10) === parseInt(id, 10)) {
        return res.status(400).json({ message: 'Un niveau ne peut pas être son propre niveau suivant.' });
    }

    try {
        const result = await db.query(`
            UPDATE niveau
            SET libelle = COALESCE($1, libelle),
                prix_formation = COALESCE($2, prix_formation),
                ordre = COALESCE($3, ordre),
                niveau_suivant_id = $4
            WHERE id = $5
            RETURNING id, libelle, prix_formation, filiere_id, site_id, anneeacademique_id, ordre, niveau_suivant_id
        `, [libelle || null, prix_formation ?? null, ordre ?? null, niveau_suivant_id || null, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Niveau introuvable.' });
        }
        res.status(200).json({ message: 'Niveau mis à jour avec succès.', niveau: result.rows[0] });
    } catch (error) {
        console.error('Erreur updateNiveau:', error);
        res.status(500).json({ message: error.message || 'Erreur serveur.' });
    }
};

// ─── DELETE supprimer un niveau (garde-fou : bloque si des données y sont rattachées) ──
// Même pattern que site.controller.js::deleteSite — vérifie l'absence de toute référence vivante
// avant de supprimer, plutôt que de laisser une contrainte FK échouer en pleine transaction ou,
// pire, de supprimer silencieusement un niveau encore utilisé.
exports.deleteNiveau = async (req, res) => {
    const { id } = req.params;
    try {
        const enUsage = await db.query(
            `SELECT 1 FROM etudiant WHERE niveau_id = $1
             UNION ALL SELECT 1 FROM classe WHERE niveau_id = $1
             UNION ALL SELECT 1 FROM inscription_annuelle WHERE niveau_id = $1
             UNION ALL SELECT 1 FROM historique_inscription WHERE niveau_id = $1
             UNION ALL SELECT 1 FROM reinscription WHERE niveau_retenu_id = $1 OR niveau_propose_id = $1
             UNION ALL SELECT 1 FROM niveau WHERE niveau_suivant_id = $1
             UNION ALL SELECT 1 FROM maquette WHERE niveau_id = $1
             LIMIT 1`,
            [id]
        );
        if (enUsage.rows.length > 0) {
            return res.status(409).json({
                message: 'Impossible de supprimer ce niveau : des étudiants, classes, maquettes ou d\'autres données y sont rattachés.'
            });
        }

        await db.query('DELETE FROM tarif WHERE niveau_id = $1', [id]);
        const result = await db.query('DELETE FROM niveau WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Niveau introuvable.' });
        }
        res.status(200).json({ message: 'Niveau supprimé avec succès.' });
    } catch (error) {
        console.error('Erreur deleteNiveau:', error);
        res.status(500).json({ message: error.message || 'Erreur serveur.' });
    }
};
