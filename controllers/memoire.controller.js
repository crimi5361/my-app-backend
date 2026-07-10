// controllers/memoire.controller.js
const db = require('../config/db.config');
const path = require('path');
const fs = require('fs');

const UPLOAD_BASE_DIR = path.join(__dirname, '../uploads/memoires');
const RAPPORT_BASE_DIR = path.join(__dirname, '../uploads/rapports'); // ✅ Nouveau répertoire

// ✅ Créer les répertoires s'ils n'existent pas
if (!fs.existsSync(UPLOAD_BASE_DIR)) {
    fs.mkdirSync(UPLOAD_BASE_DIR, { recursive: true });
}
if (!fs.existsSync(RAPPORT_BASE_DIR)) {
    fs.mkdirSync(RAPPORT_BASE_DIR, { recursive: true });
}

const getFiliereClasseFolder = (filiere, classe) => {
    const cleanFiliere = filiere?.toUpperCase().trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanClasse = classe?.toUpperCase().trim().replace(/\s+/g, '_') || 'INCONNU';
    const finalFiliere = cleanFiliere.replace(/[^A-Z0-9_]/g, '');
    const finalClasse = cleanClasse.replace(/[^A-Z0-9_]/g, '');
    return `${finalFiliere}_${finalClasse}`;
};

// ✅ Nouvelle fonction pour créer le chemin du rapport
const getRapportFolder = (filiere, niveau, matricule, etudiantNom, etudiantPrenom) => {
    const cleanFiliere = filiere?.toUpperCase().trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanNiveau = niveau?.toUpperCase().trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanMatricule = matricule?.trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanNom = etudiantNom?.trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanPrenom = etudiantPrenom?.trim().replace(/\s+/g, '_') || 'INCONNU';
    
    const finalFiliere = cleanFiliere.replace(/[^A-Z0-9_]/g, '');
    const finalNiveau = cleanNiveau.replace(/[^A-Z0-9_]/g, '');
    const finalMatricule = cleanMatricule.replace(/[^A-Z0-9_]/g, '');
    const finalNom = cleanNom.replace(/[^A-Z0-9_]/g, '');
    const finalPrenom = cleanPrenom.replace(/[^A-Z0-9_]/g, '');
    
    // Structure: RAPPORTS/FILIERE_NIVEAU/MATRICULE_NOM_PRENOM/
    return `${finalFiliere}_${finalNiveau}/${finalMatricule}_${finalNom}_${finalPrenom}`;
};

const getEtudiantFiliereEtClasse = async (etudiantId) => {
    const query = `
        SELECT 
            e.id,
            e.matricule,
            e.nom,
            e.prenoms,
            f.nom as filiere,
            n.libelle as niveau,
            ac.annee as annee_academique
        FROM public.etudiant e
        LEFT JOIN public.filiere f ON e.id_filiere = f.id
        LEFT JOIN public.niveau n ON e.niveau_id = n.id
        LEFT JOIN public.anneeacademique ac ON e.annee_academique_id = ac.id
        WHERE e.id = $1
    `;
    const result = await db.query(query, [etudiantId]);
    if (result.rows.length === 0) throw new Error('Étudiant non trouvé');
    return result.rows[0];
};

const getUtilisateurById = async (utilisateurId) => {
    if (!utilisateurId) return null;
    const result = await db.query(
        `SELECT id, nom, email, role_id, statut FROM public.utilisateur WHERE id = $1`,
        [utilisateurId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
};

// ✅ Helper : comparaison robuste number/string
const isSameUser = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a).trim() === String(b).trim();
};

// ✅ Helper pour générer le nom du fichier rapport
const generateRapportFileName = (matricule, nom, prenom, suffix = '') => {
    const cleanMatricule = matricule?.trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanNom = nom?.trim().replace(/\s+/g, '_') || 'INCONNU';
    const cleanPrenom = prenom?.trim().replace(/\s+/g, '_') || 'INCONNU';
    const dateStr = new Date().toISOString().split('T')[0];
    const timestamp = Date.now();
    const suffixPart = suffix ? `_${suffix}` : '';
    return `RAPPORT_${cleanMatricule}_${cleanNom}_${cleanPrenom}${suffixPart}_${dateStr}_${timestamp}.pdf`;
};

/**
 * POST /api/memoire/deposer
 */
exports.postChargerPdf = async (req, res) => {
    try {
        const { etudiant_id, theme } = req.body;
        const fichier = req.file;

        if (!etudiant_id) return res.status(400).json({ success: false, message: "L'ID de l'étudiant est requis" });
        if (!theme || theme.trim() === '') return res.status(400).json({ success: false, message: "Le thème du mémoire est requis" });
        if (!fichier) return res.status(400).json({ success: false, message: "Aucun fichier PDF n'a été téléchargé" });

        if (fichier.mimetype !== 'application/pdf') {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: "Le fichier doit être au format PDF" });
        }

        if (fichier.size > 10 * 1024 * 1024) {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: "Le fichier ne doit pas dépasser 10 Mo" });
        }

        let etudiantInfo;
        try {
            etudiantInfo = await getEtudiantFiliereEtClasse(etudiant_id);
        } catch (error) {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(404).json({ success: false, message: error.message || "Étudiant non trouvé" });
        }

        const folderName = getFiliereClasseFolder(etudiantInfo.filiere || 'INCONNU', etudiantInfo.niveau || 'INCONNU');
        const targetDir = path.join(UPLOAD_BASE_DIR, folderName);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const existingMemoire = await db.query(
            `SELECT id, statut FROM public.memoire WHERE etudiant_id = $1 AND statut IN ('en_attente', 'encours', 'valide') LIMIT 1`,
            [etudiant_id]
        );
        if (existingMemoire.rows.length > 0) {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({
                success: false,
                message: `Vous avez déjà un mémoire en cours de traitement (statut: ${existingMemoire.rows[0].statut})`,
                memoire_existant: existingMemoire.rows[0]
            });
        }

        const fileExtension = path.extname(fichier.originalname);
        const fileName = `${etudiantInfo.matricule || etudiant_id}_${Date.now()}${fileExtension}`;
        const relativePath = `/uploads/memoires/${folderName}/${fileName}`;
        fs.renameSync(fichier.path, path.join(targetDir, fileName));

        let anneeAcademiqueId = null;
        try {
            const anneeAcademique = await db.query(`SELECT id FROM public.anneeacademique WHERE etat = 'en cour' ORDER BY id DESC LIMIT 1`);
            if (anneeAcademique.rows.length > 0) anneeAcademiqueId = anneeAcademique.rows[0].id;
        } catch (err) {
            console.warn("Table anneeacademique non trouvée ou erreur:", err.message);
        }

        const result = await db.query(
            `INSERT INTO public.memoire (etudiant_id, annee_academique_id, theme, fichier_pdf, statut, date_depot)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, etudiant_id, theme, fichier_pdf, statut, date_depot`,
            [etudiant_id, anneeAcademiqueId, theme.trim(), relativePath, 'en_attente']
        );

        return res.status(201).json({
            success: true,
            message: "Mémoire déposé avec succès. Un retour vous sera donné sous 72h.",
            memoire: result.rows[0],
            etudiant: {
                id: etudiant_id,
                nom: etudiantInfo.nom,
                prenoms: etudiantInfo.prenoms,
                matricule: etudiantInfo.matricule,
                filiere: etudiantInfo.filiere,
                niveau: etudiantInfo.niveau,
                dossier_stockage: folderName
            }
        });
    } catch (error) {
        console.error("Erreur dans postChargerPdf:", error);
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) { console.error(e); }
        }
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * GET /api/memoire/etudiant/:etudiant_id
 */
exports.getMemoiresByEtudiant = async (req, res) => {
    try {
        const { etudiant_id } = req.params;
        if (!etudiant_id) return res.status(400).json({ success: false, message: "L'ID de l'étudiant est requis" });

        const result = await db.query(
            `SELECT id, theme, fichier_pdf, statut, motif_refus, rapport_analyse, date_depot, date_traitement
             FROM public.memoire WHERE etudiant_id = $1 ORDER BY date_depot DESC`,
            [etudiant_id]
        );
        return res.status(200).json({ success: true, memoires: result.rows, total: result.rows.length });
    } catch (error) {
        console.error("Erreur dans getMemoiresByEtudiant:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * GET /api/memoire/:id
 */
exports.getMemoireById = async (req, res) => {
    try {
        const result = await db.query(
            `SELECT m.*, e.nom, e.prenoms, e.matricule_iipea, f.nom as filiere, n.libelle as niveau
             FROM public.memoire m
             LEFT JOIN public.etudiant e ON m.etudiant_id = e.id
             LEFT JOIN public.filiere f ON e.id_filiere = f.id
             LEFT JOIN public.niveau n ON e.niveau_id = n.id
             WHERE m.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "Mémoire non trouvé" });
        return res.status(200).json({ success: true, memoire: result.rows[0] });
    } catch (error) {
        console.error("Erreur dans getMemoireById:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * GET /api/memoire
 */
exports.getAllMemoires = async (req, res) => {
    try {
        const result = await db.query(
            `SELECT m.id, m.etudiant_id, m.theme, m.fichier_pdf, m.statut, m.motif_refus, m.rapport_analyse,
                    m.date_depot, m.date_traitement, m.traite_par,
                    e.nom, e.prenoms, e.matricule_iipea, e.email,
                    f.nom as nom_filiere, n.libelle as nom_niveau
             FROM public.memoire m
             LEFT JOIN public.etudiant e ON m.etudiant_id = e.id
             LEFT JOIN public.filiere f ON e.id_filiere = f.id
             LEFT JOIN public.niveau n ON e.niveau_id = n.id
             ORDER BY m.date_depot DESC`
        );

        const memoiresAvecAgent = await Promise.all(
            result.rows.map(async (memoire) => {
                let agentInfo = null;
                if (memoire.traite_par) agentInfo = await getUtilisateurById(memoire.traite_par);
                return {
                    ...memoire,
                    traite_par: memoire.traite_par !== null ? String(memoire.traite_par) : null,
                    agent_nom: agentInfo?.nom || null,
                    agent_email: agentInfo?.email || null
                };
            })
        );

        return res.status(200).json({ success: true, memoires: memoiresAvecAgent, total: memoiresAvecAgent.length });
    } catch (error) {
        console.error("Erreur dans getAllMemoires:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * GET /api/memoire/filiere/:filiere/:classe
 */
exports.getMemoiresByFiliereEtClasse = async (req, res) => {
    try {
        const { filiere, classe } = req.params;
        if (!filiere || !classe) return res.status(400).json({ success: false, message: "La filière et la classe sont requises" });

        const result = await db.query(
            `SELECT m.*, e.nom, e.prenoms, e.matricule_iipea, f.nom as filiere, n.libelle as niveau
             FROM public.memoire m
             LEFT JOIN public.etudiant e ON m.etudiant_id = e.id
             LEFT JOIN public.filiere f ON e.id_filiere = f.id
             LEFT JOIN public.niveau n ON e.niveau_id = n.id
             WHERE f.nom ILIKE $1 AND n.libelle ILIKE $2
             ORDER BY m.date_depot DESC`,
            [`%${filiere}%`, `%${classe}%`]
        );

        const memoiresAvecAgent = await Promise.all(
            result.rows.map(async (memoire) => {
                let agentInfo = null;
                if (memoire.traite_par) agentInfo = await getUtilisateurById(memoire.traite_par);
                return {
                    ...memoire,
                    traite_par: memoire.traite_par !== null ? String(memoire.traite_par) : null,
                    agent_nom: agentInfo?.nom || null,
                    agent_email: agentInfo?.email || null
                };
            })
        );

        return res.status(200).json({ success: true, memoires: memoiresAvecAgent, total: memoiresAvecAgent.length, filiere, classe });
    } catch (error) {
        console.error("Erreur dans getMemoiresByFiliereEtClasse:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * PUT /api/memoire/:id/valider
 */
exports.validerMemoire = async (req, res) => {
    try {
        const { id } = req.params;
        const { traite_par } = req.body;

        console.log(`[valider] id=${id} | traite_par reçu=${traite_par} (type: ${typeof traite_par})`);

        const memoireCheck = await db.query(
            `SELECT id, statut, traite_par FROM public.memoire WHERE id = $1`,
            [id]
        );
        if (memoireCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Mémoire non trouvé" });

        const memoire = memoireCheck.rows[0];
        console.log(`[valider] traite_par en DB=${memoire.traite_par} (type: ${typeof memoire.traite_par})`);

        if (memoire.statut !== 'encours') {
            return res.status(400).json({
                success: false,
                message: `Seul un mémoire en cours de traitement peut être validé (statut actuel: ${memoire.statut})`
            });
        }

        if (!isSameUser(memoire.traite_par, traite_par)) {
            console.log(`[valider] REFUS : DB="${memoire.traite_par}" vs reçu="${traite_par}"`);
            return res.status(403).json({
                success: false,
                message: "Vous n'êtes pas autorisé à valider ce mémoire. Seul l'agent qui l'a pris en charge peut le faire."
            });
        }

        const result = await db.query(
            `UPDATE public.memoire SET statut = 'valide', date_traitement = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return res.status(200).json({ success: true, message: "Mémoire validé avec succès", memoire: result.rows[0] });
    } catch (error) {
        console.error("Erreur dans validerMemoire:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * PUT /api/memoire/:id/encourtraitement
 */
exports.TraitementMemoire = async (req, res) => {
    try {
        const { id } = req.params;
        const { traite_par } = req.body;

        const memoireCheck = await db.query(`SELECT id, statut FROM public.memoire WHERE id = $1`, [id]);
        if (memoireCheck.rows.length === 0) return res.status(404).json({ success: false, message: "Mémoire non trouvé" });

        if (memoireCheck.rows[0].statut !== 'en_attente') {
            return res.status(400).json({
                success: false,
                message: `Ce mémoire est déjà "${memoireCheck.rows[0].statut}" et ne peut pas être pris en charge`
            });
        }

        const result = await db.query(
            `UPDATE public.memoire SET statut = 'encours', traite_par = $1 WHERE id = $2 RETURNING *`,
            [traite_par, id]
        );
        return res.status(200).json({ success: true, message: "Mémoire pris en charge avec succès", memoire: result.rows[0] });
    } catch (error) {
        console.error("Erreur dans TraitementMemoire:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * PUT /api/memoire/:id/rejeter
 * ✅ MODIFIÉ : Ajout du support pour l'upload du rapport d'analyse
 */
exports.rejeterMemoire = async (req, res) => {
    try {
        const { id } = req.params;
        const { motif_refus, traite_par } = req.body;
        const fichierRapport = req.file; // ✅ Fichier uploadé via multer

        if (!motif_refus || motif_refus.trim() === '') {
            return res.status(400).json({ success: false, message: "Le motif de refus est requis" });
        }

        console.log(`[rejeter] id=${id} | traite_par reçu=${traite_par} (type: ${typeof traite_par})`);
        if (fichierRapport) {
            console.log(`[rejeter] Rapport reçu: ${fichierRapport.originalname}`);
        }

        const memoireCheck = await db.query(
            `SELECT id, statut, traite_par, etudiant_id FROM public.memoire WHERE id = $1`,
            [id]
        );
        if (memoireCheck.rows.length === 0) {
            if (fichierRapport && fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
            return res.status(404).json({ success: false, message: "Mémoire non trouvé" });
        }

        const memoire = memoireCheck.rows[0];
        console.log(`[rejeter] traite_par en DB=${memoire.traite_par} (type: ${typeof memoire.traite_par})`);

        if (memoire.statut !== 'encours') {
            if (fichierRapport && fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
            return res.status(400).json({
                success: false,
                message: `Seul un mémoire en cours de traitement peut être rejeté (statut actuel: ${memoire.statut})`
            });
        }

        if (!isSameUser(memoire.traite_par, traite_par)) {
            if (fichierRapport && fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
            console.log(`[rejeter] REFUS : DB="${memoire.traite_par}" vs reçu="${traite_par}"`);
            return res.status(403).json({
                success: false,
                message: "Vous n'êtes pas autorisé à rejeter ce mémoire. Seul l'agent qui l'a pris en charge peut le faire."
            });
        }

        let rapportPath = null;

        // ✅ Traitement du fichier rapport d'analyse
        if (fichierRapport) {
            try {
                // Vérification du fichier
                if (fichierRapport.mimetype !== 'application/pdf') {
                    if (fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
                    return res.status(400).json({ success: false, message: "Le rapport doit être au format PDF" });
                }

                if (fichierRapport.size > 5 * 1024 * 1024) {
                    if (fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
                    return res.status(400).json({ success: false, message: "Le rapport ne doit pas dépasser 5 Mo" });
                }

                // ✅ Récupérer les infos de l'étudiant
                const etudiantInfo = await getEtudiantFiliereEtClasse(memoire.etudiant_id);
                
                // ✅ Créer le dossier pour le rapport
                const rapportFolder = getRapportFolder(
                    etudiantInfo.filiere,
                    etudiantInfo.niveau,
                    etudiantInfo.matricule,
                    etudiantInfo.nom,
                    etudiantInfo.prenoms
                );
                
                const targetDir = path.join(RAPPORT_BASE_DIR, rapportFolder);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                // ✅ Générer le nom du fichier avec le nom de l'étudiant
                const fileName = generateRapportFileName(
                    etudiantInfo.matricule,
                    etudiantInfo.nom,
                    etudiantInfo.prenoms,
                    `memoire_${id}`
                );
                
                // ✅ Déplacer le fichier vers le dossier des rapports
                const finalPath = path.join(targetDir, fileName);
                fs.renameSync(fichierRapport.path, finalPath);
                
                // ✅ Chemin relatif pour la base de données
                rapportPath = `/uploads/rapports/${rapportFolder}/${fileName}`;
                
                console.log(`[rejeter] Rapport sauvegardé: ${rapportPath}`);

            } catch (error) {
                console.error("Erreur lors du traitement du rapport:", error);
                if (fichierRapport && fs.existsSync(fichierRapport.path)) fs.unlinkSync(fichierRapport.path);
                return res.status(500).json({ 
                    success: false, 
                    message: "Erreur lors du traitement du rapport d'analyse", 
                    error: error.message 
                });
            }
        }

        // ✅ Mise à jour de la base de données
        let query = `UPDATE public.memoire SET statut = 'rejete', motif_refus = $1, date_traitement = NOW()`;
        let params = [motif_refus];
        let paramIndex = 2;

        if (rapportPath) {
            query += `, rapport_analyse = $${paramIndex}`;
            params.push(rapportPath);
            paramIndex++;
        }

        query += ` WHERE id = $${paramIndex} RETURNING *`;
        params.push(id);

        const result = await db.query(query, params);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Mémoire non trouvé" });
        }

        return res.status(200).json({ 
            success: true, 
            message: rapportPath ? "Mémoire rejeté avec rapport d'analyse" : "Mémoire rejeté avec succès",
            memoire: result.rows[0],
            rapport: rapportPath ? { path: rapportPath } : null
        });

    } catch (error) {
        console.error("Erreur dans rejeterMemoire:", error);
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) { console.error(e); }
        }
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * PUT /api/memoire/:id/update
 */
exports.updateMemoire = async (req, res) => {
    try {
        const { id } = req.params;
        const { theme, etudiant_id } = req.body;
        const fichier = req.file;

        if (!etudiant_id) {
            if (fichier && fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: "L'ID de l'étudiant est requis" });
        }

        const memoireResult = await db.query(
            `SELECT id, etudiant_id, theme, fichier_pdf, statut, date_depot,
                    EXTRACT(EPOCH FROM (NOW() - date_depot)) / 3600 AS heures_ecoulees
             FROM public.memoire WHERE id = $1 AND etudiant_id = $2`,
            [id, etudiant_id]
        );

        if (memoireResult.rows.length === 0) {
            if (fichier && fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(404).json({ success: false, message: "Mémoire non trouvé ou vous n'êtes pas autorisé" });
        }

        const memoire = memoireResult.rows[0];
        const heuresEcoulees = parseFloat(memoire.heures_ecoulees);

        if (memoire.statut !== 'en_attente') {
            if (fichier && fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: `Vous ne pouvez pas modifier un mémoire dont le statut est "${memoire.statut}"` });
        }

        if (heuresEcoulees > 2) {
            if (fichier && fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(403).json({ success: false, message: `Le délai de modification de 2 heures est dépassé.`, heures_ecoulees: Math.floor(heuresEcoulees) });
        }

        if (!fichier) return res.status(400).json({ success: false, message: "Veuillez sélectionner un fichier PDF pour la mise à jour" });
        if (fichier.mimetype !== 'application/pdf') {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: "Le fichier doit être au format PDF" });
        }
        if (fichier.size > 10 * 1024 * 1024) {
            if (fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(400).json({ success: false, message: "Le fichier ne doit pas dépasser 10 Mo" });
        }

        let etudiantInfo;
        try {
            etudiantInfo = await getEtudiantFiliereEtClasse(etudiant_id);
        } catch (error) {
            if (fichier && fs.existsSync(fichier.path)) fs.unlinkSync(fichier.path);
            return res.status(404).json({ success: false, message: error.message || "Étudiant non trouvé" });
        }

        const folderName = getFiliereClasseFolder(etudiantInfo.filiere || 'INCONNU', etudiantInfo.niveau || 'INCONNU');
        const targetDir = path.join(UPLOAD_BASE_DIR, folderName);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        if (memoire.fichier_pdf) {
            const oldFilePath = path.join(UPLOAD_BASE_DIR, memoire.fichier_pdf.replace(/^\/uploads\/memoires\//, ''));
            if (fs.existsSync(oldFilePath)) fs.unlinkSync(oldFilePath);
        }

        const fileName = `${etudiantInfo.matricule || etudiant_id}_${Date.now()}${path.extname(fichier.originalname)}`;
        const relativePath = `/uploads/memoires/${folderName}/${fileName}`;
        fs.renameSync(fichier.path, path.join(targetDir, fileName));

        const result = await db.query(
            `UPDATE public.memoire SET theme = $1, fichier_pdf = $2, date_depot = NOW() WHERE id = $3 RETURNING id, theme, fichier_pdf, statut, date_depot`,
            [theme?.trim() || memoire.theme, relativePath, id]
        );

        return res.status(200).json({ success: true, message: "Mémoire mis à jour avec succès.", memoire: result.rows[0], delai_restant_heures: 2 });
    } catch (error) {
        console.error("Erreur dans updateMemoire:", error);
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) { console.error(e); }
        }
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};

/**
 * GET /api/memoire/etudiant/:etudiant_id/dernier
 */
exports.getDernierMemoireAvecDelai = async (req, res) => {
    try {
        const { etudiant_id } = req.params;
        if (!etudiant_id) return res.status(400).json({ success: false, message: "L'ID de l'étudiant est requis" });

        const result = await db.query(
            `SELECT id, theme, fichier_pdf, statut, motif_refus, rapport_analyse, date_depot, date_traitement, traite_par,
                    EXTRACT(EPOCH FROM (NOW() - date_depot)) / 60 AS minutes_ecoulees,
                    GREATEST(0, 120 - EXTRACT(EPOCH FROM (NOW() - date_depot)) / 60) AS minutes_restantes
             FROM public.memoire WHERE etudiant_id = $1 ORDER BY date_depot DESC LIMIT 1`,
            [etudiant_id]
        );

        if (result.rows.length === 0) return res.status(200).json({ success: true, a_un_memoire: false, message: "Aucun mémoire trouvé" });

        const memoire = result.rows[0];
        const minutesEcoulees = parseFloat(memoire.minutes_ecoulees);
        const minutesRestantes = parseFloat(memoire.minutes_restantes);

        let agentInfo = null;
        if (memoire.statut === 'encours' && memoire.traite_par) agentInfo = await getUtilisateurById(memoire.traite_par);

        const peutModifier = memoire.statut === 'en_attente' && minutesEcoulees < 120;

        return res.status(200).json({
            success: true,
            a_un_memoire: true,
            memoire: {
                id: memoire.id,
                theme: memoire.theme,
                fichier_pdf: memoire.fichier_pdf,
                statut: memoire.statut,
                motif_refus: memoire.motif_refus,
                rapport_analyse: memoire.rapport_analyse,
                date_depot: memoire.date_depot,
                traite_par: memoire.traite_par
            },
            agent_nom: agentInfo?.nom || null,
            peut_modifier: peutModifier,
            delai: {
                depose_il_y_a_minutes: Math.floor(Math.max(0, minutesEcoulees)),
                reste_minutes: peutModifier ? Math.floor(Math.max(0, minutesRestantes)) : 0,
                reste_secondes: peutModifier ? Math.floor((Math.max(0, minutesRestantes) % 1) * 60) : 0,
                limite_minutes: 120
            }
        });
    } catch (error) {
        console.error("Erreur dans getDernierMemoireAvecDelai:", error);
        return res.status(500).json({ success: false, message: "Erreur interne du serveur", error: error.message });
    }
};