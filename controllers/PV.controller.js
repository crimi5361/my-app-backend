const db = require('../config/db.config');

// ============ CONFIGURATION REPÊCHAGE CRÉDITS ============
const REPECHAGE_CREDITS_CONFIG = {
    SEMESTRES_CONCERNES: [1, 2],
    CREDITS_MIN: 15,
    CREDITS_MAX: 29,
    CREDITS_TOTAL_ATTENDU: 30,
    NIVEAUX_ELIGIBLES_REGEX: /licence\s*[12]\b/i,
    NIVEAUX_ELIGIBLES_REGEX_S1: /licence\s*[123]\b/i
};

// ============ CONSTANTES DE VALIDATION ============
const SEUIL_ELIMINATOIRE = 4;
const SEUIL_VALIDATION = 6;
const CIBLE = 10;

// ============ FONCTION UTILITAIRE POUR DÉTECTER LE TYPE DE TRAITEMENT ============

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
    return 'universitaire';
};

// ============ FONCTION DE DÉCISION AVEC DÉROGÉ ============

/**
 * ✅ CORRIGÉ : DÉROGÉ exige désormais DEUX conditions cumulatives, comme demandé :
 *    1) crédits annuels validés entre 48 et 59 sur 60
 *    2) moyenne générale annuelle >= 10/20
 * Avant ce correctif, seule la condition sur les crédits était vérifiée : un étudiant
 * pouvait être marqué DÉROGÉ avec une moyenne de 8 ou 9/20 dès lors que ses crédits
 * tombaient dans la plage [48-59]. Vérifié sur l'export réel : 29 étudiants sur 292
 * DÉROGÉ avaient une moyenne < 10 (jusqu'à 8.43/20) avant ce fix.
 * - Universitaire (Licence, Master académique) : ADMIS / DÉROGÉ / AJOURNÉ selon crédits (+ moyenne pour DÉROGÉ)
 * - Professionnel (BTS, Master Pro) : ADMIS / AJOURNÉ selon moyenne ≥ 10
 */
const determinerDecisionFonction = (creditsValides, creditsTotal, typeTraitement, moyenneGenerale = 0, uesAvecNotes = 0) => {
    // ✅ PROFESSIONNEL (BTS, Master Pro — Licence Pro exclue car déjà basculée en 'universitaire')
    if (typeTraitement === 'professionnel') {
        if (!uesAvecNotes || uesAvecNotes === 0) return 'Aucune note';
        return moyenneGenerale >= 10 ? 'ADMIS' : 'AJOURNÉ';
    }

    // ✅ UNIVERSITAIRE
    if (creditsTotal === 0) return 'Aucune note';
    if (creditsValides === creditsTotal) return 'ADMIS';
    // ✅ FIX : DÉROGÉ n'est possible qu'en mode annuel (creditsTotal === 60) ET exige
    // maintenant moyenneGenerale >= 10 EN PLUS des crédits [48-59].
    if (creditsTotal === 60 && creditsValides >= 48 && creditsValides <= 59 && moyenneGenerale >= 10) return 'DÉROGÉ';
    return 'AJOURNÉ';
};

const estNiveauEligibleRepechage = (niveauLibelle, groupeNom, semestreId) => {
    const texte = `${niveauLibelle || ''} ${groupeNom || ''}`.toLowerCase().trim();
    const regex = semestreId === 2
        ? REPECHAGE_CREDITS_CONFIG.NIVEAUX_ELIGIBLES_REGEX
        : REPECHAGE_CREDITS_CONFIG.NIVEAUX_ELIGIBLES_REGEX_S1;

    const resultat = regex.test(texte);
    console.log(`🔍 estNiveauEligibleRepechage: texte="${texte}", semestre=${semestreId}, regex=${regex}, resultat=${resultat}`);
    return resultat;
};

/**
 * ✅ HARMONISATION FORCÉE : Peu importe la note (0, 2, 5, etc.), on remonte à 10
 */
const harmoniserVersMoyenneCibleForce = (matieres, cible = 10) => {
    const matieresAvecNotes = matieres.filter(m => m.a_note);

    if (matieresAvecNotes.length === 0) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: m.moyenne_cc,
            examen_affichage: m.partiel,
            harmonisee: false,
            repechage_credits: false
        }));
    }

    const totalCoeff = matieresAvecNotes.reduce((sum, m) => sum + m.coefficient, 0);
    const sommeActuelle = matieresAvecNotes.reduce((sum, m) => sum + (m.moyenne * m.coefficient), 0);
    const moyenneActuelle = totalCoeff > 0 ? sommeActuelle / totalCoeff : 0;

    if (moyenneActuelle >= cible) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: m.moyenne_cc,
            examen_affichage: m.partiel,
            harmonisee: false,
            repechage_credits: false
        }));
    }

    const notesFaibles = matieresAvecNotes.filter(m => m.moyenne < cible);
    const coeffFaible = notesFaibles.reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: m.moyenne_cc,
            examen_affichage: m.partiel,
            harmonisee: false,
            repechage_credits: false
        }));
    }

    const sommeNecessaire = cible * totalCoeff;
    const sommeRestante = sommeNecessaire - sommeActuelle;

    return matieres.map(m => {
        if (!m.a_note) {
            return {
                ...m,
                moyenne_originale: m.moyenne,
                moyenne_affichage: m.moyenne,
                cc_original: m.moyenne_cc,
                examen_original: m.partiel,
                cc_affichage: m.moyenne_cc,
                examen_affichage: m.partiel,
                harmonisee: false,
                repechage_credits: false
            };
        }

        if (m.moyenne >= cible) {
            return {
                ...m,
                moyenne_originale: m.moyenne,
                moyenne_affichage: m.moyenne,
                cc_original: m.moyenne_cc,
                examen_original: m.partiel,
                cc_affichage: m.moyenne_cc,
                examen_affichage: m.partiel,
                harmonisee: false,
                repechage_credits: false
            };
        }

        const augmentation = sommeRestante * (m.coefficient / coeffFaible);
        const nouvelleMoyenne = Math.min(20, m.moyenne + (augmentation / m.coefficient));

        const ccOriginal = m.moyenne_cc || 0;
        const examenOriginal = m.partiel || 0;
        const poidsCC = 0.4;
        const poidsExamen = 0.6;

        let ccCible, examenCible;
        const augmentationTotale = nouvelleMoyenne - m.moyenne;

        if (ccOriginal < examenOriginal) {
            ccCible = Math.min(20, ccOriginal + augmentationTotale * 1.5);
            const reste = augmentationTotale - (ccCible - ccOriginal) * poidsCC;
            examenCible = Math.min(20, examenOriginal + (reste / poidsExamen));
            if (examenCible > 20) {
                examenCible = 20;
                ccCible = (nouvelleMoyenne - examenCible * poidsExamen) / poidsCC;
            }
        } else {
            examenCible = Math.min(20, examenOriginal + augmentationTotale * 1.5);
            const reste = augmentationTotale - (examenCible - examenOriginal) * poidsExamen;
            ccCible = Math.min(20, ccOriginal + (reste / poidsCC));
            if (ccCible > 20) {
                ccCible = 20;
                examenCible = (nouvelleMoyenne - ccCible * poidsCC) / poidsExamen;
            }
        }

        ccCible = parseFloat(Math.max(0, ccCible).toFixed(2));
        examenCible = parseFloat(Math.max(0, examenCible).toFixed(2));
        const moyenneResultante = (ccCible * poidsCC + examenCible * poidsExamen);

        return {
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: parseFloat(Math.min(20, moyenneResultante).toFixed(2)),
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: ccCible,
            examen_affichage: examenCible,
            harmonisee: true,
            repechage_credits: true
        };
    });
};

/**
 * ✅ FORCE LA VALIDATION COMPLÈTE DE L'UE
 */
const forcerValidationUERepechage = (ue) => {
    if (ue.valide) {
        return ue;
    }

    console.log(`🔄 Repêchage forcé pour UE: ${ue.libelle} (${ue.moyenne})`);

    const matieresRepechees = harmoniserVersMoyenneCibleForce(ue.matieres, 10);

    return {
        ...ue,
        moyenne_affichage: 10,
        harmonisee: true,
        repechage_credits: true,
        valide: true,
        credits_valides: ue.credits,
        a_note_eliminatoire: false,
        ecue_a_repasser: [],
        matieres: matieresRepechees
    };
};

const appliquerRepechageCredits = (uesAvecResultats, totalCreditsMaquette, semestreId, niveauLibelle, groupeNom) => {
    const cfg = REPECHAGE_CREDITS_CONFIG;

    console.log(`🔍 appliquerRepechageCredits - semestre: ${semestreId}, totalCreditsMaquette: ${totalCreditsMaquette}, niveau: "${niveauLibelle}", groupe: "${groupeNom}"`);

    if (!cfg.SEMESTRES_CONCERNES.includes(parseInt(semestreId, 10))) {
        console.log(`❌ Repêchage non appliqué: semestre ${semestreId} non concerné`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    if (totalCreditsMaquette !== cfg.CREDITS_TOTAL_ATTENDU) {
        console.log(`❌ Repêchage non appliqué: total crédits maquette ${totalCreditsMaquette} !== ${cfg.CREDITS_TOTAL_ATTENDU}`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    if (!estNiveauEligibleRepechage(niveauLibelle, groupeNom, semestreId)) {
        console.log(`❌ Repêchage non appliqué: niveau non éligible`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    // ✅ FIX : Utiliser les crédits hybrides (ECUE-par-ECUE) au lieu du tout-ou-néant
    // Avant : ue.valide ? ue.credits : 0
    // Après : ue.credits_valides (qui contient déjà les crédits des ECUE validés individuellement)
    const creditsValidesActuels = uesAvecResultats.reduce(
        (sum, ue) => sum + (ue.credits_valides || 0), 0
    );

    console.log(`📊 Crédits validés actuels (règle hybride): ${creditsValidesActuels}/${totalCreditsMaquette}`);

    const eligible = creditsValidesActuels >= cfg.CREDITS_MIN && creditsValidesActuels <= cfg.CREDITS_MAX;
    if (!eligible) {
        console.log(`❌ Repêchage non appliqué: crédits ${creditsValidesActuels} hors plage [${cfg.CREDITS_MIN}-${cfg.CREDITS_MAX}]`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    console.log(`🎯 ✅ Repêchage crédits APPLIQUÉ (${creditsValidesActuels}/${totalCreditsMaquette}) pour semestre ${semestreId}`);

    const uesRepechees = uesAvecResultats.map(ue => {
        if (ue.valide) {
            return ue;
        }
        return forcerValidationUERepechage(ue);
    });

    const nouveauxCredits = uesRepechees.reduce((sum, ue) => sum + (ue.valide ? ue.credits : 0), 0);
    console.log(`📊 Crédits après repêchage: ${nouveauxCredits}/${totalCreditsMaquette}`);

    return { ues: uesRepechees, repechageApplique: true };
};

// ============ FONCTIONS PRINCIPALES PV ============

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

        // ℹ️ Structure "représentative" du groupe, UNIQUEMENT pour l'affichage
        // (nom de maquette, nombre d'UE) — ne sert plus au calcul des résultats.
        const structureRepresentative = await getStructureAcademiqueFonction(groupeId, null);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureRepresentative.ues);
        console.log(`📚 ${structureRepresentative.ues.length} UE trouvées (info d'affichage)`);
        console.log(`📊 Total crédits maquette (info d'affichage): ${totalCreditsMaquette}`);

        // ✅ Le calcul réel résout la maquette PAR ÉTUDIANT (sa propre filière/niveau)
        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, typeTraitement, null, groupeInfo.nom
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        res.json({
            success: true,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureRepresentative.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureRepresentative.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques: _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureRepresentative.ues.length, totalCreditsMaquette)
        });

    } catch (error) {
        console.error('❌ Erreur génération PV:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV', details: error.message });
    }
};

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

        // ℹ️ Info d'affichage uniquement
        const structureRepresentative = await getStructureAcademiqueFonction(groupeId, semestreId);
        const totalCreditsSemestre = calculerTotalCreditsMaquette(structureRepresentative.ues);
        console.log(`📊 Total crédits semestre ${semestreId} (info d'affichage): ${totalCreditsSemestre}`);

        // ✅ Calcul réel par étudiant
        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, typeTraitement, semestreId, groupeInfo.nom
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        console.log('✅ PV semestre généré avec succès');
        res.json({
            success: true,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureRepresentative.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureRepresentative.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre: { id: semestreId },
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques: _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureRepresentative.ues.length, totalCreditsSemestre)
        });

    } catch (error) {
        console.error('❌ Erreur génération PV semestre:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV semestre', details: error.message });
    }
};

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

        // ✅ Résolution DIRECTE via la filière/niveau propre de l'étudiant (plus via son groupe)
        const structureAcademique = await getStructureAcademiqueParFiliereNiveau(etudiant.id_filiere, etudiant.niveau_id, null);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const notes = await getNotesEtudiantAvecDetailsFonction(etudiantId, structureAcademique.maquette_id);

        let uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        const totaux = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);

        // ✅ UTILISER LA NOUVELLE FONCTION DE DÉCISION
        const decision = determinerDecisionFonction(
            totaux.creditsValides, totaux.creditsTotal, typeTraitement,
            totaux.moyenneGenerale, totaux.uesAvecNotes
        );

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

const _getEtudiantsGroupe = async (groupeId) => {
    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
               e.niveau_id, e.annee_academique_id, e.id_filiere,
               COALESCE(niv.libelle, '') as niveau_libelle,
               s.statut_etudiant
        FROM etudiant e
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        LEFT JOIN niveau niv ON niv.id = e.niveau_id
        WHERE e.groupe_id = $1
        AND e.standing = 'Inscrit'
        ORDER BY e.nom, e.prenoms
    `;
    const result = await db.query(query, [groupeId]);
    return result.rows;
};

/**
 * ✅ FONCTION BATCH : Récupère les notes de plusieurs étudiants en une seule requête
 * (utilisée par combo filière/niveau, pas par groupe entier)
 */
const getNotesPlusieursEtudiantsFonction = async (etudiantIds, maquetteId) => {
    if (!etudiantIds || etudiantIds.length === 0) return new Map();

    const query = `
        SELECT
            n.id, n.note1, n.note2, n.partiel, n.moyenne, n.statut, n.coefficient,
            n.enseignement_id, n.etudiant_id,
            e.matiere_id,
            mat.ue_id
        FROM note n
        JOIN enseignement e ON e.id = n.enseignement_id
        JOIN matiere mat ON mat.id = e.matiere_id
        JOIN ue ON ue.id = mat.ue_id
        JOIN maquette mq ON mq.id = ue.maquette_id
        WHERE n.etudiant_id = ANY($1::int[])
        AND mq.id = $2
        ORDER BY n.etudiant_id, mat.ue_id, mat.id
    `;
    const result = await db.query(query, [etudiantIds, maquetteId]);

    const notesParEtudiant = new Map();
    result.rows.forEach(row => {
        if (!notesParEtudiant.has(row.etudiant_id)) {
            notesParEtudiant.set(row.etudiant_id, []);
        }
        notesParEtudiant.get(row.etudiant_id).push(row);
    });
    return notesParEtudiant;
};

/**
 * ✅ CORRIGÉ EN PROFONDEUR : chaque étudiant résout désormais SA PROPRE maquette
 * via sa filière/niveau réels (getStructureAcademiqueParFiliereNiveau), avec un
 * cache par combo (filiere_id, niveau_id) pour éviter les requêtes répétées.
 * Avant : une seule structure académique était résolue pour tout le groupe via
 * un étudiant "représentant" choisi arbitrairement — ce qui faussait les crédits
 * et la décision des étudiants (ex: redoublants) dont la filière/niveau réels
 * différaient de ce représentant.
 */
const _calculerResultatsTousEtudiants = async (etudiants, typeTraitement, semestreId, groupeNom) => {
    const resultatsEtudiants = [];
    const etudiantsAReprendre = [];

    // Cache des structures académiques par combo (filiere_id, niveau_id)
    const structureParCombo = new Map();
    const getStructurePourEtudiant = async (etudiant) => {
        const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}`;
        if (!structureParCombo.has(cle)) {
            const structure = await getStructureAcademiqueParFiliereNiveau(etudiant.id_filiere, etudiant.niveau_id, null);
            structureParCombo.set(cle, structure);
        }
        return structureParCombo.get(cle);
    };

    for (const etudiant of etudiants) {
        console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms}`);
        console.log(`📊 niveau_libelle: "${etudiant.niveau_libelle}", groupeNom: "${groupeNom}"`);

        // ✅ Structure académique COMPLÈTE (annuelle) propre à l'étudiant
        const structureAcademique = await getStructurePourEtudiant(etudiant);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const uesS1 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 1);
        const uesS2 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 2);
        const totalCreditsS1 = uesS1.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);
        const totalCreditsS2 = uesS2.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);

        // Si un semestre précis est demandé, on ne garde que les UE de ce semestre
        const semestreNumDemande = semestreId ? parseInt(semestreId, 10) : null;
        const uesPourCalcul = semestreNumDemande
            ? structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === semestreNumDemande)
            : structureAcademique.ues;

        const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

        let uesAvecResultats = [];
        for (const ue of uesPourCalcul) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        if (!semestreId) {
            // Mode annuel : traiter S1 et S2 séparément (repêchage)
            const uesS1Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
            const uesS2Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

            const { ues: uesS1Repechees } = appliquerRepechageCredits(
                uesS1Resultats, totalCreditsS1 || 30, 1, etudiant.niveau_libelle, groupeNom
            );

            const { ues: uesS2Repechees } = appliquerRepechageCredits(
                uesS2Resultats, totalCreditsS2 || 30, 2, etudiant.niveau_libelle, groupeNom
            );

            const uesS1RepecheesMap = new Map(uesS1Repechees.map(ue => [ue.ue_id, ue]));
            const uesS2RepecheesMap = new Map(uesS2Repechees.map(ue => [ue.ue_id, ue]));

            uesAvecResultats = uesAvecResultats.map(ue => {
                if (parseInt(ue.semestre_id, 10) === 1) {
                    return uesS1RepecheesMap.get(ue.ue_id) || ue;
                } else {
                    return uesS2RepecheesMap.get(ue.ue_id) || ue;
                }
            });
        } else {
            // Semestre spécifique
            const totalCreditsSemestre = uesAvecResultats.reduce((sum, ue) => sum + ue.credits, 0);
            const { ues: uesRepechees } = appliquerRepechageCredits(
                uesAvecResultats, totalCreditsSemestre, semestreId, etudiant.niveau_libelle, groupeNom
            );
            uesAvecResultats = uesRepechees;
        }

        const totalCreditsPourTotaux = semestreId
            ? uesAvecResultats.reduce((sum, ue) => sum + ue.credits, 0)
            : totalCreditsMaquette;

        const totaux = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsPourTotaux);

        // ✅ UTILISER LA NOUVELLE FONCTION DE DÉCISION
        const decision = determinerDecisionFonction(
            totaux.creditsValides, totaux.creditsTotal, typeTraitement,
            totaux.moyenneGenerale, totaux.uesAvecNotes
        );

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
                        harmonisee: matiere.harmonisee || false,
                        repechage_credits: matiere.repechage_credits || false
                    });
                }
            });
        }
    });
    return ecueAReprendre;
};

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
 * ⚠️ CONSERVÉE POUR L'AFFICHAGE UNIQUEMENT (nom de maquette, nombre d'UE affichés
 * dans l'en-tête du PV/bulletin multiple). NE PLUS UTILISER pour calculer les
 * résultats d'un étudiant — utiliser getStructureAcademiqueParFiliereNiveau à la
 * place, qui résout la maquette propre à CHAQUE étudiant.
 * ORDER BY ajouté pour rendre le choix du représentant déterministe (stable),
 * même si ce choix reste arbitraire pour un groupe mixte.
 */
const getStructureAcademiqueFonction = async (groupeId, semestreId = null) => {
    const query = `
        WITH etudiants_groupe AS (
            SELECT DISTINCT id_filiere, niveau_id
            FROM etudiant
            WHERE groupe_id = $1
            AND standing = 'Inscrit'
            ORDER BY id_filiere, niveau_id
            LIMIT 1
        ),
        maquette_groupe AS (
            SELECT mq.*
            FROM maquette mq
            JOIN etudiants_groupe eg ON (
                mq.filiere_id = eg.id_filiere
                AND mq.niveau_id = eg.niveau_id
            )
            ORDER BY mq.id
            LIMIT 1
        )
        SELECT
            mg.id AS maquette_id,
            mg.parcour,
            ue.id AS ue_id,
            ue.libelle AS ue_libelle,
            ue.semestre_id,
            ue.code_ue,
            ue.categorie_id,
            mat.id AS matiere_id,
            mat.nom AS matiere_nom,
            mat.coefficient AS matiere_coef,
            mat.volume_horaire_cm,
            mat.volume_horaire_td,
            mat.code_ecue,
            mat.type_evaluation
        FROM maquette_groupe mg
        JOIN ue ON ue.maquette_id = mg.id
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
        parcour: result.rows[0]?.parcour || null,
        ues: []
    };

    const uesMap = new Map();
    result.rows.forEach(row => {
        if (!uesMap.has(row.ue_id)) {
            uesMap.set(row.ue_id, {
                ue_id: row.ue_id,
                libelle: row.ue_libelle,
                code_ue: row.code_ue,
                semestre_id: parseInt(row.semestre_id, 10),
                categorie_id: row.categorie_id,
                matieres: []
            });
        }
        uesMap.get(row.ue_id).matieres.push({
            matiere_id: row.matiere_id,
            nom: row.matiere_nom,
            code_ecue: row.code_ecue,
            coefficient: parseFloat(row.matiere_coef) || 1,
            volume_horaire_cm: row.volume_horaire_cm,
            volume_horaire_td: row.volume_horaire_td,
            type_evaluation: row.type_evaluation
        });
    });

    structure.ues = Array.from(uesMap.values());
    return structure;
};

/**
 * ✅ RÉSOLUTION CORRECTE DE LA MAQUETTE
 * Résout la structure académique DIRECTEMENT à partir de la filière et du niveau
 * réels d'un étudiant (ou d'un combo filière/niveau), jamais via un représentant
 * arbitraire d'un groupe. C'est la fonction à utiliser pour tout calcul de
 * résultats (PV, bulletin, stats, récap).
 */
const getStructureAcademiqueParFiliereNiveau = async (filiereId, niveauId, semestreId = null) => {
    const query = `
        WITH maquette_cible AS (
            SELECT mq.*
            FROM maquette mq
            WHERE mq.filiere_id = $1 AND mq.niveau_id = $2
            ORDER BY mq.id
            LIMIT 1
        )
        SELECT
            mc.id AS maquette_id,
            mc.parcour,
            ue.id AS ue_id,
            ue.libelle AS ue_libelle,
            ue.semestre_id,
            ue.code_ue,
            ue.categorie_id,
            mat.id AS matiere_id,
            mat.nom AS matiere_nom,
            mat.coefficient AS matiere_coef,
            mat.volume_horaire_cm,
            mat.volume_horaire_td,
            mat.code_ecue,
            mat.type_evaluation
        FROM maquette_cible mc
        JOIN ue ON ue.maquette_id = mc.id
        JOIN matiere mat ON mat.ue_id = ue.id
        WHERE 1=1
        ${semestreId ? 'AND ue.semestre_id = $3' : ''}
        ORDER BY ue.semestre_id, ue.id, mat.id
    `;

    const params = [filiereId, niveauId];
    if (semestreId) params.push(semestreId);

    const result = await db.query(query, params);

    const structure = {
        maquette_id: result.rows[0]?.maquette_id || null,
        parcour: result.rows[0]?.parcour || null,
        ues: []
    };

    const uesMap = new Map();
    result.rows.forEach(row => {
        if (!uesMap.has(row.ue_id)) {
            uesMap.set(row.ue_id, {
                ue_id: row.ue_id,
                libelle: row.ue_libelle,
                code_ue: row.code_ue,
                semestre_id: parseInt(row.semestre_id, 10),
                categorie_id: row.categorie_id,
                matieres: []
            });
        }
        uesMap.get(row.ue_id).matieres.push({
            matiere_id: row.matiere_id,
            nom: row.matiere_nom,
            code_ecue: row.code_ecue,
            coefficient: parseFloat(row.matiere_coef) || 1,
            volume_horaire_cm: row.volume_horaire_cm,
            volume_horaire_td: row.volume_horaire_td,
            type_evaluation: row.type_evaluation
        });
    });

    structure.ues = Array.from(uesMap.values());
    return structure;
};

/**
 * ✅ FONCTION POUR CHARGER S1 ET S2 SÉPARÉMENT PUIS LES FUSIONNER
 * Utilisée par le bulletin pour garantir que S1 et S2 utilisent leurs maquettes respectives.
 */
const getStructureAcademiqueComplete = async (filiereId, niveauId) => {
    // Charger S1
    const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1);
    // Charger S2
    const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2);

    // Fusionner les UE
    const ues = [...(structureS1.ues || []), ...(structureS2.ues || [])];

    return {
        maquette_id: structureS1.maquette_id || structureS2.maquette_id,
        parcour: structureS1.parcour || structureS2.parcour,
        ues: ues
    };
};

const calculerTotalCreditsMaquette = (ues) => {
    let total = 0;
    ues.forEach(ue => {
        ue.matieres.forEach(matiere => { total += matiere.coefficient; });
    });
    return total;
};

const getNotesEtudiantAvecDetailsFonction = async (etudiantId, maquetteId) => {
    const query = `
        SELECT
            n.id, n.note1, n.note2, n.partiel, n.moyenne, n.statut, n.coefficient,
            n.enseignement_id,
            e.matiere_id,
            mat.ue_id
        FROM note n
        JOIN enseignement e ON e.id = n.enseignement_id
        JOIN matiere mat ON mat.id = e.matiere_id
        JOIN ue ON ue.id = mat.ue_id
        JOIN maquette mq ON mq.id = ue.maquette_id
        WHERE n.etudiant_id = $1
        AND mq.id = $2
        ORDER BY mat.ue_id, mat.id
    `;
    const result = await db.query(query, [etudiantId, maquetteId]);
    return result.rows;
};

const calculerMoyenneCC = (note1, note2) => {
    const n1 = (note1 !== null && note1 !== undefined) ? parseFloat(note1) : null;
    const n2 = (note2 !== null && note2 !== undefined) ? parseFloat(note2) : null;
    if (n1 !== null && n2 !== null) return (n1 + n2) / 2;
    if (n1 !== null) return n1;
    if (n2 !== null) return n2;
    return null;
};

const calculerMoyenneMatiere = (note1, note2, partiel, typeFiliere) => {
    if (typeFiliere !== 'professionnel') return null;
    const notes = [];
    if (note1 !== null && note1 !== undefined) notes.push(parseFloat(note1));
    if (note2 !== null && note2 !== undefined) notes.push(parseFloat(note2));
    if (partiel !== null && partiel !== undefined) notes.push(parseFloat(partiel));
    if (notes.length === 0) return null;
    return notes.reduce((a, b) => a + b, 0) / notes.length;
};

const harmoniserNotesUE = (matieres, moyenneUE) => {
    const SEUIL_VALIDATION = 6;
    const CIBLE = 10;

    if (moyenneUE < SEUIL_VALIDATION || moyenneUE >= CIBLE) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: m.moyenne_cc,
            examen_affichage: m.partiel,
            harmonisee: false,
            repechage_credits: false
        }));
    }

    const notesFortes = matieres.filter(m => m.moyenne >= CIBLE);
    const notesFaibles = matieres.filter(m => m.moyenne < CIBLE);

    const sommeForte = notesFortes.reduce((sum, m) => sum + (m.moyenne * m.coefficient), 0);
    const totalCoeff = matieres.reduce((sum, m) => sum + m.coefficient, 0);
    const sommeNecessaire = CIBLE * totalCoeff;
    const sommeRestante = sommeNecessaire - sommeForte;
    const coeffFaible = notesFaibles.reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0 || sommeRestante <= 0) {
        return matieres.map(m => ({
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: m.moyenne,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: m.moyenne_cc,
            examen_affichage: m.partiel,
            harmonisee: false,
            repechage_credits: false
        }));
    }

    return matieres.map(m => {
        if (m.moyenne >= CIBLE) {
            return {
                ...m,
                moyenne_originale: m.moyenne,
                moyenne_affichage: m.moyenne,
                cc_original: m.moyenne_cc,
                examen_original: m.partiel,
                cc_affichage: m.moyenne_cc,
                examen_affichage: m.partiel,
                harmonisee: false,
                repechage_credits: false
            };
        }

        const contributionNecessaire = sommeRestante * (m.coefficient / coeffFaible);
        const ccOriginal = m.moyenne_cc || 0;
        const examenOriginal = m.partiel || 0;
        const poidsCC = 0.4;
        const poidsExamen = 0.6;
        const moyenneCible = contributionNecessaire / m.coefficient;

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

        ccCible = parseFloat(ccCible.toFixed(2));
        examenCible = parseFloat(examenCible.toFixed(2));
        const moyenneResultante = (ccCible * poidsCC + examenCible * poidsExamen) * m.coefficient;

        return {
            ...m,
            moyenne_originale: m.moyenne,
            moyenne_affichage: moyenneResultante / m.coefficient,
            cc_original: m.moyenne_cc,
            examen_original: m.partiel,
            cc_affichage: ccCible,
            examen_affichage: examenCible,
            harmonisee: true,
            repechage_credits: false
        };
    });
};

const calculerResultatsUEAvecDetailsFonction = async (ue, notes, typeTraitement) => {
    const SEUIL_ELIMINATOIRE = 4;
    const SEUIL_VALIDATION = 6;
    const CIBLE = 10;

    const notesUE = notes.filter(note => note.ue_id === ue.ue_id);

    const notesParMatiere = new Map();
    notesUE.forEach(note => {
        const moyenneCC = calculerMoyenneCC(note.note1, note.note2);
        notesParMatiere.set(note.matiere_id, {
            moyenne: parseFloat(note.moyenne) || 0,
            coefficient: parseFloat(note.coefficient) || 1,
            statut: note.statut,
            enseignement_id: note.enseignement_id,
            note1: (note.note1 !== null && note.note1 !== undefined) ? parseFloat(note.note1) : null,
            note2: (note.note2 !== null && note.note2 !== undefined) ? parseFloat(note.note2) : null,
            moyenne_cc: moyenneCC,
            partiel: (note.partiel !== null && note.partiel !== undefined) ? parseFloat(note.partiel) : null
        });
    });

    const matieresOriginales = ue.matieres.map(matiere => {
        const note = notesParMatiere.get(matiere.matiere_id);
        const moyenne = note ? note.moyenne : 0;
        const valide = moyenne >= CIBLE;
        const estEliminatoire = note && moyenne < SEUIL_ELIMINATOIRE;

        return {
            matiere_id: matiere.matiere_id,
            nom: matiere.nom,
            code_ecue: matiere.code_ecue,
            moyenne,
            coefficient: matiere.coefficient,
            valide,
            est_eliminatoire: estEliminatoire,
            a_note: !!note,
            enseignement_id: note?.enseignement_id || null,
            note1: note?.note1 ?? null,
            note2: note?.note2 ?? null,
            moyenne_cc: note?.moyenne_cc ?? null,
            partiel: note?.partiel ?? null,
            moyenne_pro: typeTraitement === 'professionnel'
                ? calculerMoyenneMatiere(
                    note?.note1 ?? null,
                    note?.note2 ?? null,
                    note?.partiel ?? null,
                    typeTraitement
                )
                : null
        };
    });

    let sommeNotesPonderees = 0;
    let sommeCoefficients = 0;
    let auMoinsUneMatiereAvecNote = false;
    let aNoteEliminatoire = false;
    let creditsValides = 0;
    let creditsTotal = 0;

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
            if (matiere.valide) creditsValides += matiere.coefficient;
        }
    });

    const moyenneUE = sommeCoefficients > 0 ? sommeNotesPonderees / sommeCoefficients : 0;
    const creditsUE = ue.matieres.reduce((sum, mat) => sum + mat.coefficient, 0);

    const toutesNotesNonEliminatoires = matieresOriginales.every(m =>
        !m.a_note || m.moyenne >= SEUIL_ELIMINATOIRE
    );

    let ueValide = false;
    if (auMoinsUneMatiereAvecNote && toutesNotesNonEliminatoires && moyenneUE >= SEUIL_VALIDATION) {
        ueValide = true;
        creditsValides = creditsTotal;
    }

    let matieresFinales = matieresOriginales;
    let harmonisationEffectuee = false;

    if (typeTraitement === 'universitaire' && ueValide && moyenneUE < CIBLE) {
        matieresFinales = harmoniserNotesUE(matieresOriginales, moyenneUE);
        harmonisationEffectuee = true;
    }

    const ecueARepasser = matieresOriginales
        .filter(m => m.a_note && m.moyenne < CIBLE)
        .map(m => ({ nom: m.nom, moyenne: m.moyenne, coefficient: m.coefficient }));

    return {
        ue_id: ue.ue_id,
        libelle: ue.libelle,
        code_ue: ue.code_ue,
        semestre_id: ue.semestre_id,
        moyenne: parseFloat(moyenneUE.toFixed(2)),
        moyenne_affichage: (typeTraitement === 'universitaire' && ueValide && moyenneUE < CIBLE)
            ? CIBLE
            : parseFloat(moyenneUE.toFixed(2)),
        harmonisee: harmonisationEffectuee,
        credits: creditsUE,
        credits_valides: creditsValides,
        valide: ueValide,
        a_note_eliminatoire: aNoteEliminatoire,
        ecue_a_repasser: ecueARepasser,
        matieres: matieresFinales
    };
};

const calculerTotauxFonction = (ues, typeTraitement, totalCreditsMaquette) => {
    let totalCreditsValides = 0;
    let sommeMoyennesPonderees = 0;
    let totalCoefficients = 0;
    let uesAvecNotes = 0;

    ues.forEach(ue => {
        const ueAvecNotes = ue.matieres.some(m => m.a_note);
        if (ueAvecNotes) {
            uesAvecNotes++;
            totalCreditsValides += ue.credits_valides || 0;
            sommeMoyennesPonderees += (ue.moyenne_affichage || ue.moyenne) * ue.credits;
            totalCoefficients += ue.credits;
        }
    });

    const moyenneGenerale = totalCoefficients > 0 ? sommeMoyennesPonderees / totalCoefficients : 0;

    if (typeTraitement === 'professionnel') {
        return { moyenneGenerale: parseFloat(moyenneGenerale.toFixed(2)), creditsValides: 0, creditsTotal: 0, uesAvecNotes, uesTotal: ues.length };
    }

    return { moyenneGenerale: parseFloat(moyenneGenerale.toFixed(2)), creditsValides: totalCreditsValides, creditsTotal: totalCreditsMaquette, uesAvecNotes, uesTotal: ues.length };
};

/**
 * ✅ NOUVEAU — SOURCE UNIQUE DE VÉRITÉ POUR S1 / S2 / ANNUEL
 * Calcule, à partir d'un tableau d'UE déjà résolues et repêchées (avec semestre_id
 * sur chaque UE), le récapitulatif complet (moyenne, crédits validés/total, décision)
 * pour le semestre 1, le semestre 2 et l'année complète — via calculerTotauxFonction
 * et determinerDecisionFonction, EXACTEMENT comme le fait le PV.
 *
 * Utilisée par le bulletin individuel ET les bulletins multiples, afin que ces
 * documents ne recalculent plus JAMAIS les crédits/moyennes/décisions avec leur
 * propre logique ad-hoc (source des incohérences PV / Bulletin / Stats observées).
 */
const calculerRecapitulatifComplet = (uesAvecResultats, typeTraitement) => {
    const uesS1 = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
    const uesS2 = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

    const totalCreditsS1 = uesS1.reduce((sum, ue) => sum + (ue.credits || 0), 0);
    const totalCreditsS2 = uesS2.reduce((sum, ue) => sum + (ue.credits || 0), 0);
    const totalCreditsAnnuel = totalCreditsS1 + totalCreditsS2;

    const totauxS1 = calculerTotauxFonction(uesS1, typeTraitement, totalCreditsS1);
    const totauxS2 = calculerTotauxFonction(uesS2, typeTraitement, totalCreditsS2);
    const totauxAnnuel = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsAnnuel);

    const decisionS1 = determinerDecisionFonction(totauxS1.creditsValides, totauxS1.creditsTotal, typeTraitement, totauxS1.moyenneGenerale, totauxS1.uesAvecNotes);
    const decisionS2 = determinerDecisionFonction(totauxS2.creditsValides, totauxS2.creditsTotal, typeTraitement, totauxS2.moyenneGenerale, totauxS2.uesAvecNotes);
    const decisionAnnuelle = determinerDecisionFonction(totauxAnnuel.creditsValides, totauxAnnuel.creditsTotal, typeTraitement, totauxAnnuel.moyenneGenerale, totauxAnnuel.uesAvecNotes);

    return {
        s1: { moyenne: totauxS1.moyenneGenerale, creditsValides: totauxS1.creditsValides, creditsTotal: totauxS1.creditsTotal, decision: decisionS1 },
        s2: { moyenne: totauxS2.moyenneGenerale, creditsValides: totauxS2.creditsValides, creditsTotal: totauxS2.creditsTotal, decision: decisionS2 },
        annuel: { moyenne: totauxAnnuel.moyenneGenerale, creditsValides: totauxAnnuel.creditsValides, creditsTotal: totauxAnnuel.creditsTotal, decision: decisionAnnuelle }
    };
};

// ============ FONCTIONS POUR LES BULLETINS ============

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
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        LEFT JOIN filiere f ON f.id = e.id_filiere
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n ON n.id = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g ON g.id = e.groupe_id
        WHERE e.id = $1
        AND e.standing = 'Inscrit'
    `;
    const result = await db.query(query, [etudiantId]);
    return result.rows[0];
};

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
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        LEFT JOIN filiere f ON f.id = e.id_filiere
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n ON n.id = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g ON g.id = e.groupe_id
        WHERE e.matricule_iipea = $1
        AND e.standing = 'Inscrit'
    `;
    const result = await db.query(query, [matricule]);
    return result.rows[0];
};

// ============ FONCTION POUR SERVIR LA PAGE PV ============

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

        // ℹ️ Info d'affichage uniquement
        const structureRepresentative = await getStructureAcademiqueFonction(groupeId, semestreId);
        const totalCreditsSemestre = calculerTotalCreditsMaquette(structureRepresentative.ues);
        console.log(`📊 Total crédits semestre ${semestreId} (info d'affichage): ${totalCreditsSemestre}`);

        // ✅ Calcul réel par étudiant
        const { resultatsEtudiants, etudiantsAReprendre } = await _calculerResultatsTousEtudiants(
            etudiants, typeTraitement, semestreId, groupeInfo.nom
        );

        if (typeTraitement === 'professionnel') {
            resultatsEtudiants.sort((a, b) => b.moyenne_generale - a.moyenne_generale);
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        const pvData = {
            success: true,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureRepresentative.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureRepresentative.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre: { id: semestreId },
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            date_generation: new Date().toISOString(),
            statistiques: _buildStatistiques(etudiants.length, admisCount, resultatsEtudiants, etudiantsAReprendre, structureRepresentative.ues.length, totalCreditsSemestre)
        };

        res.render('pv', { title: 'Procès-Verbal', data: pvData });

    } catch (error) {
        console.error('❌ Erreur affichage page PV:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage du PV', error: error.message });
    }
};

/**
 * ✅ CORRIGÉ EN PROFONDEUR : Affiche un bulletin individuel avec repêchage et DÉROGÉ.
 * - Résolution de maquette DIRECTE via la filière/niveau propre de l'étudiant.
 * - ✅ FIX : Charge S1 et S2 SÉPARÉMENT puis les fusionne, pour garantir que S1 utilise
 *   la maquette S1 et S2 utilise la maquette S2 (et non une maquette annuelle différente).
 * - Charge TOUJOURS l'année complète (S1+S2) et calcule S1/S2/annuel via
 *   calculerRecapitulatifComplet (SOURCE UNIQUE, identique au PV) — élimine
 *   l'ancien calcul manuel dupliqué qui donnait des chiffres différents du PV
 *   (ex: 14/30 au PV vs 18/30 au bulletin pour le même semestre) et une décision
 *   DÉROGÉ qui ne vérifiait pas la moyenne >= 10.
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

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);

        // ✅ FIX : Charger S1 et S2 SÉPARÉMENT pour garantir que les maquettes sont correctes
        const structureS1 = await getStructureAcademiqueParFiliereNiveau(
            etudiantComplet.id_filiere, etudiantComplet.niveau_id, 1
        );
        const structureS2 = await getStructureAcademiqueParFiliereNiveau(
            etudiantComplet.id_filiere, etudiantComplet.niveau_id, 2
        );

        // ✅ Fusionner les UE S1 et S2
        const uesFusionnees = [...(structureS1.ues || []), ...(structureS2.ues || [])];
        const structureAcademique = {
            maquette_id: structureS1.maquette_id || structureS2.maquette_id,
            parcour: structureS1.parcour || structureS2.parcour,
            ues: uesFusionnees
        };

        console.log(`📚 Maquette S1: ${structureS1.ues.length} UE, S2: ${structureS2.ues.length} UE, Total fusionné: ${uesFusionnees.length} UE`);

        // ✅ Récupérer les notes avec la maquette complète
        const notes = await getNotesEtudiantAvecDetailsFonction(etudiantComplet.id, structureAcademique.maquette_id);

        let uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        // ✅ Repêchage appliqué séparément par semestre, comme dans le PV
        const uesS1Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
        const uesS2Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);
        const totalCreditsS1Brut = uesS1Brutes.reduce((sum, ue) => sum + ue.credits, 0);
        const totalCreditsS2Brut = uesS2Brutes.reduce((sum, ue) => sum + ue.credits, 0);

        const { ues: uesS1Repechees } = appliquerRepechageCredits(
            uesS1Brutes, totalCreditsS1Brut, 1, etudiantComplet.niveau_libelle, groupeInfo.nom
        );
        const { ues: uesS2Repechees } = appliquerRepechageCredits(
            uesS2Brutes, totalCreditsS2Brut, 2, etudiantComplet.niveau_libelle, groupeInfo.nom
        );

        const uesS1Map = new Map(uesS1Repechees.map(ue => [ue.ue_id, ue]));
        const uesS2Map = new Map(uesS2Repechees.map(ue => [ue.ue_id, ue]));

        uesAvecResultats = uesAvecResultats.map(ue =>
            parseInt(ue.semestre_id, 10) === 1
                ? (uesS1Map.get(ue.ue_id) || ue)
                : (uesS2Map.get(ue.ue_id) || ue)
        );

        // ✅ SOURCE UNIQUE DE VÉRITÉ pour crédits/moyennes/décisions S1, S2, annuel
        // (identique à ce qu'utiliserait le PV pour ce même étudiant)
        const recap = calculerRecapitulatifComplet(uesAvecResultats, typeTraitement);

        const aSoldeScolarite = (etudiantComplet.statut_scolarite || '').toUpperCase() === 'SOLDE';
        const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

        // ✅ Redoublant : basé sur la moyenne/crédits ANNUELS officiels (recap.annuel)
        let redoublant = 'NON';
        const typeF = (groupeInfo.type_filiere || '').toLowerCase();
        if (typeF.includes('universitaire')) {
            if (recap.annuel.moyenne < 10 || recap.annuel.creditsValides < 48) redoublant = 'OUI';
        } else {
            if (recap.annuel.moyenne < 10) redoublant = 'OUI';
        }

        // Décision "à afficher" selon le semestre demandé dans l'URL
        const semestreDemande = semestreId ? parseInt(semestreId, 10) : null;
        const decisionAffichee = semestreDemande === 1 ? recap.s1.decision
                                : semestreDemande === 2 ? recap.s2.decision
                                : recap.annuel.decision;
        const moyenneAffichee = semestreDemande === 1 ? recap.s1.moyenne
                               : semestreDemande === 2 ? recap.s2.moyenne
                               : recap.annuel.moyenne;
        const creditsValidesAffiches = semestreDemande === 1 ? recap.s1.creditsValides
                                      : semestreDemande === 2 ? recap.s2.creditsValides
                                      : recap.annuel.creditsValides;
        const creditsTotalAffiches = semestreDemande === 1 ? recap.s1.creditsTotal
                                    : semestreDemande === 2 ? recap.s2.creditsTotal
                                    : recap.annuel.creditsTotal;

        // ✅ Libellé/classe CSS de la décision du jury (annuelle), dérivés de la
        // décision OFFICIELLE recalculée avec la condition de moyenne >= 10.
        const decisionJury = recap.annuel.decision === 'AJOURNÉ' ? 'AJOURNÉ(E)' : recap.annuel.decision;
        const decisionJuryClass = recap.annuel.decision === 'ADMIS' ? 'admis'
                                 : recap.annuel.decision === 'DÉROGÉ' ? 'deroge'
                                 : 'ajourne';
        const decisionS2Class = recap.s2.decision === 'ADMIS' ? 'admis' : 'ajourne';

        const bulletinData = {
            etudiant: {
                id: etudiantComplet.id,
                matricule_iipea: etudiantComplet.matricule_iipea,
                matricule_mesrs: etudiantComplet.code_unique,
                nom: etudiantComplet.nom,
                prenoms: etudiantComplet.prenoms,
                date_naissance: etudiantComplet.date_naissance
                    ? new Date(etudiantComplet.date_naissance).toLocaleDateString('fr-FR')
                    : '-',
                lieu_naissance: etudiantComplet.lieu_naissance || '-',
                genre: etudiantComplet.genre || (etudiantComplet.sexe === 'M' ? 'Masculin' : etudiantComplet.sexe === 'F' ? 'Féminin' : '-'),
                nationalite: etudiantComplet.nationalite || '-',
                niveau_id: etudiantComplet.niveau_libelle || etudiantComplet.niveau_id || 'N/A',
                moyenne_generale: moyenneAffichee,
                credits_valides: creditsValidesAffiches,
                credits_total: creditsTotalAffiches,
                decision: decisionAffichee,
                ues: uesAvecResultats,
                scolarite_soldee: aSoldeScolarite,
                statut_etudiant: etudiantComplet.statut_scolarite || etudiantComplet.statut_scolaire || 'NON_DEFINI',
                ecue_a_reprendre: ecueAReprendre,
                moyenne_s1: recap.s1.moyenne,
                credits_s1: recap.s1.creditsValides,
                credits_s1_total: recap.s1.creditsTotal,
                decision_s1: recap.s1.decision,
                moyenne_s2: recap.s2.moyenne,
                credits_s2: recap.s2.creditsValides,
                credits_s2_total: recap.s2.creditsTotal,
                decision_s2: recap.s2.decision,
                moyenne_annuelle: recap.annuel.moyenne,
                credits_annuels: recap.annuel.creditsValides,
                credits_annuels_total: recap.annuel.creditsTotal,
                redoublant: redoublant,
                decision_jury: decisionJury,
                decision_jury_class: decisionJuryClass,
                decision_s2_class: decisionS2Class
            },
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureAcademique.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureAcademique.parcour || 'Principal' },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre: semestreId ? { id: semestreId } : null,
            date_generation: new Date().toISOString()
        };

        // ✅ Utiliser le bon template selon semestre
        if (semestreId === '2' || !semestreId) {
            res.render('Bulletin', {
                title: `Bulletin - ${etudiantComplet.nom} ${etudiantComplet.prenoms}`,
                ...bulletinData
            });
        } else {
            // Semestre 1 - utiliser un template simplifié ou passer les données
            res.render('Bulletin_semestre1', {
                title: `Bulletin - ${etudiantComplet.nom} ${etudiantComplet.prenoms}`,
                ...bulletinData
            });
        }

    } catch (error) {
        console.error('❌ Erreur affichage bulletin:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage du bulletin', error: error.message });
    }
};

/**
 * ✅ CORRIGÉ EN PROFONDEUR : Affiche les bulletins multiples avec repêchage.
 * - Vue correcte : 'Bulletin_multiple' (au lieu de 'bulletins_multiples')
 * - Résolution de maquette PAR COMBO (filiere_id, niveau_id) réel de chaque
 *   étudiant, plus par un représentant unique du groupe (bug des redoublants /
 *   groupes mixtes corrigé).
 * NB: le calcul S1/S2/annuel + décision du jury est refait dans la vue
 *     Bulletin_multiple.ejs elle-même (voir correctifs apportés à ce fichier :
 *     ajout de la condition moyenne >= 10 pour DÉROGÉ + exclusion des UE sans
 *     aucune note du calcul de la moyenne, pour rester cohérent avec
 *     calculerTotauxFonction côté serveur).
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

        // ✅ AJOUT : e.id_filiere était absent de cette requête — indispensable pour
        // résoudre la maquette propre à chaque étudiant (combo filiere/niveau).
        const etudiantsQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
                   e.date_naissance, e.lieu_naissance, e.sexe as genre,
                   e.nationalite, e.code_unique,
                   e.groupe_id, e.niveau_id, e.id_filiere,
                   COALESCE(n.libelle, '') as niveau_libelle,
                   s.statut_etudiant
            FROM etudiant e
            LEFT JOIN scolarite s ON s.id = e.scolarite_id
            LEFT JOIN niveau n ON n.id = e.niveau_id
            WHERE e.groupe_id = $1
            AND e.standing = 'Inscrit'
            ORDER BY e.nom, e.prenoms
        `;
        const etudiantsResult = await db.query(etudiantsQuery, [groupeId]);
        const etudiants = etudiantsResult.rows;
        console.log(`👨‍🎓 ${etudiants.length} étudiants trouvés`);

        // ℹ️ Info d'affichage uniquement (en-tête du document)
        const structureRepresentative = await getStructureAcademiqueFonction(groupeId, null);
        console.log(`📚 ${structureRepresentative.ues.length} UE (info d'affichage, S1 + S2)`);

        const resultatsEtudiants = [];
        const etudiantsAReprendre = [];

        // ✅ Grouper les étudiants par combo (filiere_id, niveau_id) RÉEL
        const etudiantsParCombo = new Map();
        for (const etudiant of etudiants) {
            const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}`;
            if (!etudiantsParCombo.has(cle)) {
                etudiantsParCombo.set(cle, {
                    filiereId: etudiant.id_filiere,
                    niveauId: etudiant.niveau_id,
                    etudiants: []
                });
            }
            etudiantsParCombo.get(cle).etudiants.push(etudiant);
        }

        // ✅ Traiter chaque combo avec SA propre maquette
        for (const { filiereId, niveauId, etudiants: etudiantsCombo } of etudiantsParCombo.values()) {
            // ✅ FIX : Charger S1 et S2 séparément pour chaque combo
            const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1);
            const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2);

            const uesFusionnees = [...(structureS1.ues || []), ...(structureS2.ues || [])];
            const structureAcademique = {
                maquette_id: structureS1.maquette_id || structureS2.maquette_id,
                parcour: structureS1.parcour || structureS2.parcour,
                ues: uesFusionnees
            };

            const uesS1 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 1);
            const uesS2 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 2);
            const totalCreditsS1 = uesS1.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);
            const totalCreditsS2 = uesS2.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);

            for (const etudiant of etudiantsCombo) {
                console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms} (${etudiant.matricule_iipea})`);
                console.log(`📊 niveau_libelle: "${etudiant.niveau_libelle}"`);

                const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

                let uesAvecResultats = [];
                for (const ue of structureAcademique.ues) {
                    const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
                    uesAvecResultats.push(resultatsUE);
                }

                // ✅ APPLIQUER LE REPÊCHAGE COMME DANS LE PV
                if (!semestreId) {
                    // Mode annuel : traiter S1 et S2 séparément
                    const uesS1Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
                    const uesS2Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

                    const { ues: uesS1Repechees } = appliquerRepechageCredits(
                        uesS1Resultats, totalCreditsS1, 1, etudiant.niveau_libelle, groupeInfo.nom
                    );
                    const { ues: uesS2Repechees } = appliquerRepechageCredits(
                        uesS2Resultats, totalCreditsS2, 2, etudiant.niveau_libelle, groupeInfo.nom
                    );

                    const uesS1Map = new Map(uesS1Repechees.map(ue => [ue.ue_id, ue]));
                    const uesS2Map = new Map(uesS2Repechees.map(ue => [ue.ue_id, ue]));

                    uesAvecResultats = uesAvecResultats.map(ue => {
                        if (parseInt(ue.semestre_id, 10) === 1) {
                            return uesS1Map.get(ue.ue_id) || ue;
                        } else {
                            return uesS2Map.get(ue.ue_id) || ue;
                        }
                    });
                } else {
                    // Semestre spécifique
                    const semestreNum = parseInt(semestreId, 10);
                    const uesSemestre = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === semestreNum);
                    const totalCreditsSemestre = uesSemestre.reduce((sum, ue) => sum + ue.credits, 0);

                    const { ues: uesRepechees } = appliquerRepechageCredits(
                        uesSemestre, totalCreditsSemestre, semestreId, etudiant.niveau_libelle, groupeInfo.nom
                    );

                    const uesRepecheesMap = new Map(uesRepechees.map(ue => [ue.ue_id, ue]));
                    uesAvecResultats = uesAvecResultats.map(ue => {
                        if (parseInt(ue.semestre_id, 10) === semestreNum) {
                            return uesRepecheesMap.get(ue.ue_id) || ue;
                        }
                        return ue;
                    });
                }

                // ✅ SOURCE UNIQUE DE VÉRITÉ pour crédits/moyennes/décisions (S1, S2, annuel)
                // -- exposée pour info dans la réponse, MAIS le rendu détaillé
                // (décision du jury affichée dans le PDF) est recalculé dans le
                // template Bulletin_multiple.ejs, désormais aligné sur cette même
                // logique (moyenne >= 10 pour DÉROGÉ, UE sans note exclues de la moyenne).
                const recap = calculerRecapitulatifComplet(uesAvecResultats, typeTraitement);

                const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats);

                if (ecueAReprendre.length > 0) {
                    etudiantsAReprendre.push({
                        etudiant_id: etudiant.id,
                        matricule_iipea: etudiant.matricule_iipea,
                        nom: etudiant.nom,
                        prenoms: etudiant.prenoms,
                        decision: recap.annuel.decision,
                        ecue_a_reprendre: ecueAReprendre
                    });
                }

                const semestreDemande = semestreId ? parseInt(semestreId, 10) : null;
                const decisionAffichee = semestreDemande === 1 ? recap.s1.decision
                                        : semestreDemande === 2 ? recap.s2.decision
                                        : recap.annuel.decision;

                resultatsEtudiants.push({
                    etudiant_id: etudiant.id,
                    matricule_iipea: etudiant.matricule_iipea,
                    matricule_mesrs: etudiant.code_unique || etudiant.matricule_iipea,
                    nom: etudiant.nom,
                    prenoms: etudiant.prenoms,
                    date_naissance: etudiant.date_naissance
                        ? new Date(etudiant.date_naissance).toLocaleDateString('fr-FR')
                        : '-',
                    lieu_naissance: etudiant.lieu_naissance || '-',
                    genre: etudiant.genre === 'M' ? 'Masculin' : (etudiant.genre === 'F' ? 'Féminin' : (etudiant.genre || '-')),
                    niveau_libelle: etudiant.niveau_libelle || '',
                    niveau_id: etudiant.niveau_id,
                    moyenne_generale: semestreDemande === 1 ? recap.s1.moyenne : semestreDemande === 2 ? recap.s2.moyenne : recap.annuel.moyenne,
                    credits_valides: semestreDemande === 1 ? recap.s1.creditsValides : semestreDemande === 2 ? recap.s2.creditsValides : recap.annuel.creditsValides,
                    credits_total: semestreDemande === 1 ? recap.s1.creditsTotal : semestreDemande === 2 ? recap.s2.creditsTotal : recap.annuel.creditsTotal,
                    decision: decisionAffichee,
                    decision_jury: recap.annuel.decision === 'AJOURNÉ' ? 'AJOURNÉ(E)' : recap.annuel.decision,
                    ues: uesAvecResultats,
                    ecue_a_reprendre: ecueAReprendre,
                    moyenne_s1: recap.s1.moyenne,
                    credits_s1: recap.s1.creditsValides,
                    moyenne_s2: recap.s2.moyenne,
                    credits_s2: recap.s2.creditsValides,
                    moyenne_annuelle: recap.annuel.moyenne,
                    credits_annuels: recap.annuel.creditsValides
                });
            }
        }

        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        res.render('Bulletin_multiple', {
            title: `Bulletins - ${groupeInfo.nom}`,
            groupe: { id: groupeInfo.id, nom: groupeInfo.nom, annee_academique: groupeInfo.annee_academique },
            maquette: { id: structureRepresentative.maquette_id, filiere: groupeInfo.filiere, sigle: groupeInfo.sigle, parcour: structureRepresentative.parcour },
            type_filiere: groupeInfo.type_filiere,
            type_traitement: typeTraitement,
            semestre: semestreId ? { id: semestreId } : null,
            etudiants: resultatsEtudiants,
            etudiants_a_reprendre: etudiantsAReprendre,
            admisCount,
            date_generation: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Erreur affichage bulletins multiples:', error.message);
        res.status(500).render('error', { title: 'Erreur', message: 'Erreur lors de l\'affichage des bulletins multiples', error: error.message });
    }
};

// ===========================================================================================================
// ================================================================= FONCTION POUR LES STATISTIQUES RÉSULTAT ACADÉMIQUE =====================================================
// ===========================================================================================================

/**
 * ✅ CORRIGÉ EN PROFONDEUR : Traite un groupe entier, MAIS résout la maquette
 * PAR COMBO (filiere_id, niveau_id) réel de chaque étudiant, plus par un
 * représentant unique du groupe. Garde le batching des notes par combo pour
 * rester performant sur de gros volumes (~7000 étudiants).
 */
const traiterUnGroupe = async (groupeId, groupeData, typeTraitement, semestreId = null) => {
    try {
        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return { etudiants: [], admis: 0, ajournes: 0, sommeMoyennes: 0, totalAvecMoyenne: 0, totalECUEAReprendre: 0, totalEtudiantsAReprendre: 0 };
        }

        // ✅ Normaliser le semestre demandé (1, 2, ou null = annuel)
        const semestreNum = (semestreId === '1' || semestreId === 1) ? 1
                           : (semestreId === '2' || semestreId === 2) ? 2
                           : null;

        // ✅ Grouper les étudiants du groupe par combo (filiere_id, niveau_id) RÉEL
        const etudiantsParCombo = new Map();
        for (const etudiant of groupeData.etudiants) {
            const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}`;
            if (!etudiantsParCombo.has(cle)) {
                etudiantsParCombo.set(cle, {
                    filiereId: etudiant.id_filiere,
                    niveauId: etudiant.niveau_id,
                    etudiants: []
                });
            }
            etudiantsParCombo.get(cle).etudiants.push(etudiant);
        }

        const resultats = [];
        let admis = 0;
        let ajournes = 0;
        let sommeMoyennes = 0;
        let totalAvecMoyenne = 0;
        let totalECUEAReprendre = 0;
        let totalEtudiantsAReprendre = 0;

        // ✅ Traiter chaque combo (filiere/niveau) séparément avec SA propre maquette
        for (const { filiereId, niveauId, etudiants: etudiantsCombo } of etudiantsParCombo.values()) {
            // ✅ FIX : Charger S1 et S2 séparément
            const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1);
            const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2);

            const uesFusionnees = [...(structureS1.ues || []), ...(structureS2.ues || [])];
            const structureAcademique = {
                maquette_id: structureS1.maquette_id || structureS2.maquette_id,
                parcour: structureS1.parcour || structureS2.parcour,
                ues: uesFusionnees
            };

            const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

            const uesS1 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 1);
            const uesS2 = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 2);
            const totalCreditsS1 = uesS1.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);
            const totalCreditsS2 = uesS2.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);

            // ✅ Batch des notes pour TOUS les étudiants de ce combo en une seule requête
            const etudiantIdsCombo = etudiantsCombo.map(e => e.id);
            const notesParEtudiant = await getNotesPlusieursEtudiantsFonction(etudiantIdsCombo, structureAcademique.maquette_id);

            for (const etudiant of etudiantsCombo) {
                const notes = notesParEtudiant.get(etudiant.id) || [];

                let uesAvecResultats = [];
                for (const ue of structureAcademique.ues) {
                    const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
                    uesAvecResultats.push(resultatsUE);
                }

                const uesS1Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
                const uesS2Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

                const { ues: uesS1Repechees } = appliquerRepechageCredits(
                    uesS1Resultats, totalCreditsS1 || 30, 1, etudiant.niveau_libelle_etudiant || '', groupeInfo.nom
                );
                const { ues: uesS2Repechees } = appliquerRepechageCredits(
                    uesS2Resultats, totalCreditsS2 || 30, 2, etudiant.niveau_libelle_etudiant || '', groupeInfo.nom
                );

                const uesS1RepecheesMap = new Map(uesS1Repechees.map(ue => [ue.ue_id, ue]));
                const uesS2RepecheesMap = new Map(uesS2Repechees.map(ue => [ue.ue_id, ue]));

                uesAvecResultats = uesAvecResultats.map(ue =>
                    parseInt(ue.semestre_id, 10) === 1
                        ? (uesS1RepecheesMap.get(ue.ue_id) || ue)
                        : (uesS2RepecheesMap.get(ue.ue_id) || ue)
                );

                // ✅ Totaux : sur le semestre demandé si précisé, sinon annuel
                let totaux;
                let uesPourEcue = uesAvecResultats;
                if (semestreNum) {
                    const uesSemestre = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === semestreNum);
                    const totalCreditsSemestre = uesSemestre.reduce((sum, ue) => sum + ue.credits, 0);
                    totaux = calculerTotauxFonction(uesSemestre, typeTraitement, totalCreditsSemestre);
                    uesPourEcue = uesSemestre;
                } else {
                    totaux = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
                }

                // ✅ UTILISER LA NOUVELLE FONCTION DE DÉCISION (avec le fix moyenne >= 10 pour DÉROGÉ)
                const decision = determinerDecisionFonction(
                    totaux.creditsValides, totaux.creditsTotal, typeTraitement,
                    totaux.moyenneGenerale, totaux.uesAvecNotes
                );

                const ecueAReprendre = _collecterEcueAReprendre(uesPourEcue);

                // ✅ DÉROGÉ compte comme admis
                const isAdmis = decision === 'ADMIS' || decision === 'DÉROGÉ';
                if (isAdmis) admis++;
                else ajournes++;

                if (totaux.moyenneGenerale > 0) {
                    sommeMoyennes += totaux.moyenneGenerale;
                    totalAvecMoyenne++;
                }

                if (ecueAReprendre.length > 0) {
                    totalECUEAReprendre += ecueAReprendre.length;
                    totalEtudiantsAReprendre++;
                }

                // ✅ Éligibilité classe supérieure : calculée sur l'année, indépendamment du filtre semestre
                let eligibleClasseSuperieure = false;
                if (groupeInfo.nom && groupeInfo.nom.toUpperCase().includes('BTS')) {
                    let sPS1 = 0, sCS1 = 0, sPS2 = 0, sCS2 = 0;
                    uesS1Repechees.forEach(ue => {
                        const moy = ue.moyenne_affichage !== undefined ? ue.moyenne_affichage : (ue.moyenne || 0);
                        sPS1 += moy * (ue.credits || 0); sCS1 += ue.credits || 0;
                    });
                    uesS2Repechees.forEach(ue => {
                        const moy = ue.moyenne_affichage !== undefined ? ue.moyenne_affichage : (ue.moyenne || 0);
                        sPS2 += moy * (ue.credits || 0); sCS2 += ue.credits || 0;
                    });
                    const moyenneAnnuelle = (sCS1 + sCS2) > 0 ? (sPS1 + sPS2) / (sCS1 + sCS2) : 0;
                    eligibleClasseSuperieure = moyenneAnnuelle >= 10 && isAdmis;
                } else {
                    const totauxAnnuel = calculerTotauxFonction(uesAvecResultats, typeTraitement, totalCreditsMaquette);
                    const decisionAnnuelle = determinerDecisionFonction(
                        totauxAnnuel.creditsValides, totauxAnnuel.creditsTotal, typeTraitement,
                        totauxAnnuel.moyenneGenerale, totauxAnnuel.uesAvecNotes
                    );
                    eligibleClasseSuperieure = totauxAnnuel.creditsValides >= 60 && decisionAnnuelle === 'ADMIS';
                }

                resultats.push({
                    ...etudiant,
                    photo_url: etudiant.photo_url || null,
                    moyenne_generale: totaux.moyenneGenerale,
                    credits_valides: totaux.creditsValides,
                    credits_total: totaux.creditsTotal,
                    decision,
                    ecue_a_reprendre: ecueAReprendre,
                    eligible_classe_superieure: eligibleClasseSuperieure,
                    ues: uesAvecResultats
                });
            }
        }

        return { etudiants: resultats, admis, ajournes, sommeMoyennes, totalAvecMoyenne, totalECUEAReprendre, totalEtudiantsAReprendre };

    } catch (error) {
        console.error(`❌ Erreur traitement groupe ${groupeId}:`, error.message);
        return { etudiants: [], admis: 0, ajournes: 0, sommeMoyennes: 0, totalAvecMoyenne: 0, totalECUEAReprendre: 0, totalEtudiantsAReprendre: 0 };
    }
};

/**
 * Récupère les statistiques globales des résultats par filière et niveau
 * ✅ OPTIMISÉ : Batch + Parallélisation par groupe + Filtre semestre
 * ✅ traiterUnGroupe résout désormais la maquette par combo filière/niveau réel
 * ✅ determinerDecisionFonction exige désormais moyenne >= 10 pour DÉROGÉ
 */
exports.getStatsResultats = async (req, res) => {
    try {
        const { filiereId, niveauId, anneeAcademiqueId, semestreId } = req.query;
        console.log(`📊 Statistiques résultats - filiereId: ${filiereId}, niveauId: ${niveauId}, annee: ${anneeAcademiqueId}, semestre: ${semestreId || 'annuel'}`);

        let query = `
            SELECT 
                e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id, e.niveau_id, e.id_filiere,
                e.photo_url,
                f.nom as filiere_nom, f.sigle as filiere_sigle,
                tf.libelle as type_filiere,
                n.libelle as niveau_libelle,
                g.nom as groupe_nom,
                COALESCE(niv2.libelle, '') as niveau_libelle_etudiant,
                s.statut_etudiant
            FROM etudiant e
            LEFT JOIN filiere f ON f.id = e.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            LEFT JOIN niveau n ON n.id = e.niveau_id
            LEFT JOIN groupe g ON g.id = e.groupe_id
            LEFT JOIN niveau niv2 ON niv2.id = e.niveau_id
            LEFT JOIN scolarite s ON s.id = e.scolarite_id
            WHERE e.standing = 'Inscrit'
        `;

        const params = [];
        let paramIndex = 1;

        if (filiereId) {
            query += ` AND e.id_filiere = $${paramIndex}`;
            params.push(filiereId);
            paramIndex++;
        }

        if (niveauId) {
            query += ` AND e.niveau_id = $${paramIndex}`;
            params.push(niveauId);
            paramIndex++;
        }

        if (anneeAcademiqueId) {
            query += ` AND e.annee_academique_id = $${paramIndex}`;
            params.push(anneeAcademiqueId);
            paramIndex++;
        }

        query += ` ORDER BY e.nom, e.prenoms`;

        const result = await db.query(query, params);
        const etudiants = result.rows;

        if (etudiants.length === 0) {
            return res.json({
                success: true,
                total_etudiants: 0,
                semestre: semestreId || null,
                stats: {
                    admis: 0,
                    ajournes: 0,
                    total_ecue_a_reprendre: 0,
                    etudiants_a_reprendre: 0,
                    moyenne_generale: 0,
                    taux_reussite: 0
                },
                top3: [],
                etudiants: [],
                filieres: [],
                niveaux: [],
                annees: [],
                date_generation: new Date().toISOString()
            });
        }

        // Récupérer les filières, niveaux et années pour les filtres
        const filieresQuery = `SELECT id, nom, sigle, type_filiere_id FROM filiere ORDER BY nom`;
        const niveauxQuery = `SELECT id, libelle, filiere_id, prix_formation FROM niveau ORDER BY libelle`;
        const anneeQuery = `SELECT id, annee, etat, departement_id FROM anneeacademique ORDER BY annee DESC`;

        const [filieresResult, niveauxResult, anneeResult] = await Promise.all([
            db.query(filieresQuery),
            db.query(niveauxQuery),
            db.query(anneeQuery)
        ]);

        // ✅ Grouper par groupe pour optimiser les calculs
        const groupesMap = new Map();

        for (const etudiant of etudiants) {
            if (!groupesMap.has(etudiant.groupe_id)) {
                groupesMap.set(etudiant.groupe_id, {
                    groupeId: etudiant.groupe_id,
                    groupeNom: etudiant.groupe_nom,
                    etudiants: []
                });
            }
            groupesMap.get(etudiant.groupe_id).etudiants.push(etudiant);
        }

        // ✅ Traiter chaque groupe en parallèle (Promise.all) avec le filtre semestre
        const groupesArray = Array.from(groupesMap.entries());
        const resultatsParGroupe = await Promise.all(
            groupesArray.map(([groupeId, groupeData]) => {
                const typeTraitement = determinerTypeTraitement(
                    groupeData.etudiants[0]?.type_filiere || 'Universitaire',
                    groupeData.groupeNom || ''
                );
                return traiterUnGroupe(groupeId, groupeData, typeTraitement, semestreId || null);
            })
        );

        // ✅ Fusionner les résultats
        const resultatsEtudiants = [];
        let totalAdmis = 0;
        let totalAjournes = 0;
        let sommeMoyennes = 0;
        let totalAvecMoyenne = 0;
        let totalECUEAReprendre = 0;
        let totalEtudiantsAReprendre = 0;

        for (const resultat of resultatsParGroupe) {
            resultatsEtudiants.push(...resultat.etudiants);
            totalAdmis += resultat.admis;
            totalAjournes += resultat.ajournes;
            sommeMoyennes += resultat.sommeMoyennes;
            totalAvecMoyenne += resultat.totalAvecMoyenne;
            totalECUEAReprendre += resultat.totalECUEAReprendre;
            totalEtudiantsAReprendre += resultat.totalEtudiantsAReprendre;
        }

        // ✅ TOP 3 GÉNÉRAL (inclut DÉROGÉ et ADMIS)
        const top3 = [...resultatsEtudiants]
            .filter(e => e.moyenne_generale > 0 && (e.decision === 'ADMIS' || e.decision === 'DÉROGÉ'))
            .sort((a, b) => b.moyenne_generale - a.moyenne_generale)
            .slice(0, 3)
            .map((e, index) => ({
                rang: index + 1,
                nom: e.nom,
                prenoms: e.prenoms,
                matricule: e.matricule_iipea,
                moyenne: e.moyenne_generale,
                filiere: e.filiere_nom || 'N/A',
                niveau: e.niveau_libelle || 'N/A',
                photo_url: e.photo_url || null
            }));

        const moyenneGenerale = totalAvecMoyenne > 0 ? sommeMoyennes / totalAvecMoyenne : 0;
        const tauxReussite = resultatsEtudiants.length > 0 
            ? parseFloat(((totalAdmis / resultatsEtudiants.length) * 100).toFixed(2)) 
            : 0;

        res.json({
            success: true,
            total_etudiants: resultatsEtudiants.length,
            semestre: semestreId || null,
            stats: {
                admis: totalAdmis,
                ajournes: totalAjournes,
                total_ecue_a_reprendre: totalECUEAReprendre,
                etudiants_a_reprendre: totalEtudiantsAReprendre,
                moyenne_generale: parseFloat(moyenneGenerale.toFixed(2)),
                taux_reussite: tauxReussite
            },
            top3: top3,
            etudiants: resultatsEtudiants.map(e => ({
                id: e.id,
                nom: e.nom,
                prenoms: e.prenoms,
                matricule: e.matricule_iipea,
                moyenne: e.moyenne_generale,
                filiere: e.filiere_nom || 'N/A',
                niveau: e.niveau_libelle || 'N/A',
                photo_url: e.photo_url || null,
                decision: e.decision,
                eligible_classe_superieure: e.eligible_classe_superieure
            })),
            filieres: filieresResult.rows,
            niveaux: niveauxResult.rows,
            annees: anneeResult.rows,
            date_generation: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Erreur statistiques résultats:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Erreur lors du calcul des statistiques', 
            details: error.message 
        });
    }
};

/**
 * Récapitulatif agrégé par Filière + Niveau (léger : pas de retour des 7000 étudiants,
 * uniquement des compteurs). Supporte le filtre semestre.
 * ✅ traiterUnGroupe résout désormais la maquette par combo filière/niveau réel
 * ✅ determinerDecisionFonction exige désormais moyenne >= 10 pour DÉROGÉ
 */
exports.getRecapFiliereNiveau = async (req, res) => {
    try {
        const { filiereId, niveauId, anneeAcademiqueId, semestreId } = req.query;
        console.log(`📋 Récap Filière/Niveau - filiereId: ${filiereId}, niveauId: ${niveauId}, annee: ${anneeAcademiqueId}, semestre: ${semestreId || 'annuel'}`);

        let query = `
            SELECT 
                e.id, e.groupe_id, e.niveau_id, e.id_filiere,
                f.nom as filiere_nom, f.sigle as filiere_sigle,
                n.libelle as niveau_libelle,
                g.nom as groupe_nom,
                COALESCE(niv2.libelle, '') as niveau_libelle_etudiant,
                tf.libelle as type_filiere
            FROM etudiant e
            LEFT JOIN filiere f ON f.id = e.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            LEFT JOIN niveau n ON n.id = e.niveau_id
            LEFT JOIN groupe g ON g.id = e.groupe_id
            LEFT JOIN niveau niv2 ON niv2.id = e.niveau_id
            WHERE e.standing = 'Inscrit'
        `;

        const params = [];
        let paramIndex = 1;

        if (filiereId) {
            query += ` AND e.id_filiere = $${paramIndex}`;
            params.push(filiereId);
            paramIndex++;
        }
        if (niveauId) {
            query += ` AND e.niveau_id = $${paramIndex}`;
            params.push(niveauId);
            paramIndex++;
        }
        if (anneeAcademiqueId) {
            query += ` AND e.annee_academique_id = $${paramIndex}`;
            params.push(anneeAcademiqueId);
            paramIndex++;
        }

        const result = await db.query(query, params);
        const etudiants = result.rows;

        if (etudiants.length === 0) {
            return res.json({ success: true, semestre: semestreId || null, recap: [], date_generation: new Date().toISOString() });
        }

        // Grouper par groupe pour le calcul académique (comme getStatsResultats)
        const groupesMap = new Map();
        for (const etudiant of etudiants) {
            if (!groupesMap.has(etudiant.groupe_id)) {
                groupesMap.set(etudiant.groupe_id, {
                    groupeId: etudiant.groupe_id,
                    groupeNom: etudiant.groupe_nom,
                    etudiants: []
                });
            }
            groupesMap.get(etudiant.groupe_id).etudiants.push(etudiant);
        }

        const groupesArray = Array.from(groupesMap.entries());
        const resultatsParGroupe = await Promise.all(
            groupesArray.map(([groupeId, groupeData]) => {
                const typeTraitement = determinerTypeTraitement(
                    groupeData.etudiants[0]?.type_filiere || 'Universitaire',
                    groupeData.groupeNom || ''
                );
                return traiterUnGroupe(groupeId, groupeData, typeTraitement, semestreId || null);
            })
        );

        // ✅ Agrégation par (Filière, Niveau) — on ne garde QUE les compteurs, pas les étudiants
        const recapMap = new Map();

        resultatsParGroupe.forEach(resultat => {
            resultat.etudiants.forEach(e => {
                const filiereNom = e.filiere_nom || 'N/A';
                const filiereSigle = e.filiere_sigle || '';
                const niveauLibelle = e.niveau_libelle || 'N/A';
                const cle = `${filiereNom}___${niveauLibelle}`;

                if (!recapMap.has(cle)) {
                    recapMap.set(cle, {
                        filiere: filiereNom,
                        filiere_sigle: filiereSigle,
                        niveau: niveauLibelle,
                        total: 0,
                        admis: 0,
                        ajournes: 0,
                        sommeMoyennes: 0,
                        totalAvecMoyenne: 0,
                        etudiants_a_reprendre: 0
                    });
                }

                const rec = recapMap.get(cle);
                rec.total += 1;
                // ✅ DÉROGÉ compte comme admis
                if (e.decision === 'ADMIS' || e.decision === 'DÉROGÉ') rec.admis += 1;
                else rec.ajournes += 1;
                if (e.moyenne_generale > 0) {
                    rec.sommeMoyennes += e.moyenne_generale;
                    rec.totalAvecMoyenne += 1;
                }
                if (e.ecue_a_reprendre && e.ecue_a_reprendre.length > 0) {
                    rec.etudiants_a_reprendre += 1;
                }
            });
        });

        const recap = Array.from(recapMap.values())
            .map(r => ({
                filiere: r.filiere,
                filiere_sigle: r.filiere_sigle,
                niveau: r.niveau,
                total: r.total,
                admis: r.admis,
                ajournes: r.ajournes,
                etudiants_a_reprendre: r.etudiants_a_reprendre,
                taux_reussite: r.total > 0 ? parseFloat(((r.admis / r.total) * 100).toFixed(2)) : 0,
                moyenne_generale: r.totalAvecMoyenne > 0 ? parseFloat((r.sommeMoyennes / r.totalAvecMoyenne).toFixed(2)) : 0
            }))
            .sort((a, b) => a.filiere.localeCompare(b.filiere) || a.niveau.localeCompare(b.niveau));

        res.json({
            success: true,
            semestre: semestreId || null,
            recap,
            date_generation: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Erreur récap filière/niveau:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors du calcul du récapitulatif', details: error.message });
    }
};