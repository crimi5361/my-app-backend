const db = require('../config/db.config');

// ============ FONCTION UTILITAIRE POUR DÉTECTER LE TYPE DE TRAITEMENT ============

/**
 * Détermine si un groupe doit être traité comme universitaire ou professionnel.
 * Cas spécial : groupe professionnel dont le nom contient "Licence" → traitement universitaire.
 */
const determinerTypeTraitement = (typeFiliere, groupeNom) => {
    if (typeFiliere === 'Universitaire' || typeFiliere === 'universitaire') {
        return 'universitaire';
    }
    if (typeFiliere === 'Professionnelles' || typeFiliere === 'professionnelles') {
        if (groupeNom && groupeNom.toUpperCase().includes('LICENCE')) {
            console.log(`🎓 Cas spécial: groupe professionnel "${groupeNom}" contient "Licence" → traitement universitaire`);
            return 'universitaire';
        }
        return 'professionnel';
    }
    return 'universitaire'; // par défaut
};

// ============ FONCTIONS PRINCIPALES PV ============

/**
 * Génère le PV complet d'un groupe (tous semestres)
 */
exports.genererPVByGroupe = async (req, res) => {
    try {
        const { groupeId } = req.params;
        console.log(`🎓 Génération PV pour groupe: ${groupeId}`);

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).json({ success: false, error: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        const etudiants = await _getEtudiantsGroupe(groupeId);
        console.log(`👨‍🎓 ${etudiants.length} étudiants trouvés`);

        const structureAcademique = await getStructureAcademiqueFonction(groupeId, null);
        console.log(`📚 ${structureAcademique.ues.length} UE trouvées`);

        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);
        console.log(`📊 Total crédits maquette: ${totalCreditsMaquette}`);

        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, structureAcademique, typeTraitement, totalCreditsMaquette
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS').length;

        res.json({
            success: true,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques: _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureAcademique.ues.length, totalCreditsMaquette)
        });

    } catch (error) {
        console.error('❌ Erreur génération PV:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV', details: error.message });
    }
};

/**
 * Génère le PV d'un groupe pour un semestre spécifique
 */
exports.genererPVBySemestre = async (req, res) => {
    try {
        const { groupeId, semestreId } = req.params;
        console.log(`🎓 Génération PV pour groupe: ${groupeId}, semestre: ${semestreId}`);

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).json({ success: false, error: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        const etudiants = await _getEtudiantsGroupe(groupeId);
        console.log(`👨‍🎓 ${etudiants.length} étudiants trouvés`);

        const structureAcademique = await getStructureAcademiqueFonction(groupeId, semestreId);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, structureAcademique, typeTraitement, totalCreditsMaquette
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS').length;

        console.log('✅ PV semestre généré avec succès');
        res.json({
            success: true,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre: { id: semestreId },
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques: _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureAcademique.ues.length, totalCreditsMaquette)
        });

    } catch (error) {
        console.error('❌ Erreur génération PV semestre:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV semestre', details: error.message });
    }
};

/**
 * Génère le PV d'un étudiant individuel
 */
exports.genererPVByEtudiant = async (req, res) => {
    try {
        const { etudiantId } = req.params;
        console.log(`🎓 Génération PV pour étudiant: ${etudiantId}`);

        const etudiantQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
                   e.niveau_id, e.annee_academique_id, e.id_filiere,
                   s.statut_etudiant
            FROM etudiant e
            LEFT JOIN scolarite s ON s.id = e.scolarite_id
            WHERE e.id = $1
        `;
        const etudiantResult = await db.query(etudiantQuery, [etudiantId]);
        if (etudiantResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: `Étudiant ${etudiantId} non trouvé` });
        }
        const etudiant = etudiantResult.rows[0];

        const groupeQuery = `
            SELECT g.id, g.nom, f.nom as filiere, f.sigle, tf.libelle as type_filiere
            FROM groupe g
            LEFT JOIN etudiant et ON et.groupe_id = g.id AND et.id = $1
            LEFT JOIN filiere f ON f.id = et.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            WHERE g.id = $2
            LIMIT 1
        `;
        const groupeResult = await db.query(groupeQuery, [etudiantId, etudiant.groupe_id]);
        const groupeInfo = groupeResult.rows[0];

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        const structureAcademique = await getStructureAcademiqueFonction(etudiant.groupe_id, null);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const notes = await getNotesEtudiantAvecDetailsFonction(etudiantId, structureAcademique.maquette_id);

        const uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        const totaux = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
        const decision = determinerDecisionFonction(totaux.creditsValides, totaux.creditsTotal, typeTraitement);
        const aSoldeScolarite = (etudiant.statut_etudiant || '').toUpperCase() === 'SOLDE';
        const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

        console.log('✅ PV étudiant généré avec succès');
        res.json({
            success: true,
            etudiant: { id: etudiant.id, matricule_iipea: etudiant.matricule_iipea, nom: etudiant.nom, prenoms: etudiant.prenoms, niveau_id: etudiant.niveau_id },
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            moyenne_generale: totaux.moyenneGenerale,
            credits_valides: totaux.creditsValides,
            credits_total: totaux.creditsTotal,
            decision,
            ues: uesAvecResultats,
            ecue_a_reprendre: ecueAReprendre,
            scolarite_soldee: aSoldeScolarite,
            statut_etudiant: etudiant.statut_etudiant || 'NON_DEFINI',
            date_generation: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Erreur génération PV étudiant:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV étudiant', details: error.message });
    }
};

// ============ FONCTIONS INTERNES ============

/**
 * Récupère les infos d'un groupe (filière, type, année académique)
 */
const _getGroupeInfo = async (groupeId) => {
    const query = `
        SELECT g.id, g.nom, g.classe_id,
               f.nom as filiere, f.sigle,
               tf.libelle as type_filiere,
               aa.annee as annee_academique
        FROM groupe g
        LEFT JOIN etudiant et ON et.groupe_id = g.id AND et.standing = 'Inscrit'
        LEFT JOIN filiere f ON f.id = et.id_filiere
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        LEFT JOIN anneeacademique aa ON aa.id = et.annee_academique_id
        WHERE g.id = $1
        LIMIT 1
    `;
    const result = await db.query(query, [groupeId]);
    return result.rows[0] || null;
};

/**
 * Récupère les étudiants inscrits d'un groupe
 */
const _getEtudiantsGroupe = async (groupeId) => {
    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
               e.niveau_id, e.annee_academique_id, e.id_filiere,
               s.statut_etudiant
        FROM etudiant e
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        WHERE e.groupe_id = $1
        AND e.standing = 'Inscrit'
        ORDER BY e.nom, e.prenoms
    `;
    const result = await db.query(query, [groupeId]);
    return result.rows;
};

/**
 * Calcule les résultats de tous les étudiants d'un groupe
 */
const _calculerResultatsTousEtudiants = async (etudiants, structureAcademique, typeTraitement, totalCreditsMaquette) => {
    const resultatsEtudiants = [];
    const etudiantsAReprendre = [];

    for (const etudiant of etudiants) {
        console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms}`);

        const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

        const uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        const totaux = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
        const decision = determinerDecisionFonction(totaux.creditsValides, totaux.creditsTotal, typeTraitement);
        const aSoldeScolarite = (etudiant.statut_etudiant || '').toUpperCase() === 'SOLDE';
        const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

        if (ecueAReprendre.length > 0) {
            etudiantsAReprendre.push({
                etudiant_id: etudiant.id,
                matricule_iipea: etudiant.matricule_iipea,
                nom: etudiant.nom,
                prenoms: etudiant.prenoms,
                decision,
                ecue_a_reprendre: ecueAReprendre,
                scolarite_soldee: aSoldeScolarite
            });
        }

        resultatsEtudiants.push({
            etudiant_id: etudiant.id,
            matricule_iipea: etudiant.matricule_iipea,
            nom: etudiant.nom,
            prenoms: etudiant.prenoms,
            moyenne_generale: totaux.moyenneGenerale,
            credits_valides: totaux.creditsValides,
            credits_total: totaux.creditsTotal,
            decision,
            ues: uesAvecResultats,
            scolarite_soldee: aSoldeScolarite,
            statut_etudiant: etudiant.statut_etudiant || 'NON_DEFINI',
            ecue_a_reprendre: ecueAReprendre
        });
    }

    return { resultatsEtudiants, etudiantsAReprendre };
};

/**
 * Collecte les ECUE à reprendre pour un étudiant (UE non validées, notes < 10)
 */
const _collecterEcueAReprendre = (uesAvecResultats) => {
    const ecueAReprendre = [];
    uesAvecResultats.forEach(ue => {
        if (!ue.valide) {
            ue.matieres.forEach(matiere => {
                const moyenneOriginale = matiere.harmonisee ? matiere.moyenne_originale : matiere.moyenne;
                if (matiere.a_note && moyenneOriginale < 10) {
                    ecueAReprendre.push({
                        ue_libelle: ue.libelle,
                        ue_id: ue.ue_id,
                        ue_valide: ue.valide,
                        ue_moyenne: ue.moyenne,
                        matiere_nom: matiere.nom,
                        matiere_id: matiere.matiere_id,
                        moyenne: moyenneOriginale,
                        coefficient: matiere.coefficient,
                        cc_original: matiere.cc_original || matiere.moyenne_cc,
                        examen_original: matiere.examen_original || matiere.partiel,
                        harmonisee: matiere.harmonisee || false
                    });
                }
            });
        }
    });
    return ecueAReprendre;
};

/**
 * Construit l'objet statistiques
 */
const _buildStatistiques = (totalEtudiants, admisCount, resultatsEtudiants, etudiantsAReprendre, totalUE, totalCreditsMaquette) => ({
    total_etudiants: totalEtudiants,
    total_admis: admisCount,
    total_ajournes: totalEtudiants - admisCount,
    total_ue: totalUE,
    total_credits_maquette: totalCreditsMaquette,
    statistiques_scolarite: {
        total_solde: resultatsEtudiants.filter(e => e.scolarite_soldee).length,
        total_non_solde: resultatsEtudiants.filter(e => !e.scolarite_soldee).length
    },
    statistiques_reprise: {
        total_etudiants_a_reprendre: etudiantsAReprendre.length,
        total_ecue_a_reprendre: etudiantsAReprendre.reduce((sum, e) => sum + e.ecue_a_reprendre.length, 0)
    }
});

/**
 * Récupère la structure académique (UE + matières) d'un groupe
 * ✅ code_ue et code_ecue inclus
 */
const getStructureAcademiqueFonction = async (groupeId, semestreId = null) => {
    const query = `
        WITH etudiants_groupe AS (
            SELECT DISTINCT id_filiere, niveau_id
            FROM etudiant
            WHERE groupe_id = $1
            AND standing = 'Inscrit'
            LIMIT 1
        ),
        maquette_groupe AS (
            SELECT mq.*
            FROM maquette mq
            JOIN etudiants_groupe eg ON (
                mq.filiere_id = eg.id_filiere
                AND mq.niveau_id = eg.niveau_id
            )
            LIMIT 1
        )
        SELECT
            mg.id        AS maquette_id,
            mg.parcour,
            ue.id        AS ue_id,
            ue.libelle   AS ue_libelle,
            ue.semestre_id,
            ue.code_ue,
            ue.categorie_id,
            mat.id       AS matiere_id,
            mat.nom      AS matiere_nom,
            mat.coefficient AS matiere_coef,
            mat.volume_horaire_cm,
            mat.volume_horaire_td,
            mat.code_ecue,
            mat.type_evaluation
        FROM maquette_groupe mg
        JOIN ue  ON ue.maquette_id  = mg.id
        JOIN matiere mat ON mat.ue_id = ue.id
        WHERE 1=1
        ${semestreId ? 'AND ue.semestre_id = $2' : ''}
        ORDER BY ue.semestre_id, ue.id, mat.id
    `;

    const params = [groupeId];
    if (semestreId) params.push(semestreId);

    const result = await db.query(query, params);

    const structure = {
        maquette_id: result.rows[0]?.maquette_id || null,
        parcour:     result.rows[0]?.parcour     || null,
        ues: []
    };

    const uesMap = new Map();
    result.rows.forEach(row => {
        if (!uesMap.has(row.ue_id)) {
            uesMap.set(row.ue_id, {
                ue_id:        row.ue_id,
                libelle:      row.ue_libelle,
                code_ue:      row.code_ue,       // ✅
                semestre_id:  parseInt(row.semestre_id, 10), // ✅ normalisé en number
                categorie_id: row.categorie_id,
                matieres: []
            });
        }
        uesMap.get(row.ue_id).matieres.push({
            matiere_id:        row.matiere_id,
            nom:               row.matiere_nom,
            code_ecue:         row.code_ecue,    // ✅
            coefficient:       parseFloat(row.matiere_coef) || 1,
            volume_horaire_cm: row.volume_horaire_cm,
            volume_horaire_td: row.volume_horaire_td,
            type_evaluation:   row.type_evaluation
        });
    });

    structure.ues = Array.from(uesMap.values());
    return structure;
};

/**
 * Calcule le total des crédits de la maquette
 */
const calculerTotalCreditsMaquette = (ues) => {
    let total = 0;
    ues.forEach(ue => {
        ue.matieres.forEach(matiere => { total += matiere.coefficient; });
    });
    return total;
};

/**
 * Récupère les notes d'un étudiant pour une maquette donnée
 */
const getNotesEtudiantAvecDetailsFonction = async (etudiantId, maquetteId) => {
    const query = `
        SELECT
            n.id, n.note1, n.note2, n.partiel, n.moyenne, n.statut, n.coefficient,
            n.enseignement_id,
            e.matiere_id,
            mat.ue_id
        FROM note n
        JOIN enseignement e  ON e.id   = n.enseignement_id
        JOIN matiere mat     ON mat.id = e.matiere_id
        JOIN ue              ON ue.id  = mat.ue_id
        JOIN maquette mq     ON mq.id  = ue.maquette_id
        WHERE n.etudiant_id = $1
        AND mq.id = $2
        ORDER BY mat.ue_id, mat.id
    `;
    const result = await db.query(query, [etudiantId, maquetteId]);
    return result.rows;
};

/**
 * Calcule la moyenne du contrôle continu (note1 + note2)
 */
const calculerMoyenneCC = (note1, note2) => {
    const n1 = (note1 !== null && note1 !== undefined) ? parseFloat(note1) : null;
    const n2 = (note2 !== null && note2 !== undefined) ? parseFloat(note2) : null;
    if (n1 !== null && n2 !== null) return (n1 + n2) / 2;
    if (n1 !== null) return n1;
    if (n2 !== null) return n2;
    return null;
};

/**
 * Calcule la moyenne d'une matière en mode professionnel (moyenne arithmétique des notes présentes)
 */
const calculerMoyenneMatiere = (note1, note2, partiel, typeFiliere) => {
    if (typeFiliere !== 'professionnel') return null;
    const notes = [];
    if (note1 !== null && note1 !== undefined) notes.push(parseFloat(note1));
    if (note2 !== null && note2 !== undefined) notes.push(parseFloat(note2));
    if (partiel !== null && partiel !== undefined) notes.push(parseFloat(partiel));
    if (notes.length === 0) return null;
    return notes.reduce((a, b) => a + b, 0) / notes.length;
};

/**
 * Harmonise les notes d'une UE validée dont la moyenne est entre 8 et 10
 * (relève les notes faibles pour atteindre la cible de 10)
 */
const harmoniserNotesUE = (matieres, moyenneUE) => {
    const SEUIL_VALIDATION = 8;
    const CIBLE = 10;

    // Pas d'harmonisation si UE trop faible ou déjà >= 10
    if (moyenneUE < SEUIL_VALIDATION || moyenneUE >= CIBLE) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale:  m.moyenne,
            moyenne_affichage:  m.moyenne,
            cc_original:        m.moyenne_cc,
            examen_original:    m.partiel,
            cc_affichage:       m.moyenne_cc,
            examen_affichage:   m.partiel,
            harmonisee:         false
        }));
    }

    const notesFortes = matieres.filter(m => m.moyenne >= CIBLE);
    const notesFaibles = matieres.filter(m => m.moyenne < CIBLE);

    const sommeForte     = notesFortes.reduce((sum, m) => sum + (m.moyenne * m.coefficient), 0);
    const totalCoeff     = matieres.reduce((sum, m) => sum + m.coefficient, 0);
    const sommeNecessaire = CIBLE * totalCoeff;
    const sommeRestante  = sommeNecessaire - sommeForte;
    const coeffFaible    = notesFaibles.reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0 || sommeRestante <= 0) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original:       m.moyenne_cc,
            examen_original:   m.partiel,
            cc_affichage:      m.moyenne_cc,
            examen_affichage:  m.partiel,
            harmonisee:        false
        }));
    }

    return matieres.map(m => {
        if (m.moyenne >= CIBLE) {
            return {
                ...m,
                moyenne_originale: m.moyenne,
                moyenne_affichage: m.moyenne,
                cc_original:       m.moyenne_cc,
                examen_original:   m.partiel,
                cc_affichage:      m.moyenne_cc,
                examen_affichage:  m.partiel,
                harmonisee:        false
            };
        }

        const contributionNecessaire = sommeRestante * (m.coefficient / coeffFaible);
        const ccOriginal    = m.moyenne_cc || 0;
        const examenOriginal = m.partiel   || 0;
        const poidsCC       = 0.4;
        const poidsExamen   = 0.6;
        const moyenneCible  = contributionNecessaire / m.coefficient;

        let ccCible, examenCible;

        if (examenOriginal < ccOriginal) {
            examenCible = Math.min(20, Math.max(examenOriginal, (moyenneCible - ccOriginal * poidsCC) / poidsExamen));
            if (examenCible > 20) {
                examenCible = 20;
                ccCible = (moyenneCible - examenCible * poidsExamen) / poidsCC;
            } else {
                ccCible = ccOriginal;
            }
        } else {
            ccCible = Math.min(20, Math.max(ccOriginal, (moyenneCible - examenOriginal * poidsExamen) / poidsCC));
            if (ccCible > 20) {
                ccCible = 20;
                examenCible = (moyenneCible - ccCible * poidsCC) / poidsExamen;
            } else {
                examenCible = examenOriginal;
            }
        }

        ccCible      = parseFloat(ccCible.toFixed(2));
        examenCible  = parseFloat(examenCible.toFixed(2));
        const moyenneResultante = (ccCible * poidsCC + examenCible * poidsExamen) * m.coefficient;

        return {
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: moyenneResultante / m.coefficient,
            cc_original:       m.moyenne_cc,
            examen_original:   m.partiel,
            cc_affichage:      ccCible,
            examen_affichage:  examenCible,
            harmonisee:        true
        };
    });
};

/**
 * Calcule les résultats détaillés d'une UE avec harmonisation éventuelle.
 * ✅ CORRECTION : code_ue et code_ecue propagés dans l'objet retourné.
 */
const calculerResultatsUEAvecDetailsFonction = async (ue, notes, typeTraitement) => {
    const SEUIL_ELIMINATOIRE = 6;
    const SEUIL_VALIDATION   = 8;
    const CIBLE              = 10;

    const notesUE = notes.filter(note => note.ue_id === ue.ue_id);

    const notesParMatiere = new Map();
    notesUE.forEach(note => {
        const moyenneCC = calculerMoyenneCC(note.note1, note.note2);
        notesParMatiere.set(note.matiere_id, {
            moyenne:        parseFloat(note.moyenne) || 0,
            coefficient:    parseFloat(note.coefficient) || 1,
            statut:         note.statut,
            enseignement_id: note.enseignement_id,
            note1:          (note.note1 !== null && note.note1 !== undefined) ? parseFloat(note.note1) : null,
            note2:          (note.note2 !== null && note.note2 !== undefined) ? parseFloat(note.note2) : null,
            moyenne_cc:     moyenneCC,
            partiel:        (note.partiel !== null && note.partiel !== undefined) ? parseFloat(note.partiel) : null
        });
    });

    // Construction des matières avec données enrichies
    const matieresOriginales = ue.matieres.map(matiere => {
        const note           = notesParMatiere.get(matiere.matiere_id);
        const moyenne        = note ? note.moyenne : 0;
        const valide         = moyenne >= CIBLE;
        const estEliminatoire = note && moyenne < SEUIL_ELIMINATOIRE;

        return {
            matiere_id:      matiere.matiere_id,
            nom:             matiere.nom,
            code_ecue:       matiere.code_ecue,  // ✅ FIX : propagation du code ECUE
            moyenne,
            coefficient:     matiere.coefficient,
            valide,
            est_eliminatoire: estEliminatoire,
            a_note:          !!note,
            enseignement_id: note?.enseignement_id || null,
            note1:           note?.note1  ?? null,
            note2:           note?.note2  ?? null,
            moyenne_cc:      note?.moyenne_cc ?? null,
            partiel:         note?.partiel    ?? null,
            moyenne_pro:     typeTraitement === 'professionnel'
                ? calculerMoyenneMatiere(
                    note?.note1  ?? null,
                    note?.note2  ?? null,
                    note?.partiel ?? null,
                    typeTraitement
                  )
                : null
        };
    });

    // Calcul des agrégats de l'UE
    let sommeNotesPonderees     = 0;
    let sommeCoefficients       = 0;
    let auMoinsUneMatiereAvecNote = false;
    let aNoteEliminatoire       = false;
    let creditsValides          = 0;
    let creditsTotal            = 0;

    matieresOriginales.forEach(matiere => {
        creditsTotal += matiere.coefficient;

        if (matiere.a_note) {
            auMoinsUneMatiereAvecNote = true;

            if (typeTraitement === 'professionnel' && matiere.moyenne_pro !== null) {
                sommeNotesPonderees += matiere.moyenne_pro * matiere.coefficient;
            } else {
                sommeNotesPonderees += matiere.moyenne * matiere.coefficient;
            }

            sommeCoefficients += matiere.coefficient;

            if (matiere.est_eliminatoire) aNoteEliminatoire = true;
            if (matiere.valide)           creditsValides    += matiere.coefficient;
        }
    });

    const moyenneUE  = sommeCoefficients > 0 ? sommeNotesPonderees / sommeCoefficients : 0;
    const creditsUE  = ue.matieres.reduce((sum, mat) => sum + mat.coefficient, 0);

    const toutesNotesNonEliminatoires = matieresOriginales.every(m =>
        !m.a_note || m.moyenne >= SEUIL_ELIMINATOIRE
    );

    let ueValide = false;
    if (auMoinsUneMatiereAvecNote && toutesNotesNonEliminatoires && moyenneUE >= SEUIL_VALIDATION) {
        ueValide       = true;
        creditsValides = creditsTotal;
    }

    // Harmonisation (universitaire uniquement, UE validée entre 8 et 10)
    let matieresFinales        = matieresOriginales;
    let harmonisationEffectuee = false;

    if (typeTraitement === 'universitaire' && ueValide && moyenneUE < CIBLE) {
        matieresFinales        = harmoniserNotesUE(matieresOriginales, moyenneUE);
        harmonisationEffectuee = true;
    }

    const ecueARepasser = matieresOriginales
        .filter(m => m.a_note && m.moyenne < CIBLE)
        .map(m => ({ nom: m.nom, moyenne: m.moyenne, coefficient: m.coefficient }));

    // ✅ FIX PRINCIPAL : code_ue propagé dans l'objet retourné
    return {
        ue_id:              ue.ue_id,
        libelle:            ue.libelle,
        code_ue:            ue.code_ue,          // ✅ FIX : propagation du code UE
        semestre_id:        ue.semestre_id,       // déjà normalisé en number dans getStructureAcademiqueFonction
        moyenne:            parseFloat(moyenneUE.toFixed(2)),
        moyenne_affichage:  (typeTraitement === 'universitaire' && ueValide && moyenneUE < CIBLE)
                                ? CIBLE
                                : parseFloat(moyenneUE.toFixed(2)),
        harmonisee:         harmonisationEffectuee,
        credits:            creditsUE,
        credits_valides:    creditsValides,
        valide:             ueValide,
        a_note_eliminatoire: aNoteEliminatoire,
        ecue_a_repasser:    ecueARepasser,
        matieres:           matieresFinales
    };
};

/**
 * Calcule les totaux (moyenne générale, crédits) pour un ensemble d'UE
 */
const calculerTotauxFonction = (ues, typeTraitement, totalCreditsMaquette) => {
    let totalCreditsValides      = 0;
    let sommeMoyennesPonderees   = 0;
    let totalCoefficients        = 0;
    let uesAvecNotes             = 0;

    ues.forEach(ue => {
        const ueAvecNotes = ue.matieres.some(m => m.a_note);
        if (ueAvecNotes) {
            uesAvecNotes++;
            totalCreditsValides    += ue.credits_valides || 0;
            sommeMoyennesPonderees += (ue.moyenne_affichage || ue.moyenne) * ue.credits;
            totalCoefficients      += ue.credits;
        }
    });

    const moyenneGenerale = totalCoefficients > 0 ? sommeMoyennesPonderees / totalCoefficients : 0;

    if (typeTraitement === 'professionnel') {
        return { moyenneGenerale: parseFloat(moyenneGenerale.toFixed(2)), creditsValides: 0, creditsTotal: 0, uesAvecNotes, uesTotal: ues.length };
    }

    return { moyenneGenerale: parseFloat(moyenneGenerale.toFixed(2)), creditsValides: totalCreditsValides, creditsTotal: totalCreditsMaquette, uesAvecNotes, uesTotal: ues.length };
};

/**
 * Détermine la décision finale (ADMIS / AJOURNÉ)
 */
const determinerDecisionFonction = (creditsValides, creditsTotal, typeTraitement) => {
    if (creditsTotal === 0)           return 'Aucune note';
    if (creditsValides === creditsTotal) return 'ADMIS';
    return 'AJOURNÉ';
};

/**
 * Calcule les moyennes et crédits par semestre à partir d'un tableau d'UE.
 * ✅ CORRECTION : utilise parseInt pour comparer semestre_id (évite comparaisons string vs number)
 */
const calculerResultatsParSemestre = (ues) => {
    const s1 = { sommePonderee: 0, sommCoeffs: 0, creditsTotal: 0, creditsValides: 0 };
    const s2 = { sommePonderee: 0, sommCoeffs: 0, creditsTotal: 0, creditsValides: 0 };

    ues.forEach(ue => {
        const sid    = parseInt(ue.semestre_id, 10); // ✅ normalisation
        const moyUE  = ue.moyenne_affichage !== undefined ? ue.moyenne_affichage : (ue.moyenne || 0);
        const cred   = ue.credits || 0;
        const credV  = ue.credits_valides || 0;

        if (sid === 1) {
            s1.sommePonderee  += moyUE * cred;
            s1.sommCoeffs     += cred;
            s1.creditsTotal   += cred;
            s1.creditsValides += credV;
        } else if (sid === 2) {
            s2.sommePonderee  += moyUE * cred;
            s2.sommCoeffs     += cred;
            s2.creditsTotal   += cred;
            s2.creditsValides += credV;
        }
    });

    return {
        semestre1: {
            moyenne:       s1.sommCoeffs > 0 ? s1.sommePonderee / s1.sommCoeffs : 0,
            creditsTotal:  s1.creditsTotal,
            creditsValides: s1.creditsValides
        },
        semestre2: {
            moyenne:       s2.sommCoeffs > 0 ? s2.sommePonderee / s2.sommCoeffs : 0,
            creditsTotal:  s2.creditsTotal,
            creditsValides: s2.creditsValides
        }
    };
};

// ============ FONCTIONS POUR LES BULLETINS ============

/**
 * Récupère les informations complètes d'un étudiant (par ID)
 */
const getEtudiantComplet = async (etudiantId) => {
    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
               e.date_naissance, e.lieu_naissance, e.sexe as genre,
               e.nationalite, e.pays_naissance, e.telephone, e.email,
               e.code_unique, e.numero_table, e.statut_scolaire, e.standing,
               e.groupe_id, e.niveau_id, e.annee_academique_id, e.id_filiere,
               s.statut_etudiant as statut_scolarite,
               f.nom as filiere_nom, f.sigle as filiere_sigle,
               tf.libelle as type_filiere,
               n.libelle as niveau_libelle,
               aa.annee as annee_academique,
               g.nom as groupe_nom, g.classe_id
        FROM etudiant e
        LEFT JOIN scolarite s       ON s.id  = e.scolarite_id
        LEFT JOIN filiere f         ON f.id  = e.id_filiere
        LEFT JOIN typefiliere tf    ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n          ON n.id  = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g          ON g.id  = e.groupe_id
        WHERE e.id = $1
        AND e.standing = 'Inscrit'
    `;
    const result = await db.query(query, [etudiantId]);
    return result.rows[0];
};

/**
 * Récupère les informations complètes d'un étudiant (par matricule_iipea)
 */
const getEtudiantCompletByMatricule = async (matricule) => {
    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
               e.date_naissance, e.lieu_naissance, e.sexe as genre,
               e.nationalite, e.pays_naissance, e.telephone, e.email,
               e.code_unique, e.numero_table, e.statut_scolaire, e.standing,
               e.groupe_id, e.niveau_id, e.annee_academique_id, e.id_filiere,
               s.statut_etudiant as statut_scolarite,
               f.nom as filiere_nom, f.sigle as filiere_sigle,
               tf.libelle as type_filiere,
               n.libelle as niveau_libelle,
               aa.annee as annee_academique,
               g.nom as groupe_nom, g.classe_id
        FROM etudiant e
        LEFT JOIN scolarite s       ON s.id  = e.scolarite_id
        LEFT JOIN filiere f         ON f.id  = e.id_filiere
        LEFT JOIN typefiliere tf    ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n          ON n.id  = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g          ON g.id  = e.groupe_id
        WHERE e.matricule_iipea = $1
        AND e.standing = 'Inscrit'
    `;
    const result = await db.query(query, [matricule]);
    return result.rows[0];
};

// ============ FONCTION POUR SERVIR LA PAGE PV ============

/**
 * Affiche la page HTML du PV (rendu EJS)
 */
exports.afficherPVPage = async (req, res) => {
    try {
        const { groupeId, semestreId } = req.params;
        console.log(`🎓 Affichage page PV pour groupe: ${groupeId}, semestre: ${semestreId}`);

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).render('error', { title: 'Erreur', message: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        const etudiants = await _getEtudiantsGroupe(groupeId);

        const structureAcademique = await getStructureAcademiqueFonction(groupeId, semestreId);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, structureAcademique, typeTraitement, totalCreditsMaquette
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS').length;

        const pvData = {
            success: true,
            groupe:  { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour },
            type_filiere:    groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre:        { id: semestreId },
            etudiants:       resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques:    _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureAcademique.ues.length, totalCreditsMaquette)
        };

        res.render('pv', { title: 'Procès-Verbal', data: pvData });

    } catch (error) {
        console.error('❌ Erreur affichage page PV:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage du PV', error: error.message });
    }
};

/**
 * Affiche un bulletin individuel (par matricule_iipea)
 * ✅ CORRECTION : utilise typeTraitement (déterminé) au lieu de groupeInfo.type_filiere brut
 */
exports.afficherBulletinByMatricule = async (req, res) => {
    try {
        const { matricule, semestreId } = req.params;
        console.log(`📄 Bulletin - Matricule: ${matricule}, semestre: ${semestreId || 'annuel'}`);

        const etudiantComplet = await getEtudiantCompletByMatricule(matricule);
        if (!etudiantComplet) {
            return res.status(404).render('error', { title: 'Erreur', message: `Étudiant ${matricule} non trouvé` });
        }

        const groupeQuery = `
            SELECT g.id, g.nom, f.nom as filiere, f.sigle,
                   tf.libelle as type_filiere, aa.annee as annee_academique
            FROM groupe g
            LEFT JOIN etudiant et ON et.groupe_id = g.id AND et.matricule_iipea = $1
            LEFT JOIN filiere f ON f.id = et.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            LEFT JOIN anneeacademique aa ON aa.id = et.annee_academique_id
            WHERE g.id = $2
            LIMIT 1
        `;
        const groupeResult = await db.query(groupeQuery, [matricule, etudiantComplet.groupe_id]);
        const groupeInfo = groupeResult.rows[0];

        // ✅ FIX : déterminer le type de traitement réel (idem bulletins multiples)
        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);

        const structureAcademique = await getStructureAcademiqueFonction(etudiantComplet.groupe_id, semestreId || null);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);
        const notes = await getNotesEtudiantAvecDetailsFonction(etudiantComplet.id, structureAcademique.maquette_id);

        const uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            // ✅ FIX : passe typeTraitement au lieu de groupeInfo.type_filiere
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        // ✅ FIX : passe typeTraitement au lieu de groupeInfo.type_filiere
        const totaux  = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
        const decision = determinerDecisionFonction(totaux.creditsValides, totaux.creditsTotal, typeTraitement);
        const aSoldeScolarite = (etudiantComplet.statut_scolarite || '').toUpperCase() === 'SOLDE';
        const resultatsParSemestre = calculerResultatsParSemestre(uesAvecResultats);
        const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

        const bulletinData = {
            etudiant: {
                id:               etudiantComplet.id,
                matricule_iipea:  etudiantComplet.matricule_iipea,
                matricule_mesrs:  etudiantComplet.code_unique,
                nom:              etudiantComplet.nom,
                prenoms:          etudiantComplet.prenoms,
                date_naissance:   etudiantComplet.date_naissance
                                    ? new Date(etudiantComplet.date_naissance).toLocaleDateString('fr-FR')
                                    : '-',
                lieu_naissance:   etudiantComplet.lieu_naissance || '-',
                genre:            etudiantComplet.genre || (etudiantComplet.sexe === 'M' ? 'Masculin' : etudiantComplet.sexe === 'F' ? 'Féminin' : '-'),
                nationalite:      etudiantComplet.nationalite || '-',
                niveau_id:        etudiantComplet.niveau_libelle || etudiantComplet.niveau_id || 'N/A',
                moyenne_generale: totaux.moyenneGenerale,
                credits_valides:  totaux.creditsValides,
                credits_total:    totaux.creditsTotal,
                decision,
                ues:              uesAvecResultats,
                scolarite_soldee: aSoldeScolarite,
                statut_etudiant:  etudiantComplet.statut_scolarite || etudiantComplet.statut_scolaire || 'NON_DEFINI',
                ecue_a_reprendre: ecueAReprendre,
                moyenne_s1:       resultatsParSemestre.semestre1.moyenne,
                credits_s1:       resultatsParSemestre.semestre1.creditsValides,
                moyenne_s2:       resultatsParSemestre.semestre2.moyenne,
                credits_s2:       resultatsParSemestre.semestre2.creditsValides,
                moyenne_annuelle: totaux.moyenneGenerale,
                credits_annuels:  totaux.creditsValides
            },
            groupe:   { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour || 'Principal' },
            type_filiere:    groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre:        semestreId ? { id: semestreId } : null,
            date_generation: new Date().toISOString()
        };

        res.render('Bulletin', {
            title: `Bulletin - ${etudiantComplet.nom} ${etudiantComplet.prenoms}`,
            ...bulletinData
        });

    } catch (error) {
        console.error('❌ Erreur affichage bulletin:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage du bulletin', error: error.message });
    }
};

/**
 * Affiche les bulletins de tous les étudiants d'un groupe
 */
exports.afficherBulletinsMultiples = async (req, res) => {
    try {
        const { groupeId, semestreId } = req.params;
        console.log(`📚 Bulletins multiples - groupe: ${groupeId}, semestre: ${semestreId}`);

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).render('error', { title: 'Erreur', message: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        // Récupérer tous les étudiants avec infos complètes
        const etudiantsQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
                   e.date_naissance, e.lieu_naissance, e.sexe as genre,
                   e.nationalite, e.code_unique,
                   e.groupe_id, e.niveau_id, n.libelle as niveau_libelle,
                   s.statut_etudiant
            FROM etudiant e
            LEFT JOIN scolarite s ON s.id = e.scolarite_id
            LEFT JOIN niveau n    ON n.id = e.niveau_id
            WHERE e.groupe_id = $1
            AND e.standing = 'Inscrit'
            ORDER BY e.nom, e.prenoms
        `;
        const etudiantsResult = await db.query(etudiantsQuery, [groupeId]);
        const etudiants = etudiantsResult.rows;
        console.log(`👨‍🎓 ${etudiants.length} étudiants trouvés`);

        // Structure académique complète (S1 + S2)
        const structureAcademique = await getStructureAcademiqueFonction(groupeId, null);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);
        console.log(`📚 ${structureAcademique.ues.length} UE (S1 + S2)`);

        const resultatsEtudiants = [];
        const etudiantsAReprendre = [];

        for (const etudiant of etudiants) {
            console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms} (${etudiant.matricule_iipea})`);

            const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

            const uesAvecResultats = [];
            for (const ue of structureAcademique.ues) {
                const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
                uesAvecResultats.push(resultatsUE);
            }

            const totaux   = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
            const decision = determinerDecisionFonction(totaux.creditsValides, totaux.creditsTotal, typeTraitement);
            const aSoldeScolarite = (etudiant.statut_etudiant || '').toUpperCase() === 'SOLDE';
            const resultatsParSemestre = calculerResultatsParSemestre(uesAvecResultats);
            const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

            if (ecueAReprendre.length > 0) {
                etudiantsAReprendre.push({
                    etudiant_id:     etudiant.id,
                    matricule_iipea: etudiant.matricule_iipea,
                    nom:             etudiant.nom,
                    prenoms:         etudiant.prenoms,
                    decision,
                    ecue_a_reprendre: ecueAReprendre,
                    scolarite_soldee: aSoldeScolarite
                });
            }

            resultatsEtudiants.push({
                etudiant_id:      etudiant.id,
                matricule_iipea:  etudiant.matricule_iipea,
                matricule_mesrs:  etudiant.code_unique || etudiant.matricule_iipea,
                nom:              etudiant.nom,
                prenoms:          etudiant.prenoms,
                date_naissance:   etudiant.date_naissance
                                    ? new Date(etudiant.date_naissance).toLocaleDateString('fr-FR')
                                    : '-',
                lieu_naissance:   etudiant.lieu_naissance || '-',
                genre:            etudiant.genre || (etudiant.sexe === 'M' ? 'Masculin' : etudiant.sexe === 'F' ? 'Féminin' : '-'),
                nationalite:      etudiant.nationalite || '-',
                niveau_libelle:   etudiant.niveau_libelle,
                niveau_id:        etudiant.niveau_id,
                moyenne_generale: totaux.moyenneGenerale,
                credits_valides:  totaux.creditsValides,
                credits_total:    totaux.creditsTotal,
                decision,
                ues:              uesAvecResultats, // toutes UE S1 + S2 avec harmonisation
                scolarite_soldee: aSoldeScolarite,
                statut_etudiant:  etudiant.statut_etudiant || 'NON_DEFINI',
                ecue_a_reprendre: ecueAReprendre,
                moyenne_s1:       resultatsParSemestre.semestre1.moyenne,
                credits_s1:       resultatsParSemestre.semestre1.creditsValides,
                credits_total_s1: resultatsParSemestre.semestre1.creditsTotal,
                moyenne_s2:       resultatsParSemestre.semestre2.moyenne,
                credits_s2:       resultatsParSemestre.semestre2.creditsValides,
                credits_total_s2: resultatsParSemestre.semestre2.creditsTotal,
                moyenne_annuelle: totaux.moyenneGenerale,
                credits_annuels:  totaux.creditsValides
            });
        }

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS').length;

        res.render('Bulletin_multiple', {
            title: `Bulletins - ${groupeInfo.nom}`,
            groupe:   { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour || 'Principal' },
            type_filiere:    groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre:        semestreId ? { id: semestreId } : null,
            semestre_courant: semestreId || 1,
            etudiants:        resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation:  new Date().toISOString(),
            statistiques:     _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureAcademique.ues.length, totalCreditsMaquette)
        });

    } catch (error) {
        console.error('❌ Erreur affichage bulletins multiples:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage des bulletins multiples', error: error.message });
    }
};