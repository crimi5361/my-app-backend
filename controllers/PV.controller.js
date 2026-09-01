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

// ============ ECUE À CHOIX MUTUELLEMENT EXCLUSIFS ============
// L'étudiant ne suit qu'une matière de la paire ; l'autre reste à 0 en base par absence
// d'évaluation, pas par échec (ex: Espagnol/Allemand). Comparaison insensible à la casse sur
// matiere.nom. Pour ajouter une nouvelle paire, l'ajouter ci-dessous.
const PAIRES_ECUE_CHOIX = [
    ['ESPAGNOL', 'ALLEMAND'],
];

const trouverPaireChoix = (nomMatiere) => {
    const nom = (nomMatiere || '').trim().toUpperCase();
    return PAIRES_ECUE_CHOIX.find(paire => paire.includes(nom)) || null;
};

// ✅ PERF : ces logs de diagnostic s'exécutent potentiellement plusieurs milliers de fois par
// requête (jusqu'à 2 fois par étudiant × 728 étudiants sur la page Statistiques). console.log
// est une écriture synchrone dès que stdout n'est pas un terminal interactif (cas de la
// production), ce qui contribue au blocage de l'Event Loop. Silencieux par défaut ; activable
// via DEBUG_PV_VERBOSE=true pour le diagnostic du repêchage crédits en développement.
const DEBUG_VERBOSE = process.env.DEBUG_PV_VERBOSE === 'true';

// ============ FONCTION UTILITAIRE POUR DÉTECTER LE TYPE DE TRAITEMENT ============

const determinerTypeTraitement = (typeFiliere, groupeNom) => {
    if (typeFiliere === 'Universitaire' || typeFiliere === 'universitaire') {
        return 'universitaire';
    }
    if (typeFiliere === 'Professionnelles' || typeFiliere === 'professionnelles') {
        if (groupeNom && groupeNom.toUpperCase().includes('LICENCE')) {
            if (DEBUG_VERBOSE) console.log(`🎓 Cas spécial: groupe professionnel "${groupeNom}" contient "Licence" → traitement universitaire`);
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
    if (DEBUG_VERBOSE) console.log(`🔍 estNiveauEligibleRepechage: texte="${texte}", semestre=${semestreId}, regex=${regex}, resultat=${resultat}`);
    return resultat;
};

/**
 * ✅ HARMONISATION FORCÉE : Peu importe la note (0, 2, 5, etc.), on remonte à 10
 */
const harmoniserVersMoyenneCibleForce = (matieres, cible = 10) => {
    const passthrough = (m) => ({
        ...m,
        moyenne_originale: m.moyenne,
        moyenne_affichage: m.moyenne,
        cc_original: m.moyenne_cc,
        examen_original: m.partiel,
        cc_affichage: m.moyenne_cc,
        examen_affichage: m.partiel,
        harmonisee: false,
        repechage_credits: false
    });

    // ✅ ECUE à choix exclues (non_classe) : ne participent jamais au repêchage forcé, ni comme
    // poids ni comme cible à recalculer.
    const matieresAvecNotes = matieres.filter(m => m.a_note && !m.non_classe);

    if (matieresAvecNotes.length === 0) {
        return matieres.map(passthrough);
    }

    const totalCoeff = matieresAvecNotes.reduce((sum, m) => sum + m.coefficient, 0);
    const sommeActuelle = matieresAvecNotes.reduce((sum, m) => sum + (m.moyenne * m.coefficient), 0);
    const moyenneActuelle = totalCoeff > 0 ? sommeActuelle / totalCoeff : 0;

    if (moyenneActuelle >= cible) {
        return matieres.map(passthrough);
    }

    const notesFaibles = matieresAvecNotes.filter(m => m.moyenne < cible);
    const coeffFaible = notesFaibles.reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0) {
        return matieres.map(passthrough);
    }

    const sommeNecessaire = cible * totalCoeff;
    const sommeRestante = sommeNecessaire - sommeActuelle;

    return matieres.map(m => {
        if (!m.a_note || m.non_classe) {
            return passthrough(m);
        }

        if (m.moyenne >= cible) {
            return passthrough(m);
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

    if (DEBUG_VERBOSE) console.log(`🔄 Repêchage forcé pour UE: ${ue.libelle} (${ue.moyenne})`);

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

    if (DEBUG_VERBOSE) console.log(`🔍 appliquerRepechageCredits - semestre: ${semestreId}, totalCreditsMaquette: ${totalCreditsMaquette}, niveau: "${niveauLibelle}", groupe: "${groupeNom}"`);

    if (!cfg.SEMESTRES_CONCERNES.includes(parseInt(semestreId, 10))) {
        if (DEBUG_VERBOSE) console.log(`❌ Repêchage non appliqué: semestre ${semestreId} non concerné`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    if (totalCreditsMaquette !== cfg.CREDITS_TOTAL_ATTENDU) {
        if (DEBUG_VERBOSE) console.log(`❌ Repêchage non appliqué: total crédits maquette ${totalCreditsMaquette} !== ${cfg.CREDITS_TOTAL_ATTENDU}`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    if (!estNiveauEligibleRepechage(niveauLibelle, groupeNom, semestreId)) {
        if (DEBUG_VERBOSE) console.log(`❌ Repêchage non appliqué: niveau non éligible`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    // ✅ FIX : Utiliser les crédits hybrides (ECUE-par-ECUE) au lieu du tout-ou-néant
    // Avant : ue.valide ? ue.credits : 0
    // Après : ue.credits_valides (qui contient déjà les crédits des ECUE validés individuellement)
    const creditsValidesActuels = uesAvecResultats.reduce(
        (sum, ue) => sum + (ue.credits_valides || 0), 0
    );

    if (DEBUG_VERBOSE) console.log(`📊 Crédits validés actuels (règle hybride): ${creditsValidesActuels}/${totalCreditsMaquette}`);

    const eligible = creditsValidesActuels >= cfg.CREDITS_MIN && creditsValidesActuels <= cfg.CREDITS_MAX;
    if (!eligible) {
        if (DEBUG_VERBOSE) console.log(`❌ Repêchage non appliqué: crédits ${creditsValidesActuels} hors plage [${cfg.CREDITS_MIN}-${cfg.CREDITS_MAX}]`);
        return { ues: uesAvecResultats, repechageApplique: false };
    }

    if (DEBUG_VERBOSE) console.log(`🎯 ✅ Repêchage crédits APPLIQUÉ (${creditsValidesActuels}/${totalCreditsMaquette}) pour semestre ${semestreId}`);

    const uesRepechees = uesAvecResultats.map(ue => {
        if (ue.valide) {
            return ue;
        }
        return forcerValidationUERepechage(ue);
    });

    const nouveauxCredits = uesRepechees.reduce((sum, ue) => sum + (ue.valide ? ue.credits : 0), 0);
    if (DEBUG_VERBOSE) console.log(`📊 Crédits après repêchage: ${nouveauxCredits}/${totalCreditsMaquette}`);

    return { ues: uesRepechees, repechageApplique: true };
};

// ============ REPÊCHAGE MOYENNE BTS (BTS 1 / BTS 2 UNIQUEMENT) ============

/**
 * ✅ REPÊCHAGE MOYENNE BTS — mécanisme totalement indépendant du repêchage crédits
 * ci-dessus (qui ne concerne que les Licences universitaires).
 *
 * Règle : pour un étudiant BTS 1/BTS 2 dont la moyenne générale (sur le périmètre
 * fourni — un semestre ou l'année) est comprise entre 8,00 et 9,99, on harmonise
 * AU STRICT MINIMUM les ECUE en échec (moyenne_pro < 10) pour que la moyenne
 * générale atteigne exactement 10,00 — jamais plus. `ACTIF: false` désactive
 * entièrement le mécanisme sans toucher au reste du code.
 */
const REPECHAGE_MOYENNE_BTS_CONFIG = {
    ACTIF: true,
    MOYENNE_MIN: 8,
    MOYENNE_MAX: 9.99,
    CIBLE: 10,
    NIVEAU_ELIGIBLE_REGEX: /\bbts\s*[12]\b/i
};

const estNiveauEligibleRepechageMoyenneBTS = (niveauLibelle, groupeNom) => {
    const texte = `${niveauLibelle || ''} ${groupeNom || ''}`;
    return REPECHAGE_MOYENNE_BTS_CONFIG.NIVEAU_ELIGIBLE_REGEX.test(texte);
};

/**
 * ✅ Note effective d'une ECUE pour le calcul de la moyenne générale professionnelle :
 * la note harmonisée BTS si elle existe, sinon moyenne_pro, sinon la moyenne brute.
 * (Même priorité que celle utilisée côté vues EJS pour l'affichage — voir Étape 5.)
 */
const getMoyenneEffectiveECUE = (matiere) => {
    if (matiere.moyenne_pro_affichage !== undefined && matiere.moyenne_pro_affichage !== null) {
        return matiere.moyenne_pro_affichage;
    }
    if (matiere.moyenne_pro !== undefined && matiere.moyenne_pro !== null) {
        return matiere.moyenne_pro;
    }
    return matiere.moyenne;
};

/**
 * Somme pondérée (par coefficient) et coefficient total des ECUE notées d'un
 * ensemble d'UE — brique de base pour calculer une moyenne "à plat" (voir analyse :
 * pour le professionnel, ue.credits = somme des coefficients de ses ECUE, donc la
 * moyenne pondérée par UE équivaut exactement à la moyenne pondérée par ECUE).
 *
 * ✅ Exclut les ECUE à choix non suivies (non_classe — ex. Espagnol/Allemand, voir
 * PAIRES_ECUE_CHOIX), exactement comme calculerTotauxFonction/calculerResultatsUEAvecDetailsFonction
 * les exclut de la moyenne officielle : sans ce filtre, coeffCible ci-dessous compterait un total
 * de coefficients supérieur à celui réellement utilisé par la moyenne affichée.
 */
const _sommeEtCoeffECUE = (ues) => {
    let somme = 0;
    let coeff = 0;
    (ues || []).forEach(ue => (ue.matieres || []).forEach(m => {
        if (m.a_note && !m.non_classe) {
            somme += getMoyenneEffectiveECUE(m) * m.coefficient;
            coeff += m.coefficient;
        }
    }));
    return { somme, coeff };
};

/**
 * ✅ REPÊCHAGE ANNUEL BTS (BTS 1 / BTS 2 uniquement) — VERSION INDÉPENDANTE DE LA MAQUETTE.
 *
 * ⚠️ Cette fonction ne calcule JAMAIS une moyenne "à plat" sur les coefficients cumulés des
 * deux semestres — cette ancienne approche divergeait de la règle officielle dès que les
 * maquettes S1/S2 n'avaient pas exactement le même total de coefficients (ex. 16/18, 25/11),
 * laissant la moyenne annuelle officiellement affichée bloquée à 9,95/9,98 au lieu de 10,00.
 *
 * RÈGLE UNIQUE (celle utilisée partout ailleurs — PV, bulletins, décisions) :
 *
 *   moyenneAnnuelle = (moyenneS1 + moyenneS2) / 2
 *
 * moyenneS1/moyenneS2 sont calculées via calculerTotauxFonction — LA MÊME fonction que celle
 * utilisée en aval pour l'affichage officiel — jamais un recalcul parallèle. Ainsi la décision
 * d'éligibilité porte exactement sur la valeur qui sera ensuite affichée/décidée.
 *
 * - moyenneAnnuelle >= 10  → ADMIS, aucune note modifiée.
 * - moyenneAnnuelle < 8    → AJOURNÉ, aucun repêchage.
 * - 8 <= moyenneAnnuelle < 10 → éligible : on identifie le semestre le plus faible (celui
 *   ayant la plus petite moyenne), et on calcule sa CIBLE — Cible = 2×10 − MoyenneAutreSemestre
 *   — indépendante de tout total de coefficients, donc valable identiquement quelle que soit
 *   la répartition de la maquette. Les points manquants sur ce semestre
 *   ((Cible − MoyenneSemestre) × TotalCoefficientsDuSemestre) sont ensuite répartis, comme
 *   avant, uniquement sur les ECUE en échec de CE SEUL semestre, proportionnellement à leur
 *   coefficient.
 *
 * Preuve d'atteignabilité : l'éligibilité impose moyenneAnnuelle < 10, donc
 * MoyenneAutreSemestre >= moyenneAnnuelle >= 8 (l'autre semestre est toujours le plus fort ou
 * égal), donc Cible = 20 − MoyenneAutreSemestre <= 12 — toujours largement atteignable, quelle
 * que soit la maquette.
 *
 * L'autre semestre n'est JAMAIS modifié. Ne mute jamais les tableaux reçus (retourne de
 * nouveaux tableaux uesS1/uesS2), comme appliquerRepechageCredits.
 *
 * ⚠️ Arrondi PAR EXCÈS (Math.ceil) sur les valeurs harmonisées uniquement : un double
 * arrondi (ECUE puis UE) au plus proche pourrait laisser la moyenne finale à 9,99 au
 * lieu de 10,00 dans de rares cas limites. L'arrondi par excès garantit ≥10,00 de
 * façon fiable, au prix d'un dépassement négligeable (≤0,01 point).
 */
const appliquerRepechageAnnuelBTS = (uesS1, uesS2, typeTraitement, niveauLibelle, groupeNom) => {
    const cfg = REPECHAGE_MOYENNE_BTS_CONFIG;
    const resultatInchange = { uesS1, uesS2, repechageApplique: false, semestreHarmonise: null };

    if (!cfg.ACTIF || typeTraitement !== 'professionnel') return resultatInchange;
    if (!estNiveauEligibleRepechageMoyenneBTS(niveauLibelle, groupeNom)) return resultatInchange;

    // ✅ Moyennes semestrielles OFFICIELLES — calculerTotauxFonction est la même fonction que
    // celle utilisée par le PV et les bulletins (via calculerRecapitulatifComplet). Aucun
    // recalcul parallèle, aucune formule différente. Le 3e argument (totalCreditsMaquette)
    // n'intervient pas dans moyenneGenerale pour le traitement 'professionnel' (0 accepté).
    const moyenneS1 = calculerTotauxFonction(uesS1, typeTraitement, 0).moyenneGenerale;
    const moyenneS2 = calculerTotauxFonction(uesS2, typeTraitement, 0).moyenneGenerale;

    // ✅ RÈGLE OFFICIELLE UNIQUE (calculerMoyenneAnnuelleDepuisSemestres) : la seule définition
    // de la moyenne annuelle dans tout le système, ici comme partout ailleurs.
    const moyenneAnnuelle = calculerMoyenneAnnuelleDepuisSemestres(moyenneS1, moyenneS2);
    if (DEBUG_VERBOSE) console.log(`🎓 appliquerRepechageAnnuelBTS: moyenne annuelle officielle=${moyenneAnnuelle.toFixed(2)} (S1=${moyenneS1.toFixed(2)}, S2=${moyenneS2.toFixed(2)}), niveau="${niveauLibelle}", groupe="${groupeNom}"`);

    // ✅ Décision UNIQUEMENT sur la moyenne annuelle officielle : déjà admis (>=10) ou hors
    // plage de repêchage (<8) → on ne touche à rien.
    if (moyenneAnnuelle < cfg.MOYENNE_MIN || moyenneAnnuelle >= cfg.CIBLE) {
        return resultatInchange;
    }

    // ✅ Semestre le plus faible = celui à harmoniser (règle inchangée).
    const cibleEstS1 = moyenneS1 <= moyenneS2;
    const uesCible = cibleEstS1 ? uesS1 : uesS2;
    const moyenneCible = cibleEstS1 ? moyenneS1 : moyenneS2;
    const moyenneAutre = cibleEstS1 ? moyenneS2 : moyenneS1;

    const { coeff: coeffCible } = _sommeEtCoeffECUE(uesCible);
    if (coeffCible === 0) return resultatInchange;

    const matieresCible = [];
    uesCible.forEach(ue => (ue.matieres || []).forEach(m => { if (m.a_note && !m.non_classe) matieresCible.push(m); }));

    const coeffFaible = matieresCible
        .filter(m => getMoyenneEffectiveECUE(m) < cfg.CIBLE)
        .reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0) {
        // Ne devrait pas arriver si le semestre ciblé a une moyenne < 10, mais on reste défensif.
        return resultatInchange;
    }

    // ✅ Cible du semestre faible — indépendante de toute répartition de coefficients entre
    // semestres : Cible = 2×10 − MoyenneAutreSemestre. Puis points manquants sur CE semestre
    // uniquement, à répartir (mécanique inchangée) sur ses ECUE en échec.
    const cibleSemestre = 2 * cfg.CIBLE - moyenneAutre;
    const pointsManquants = (cibleSemestre - moyenneCible) * coeffCible;

    if (DEBUG_VERBOSE) console.log(`🎯 ✅ Repêchage annuel BTS APPLIQUÉ sur le semestre ${cibleEstS1 ? 1 : 2} (moyenne annuelle ${moyenneAnnuelle.toFixed(2)} → cible du semestre ${cibleSemestre.toFixed(2)})`);

    const uesCibleHarmonisees = uesCible.map(ue => {
        const matieresHarmonisees = (ue.matieres || []).map(matiere => {
            const moyenneEffective = getMoyenneEffectiveECUE(matiere);
            if (!matiere.a_note || moyenneEffective >= cfg.CIBLE) {
                return matiere;
            }

            const augmentation = pointsManquants * (matiere.coefficient / coeffFaible);
            const nouvelleMoyenne = Math.min(20, moyenneEffective + (augmentation / matiere.coefficient));

            return {
                ...matiere,
                moyenne_pro_originale: moyenneEffective,
                moyenne_pro_affichage: Math.min(20, Math.ceil(nouvelleMoyenne * 100) / 100),
                harmonisee_bts: true
            };
        });

        const matieresNotees = matieresHarmonisees.filter(m => m.a_note && !m.non_classe);
        const coeffUE = matieresNotees.reduce((sum, m) => sum + m.coefficient, 0);
        const sommeUE = matieresNotees.reduce((sum, m) => sum + (getMoyenneEffectiveECUE(m) * m.coefficient), 0);
        const moyenneUEHarmonisee = coeffUE > 0 ? sommeUE / coeffUE : (ue.moyenne_affichage ?? ue.moyenne ?? 0);

        return {
            ...ue,
            moyenne_affichage: Math.ceil(moyenneUEHarmonisee * 100) / 100,
            matieres: matieresHarmonisees
        };
    });

    return cibleEstS1
        ? { uesS1: uesCibleHarmonisees, uesS2, repechageApplique: true, semestreHarmonise: 1 }
        : { uesS1, uesS2: uesCibleHarmonisees, repechageApplique: true, semestreHarmonise: 2 };
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
            // ✅ Rang académique réel (classement par moyenne générale), calculé AVANT le tri
            // d'affichage ci-dessous — le rang ne doit jamais dépendre de l'ordre d'affichage.
            // Identique au calcul d'avant (position après tri par moyenne décroissante).
            [...resultatsEtudiants]
                .sort((a, b) => b.moyenne_generale - a.moyenne_generale)
                .forEach((etudiant, index) => { etudiant.rang = index + 1; });

            // ✅ PV filières professionnelles : ordre d'AFFICHAGE alphabétique (Nom puis Prénoms),
            // plus pratique pour la consultation. Le N° de ligne suit cet ordre ; le RANG ci-dessus
            // reste le classement académique réel, affiché séparément.
            resultatsEtudiants.sort((a, b) => {
                const nomA = (a.nom || '').toLowerCase();
                const nomB = (b.nom || '').toLowerCase();
                if (nomA < nomB) return -1;
                if (nomA > nomB) return 1;
                const prenomsA = (a.prenoms || '').toLowerCase();
                const prenomsB = (b.prenoms || '').toLowerCase();
                if (prenomsA < prenomsB) return -1;
                if (prenomsA > prenomsB) return 1;
                return 0;
            });
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        res.json({
            success: true,
            groupe: construireGroupeAffichage(groupeInfo),
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
            // ✅ Rang académique réel (classement par moyenne générale), calculé AVANT le tri
            // d'affichage ci-dessous — le rang ne doit jamais dépendre de l'ordre d'affichage.
            // Identique au calcul d'avant (position après tri par moyenne décroissante).
            [...resultatsEtudiants]
                .sort((a, b) => b.moyenne_generale - a.moyenne_generale)
                .forEach((etudiant, index) => { etudiant.rang = index + 1; });

            // ✅ PV filières professionnelles : ordre d'AFFICHAGE alphabétique (Nom puis Prénoms),
            // plus pratique pour la consultation. Le N° de ligne suit cet ordre ; le RANG ci-dessus
            // reste le classement académique réel, affiché séparément.
            resultatsEtudiants.sort((a, b) => {
                const nomA = (a.nom || '').toLowerCase();
                const nomB = (b.nom || '').toLowerCase();
                if (nomA < nomB) return -1;
                if (nomA > nomB) return 1;
                const prenomsA = (a.prenoms || '').toLowerCase();
                const prenomsB = (b.prenoms || '').toLowerCase();
                if (prenomsA < prenomsB) return -1;
                if (prenomsA > prenomsB) return 1;
                return 0;
            });
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        console.log('✅ PV semestre généré avec succès');
        res.json({
            success: true,
            groupe: construireGroupeAffichage(groupeInfo),
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

// ✅ Extrait de genererPVByEtudiant : calcul pur (sans req/res), réutilisable par
// d'autres modules (ex: Réinscription) pour le contrôle académique d'un étudiant.
// Le handler HTTP ci-dessous ne fait plus qu'appeler cette fonction et sérialiser le résultat.
//
// ✅ FIX COHÉRENCE : cette fonction n'appliquait JAMAIS le repêchage crédits (contrairement au
// PV par groupe/semestre et au Bulletin, qui l'appliquent tous les deux), et ne passait pas par
// calculerRecapitulatifComplet — deux étudiants strictement identiques pouvaient donc afficher
// une moyenne/décision différente en Réinscription et au Bulletin. Elle reproduit désormais
// exactement la même séquence que afficherBulletinByMatricule (repêchage par semestre puis
// calculerRecapitulatifComplet), pour que Réinscription affiche toujours les mêmes chiffres que
// le Bulletin annuel du même étudiant.
// ✅ vue_position_academique (historique_inscription pour une année déjà quittée, position live
// pour l'année courante) : quand anneeAcademiqueId est fourni, résout l'étudiant pour CETTE année
// précisément — un étudiant réinscrit vers une année suivante reste retrouvable pour l'année qu'il
// a quittée (autrefois : 404 « Étudiant non trouvé », inscription_annuelle n'étant jamais alimentée
// par le flux de réinscription). Par défaut (paramètre omis), comportement inchangé : position
// actuelle de l'étudiant.
exports.calculerResultatsAnnuelsEtudiant = async (etudiantId, anneeAcademiqueId = null) => {
    let etudiant;
    if (anneeAcademiqueId) {
        const posQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
                   e.niveau_id, e.annee_academique_id, e.id_filiere,
                   n.libelle AS niveau_libelle,
                   e.statut_paiement AS statut_etudiant, e.curcus_id
            FROM vue_position_academique e
            LEFT JOIN niveau n ON n.id = e.niveau_id
            WHERE e.id = $1 AND e.annee_academique_id = $2
        `;
        const posResult = await db.query(posQuery, [etudiantId, anneeAcademiqueId]);
        if (posResult.rows.length === 0) {
            const notFound = new Error(`Étudiant ${etudiantId} non trouvé pour l'année académique ${anneeAcademiqueId}`);
            notFound.statusCode = 404;
            throw notFound;
        }
        etudiant = posResult.rows[0];
    } else {
        const etudiantQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
                   e.niveau_id, e.annee_academique_id, e.id_filiere,
                   n.libelle AS niveau_libelle,
                   s.statut_etudiant, e.curcus_id
            FROM etudiant e
            LEFT JOIN scolarite s ON s.id = e.scolarite_id
            LEFT JOIN niveau n ON n.id = e.niveau_id
            WHERE e.id = $1
        `;
        const etudiantResult = await db.query(etudiantQuery, [etudiantId]);
        if (etudiantResult.rows.length === 0) {
            const notFound = new Error(`Étudiant ${etudiantId} non trouvé`);
            notFound.statusCode = 404;
            throw notFound;
        }
        etudiant = etudiantResult.rows[0];
    }

    const groupeQuery = `
        SELECT g.id, g.nom, g.est_primaire, cl.nom as classe_nom,
               f.nom as filiere, f.sigle, tf.libelle as type_filiere
        FROM groupe g
        LEFT JOIN classe cl ON cl.id = g.classe_id
        LEFT JOIN filiere f ON f.id = $2
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        WHERE g.id = $1
    `;
    const groupeResult = await db.query(groupeQuery, [etudiant.groupe_id, etudiant.id_filiere]);
    const groupeInfo = groupeResult.rows[0];

    const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);

    // ✅ Parcours JOUR/SOIR : résout le libellé exact (curcus.type_parcours) pour désambiguïser
    // la maquette quand plusieurs existent pour cette filière+niveau — null pour tout étudiant
    // sans curcus_id, comportement alors strictement identique à avant.
    let parcourLibelle = null;
    if (etudiant.curcus_id) {
        const curcusResult = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [etudiant.curcus_id]);
        parcourLibelle = curcusResult.rows[0]?.type_parcours || null;
    }

    // ✅ Résolution DIRECTE via la filière/niveau propre de l'étudiant (plus via son groupe)
    const structureAcademique = await getStructureAcademiqueParFiliereNiveau(etudiant.id_filiere, etudiant.niveau_id, null, parcourLibelle);

    const notes = await getNotesEtudiantAvecDetailsFonction(etudiantId, structureAcademique.maquette_id);

    let uesAvecResultats = [];
    for (const ue of structureAcademique.ues) {
        const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
        uesAvecResultats.push(resultatsUE);
    }

    // ✅ Repêchage appliqué séparément par semestre, exactement comme le PV et le Bulletin
    const uesS1Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
    const uesS2Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);
    const totalCreditsS1Brut = uesS1Brutes.reduce((sum, ue) => sum + ue.credits, 0);
    const totalCreditsS2Brut = uesS2Brutes.reduce((sum, ue) => sum + ue.credits, 0);

    const { ues: uesS1Repechees } = appliquerRepechageCredits(
        uesS1Brutes, totalCreditsS1Brut, 1, etudiant.niveau_libelle, groupeInfo.nom
    );
    const { ues: uesS2Repechees } = appliquerRepechageCredits(
        uesS2Brutes, totalCreditsS2Brut, 2, etudiant.niveau_libelle, groupeInfo.nom
    );

    const uesS1Map = new Map(uesS1Repechees.map(ue => [ue.ue_id, ue]));
    const uesS2Map = new Map(uesS2Repechees.map(ue => [ue.ue_id, ue]));

    uesAvecResultats = uesAvecResultats.map(ue =>
        parseInt(ue.semestre_id, 10) === 1
            ? (uesS1Map.get(ue.ue_id) || ue)
            : (uesS2Map.get(ue.ue_id) || ue)
    );

    // ✅ SOURCE UNIQUE DE VÉRITÉ pour crédits/moyennes/décisions S1, S2, annuel — identique au Bulletin
    // (niveauLibelle/groupeNom transmis pour que le repêchage annuel BTS s'applique ici aussi —
    // une décision AJOURNÉ/ADMIS erronée à cet endroit fausserait la fiche de réinscription).
    const recap = calculerRecapitulatifComplet(uesAvecResultats, typeTraitement, etudiant.niveau_libelle, groupeInfo.nom);

    const aSoldeScolarite = (etudiant.statut_etudiant || '').toUpperCase() === 'SOLDE';
    // ✅ typeTraitement transmis ici (contrairement aux autres appels de cette fonction, laissés
    // inchangés hors périmètre de cette correction) : ce résultat alimente exclusivement la fiche
    // de réinscription, où l'affichage de rattrapages BTS/Pro n'a aucun sens (cf. determinerDecisionFonction).
    const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats, typeTraitement);

    return {
        etudiant: { id: etudiant.id, matricule_iipea: etudiant.matricule_iipea, nom: etudiant.nom, prenoms: etudiant.prenoms, niveau_id: etudiant.niveau_id },
        groupe: construireGroupeAffichage(groupeInfo),
        type_filiere: groupeInfo.type_filiere,
        type_traitement: typeTraitement,
        moyenne_generale: recap.annuel.moyenne,
        credits_valides: recap.annuel.creditsValides,
        credits_total: recap.annuel.creditsTotal,
        decision: recap.annuel.decision,
        moyenne_s1: recap.s1.moyenne,
        credits_s1: recap.s1.creditsValides,
        credits_s1_total: recap.s1.creditsTotal,
        decision_s1: recap.s1.decision,
        moyenne_s2: recap.s2.moyenne,
        credits_s2: recap.s2.creditsValides,
        credits_s2_total: recap.s2.creditsTotal,
        decision_s2: recap.s2.decision,
        ues: uesAvecResultats,
        ecue_a_reprendre: ecueAReprendre,
        scolarite_soldee: aSoldeScolarite,
        statut_etudiant: etudiant.statut_etudiant || 'NON_DEFINI',
        date_generation: new Date().toISOString()
    };
};

exports.genererPVByEtudiant = async (req, res) => {
    try {
        const { etudiantId } = req.params;
        const { anneeAcademiqueId } = req.query;
        console.log(`🎓 Génération PV pour étudiant: ${etudiantId}${anneeAcademiqueId ? `, année: ${anneeAcademiqueId}` : ''}`);
        const resultats = await exports.calculerResultatsAnnuelsEtudiant(etudiantId, anneeAcademiqueId || null);
        console.log('✅ PV étudiant généré avec succès');
        res.json({ success: true, ...resultats });
    } catch (error) {
        if (error.statusCode === 404) {
            return res.status(404).json({ success: false, error: error.message });
        }
        console.error('❌ Erreur génération PV étudiant:', error.message);
        res.status(500).json({ success: false, error: 'Erreur lors de la génération du PV étudiant', details: error.message });
    }
};

// ============ FONCTIONS INTERNES ============

// Chantier 11 (2026-08-04) — sous-phase 2 : construit l'objet "groupe" tel qu'envoyé aux
// templates/JSON (PV, Bulletins). Ne JAMAIS utiliser cette fonction pour la logique métier
// (determinerTypeTraitement, appliquerRepechageCredits, etc.) — ces fonctions continuent de lire
// groupeInfo.nom directement, en amont, sur la donnée brute non filtrée : la logique doit
// toujours connaître le vrai groupe de l'étudiant, seul l'AFFICHAGE final masque le Groupe
// primaire. Attend un objet source contenant nom/est_primaire/classe_nom/annee_academique (les
// champs absents restent simplement absents du résultat, sans erreur).
function construireGroupeAffichage(groupeInfo) {
  return {
    id: groupeInfo.id,
    nom: groupeInfo.est_primaire ? null : groupeInfo.nom,
    classe: groupeInfo.classe_nom || null,
    annee_academique: groupeInfo.annee_academique,
  };
}

// ✅ vue_position_academique : le représentant du groupe est résolu qu'il soit encore
// aujourd'hui rattaché à ce groupe (position live) ou qu'il l'ait quitté depuis (position
// historique figée dans historique_inscription) — un groupe reste retrouvable même si tous ses
// membres d'origine ont depuis été réinscrits/promus ailleurs. Aucun paramètre année requis :
// un groupe appartient à une seule classe, elle-même rattachée à une seule année (g.classe_id →
// classe.annee_academique_id), donc déjà intrinsèquement daté.
const _getGroupeInfo = async (groupeId) => {
    const query = `
        SELECT g.id, g.nom, g.classe_id, g.est_primaire, cl.nom as classe_nom,
               rep.filiere, rep.sigle, rep.type_filiere, rep.annee_academique
        FROM groupe g
        LEFT JOIN classe cl ON cl.id = g.classe_id
        LEFT JOIN LATERAL (
            SELECT f.nom as filiere, f.sigle, tf.libelle as type_filiere, aa.annee as annee_academique
            FROM vue_position_academique e
            LEFT JOIN filiere f ON f.id = e.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
            WHERE e.groupe_id = g.id AND e.standing = 'Inscrit'
            LIMIT 1
        ) rep ON true
        WHERE g.id = $1
        LIMIT 1
    `;
    const result = await db.query(query, [groupeId]);
    return result.rows[0] || null;
};

// ✅ vue_position_academique : ramène TOUS les étudiants ayant un jour appartenu à ce groupe
// (position live pour ceux qui y sont toujours, position historique figée pour ceux qui l'ont
// quitté depuis une réinscription) — plus besoin d'un second bloc de repli, la vue couvre déjà
// les deux cas sans risque de doublon (UNION ALL interne déjà garanti sans chevauchement par
// vue_position_academique elle-même).
const _getEtudiantsGroupe = async (groupeId) => {
    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id,
               e.niveau_id, e.annee_academique_id, e.id_filiere,
               COALESCE(niv.libelle, '') as niveau_libelle,
               e.statut_paiement as statut_etudiant,
               e.curcus_id
        FROM vue_position_academique e
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
        ORDER BY n.etudiant_id, mat.ue_id, mat.id, n.id
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

    // Cache des structures académiques par combo (filiere_id, niveau_id, curcus_id) — le curcus
    // fait partie de la clé : deux étudiants de même filière+niveau mais de parcours JOUR/SOIR
    // différents ne doivent jamais partager la même maquette résolue.
    const structureParCombo = new Map();
    const curcusLibelleCache = new Map();
    const resoudreParcourLibelle = async (curcusId) => {
        if (!curcusId) return null;
        if (!curcusLibelleCache.has(curcusId)) {
            const r = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [curcusId]);
            curcusLibelleCache.set(curcusId, r.rows[0]?.type_parcours || null);
        }
        return curcusLibelleCache.get(curcusId);
    };
    const getStructurePourEtudiant = async (etudiant) => {
        const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}_${etudiant.curcus_id || ''}`;
        if (!structureParCombo.has(cle)) {
            const parcourLibelle = await resoudreParcourLibelle(etudiant.curcus_id);
            const structure = await getStructureAcademiqueParFiliereNiveau(etudiant.id_filiere, etudiant.niveau_id, null, parcourLibelle);
            structureParCombo.set(cle, structure);
        }
        return structureParCombo.get(cle);
    };

    // ✅ PERF : contrairement à traiterUnGroupe, cette boucle fait déjà un vrai await db.query()
    // par étudiant (getNotesEtudiantAvecDetailsFonction ci-dessous) et cède donc déjà la main à
    // l'Event Loop à chaque itération. Point de pause supplémentaire ajouté par cohérence/filet de
    // sécurité (groupes volumineux, requêtes très rapides depuis le pool) — aucun changement de
    // logique métier.
    let _yieldCounterPV = 0;
    for (const etudiant of etudiants) {
        if (++_yieldCounterPV % 25 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
        if (DEBUG_VERBOSE) {
            console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms}`);
            console.log(`📊 niveau_libelle: "${etudiant.niveau_libelle}", groupeNom: "${groupeNom}"`);
        }

        // ✅ Structure académique COMPLÈTE (annuelle) propre à l'étudiant
        const structureAcademique = await getStructurePourEtudiant(etudiant);
        const totalCreditsMaquette = calculerTotalCreditsMaquette(structureAcademique.ues);

        const uesS1Def = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 1);
        const uesS2Def = structureAcademique.ues.filter(ue => parseInt(ue.semestre_id, 10) === 2);
        const totalCreditsS1 = uesS1Def.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);
        const totalCreditsS2 = uesS2Def.reduce((sum, ue) => sum + ue.matieres.reduce((s, m) => s + m.coefficient, 0), 0);

        const semestreNumDemande = semestreId ? parseInt(semestreId, 10) : null;

        const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

        // ✅ On calcule TOUJOURS les résultats des DEUX semestres, même si un seul est demandé à
        // l'affichage : le repêchage BTS ne peut être décidé qu'à partir de la moyenne ANNUELLE
        // (S1+S2), jamais d'un semestre isolé.
        let uesAvecResultats = [];
        for (const ue of structureAcademique.ues) {
            const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
            uesAvecResultats.push(resultatsUE);
        }

        const uesS1Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
        const uesS2Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

        // Repêchage crédits (Licence universitaire uniquement — no-op pour le professionnel)
        const { ues: uesS1ApresCredits } = appliquerRepechageCredits(
            uesS1Resultats, totalCreditsS1 || 30, 1, etudiant.niveau_libelle, groupeNom
        );
        const { ues: uesS2ApresCredits } = appliquerRepechageCredits(
            uesS2Resultats, totalCreditsS2 || 30, 2, etudiant.niveau_libelle, groupeNom
        );

        // ✅ Repêchage annuel BTS : décision et harmonisation basées UNIQUEMENT sur la
        // moyenne annuelle — no-op pour tout ce qui n'est pas BTS 1/2 professionnel.
        const { uesS1: uesS1Final, uesS2: uesS2Final } = appliquerRepechageAnnuelBTS(
            uesS1ApresCredits, uesS2ApresCredits, typeTraitement, etudiant.niveau_libelle, groupeNom
        );

        uesAvecResultats = [...uesS1Final, ...uesS2Final];

        // ✅ Périmètre affiché/compté : le semestre demandé, ou l'année complète —
        // mais toujours à partir des UE déjà (éventuellement) repêchées ci-dessus.
        const uesPourAffichage = semestreNumDemande
            ? uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === semestreNumDemande)
            : uesAvecResultats;

        const totalCreditsPourTotaux = semestreNumDemande
            ? uesPourAffichage.reduce((sum, ue) => sum + ue.credits, 0)
            : totalCreditsMaquette;

        let totaux;
        if (semestreNumDemande) {
            // Un seul semestre en jeu : pas de moyenne annuelle à dériver.
            totaux = calculerTotauxFonction(uesPourAffichage, typeTraitement, totalCreditsPourTotaux);
        } else {
            // ✅ RÈGLE MÉTIER OFFICIELLE : moyenne annuelle = (Moyenne S1 + Moyenne S2) / 2
            // à partir des moyennes semestrielles déjà arrondies — jamais un recalcul
            // indépendant "à plat" sur les UE de l'année (source unique de vérité,
            // identique à calculerRecapitulatifComplet côté Bulletins).
            const uesS1PourTotaux = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
            const uesS2PourTotaux = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);
            const creditsS1PourTotaux = uesS1PourTotaux.reduce((sum, ue) => sum + ue.credits, 0);
            const creditsS2PourTotaux = uesS2PourTotaux.reduce((sum, ue) => sum + ue.credits, 0);
            const totauxS1PourAnnuel = calculerTotauxFonction(uesS1PourTotaux, typeTraitement, creditsS1PourTotaux);
            const totauxS2PourAnnuel = calculerTotauxFonction(uesS2PourTotaux, typeTraitement, creditsS2PourTotaux);

            totaux = {
                ...calculerTotauxFonction(uesPourAffichage, typeTraitement, totalCreditsPourTotaux),
                moyenneGenerale: calculerMoyenneAnnuelleDepuisSemestres(totauxS1PourAnnuel.moyenneGenerale, totauxS2PourAnnuel.moyenneGenerale)
            };
        }

        // ✅ UTILISER LA NOUVELLE FONCTION DE DÉCISION
        const decision = determinerDecisionFonction(
            totaux.creditsValides, totaux.creditsTotal, typeTraitement,
            totaux.moyenneGenerale, totaux.uesAvecNotes
        );

        // ✅ DÉCISION DU JURY (ANNUELLE) — exposée même en vue "un seul semestre", pour que le PV
        // n'affiche jamais une décision différente de celle du Bulletin pour le même étudiant.
        // uesAvecResultats est déjà repêché (crédits + BTS annuel) sur l'année complète ci-dessus ;
        // calculerRecapitulatifComplet est donc appelé sur ce même tableau — appliquerRepechageAnnuelBTS
        // est idempotent (une moyenne annuelle déjà ≥10 n'est jamais réharmonisée), donc aucun risque
        // de double-harmonisation.
        let decisionJury = decision;
        let moyenneAnnuelle = totaux.moyenneGenerale;
        let creditsAnnuelsValides = totaux.creditsValides;
        let creditsAnnuelsTotal = totaux.creditsTotal;
        if (semestreNumDemande) {
            const recapAnnuel = calculerRecapitulatifComplet(uesAvecResultats, typeTraitement, etudiant.niveau_libelle, groupeNom);
            decisionJury = recapAnnuel.annuel.decision;
            moyenneAnnuelle = recapAnnuel.annuel.moyenne;
            creditsAnnuelsValides = recapAnnuel.annuel.creditsValides;
            creditsAnnuelsTotal = recapAnnuel.annuel.creditsTotal;
        }

        const aSoldeScolarite = (etudiant.statut_etudiant || '').toUpperCase() === 'SOLDE';
        const ecueAReprendre = _collecterEcueAReprendre(uesPourAffichage, typeTraitement);

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
            decision_jury: decisionJury,
            moyenne_annuelle: moyenneAnnuelle,
            credits_annuels: creditsAnnuelsValides,
            credits_annuels_total: creditsAnnuelsTotal,
            ues: uesPourAffichage,
            scolarite_soldee: aSoldeScolarite,
            statut_etudiant: etudiant.statut_etudiant || 'NON_DEFINI',
            ecue_a_reprendre: ecueAReprendre
        });
    }

    return { resultatsEtudiants, etudiantsAReprendre };
};

// ✅ En BTS/filière professionnelle (hors Licence Pro, déjà basculée en 'universitaire' par
// determinerTypeTraitement), la décision ne se joue que sur la moyenne générale ≥ 10 — il
// n'existe aucune notion de rattrapage par UE/ECUE dans ce cas, contrairement au traitement
// universitaire. Filtré ici, à la source unique, pour que tous les consommateurs (fiche de
// réinscription notamment) héritent automatiquement de la bonne règle sans la dupliquer.
const _collecterEcueAReprendre = (uesAvecResultats, typeTraitement) => {
    if (typeTraitement === 'professionnel') return [];
    const ecueAReprendre = [];
    uesAvecResultats.forEach(ue => {
        if (!ue.valide) {
            ue.matieres.forEach(matiere => {
                const moyenneOriginale = matiere.harmonisee ? matiere.moyenne_originale : matiere.moyenne;
                if (matiere.a_note && !matiere.non_classe && moyenneOriginale < 10) {
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
 *
 * ✅ CORRECTIF (2026-08-28) — bug "maquette JOUR affichée pour un groupe/parcours SOIR" :
 * l'ancienne requête résolvait la maquette par un simple JOIN filiere_id+niveau_id SANS filtrer
 * par parcours (curcus), avec `ORDER BY mq.id LIMIT 1` — pour une filière/niveau ayant une
 * maquette JOUR (non vide) et aucune maquette SOIR, ce LIMIT 1 arbitraire choisissait la maquette
 * JOUR même pour l'en-tête d'un groupe SOIR. Délègue désormais à
 * getStructureAcademiqueParFiliereNiveau (source unique déjà correcte, utilisée par le calcul
 * réel des résultats — aucune nouvelle logique créée), après avoir résolu le parcours réel du
 * groupe depuis un étudiant représentant (curcus.type_parcours). Jamais de repli vers un autre
 * parcours : une maquette absente/vide pour CE parcours précis renvoie désormais une structure
 * vide (ues: []), cohérente avec le corps du document — pas plus de matières qu'avant pour les
 * groupes déjà corrects (une seule maquette pour leur filière/niveau), structure vide (au lieu de
 * la maquette d'un autre parcours) pour les groupes affectés par le bug.
 */
const getStructureAcademiqueFonction = async (groupeId, semestreId = null) => {
    const representant = await _resoudreParcourGroupe(db, groupeId);
    if (!representant) {
        return { maquette_id: null, parcour: null, ues: [] };
    }
    return getStructureAcademiqueParFiliereNiveau(
        representant.filiereId, representant.niveauId, semestreId, representant.parcourLibelle
    );
};

/**
 * ✅ NOUVEAU (2026-08-28), CORRIGÉ (2026-08-30) — résout le parcours RÉEL d'un groupe OU d'une
 * classe à partir de SES étudiants réellement inscrits (curcus.type_parcours), pour alimenter
 * getStructureAcademiqueParFiliereNiveau sans jamais deviner le parcours par un texte (nom de
 * groupe/classe). Centralisé ici pour être appelé IDENTIQUEMENT par getStructureAcademiqueFonction
 * (en-tête PV), exports.getStructureGroupe ("Nouvelle Note → Importation des notes") ET
 * exports.getStructureClasse ("Gestion des maquettes" / DetailClasse.tsx, qui appelait auparavant
 * une copie de cette même requête, désormais retirée) — un seul point de résolution, jamais deux
 * logiques divergentes.
 *
 * ✅ CORRECTIF (2026-08-30) — bug réel "GBAT LICENCE 3 PRO SOIR affiche la maquette JOUR" : la
 * version précédente ne triait QUE par (id_filiere, niveau_id) — deux colonnes identiques pour
 * TOUS les étudiants d'un même groupe/classe par construction — ce qui revenait en pratique à un
 * LIMIT 1 sans aucun tri déterministe : l'étudiant "représentant" choisi dépendait de l'ordre de
 * lecture disque de Postgres, pas d'un critère métier. Pour le groupe 163 (GBAT L3 PRO SOIR,
 * 2 étudiants curcus "Professionnel jour" / 17 "Professionnel soir" — placement individuel
 * incohérent avec leur groupe, cf. rapport), ce tirage arbitraire retombait sur un des 2 étudiants
 * "jour" et résolvait donc la maquette JOUR pour tout le groupe SOIR.
 *
 * Corrigé en un VOTE MAJORITAIRE parmi les étudiants réellement inscrits dans le groupe/la classe :
 * le parcours retenu est celui du plus grand nombre d'étudiants 'Inscrit' à cet instant — une
 * minorité d'étudiants mal placés (donnée à corriger séparément, jamais ici) ne peut plus, à elle
 * seule, faire basculer la maquette résolue pour tout le groupe. Aucun repli vers un autre
 * parcours, une autre année ou une autre filière : si aucun étudiant n'est inscrit, `null`.
 */
const _resoudreParcourGroupeOuClasse = async (dbClient, { groupeId = null, classeId = null } = {}) => {
    const params = [];
    let whereGroupe;
    if (groupeId) {
        params.push(groupeId);
        whereGroupe = `e.groupe_id = $${params.length}`;
    } else if (classeId) {
        params.push(classeId);
        whereGroupe = `e.groupe_id IN (SELECT id FROM groupe WHERE classe_id = $${params.length})`;
    } else {
        return null;
    }
    const result = await dbClient.query(`
        SELECT e.id_filiere, e.niveau_id, c.type_parcours AS parcour, COUNT(*) AS nb_etudiants
        FROM vue_position_academique e
        LEFT JOIN curcus c ON c.id = e.curcus_id
        WHERE ${whereGroupe} AND e.standing = 'Inscrit'
        GROUP BY e.id_filiere, e.niveau_id, c.type_parcours
        ORDER BY nb_etudiants DESC, c.type_parcours ASC NULLS LAST
        LIMIT 1
    `, params);
    if (result.rows.length === 0) return null;
    return {
        filiereId: result.rows[0].id_filiere,
        niveauId: result.rows[0].niveau_id,
        parcourLibelle: result.rows[0].parcour,
    };
};

// Conservé sous son nom d'origine — appelé par getStructureAcademiqueFonction et
// exports.getStructureGroupe, inchangé pour ces deux appelants (même signature, même résultat).
const _resoudreParcourGroupe = async (dbClient, groupeId) =>
    _resoudreParcourGroupeOuClasse(dbClient, { groupeId });

/**
 * ✅ RÉSOLUTION CORRECTE DE LA MAQUETTE
 * Résout la structure académique DIRECTEMENT à partir de la filière et du niveau
 * réels d'un étudiant (ou d'un combo filière/niveau), jamais via un représentant
 * arbitraire d'un groupe. C'est la fonction à utiliser pour tout calcul de
 * résultats (PV, bulletin, stats, récap).
 */
// ✅ Parcours JOUR/SOIR : quand un même filiere_id+niveau_id a plusieurs maquettes (une par
// curcus, ex. "Professionnel jour" / "Professionnel soir"), parcourLibelle (texte identique à
// maquette.parcour/curcus.type_parcours) permet de résoudre la BONNE maquette au lieu d'un
// LIMIT 1 arbitraire. Omis (null) : comportement strictement identique à avant — non-régression
// totale pour tous les niveaux qui n'ont qu'une seule maquette.
const getStructureAcademiqueParFiliereNiveau = async (filiereId, niveauId, semestreId = null, parcourLibelle = null) => {
    const params = [filiereId, niveauId];
    let whereParcour = '';
    if (parcourLibelle) {
        params.push(parcourLibelle);
        whereParcour = `AND mq.parcour = $${params.length}`;
    }
    let whereSemestre = '';
    if (semestreId) {
        params.push(semestreId);
        whereSemestre = `AND ue.semestre_id = $${params.length}`;
    }

    const query = `
        WITH maquette_cible AS (
            SELECT mq.*
            FROM maquette mq
            WHERE mq.filiere_id = $1 AND mq.niveau_id = $2 ${whereParcour}
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
        ${whereSemestre}
        ORDER BY ue.semestre_id, ue.id, mat.id
    `;

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
const getStructureAcademiqueComplete = async (filiereId, niveauId, parcourLibelle = null) => {
    // Charger S1
    const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1, parcourLibelle);
    // Charger S2
    const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2, parcourLibelle);

    // Fusionner les UE
    const ues = [...(structureS1.ues || []), ...(structureS2.ues || [])];

    return {
        maquette_id: structureS1.maquette_id || structureS2.maquette_id,
        parcour: structureS1.parcour || structureS2.parcour,
        ues: ues
    };
};

/**
 * ✅ NOUVEAU (2026-08-28, correctif "maquette JOUR affichée pour un groupe SOIR") — endpoint
 * backend faisant AUTORITÉ pour résoudre QUELLE maquette (id) correspond au parcours réel d'un
 * GROUPE. Remplace la résolution ad hoc précédemment faite côté frontend (NouvelleNote.tsx,
 * fonction fetchMaquetteForClasse) : correspondance filière/niveau + repli implicite sur le
 * premier candidat trouvé (`maquettesCandidates[0]`) dès qu'un seul résultat existait — ce repli
 * affichait silencieusement les matières de la maquette JOUR pour un groupe SOIR dès lors
 * qu'aucune maquette SOIR n'existait pour ce couple filière/niveau. Ici : jamais de repli vers un
 * autre parcours — `maquette_id: null` si aucune maquette ne correspond exactement au parcours
 * résolu. Réutilise _resoudreParcourGroupe + getStructureAcademiqueParFiliereNiveau (source
 * unique déjà correcte, utilisée par les bulletins/PV) — aucune nouvelle logique de résolution.
 * Le frontend n'a plus ensuite qu'à appeler /api/detailaffichageMaquette/maquettes/:id/structured
 * (inchangé) avec ce maquette_id pour afficher le détail.
 */
exports.getStructureGroupe = async (req, res) => {
    try {
        const { groupeId } = req.params;
        const { semestreId } = req.query;

        const representant = await _resoudreParcourGroupe(db, groupeId);
        if (!representant) {
            return res.status(404).json({
                success: false,
                message: 'Aucun étudiant inscrit dans ce groupe — impossible de résoudre la maquette.'
            });
        }

        const structure = await getStructureAcademiqueParFiliereNiveau(
            representant.filiereId, representant.niveauId,
            semestreId ? parseInt(semestreId, 10) : null, representant.parcourLibelle
        );

        res.status(200).json({
            success: true,
            maquette_id: structure.maquette_id,
            parcour: representant.parcourLibelle,
            filiere_id: representant.filiereId,
            niveau_id: representant.niveauId,
            message: structure.maquette_id ? null : "Aucune maquette pédagogique n'est configurée pour ce parcours.",
        });
    } catch (error) {
        console.error('Erreur getStructureGroupe:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
};

/**
 * ✅ Même principe que exports.getStructureGroupe ci-dessus, mais résolu depuis une CLASSE —
 * utilisé par l'écran "Gestion académique → Maquettes pédagogiques" (DetailClasse.tsx), qui
 * navigue par classe et non par groupe. Un étudiant représentant est cherché parmi tous les
 * groupes de cette classe (une classe peut avoir plusieurs groupes, tous censés être du même
 * parcours). Réutilise désormais _resoudreParcourGroupeOuClasse (2026-08-30) — plus de requête
 * dupliquée : même vote majoritaire, même robustesse qu'exports.getStructureGroupe.
 */
exports.getStructureClasse = async (req, res) => {
    try {
        const { classeId } = req.params;
        const { semestreId } = req.query;

        const representant = await _resoudreParcourGroupeOuClasse(db, { classeId });
        if (!representant) {
            return res.status(404).json({
                success: false,
                message: 'Aucun étudiant inscrit dans cette classe — impossible de résoudre la maquette.'
            });
        }

        const { filiereId, niveauId, parcourLibelle } = representant;
        const structure = await getStructureAcademiqueParFiliereNiveau(
            filiereId, niveauId, semestreId ? parseInt(semestreId, 10) : null, parcourLibelle
        );

        res.status(200).json({
            success: true,
            maquette_id: structure.maquette_id,
            parcour: parcourLibelle,
            filiere_id: filiereId,
            niveau_id: niveauId,
            message: structure.maquette_id ? null : "Aucune maquette pédagogique n'est configurée pour ce parcours.",
        });
    } catch (error) {
        console.error('Erreur getStructureClasse:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur.' });
    }
};

const calculerTotalCreditsMaquette = (ues) => {
    let total = 0;
    ues.forEach(ue => {
        ue.matieres.forEach(matiere => { total += matiere.coefficient; });
    });
    return total;
};

// ✅ FIX COHÉRENCE : un même étudiant peut avoir plusieurs lignes `note` pour la même matière
// (ré-import de notes via chargementNote.js, créant un nouvel `enseignement_id` à chaque fois).
// La déduplication en aval (calculerResultatsUEAvecDetailsFonction, Map indexée par matiere_id)
// conserve la DERNIÈRE ligne rencontrée dans l'ordre de ce SELECT : le tri se termine donc
// volontairement par `n.id` (ordre d'insertion) pour que ce soit toujours la note la plus
// récemment importée/corrigée qui l'emporte, de façon déterministe à chaque appel — avant ce
// correctif, l'absence de ce tiebreaker rendait le résultat non déterministe en cas de doublon,
// ce qui produisait des moyennes/crédits différents selon l'exécution pour un même étudiant.
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
        ORDER BY mat.ue_id, mat.id, n.id
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

    const passthrough = (m) => ({
        ...m,
        moyenne_originale: m.moyenne,
        moyenne_affichage: m.moyenne,
        cc_original: m.moyenne_cc,
        examen_original: m.partiel,
        cc_affichage: m.moyenne_cc,
        examen_affichage: m.partiel,
        harmonisee: false,
        repechage_credits: false
    });

    if (moyenneUE < SEUIL_VALIDATION || moyenneUE >= CIBLE) {
        return matieres.map(passthrough);
    }

    // ✅ ECUE à choix exclues (non_classe) : ne participent jamais à l'harmonisation, ni comme
    // poids (coefficient), ni comme cible à recalculer — passthrough systématique pour elles.
    const matieresClassees = matieres.filter(m => !m.non_classe);

    const notesFortes = matieresClassees.filter(m => m.moyenne >= CIBLE);
    const notesFaibles = matieresClassees.filter(m => m.moyenne < CIBLE);

    const sommeForte = notesFortes.reduce((sum, m) => sum + (m.moyenne * m.coefficient), 0);
    const totalCoeff = matieresClassees.reduce((sum, m) => sum + m.coefficient, 0);
    const sommeNecessaire = CIBLE * totalCoeff;
    const sommeRestante = sommeNecessaire - sommeForte;
    const coeffFaible = notesFaibles.reduce((sum, m) => sum + m.coefficient, 0);

    if (coeffFaible === 0 || sommeRestante <= 0) {
        return matieres.map(passthrough);
    }

    return matieres.map(m => {
        if (m.non_classe || m.moyenne >= CIBLE) {
            return passthrough(m);
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

    // ✅ ECUE à choix (Espagnol/Allemand, etc.) : si un membre de la paire a une vraie note et
    // l'autre est à 0 (jamais évaluée, pas un échec), on exclut le 0 de tous les calculs. Si les
    // deux sont à 0 (aucune des deux réellement suivie), on exclut les deux. a_note et moyenne
    // restent inchangés (nécessaires pour l'affichage du bulletin/PV).
    const pairesDejaTraitees = new Set();
    matieresOriginales.forEach(matiere => {
        const paire = trouverPaireChoix(matiere.nom);
        if (!paire || pairesDejaTraitees.has(paire)) return;

        const membres = matieresOriginales.filter(m => paire.includes((m.nom || '').trim().toUpperCase()));
        if (membres.length < 2) return; // une seule des deux ECUE proposée dans cette UE : rien à faire

        pairesDejaTraitees.add(paire);

        const avecNoteReelle = membres.filter(m => m.a_note && m.moyenne > 0);
        const zeros = membres.filter(m => m.a_note && m.moyenne === 0);

        if (zeros.length === membres.length || (avecNoteReelle.length >= 1 && zeros.length >= 1)) {
            zeros.forEach(m => {
                m.non_classe = true;
                m.est_eliminatoire = false;
            });
        }
    });

    let sommeNotesPonderees = 0;
    let sommeCoefficients = 0;
    let auMoinsUneMatiereAvecNote = false;
    let aNoteEliminatoire = false;
    let creditsValides = 0;
    let creditsTotal = 0;

    matieresOriginales.forEach(matiere => {
        if (matiere.non_classe) return; // ECUE à choix non suivie : exclue de tous les calculs

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
    const creditsUE = matieresOriginales
        .filter(m => !m.non_classe)
        .reduce((sum, mat) => sum + mat.coefficient, 0);

    const toutesNotesNonEliminatoires = matieresOriginales.every(m =>
        m.non_classe || !m.a_note || m.moyenne >= SEUIL_ELIMINATOIRE
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
        .filter(m => m.a_note && !m.non_classe && m.moyenne < CIBLE)
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
        const ueAvecNotes = ue.matieres.some(m => m.a_note && !m.non_classe);
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

// ✅ RÈGLE MÉTIER OFFICIELLE : moyenne annuelle = (Moyenne S1 + Moyenne S2) / 2, à partir des
// moyennes semestrielles déjà arrondies — jamais un recalcul indépendant "à plat" sur les UE de
// l'année (élimine tout écart de double arrondi avec les moyennes semestrielles affichées).
const calculerMoyenneAnnuelleDepuisSemestres = (moyenneS1Affichee, moyenneS2Affichee) => {
    return parseFloat((((moyenneS1Affichee || 0) + (moyenneS2Affichee || 0)) / 2).toFixed(2));
};

/**
 * ✅ NOUVEAU — SOURCE UNIQUE DE VÉRITÉ POUR S1 / S2 / ANNUEL
 * Calcule, à partir d'un tableau d'UE déjà résolues et repêchées (avec semestre_id
 * sur chaque UE), le récapitulatif complet (moyenne, crédits validés/total, décision)
 * pour le semestre 1, le semestre 2 et l'année complète — via calculerTotauxFonction
 * et determinerDecisionFonction, EXACTEMENT comme le fait le PV.
 *
 * ✅ Applique aussi le repêchage annuel BTS (voir appliquerRepechageAnnuelBTS) : la
 * décision d'éligibilité et l'harmonisation se font UNE SEULE FOIS, à partir de la
 * moyenne annuelle (S1+S2) — jamais semestre par semestre. Le tableau `ues` retourné
 * (fusion des UE éventuellement harmonisées) doit être utilisé par l'appelant pour
 * l'affichage (table des ECUE, ecue_a_reprendre, etc.), afin que les notes visibles
 * soient toujours celles réellement comptées dans la moyenne — source unique.
 *
 * Utilisée par le bulletin individuel ET les bulletins multiples, afin que ces
 * documents ne recalculent plus JAMAIS les crédits/moyennes/décisions avec leur
 * propre logique ad-hoc (source des incohérences PV / Bulletin / Stats observées).
 */
const calculerRecapitulatifComplet = (uesAvecResultats, typeTraitement, niveauLibelle, groupeNom) => {
    const uesS1Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
    const uesS2Brutes = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

    // ✅ Repêchage annuel BTS : UNE SEULE décision, basée sur la moyenne annuelle
    // (S1+S2), qui harmonise au besoin le seul semestre le plus faible.
    const { uesS1, uesS2 } = appliquerRepechageAnnuelBTS(uesS1Brutes, uesS2Brutes, typeTraitement, niveauLibelle, groupeNom);
    const uesAnnuel = [...uesS1, ...uesS2];

    const totalCreditsS1 = uesS1.reduce((sum, ue) => sum + (ue.credits || 0), 0);
    const totalCreditsS2 = uesS2.reduce((sum, ue) => sum + (ue.credits || 0), 0);
    const totalCreditsAnnuel = totalCreditsS1 + totalCreditsS2;

    const totauxS1 = calculerTotauxFonction(uesS1, typeTraitement, totalCreditsS1);
    const totauxS2 = calculerTotauxFonction(uesS2, typeTraitement, totalCreditsS2);
    // ✅ Crédits/uesAvecNotes = sommes authentiques sur l'année complète, MAIS la
    // moyenne est TOUJOURS écrasée par la règle officielle (S1+S2)/2 — voir
    // calculerMoyenneAnnuelleDepuisSemestres — pour éliminer tout écart de double
    // arrondi avec les moyennes semestrielles réellement affichées.
    const totauxAnnuel = {
        ...calculerTotauxFonction(uesAnnuel, typeTraitement, totalCreditsAnnuel),
        moyenneGenerale: calculerMoyenneAnnuelleDepuisSemestres(totauxS1.moyenneGenerale, totauxS2.moyenneGenerale)
    };

    const decisionS1 = determinerDecisionFonction(totauxS1.creditsValides, totauxS1.creditsTotal, typeTraitement, totauxS1.moyenneGenerale, totauxS1.uesAvecNotes);
    const decisionS2 = determinerDecisionFonction(totauxS2.creditsValides, totauxS2.creditsTotal, typeTraitement, totauxS2.moyenneGenerale, totauxS2.uesAvecNotes);
    const decisionAnnuelle = determinerDecisionFonction(totauxAnnuel.creditsValides, totauxAnnuel.creditsTotal, typeTraitement, totauxAnnuel.moyenneGenerale, totauxAnnuel.uesAvecNotes);

    return {
        s1: { moyenne: totauxS1.moyenneGenerale, creditsValides: totauxS1.creditsValides, creditsTotal: totauxS1.creditsTotal, decision: decisionS1 },
        s2: { moyenne: totauxS2.moyenneGenerale, creditsValides: totauxS2.creditsValides, creditsTotal: totauxS2.creditsTotal, decision: decisionS2 },
        annuel: { moyenne: totauxAnnuel.moyenneGenerale, creditsValides: totauxAnnuel.creditsValides, creditsTotal: totauxAnnuel.creditsTotal, decision: decisionAnnuelle },
        // ✅ UE finales (avec ECUE éventuellement harmonisés BTS) — à utiliser par
        // l'appelant à la place du tableau d'UE d'origine pour tout affichage.
        ues: uesAnnuel
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
               g.nom as groupe_nom, g.classe_id, g.est_primaire, cl.nom as classe_nom
        FROM etudiant e
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        LEFT JOIN filiere f ON f.id = e.id_filiere
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n ON n.id = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g ON g.id = e.groupe_id
        LEFT JOIN classe cl ON cl.id = g.classe_id
        WHERE e.id = $1
        AND e.standing = 'Inscrit'
    `;
    const result = await db.query(query, [etudiantId]);
    return result.rows[0];
};

// ✅ vue_position_academique : quand anneeAcademiqueId est fourni, résout niveau/filière/groupe/
// statut pour CETTE année précisément (position live si l'étudiant y est toujours, position
// historique figée dans historique_inscription s'il l'a quittée depuis) — identité (nom, contact,
// date de naissance) reste lue sur `etudiant`, invariante d'une année à l'autre. Par défaut
// (paramètre omis), comportement inchangé : position actuelle de l'étudiant.
const getEtudiantCompletByMatricule = async (matricule, anneeAcademiqueId = null) => {
    if (anneeAcademiqueId) {
        const posQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
                   e.date_naissance, e.lieu_naissance, e.sexe as genre,
                   e.nationalite, e.pays_naissance, e.telephone, e.email,
                   e.code_unique, e.numero_table, e.statut_scolaire, e.standing,
                   e.groupe_id, e.niveau_id, e.annee_academique_id, e.id_filiere, e.curcus_id,
                   e.statut_paiement as statut_scolarite,
                   f.nom as filiere_nom, f.sigle as filiere_sigle,
                   tf.libelle as type_filiere,
                   n.libelle as niveau_libelle,
                   aa.annee as annee_academique,
                   g.nom as groupe_nom, g.classe_id, g.est_primaire, cl.nom as classe_nom
            FROM vue_position_academique e
            LEFT JOIN filiere f ON f.id = e.id_filiere
            LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
            LEFT JOIN niveau n ON n.id = e.niveau_id
            LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
            LEFT JOIN groupe g ON g.id = e.groupe_id
            LEFT JOIN classe cl ON cl.id = g.classe_id
            WHERE e.matricule_iipea = $1 AND e.annee_academique_id = $2
        `;
        const posResult = await db.query(posQuery, [matricule, anneeAcademiqueId]);
        return posResult.rows[0];
    }

    const query = `
        SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
               e.date_naissance, e.lieu_naissance, e.sexe as genre,
               e.nationalite, e.pays_naissance, e.telephone, e.email,
               e.code_unique, e.numero_table, e.statut_scolaire, e.standing,
               e.groupe_id, e.niveau_id, e.annee_academique_id, e.id_filiere, e.curcus_id,
               s.statut_etudiant as statut_scolarite,
               f.nom as filiere_nom, f.sigle as filiere_sigle,
               tf.libelle as type_filiere,
               n.libelle as niveau_libelle,
               aa.annee as annee_academique,
               g.nom as groupe_nom, g.classe_id, g.est_primaire, cl.nom as classe_nom
        FROM etudiant e
        LEFT JOIN scolarite s ON s.id = e.scolarite_id
        LEFT JOIN filiere f ON f.id = e.id_filiere
        LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
        LEFT JOIN niveau n ON n.id = e.niveau_id
        LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
        LEFT JOIN groupe g ON g.id = e.groupe_id
        LEFT JOIN classe cl ON cl.id = g.classe_id
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
            // ✅ Rang académique réel (classement par moyenne générale), calculé AVANT le tri
            // d'affichage ci-dessous — le rang ne doit jamais dépendre de l'ordre d'affichage.
            // Identique au calcul d'avant (position après tri par moyenne décroissante).
            [...resultatsEtudiants]
                .sort((a, b) => b.moyenne_generale - a.moyenne_generale)
                .forEach((etudiant, index) => { etudiant.rang = index + 1; });

            // ✅ PV filières professionnelles : ordre d'AFFICHAGE alphabétique (Nom puis Prénoms),
            // plus pratique pour la consultation. Le N° de ligne suit cet ordre ; le RANG ci-dessus
            // reste le classement académique réel, affiché séparément.
            resultatsEtudiants.sort((a, b) => {
                const nomA = (a.nom || '').toLowerCase();
                const nomB = (b.nom || '').toLowerCase();
                if (nomA < nomB) return -1;
                if (nomA > nomB) return 1;
                const prenomsA = (a.prenoms || '').toLowerCase();
                const prenomsB = (b.prenoms || '').toLowerCase();
                if (prenomsA < prenomsB) return -1;
                if (prenomsA > prenomsB) return 1;
                return 0;
            });
        }

        // ✅ Inclure DÉROGÉ dans les admis
        const admisCount = resultatsEtudiants.filter(e => e.decision === 'ADMIS' || e.decision === 'DÉROGÉ').length;

        const pvData = {
            success: true,
            groupe: construireGroupeAffichage(groupeInfo),
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
        const { anneeAcademiqueId } = req.query;
        console.log(`📄 Bulletin - Matricule: ${matricule}, semestre: ${semestreId || 'annuel'}${anneeAcademiqueId ? `, année: ${anneeAcademiqueId}` : ''}`);

        const etudiantComplet = await getEtudiantCompletByMatricule(matricule, anneeAcademiqueId || null);
        if (!etudiantComplet) {
            return res.status(404).render('error', { title: 'Erreur', message: `Étudiant ${matricule} non trouvé` });
        }

        // ✅ etudiantComplet porte déjà filiere/sigle/type_filiere/annee_academique/groupe_nom de
        // l'année résolue (courante ou historique demandée, via vue_position_academique) — la
        // requête séparée précédente (jointure live sur et.matricule_iipea) était redondante et
        // pouvait diverger de l'année demandée.
        const groupeInfo = {
            id: etudiantComplet.groupe_id,
            nom: etudiantComplet.groupe_nom,
            est_primaire: etudiantComplet.est_primaire,
            classe_nom: etudiantComplet.classe_nom,
            filiere: etudiantComplet.filiere_nom,
            sigle: etudiantComplet.filiere_sigle,
            type_filiere: etudiantComplet.type_filiere,
            annee_academique: etudiantComplet.annee_academique
        };

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);

        // ✅ Parcours JOUR/SOIR : désambiguïse la maquette si plusieurs existent pour cette
        // filière+niveau — null (comportement inchangé) pour tout étudiant sans curcus_id.
        let parcourLibelleBulletin = null;
        if (etudiantComplet.curcus_id) {
            const curcusResult = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [etudiantComplet.curcus_id]);
            parcourLibelleBulletin = curcusResult.rows[0]?.type_parcours || null;
        }

        // ✅ FIX : Charger S1 et S2 SÉPARÉMENT pour garantir que les maquettes sont correctes
        const structureS1 = await getStructureAcademiqueParFiliereNiveau(
            etudiantComplet.id_filiere, etudiantComplet.niveau_id, 1, parcourLibelleBulletin
        );
        const structureS2 = await getStructureAcademiqueParFiliereNiveau(
            etudiantComplet.id_filiere, etudiantComplet.niveau_id, 2, parcourLibelleBulletin
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
        // (identique à ce qu'utiliserait le PV pour ce même étudiant), y compris le
        // repêchage moyenne BTS le cas échéant.
        const recap = calculerRecapitulatifComplet(
            uesAvecResultats, typeTraitement, etudiantComplet.niveau_libelle, groupeInfo.nom
        );
        uesAvecResultats = recap.ues;

        const aSoldeScolarite = (etudiantComplet.statut_scolarite || '').toUpperCase() === 'SOLDE';
        const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats, typeTraitement);

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
            groupe: construireGroupeAffichage(groupeInfo),
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

// ============ FILTRAGE IMPRESSION BULLETINS (sélection avant impression — 2026-08-26) ============
// Chantier : permettre de sélectionner les étudiants à imprimer selon leur décision académique
// (ADMIS/AJOURNÉ/DÉROGÉ) et leur statut de scolarité (SOLDE/NON_SOLDE), SANS jamais recalculer ni
// dupliquer ces deux informations — elles restent produites exclusivement par
// calculerRecapitulatifComplet() → recap.annuel.decision (décision) et par
// vue_position_academique.statut_paiement (scolarité, déjà scopée à l'année du groupe demandé,
// identique à Caisse/Scolarité). Le filtre se contente de sélectionner, en amont ou juste après
// ces calculs inchangés, quels étudiants entrent dans la liste transmise au moteur de rendu
// existant (Bulletin_multiple.ejs, lui-même inchangé).

const DECISION_SLUG_VERS_VALEUR = { ADMIS: 'ADMIS', AJOURNE: 'AJOURNÉ', DEROGE: 'DÉROGÉ' };

const _normaliserStatutScolarite = (statutBrut) => {
    const val = (statutBrut || '').toString().toUpperCase();
    if (val === 'SOLDE') return 'SOLDE';
    if (val === 'NON_SOLDE') return 'NON_SOLDE';
    return null;
};

// query.decisions="ADMIS,DEROGE" (slugs ASCII — évite les soucis d'encodage des accents en query
// string) → Set(['ADMIS','DÉROGÉ']). query.statutScolarite="SOLDE"|"NON_SOLDE". Paramètre
// absent/invalide → null (= pas de filtre sur cet axe, comportement historique inchangé).
const _parseFiltresBulletins = (query) => {
    let decisions = null;
    if (query && query.decisions) {
        const valeurs = String(query.decisions)
            .split(',')
            .map(s => DECISION_SLUG_VERS_VALEUR[s.trim().toUpperCase()])
            .filter(Boolean);
        if (valeurs.length > 0) decisions = new Set(valeurs);
    }
    let statutScolarite = null;
    if (query && query.statutScolarite) {
        const val = String(query.statutScolarite).trim().toUpperCase();
        if (val === 'SOLDE' || val === 'NON_SOLDE') statutScolarite = val;
    }
    return { decisions, statutScolarite };
};

// ✅ Extrait TEL QUEL (aucun changement de logique) du corps de boucle historique de
// afficherBulletinsMultiples : même séquence notes → UE → repêchage crédits → repêchage annuel
// BTS → calculerRecapitulatifComplet. Centralisé ici pour être appelé IDENTIQUEMENT par
// l'impression et par le comptage par catégorie (getCompteursBulletinsGroupe ci-dessous) — un
// compteur ne doit jamais diverger de la liste réellement imprimée.
const _calculerResultatEtudiantBulletin = async (etudiant, structureAcademique, typeTraitement, totalCreditsS1, totalCreditsS2, groupeInfo, semestreId) => {
    if (DEBUG_VERBOSE) {
        console.log(`📊 Traitement: ${etudiant.nom} ${etudiant.prenoms} (${etudiant.matricule_iipea})`);
        console.log(`📊 niveau_libelle: "${etudiant.niveau_libelle}"`);
    }

    const notes = await getNotesEtudiantAvecDetailsFonction(etudiant.id, structureAcademique.maquette_id);

    let uesAvecResultats = [];
    for (const ue of structureAcademique.ues) {
        const resultatsUE = await calculerResultatsUEAvecDetailsFonction(ue, notes, typeTraitement);
        uesAvecResultats.push(resultatsUE);
    }

    // ✅ CORRECTIF RACINE : le repêchage crédits est appliqué INCONDITIONNELLEMENT aux
    // DEUX semestres, quel que soit le semestre demandé dans l'URL pour l'affichage —
    // EXACTEMENT comme le fait le PV (_calculerResultatsTousEtudiants) et le bulletin
    // individuel (afficherBulletinByMatricule). Le document affiche toujours les deux
    // semestres ; laisser le semestre non demandé avec ses valeurs BRUTES créait des
    // écarts PV/Bulletin (moyenne et crédits du semestre non demandé non harmonisés).
    const uesS1Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 1);
    const uesS2Resultats = uesAvecResultats.filter(ue => parseInt(ue.semestre_id, 10) === 2);

    const { ues: uesS1ApresCredits } = appliquerRepechageCredits(
        uesS1Resultats, totalCreditsS1, 1, etudiant.niveau_libelle, groupeInfo.nom
    );
    const { ues: uesS2ApresCredits } = appliquerRepechageCredits(
        uesS2Resultats, totalCreditsS2, 2, etudiant.niveau_libelle, groupeInfo.nom
    );

    // ✅ Repêchage annuel BTS : UNE SEULE décision, basée sur la moyenne annuelle
    // (S1+S2) — jamais semestre par semestre. No-op pour tout ce qui n'est pas
    // BTS 1/2 professionnel.
    const { uesS1: uesS1Final, uesS2: uesS2Final } = appliquerRepechageAnnuelBTS(
        uesS1ApresCredits, uesS2ApresCredits, typeTraitement, etudiant.niveau_libelle, groupeInfo.nom
    );

    uesAvecResultats = [...uesS1Final, ...uesS2Final];

    // ✅ SOURCE UNIQUE DE VÉRITÉ pour crédits/moyennes/décisions (S1, S2, annuel) —
    // EXACTEMENT la même logique que le PV et le bulletin individuel, y compris le
    // repêchage annuel BTS le cas échéant. Le template Bulletin_multiple.ejs consomme
    // directement ces valeurs (décision_s1/s2/jury, moyennes, crédits) sans jamais
    // les recalculer.
    const recap = calculerRecapitulatifComplet(uesAvecResultats, typeTraitement, etudiant.niveau_libelle, groupeInfo.nom);
    uesAvecResultats = recap.ues;

    const ecueAReprendre = _collecterEcueAReprendre(uesAvecResultats, typeTraitement);

    const ecueAReprendreEntry = ecueAReprendre.length > 0 ? {
        etudiant_id: etudiant.id,
        matricule_iipea: etudiant.matricule_iipea,
        nom: etudiant.nom,
        prenoms: etudiant.prenoms,
        decision: recap.annuel.decision,
        ecue_a_reprendre: ecueAReprendre
    } : null;

    const semestreDemande = semestreId ? parseInt(semestreId, 10) : null;
    const decisionAffichee = semestreDemande === 1 ? recap.s1.decision
                            : semestreDemande === 2 ? recap.s2.decision
                            : recap.annuel.decision;

    // ✅ Redoublant : basé sur la moyenne/crédits ANNUELS officiels (recap.annuel),
    // identique à la règle utilisée par le bulletin individuel.
    let redoublantEtudiant = 'NON';
    const typeFEtudiant = (groupeInfo.type_filiere || '').toLowerCase();
    if (typeFEtudiant.includes('universitaire')) {
        if (recap.annuel.moyenne < 10 || recap.annuel.creditsValides < 48) redoublantEtudiant = 'OUI';
    } else {
        if (recap.annuel.moyenne < 10) redoublantEtudiant = 'OUI';
    }

    const resultatEtudiant = {
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
        decision_jury_class: recap.annuel.decision === 'ADMIS' ? 'admis' : recap.annuel.decision === 'DÉROGÉ' ? 'deroge' : 'ajourne',
        ues: uesAvecResultats,
        ecue_a_reprendre: ecueAReprendre,
        moyenne_s1: recap.s1.moyenne,
        credits_s1: recap.s1.creditsValides,
        credits_s1_total: recap.s1.creditsTotal,
        decision_s1: recap.s1.decision,
        decision_s1_class: recap.s1.decision === 'ADMIS' ? 'admis' : 'ajourne',
        moyenne_s2: recap.s2.moyenne,
        credits_s2: recap.s2.creditsValides,
        credits_s2_total: recap.s2.creditsTotal,
        decision_s2: recap.s2.decision,
        decision_s2_class: recap.s2.decision === 'ADMIS' ? 'admis' : 'ajourne',
        moyenne_annuelle: recap.annuel.moyenne,
        credits_annuels: recap.annuel.creditsValides,
        credits_annuels_total: recap.annuel.creditsTotal,
        redoublant: redoublantEtudiant
    };

    return {
        resultatEtudiant,
        ecueAReprendreEntry,
        // ✅ Décision de FILTRAGE — toujours recap.annuel.decision, jamais decisionAffichee (qui
        // varie selon le semestre demandé dans l'URL) : les 3 décisions des boutons de filtrage
        // sont mutuellement exclusives et raisonnent toujours à l'année, comme demandé.
        decisionAnnuelle: recap.annuel.decision,
        statutScolariteNormalise: _normaliserStatutScolarite(etudiant.statut_etudiant)
    };
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
 *
 * ✅ Filtrage sélection avant impression (2026-08-26) : query params optionnels `decisions`
 * (slugs ASCII séparés par virgule : ADMIS, AJOURNE, DEROGE) et `statutScolarite`
 * (SOLDE|NON_SOLDE). Absents → comportement strictement identique à avant cette modification.
 */
exports.afficherBulletinsMultiples = async (req, res) => {
    try {
        const { groupeId, semestreId } = req.params;
        const { decisions: decisionsFiltre, statutScolarite: statutFiltre } = _parseFiltresBulletins(req.query);
        const filtreActif = Boolean(decisionsFiltre || statutFiltre);
        console.log(`📚 Bulletins multiples - groupe: ${groupeId}, semestre: ${semestreId}`);

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).render('error', { title: 'Erreur', message: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);
        console.log(`📌 Type de traitement: ${typeTraitement}`);

        // ✅ AJOUT : e.id_filiere était absent de cette requête — indispensable pour
        // résoudre la maquette propre à chaque étudiant (combo filiere/niveau).
        // ✅ vue_position_academique : ramène tous les étudiants ayant un jour appartenu à ce
        // groupe (live ou historique figé dans historique_inscription pour ceux qui l'ont quitté
        // depuis une réinscription) — même principe que _getEtudiantsGroupe.
        const etudiantsQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
                   e.date_naissance, e.lieu_naissance, e.sexe as genre,
                   e.nationalite, e.code_unique,
                   e.groupe_id, e.niveau_id, e.id_filiere,
                   COALESCE(n.libelle, '') as niveau_libelle,
                   e.statut_paiement as statut_etudiant,
                   e.curcus_id
            FROM vue_position_academique e
            LEFT JOIN niveau n ON n.id = e.niveau_id
            WHERE e.groupe_id = $1
            AND e.standing = 'Inscrit'
            ORDER BY e.nom, e.prenoms
        `;
        const etudiantsResult = await db.query(etudiantsQuery, [groupeId]);
        // ✅ CORRECTIF (2026-09-01) — bug "le rang change selon le filtre d'impression" : `etudiants`
        // n'est PLUS jamais réduit ici (ni par statutScolarite, ni par decisions plus bas). TOUS les
        // étudiants du groupe restent dans le périmètre de calcul, donc dans le périmètre de
        // classement (Bulletin_multiple.ejs::calculerRangs() reçoit toujours la liste complète) —
        // seule la sélection des bulletins RENDUS (voir `aImprimer` plus bas) dépend du filtre.
        const etudiants = etudiantsResult.rows;
        console.log(`👨‍🎓 ${etudiants.length} étudiants trouvés`);

        // ℹ️ Info d'affichage uniquement (en-tête du document)
        const structureRepresentative = await getStructureAcademiqueFonction(groupeId, null);
        console.log(`📚 ${structureRepresentative.ues.length} UE (info d'affichage, S1 + S2)`);

        const resultatsEtudiants = [];
        const etudiantsAReprendre = [];

        // ✅ Grouper les étudiants par combo (filiere_id, niveau_id, curcus_id) RÉEL — le curcus
        // fait partie de la clé pour ne jamais mélanger un combo JOUR et un combo SOIR.
        const etudiantsParCombo = new Map();
        for (const etudiant of etudiants) {
            const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}_${etudiant.curcus_id || ''}`;
            if (!etudiantsParCombo.has(cle)) {
                etudiantsParCombo.set(cle, {
                    filiereId: etudiant.id_filiere,
                    niveauId: etudiant.niveau_id,
                    curcusId: etudiant.curcus_id || null,
                    etudiants: []
                });
            }
            etudiantsParCombo.get(cle).etudiants.push(etudiant);
        }

        // ✅ Traiter chaque combo avec SA propre maquette
        for (const { filiereId, niveauId, curcusId, etudiants: etudiantsCombo } of etudiantsParCombo.values()) {
            let parcourLibelleCombo = null;
            if (curcusId) {
                const curcusResult = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [curcusId]);
                parcourLibelleCombo = curcusResult.rows[0]?.type_parcours || null;
            }
            // ✅ FIX : Charger S1 et S2 séparément pour chaque combo
            const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1, parcourLibelleCombo);
            const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2, parcourLibelleCombo);

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

            // ✅ PERF : cette boucle fait déjà un vrai await db.query() par étudiant
            // (getNotesEtudiantAvecDetailsFonction ci-dessous) et cède donc déjà la main à
            // l'Event Loop à chaque itération. Point de pause supplémentaire ajouté par cohérence/
            // filet de sécurité — aucun changement de logique métier.
            let _yieldCounterBulletins = 0;
            for (const etudiant of etudiantsCombo) {
                if (++_yieldCounterBulletins % 25 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }

                const { resultatEtudiant, ecueAReprendreEntry, decisionAnnuelle, statutScolariteNormalise } = await _calculerResultatEtudiantBulletin(
                    etudiant, structureAcademique, typeTraitement, totalCreditsS1, totalCreditsS2, groupeInfo, semestreId
                );

                // ✅ CORRECTIF (2026-09-01) — PÉRIMÈTRE DE CLASSEMENT ≠ PÉRIMÈTRE D'IMPRESSION.
                // Le filtre (décision et/ou statut de scolarité) ne retire plus personne de
                // `resultatsEtudiants` — il se contente de marquer `aImprimer` sur chaque étudiant,
                // toujours sur recap.annuel.decision / le statut déjà normalisé (jamais recalculés,
                // jamais une autre logique). resultatsEtudiants reste TOUJOURS le groupe complet :
                // c'est lui qui est transmis à Bulletin_multiple.ejs, qui calcule le rang dessus
                // (calculerRangs, inchangée) AVANT de sauter le rendu des étudiants non sélectionnés.
                const correspondDecision = !decisionsFiltre || decisionsFiltre.has(decisionAnnuelle);
                const correspondStatut = !statutFiltre || statutScolariteNormalise === statutFiltre;
                resultatEtudiant.aImprimer = correspondDecision && correspondStatut;

                if (resultatEtudiant.aImprimer && ecueAReprendreEntry) {
                    etudiantsAReprendre.push(ecueAReprendreEntry);
                }
                resultatsEtudiants.push(resultatEtudiant);
            }
        }

        // ✅ Filtre actif et aucun étudiant ne correspond : ne jamais générer un bulletin vide.
        // Basé sur `aImprimer` (pas sur la taille de resultatsEtudiants, qui contient désormais
        // toujours le groupe complet, filtre actif ou non).
        const nombreAImprimer = resultatsEtudiants.filter(e => e.aImprimer).length;
        if (filtreActif && nombreAImprimer === 0) {
            return res.status(200).send(
                '<html><head><meta charset="utf-8"><title>Bulletins</title></head>' +
                '<body style="font-family:sans-serif;text-align:center;padding:60px;color:#333;">' +
                '<h2>Aucun étudiant ne correspond à ce filtre.</h2>' +
                '</body></html>'
            );
        }

        const admisCount = resultatsEtudiants.filter(e => e.aImprimer && (e.decision === 'ADMIS' || e.decision === 'DÉROGÉ')).length;

        res.render('Bulletin_multiple', {
            title: `Bulletins - ${groupeInfo.est_primaire ? (groupeInfo.classe_nom || '') : groupeInfo.nom}`,
            groupe: construireGroupeAffichage(groupeInfo),
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

/**
 * ✅ NOUVEAU (filtrage impression bulletins, 2026-08-26) : compte, pour un groupe (+ semestre
 * optionnel), le nombre d'étudiants dans chacune des 6 catégories décision × statut de scolarité,
 * plus le total "TOUS". Réutilise EXACTEMENT le même moteur que l'impression
 * (_calculerResultatEtudiantBulletin, donc calculerRecapitulatifComplet) — un compteur ne doit
 * jamais diverger de la liste réellement imprimée. Ne rend aucun HTML, uniquement des chiffres
 * pour alimenter les boutons de filtrage.
 */
exports.getCompteursBulletinsGroupe = async (req, res) => {
    try {
        const { groupeId, semestreId } = req.params;

        const groupeInfo = await _getGroupeInfo(groupeId);
        if (!groupeInfo) {
            return res.status(404).json({ error: `Groupe ${groupeId} non trouvé` });
        }

        const typeTraitement = determinerTypeTraitement(groupeInfo.type_filiere, groupeInfo.nom);

        const etudiantsQuery = `
            SELECT e.id, e.matricule_iipea, e.nom, e.prenoms,
                   e.date_naissance, e.lieu_naissance, e.sexe as genre,
                   e.nationalite, e.code_unique,
                   e.groupe_id, e.niveau_id, e.id_filiere,
                   COALESCE(n.libelle, '') as niveau_libelle,
                   e.statut_paiement as statut_etudiant,
                   e.curcus_id
            FROM vue_position_academique e
            LEFT JOIN niveau n ON n.id = e.niveau_id
            WHERE e.groupe_id = $1
            AND e.standing = 'Inscrit'
            ORDER BY e.nom, e.prenoms
        `;
        const etudiantsResult = await db.query(etudiantsQuery, [groupeId]);
        const etudiants = etudiantsResult.rows;

        const etudiantsParCombo = new Map();
        for (const etudiant of etudiants) {
            const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}_${etudiant.curcus_id || ''}`;
            if (!etudiantsParCombo.has(cle)) {
                etudiantsParCombo.set(cle, {
                    filiereId: etudiant.id_filiere,
                    niveauId: etudiant.niveau_id,
                    curcusId: etudiant.curcus_id || null,
                    etudiants: []
                });
            }
            etudiantsParCombo.get(cle).etudiants.push(etudiant);
        }

        const compteurs = {
            tous: 0,
            admisSolde: 0, admisNonSolde: 0,
            ajourneSolde: 0, ajourneNonSolde: 0,
            derogeSolde: 0, derogeNonSolde: 0
        };

        for (const { filiereId, niveauId, curcusId, etudiants: etudiantsCombo } of etudiantsParCombo.values()) {
            let parcourLibelleCombo = null;
            if (curcusId) {
                const curcusResult = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [curcusId]);
                parcourLibelleCombo = curcusResult.rows[0]?.type_parcours || null;
            }
            const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1, parcourLibelleCombo);
            const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2, parcourLibelleCombo);

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

            let _yieldCounterCompteurs = 0;
            for (const etudiant of etudiantsCombo) {
                if (++_yieldCounterCompteurs % 25 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }

                const { decisionAnnuelle, statutScolariteNormalise } = await _calculerResultatEtudiantBulletin(
                    etudiant, structureAcademique, typeTraitement, totalCreditsS1, totalCreditsS2, groupeInfo, semestreId
                );

                compteurs.tous++;
                if (decisionAnnuelle === 'ADMIS' && statutScolariteNormalise === 'SOLDE') compteurs.admisSolde++;
                else if (decisionAnnuelle === 'ADMIS' && statutScolariteNormalise === 'NON_SOLDE') compteurs.admisNonSolde++;
                else if (decisionAnnuelle === 'AJOURNÉ' && statutScolariteNormalise === 'SOLDE') compteurs.ajourneSolde++;
                else if (decisionAnnuelle === 'AJOURNÉ' && statutScolariteNormalise === 'NON_SOLDE') compteurs.ajourneNonSolde++;
                else if (decisionAnnuelle === 'DÉROGÉ' && statutScolariteNormalise === 'SOLDE') compteurs.derogeSolde++;
                else if (decisionAnnuelle === 'DÉROGÉ' && statutScolariteNormalise === 'NON_SOLDE') compteurs.derogeNonSolde++;
            }
        }

        res.json({ groupeId: parseInt(groupeId, 10), semestreId: semestreId ? parseInt(semestreId, 10) : null, compteurs });

    } catch (error) {
        console.error('❌ Erreur compteurs bulletins multiples:', error.message);
        res.status(500).json({ error: 'Erreur lors du calcul des compteurs de bulletins', detail: error.message });
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
            return { etudiants: [], admis: 0, deroges: 0, ajournes: 0, sommeMoyennes: 0, totalAvecMoyenne: 0 };
        }

        // ✅ Normaliser le semestre demandé (1, 2, ou null = annuel)
        const semestreNum = (semestreId === '1' || semestreId === 1) ? 1
                           : (semestreId === '2' || semestreId === 2) ? 2
                           : null;

        // ✅ Grouper les étudiants du groupe par combo (filiere_id, niveau_id, curcus_id) RÉEL
        const etudiantsParCombo = new Map();
        for (const etudiant of groupeData.etudiants) {
            const cle = `${etudiant.id_filiere}_${etudiant.niveau_id}_${etudiant.curcus_id || ''}`;
            if (!etudiantsParCombo.has(cle)) {
                etudiantsParCombo.set(cle, {
                    filiereId: etudiant.id_filiere,
                    niveauId: etudiant.niveau_id,
                    curcusId: etudiant.curcus_id || null,
                    etudiants: []
                });
            }
            etudiantsParCombo.get(cle).etudiants.push(etudiant);
        }

        const resultats = [];
        let admis = 0;
        let deroges = 0;
        let ajournes = 0;
        let sommeMoyennes = 0;
        let totalAvecMoyenne = 0;

        // ✅ Traiter chaque combo (filiere/niveau/curcus) séparément avec SA propre maquette
        for (const { filiereId, niveauId, curcusId, etudiants: etudiantsCombo } of etudiantsParCombo.values()) {
            let parcourLibelleCombo = null;
            if (curcusId) {
                const curcusResult = await db.query('SELECT type_parcours FROM curcus WHERE id = $1', [curcusId]);
                parcourLibelleCombo = curcusResult.rows[0]?.type_parcours || null;
            }
            // ✅ FIX : Charger S1 et S2 séparément
            const structureS1 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 1, parcourLibelleCombo);
            const structureS2 = await getStructureAcademiqueParFiliereNiveau(filiereId, niveauId, 2, parcourLibelleCombo);

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

            // ✅ Batch des notes pour TOUS les étudiants de ce combo en une seule requête
            const etudiantIdsCombo = etudiantsCombo.map(e => e.id);
            const notesParEtudiant = await getNotesPlusieursEtudiantsFonction(etudiantIdsCombo, structureAcademique.maquette_id);

            // ✅ PERF : cette boucle traite les notes déjà chargées en mémoire (aucun I/O par
            // étudiant), elle s'exécute donc comme un seul bloc synchrone continu sur toute la
            // durée du combo (jusqu'à ~728 étudiants) — c'est la cause racine confirmée du blocage
            // de l'Event Loop signalé sur la page Statistiques. Point de pause coopératif toutes
            // les 25 étudiants pour laisser passer les requêtes concurrentes d'autres utilisateurs ;
            // aucun changement de logique métier, seulement de l'ordonnancement.
            let _yieldCounterCombo = 0;
            for (const etudiant of etudiantsCombo) {
                if (++_yieldCounterCombo % 25 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
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

                // ✅ SOURCE UNIQUE DE VÉRITÉ pour crédits/moyennes/décisions S1, S2, annuel —
                // identique au Bulletin/PV/Réinscription (calculerRecapitulatifComplet), y compris
                // le repêchage annuel BTS et la règle officielle moyenne annuelle = (S1+S2)/2.
                // Remplace l'ancien calcul ad-hoc (calculerTotauxFonction direct sur les UE S1+S2
                // combinées, sans jamais appliquer le repêchage annuel BTS) qui pouvait afficher une
                // moyenne/décision différente de celle du Bulletin pour un même étudiant — cause
                // des divergences observées sur Statistique_Resultat (ex. 8.65/AJOURNÉ au lieu de
                // 10.00/ADMIS pour un étudiant BTS admis au Bulletin).
                const recap = calculerRecapitulatifComplet(
                    uesAvecResultats, typeTraitement, etudiant.niveau_libelle_etudiant || '', groupeInfo.nom
                );
                uesAvecResultats = recap.ues;

                // ✅ Totaux : sur le semestre demandé si précisé, sinon annuel — mêmes valeurs que
                // le Bulletin pour ce même étudiant/semestre/année (recap.s1/s2/annuel.decision est
                // déjà calculée via determinerDecisionFonction à l'intérieur de calculerRecapitulatifComplet).
                const totaux = semestreNum === 1 ? recap.s1 : semestreNum === 2 ? recap.s2 : recap.annuel;
                const decision = totaux.decision;
                // ✅ Présentation métier (2026-08-24) : Total / Admis / Dérogés / Ajournés — plus de
                // notion de "à reprendre" dans Statistique_Resultat (Dashboard ni Excel). L'ancienne
                // métrique ECUE (_collecterEcueAReprendre) restait de toute façon calculée à tort
                // pour le professionnel avant le correctif précédent (argument typeTraitement
                // manquant) — elle n'a jamais été une catégorie de décision distincte, seulement un
                // décompte de matières individuelles, ce qui expliquait déjà l'incohérence
                // arithmétique remontée (41+2+4≠43). Le Bulletin/PV conservent leur propre calcul
                // d'ECUE à reprendre (affichage individuel), totalement indépendant de cet agrégat.
                if (decision === 'ADMIS') admis++;
                else if (decision === 'DÉROGÉ') deroges++;
                else ajournes++;

                if (totaux.moyenne > 0) {
                    sommeMoyennes += totaux.moyenne;
                    totalAvecMoyenne++;
                }

                // ✅ Éligibilité classe supérieure : toujours calculée sur l'ANNÉE COMPLÈTE
                // (recap.annuel), indépendamment du filtre semestre demandé — même source que la
                // décision affichée, plus de recalcul ad-hoc parallèle (BTS "à plat" ou universitaire).
                const eligibleClasseSuperieure = groupeInfo.nom && groupeInfo.nom.toUpperCase().includes('BTS')
                    ? recap.annuel.moyenne >= 10 && (recap.annuel.decision === 'ADMIS' || recap.annuel.decision === 'DÉROGÉ')
                    : recap.annuel.creditsValides >= 60 && recap.annuel.decision === 'ADMIS';

                resultats.push({
                    ...etudiant,
                    photo_url: etudiant.photo_url || null,
                    moyenne_generale: totaux.moyenne,
                    credits_valides: totaux.creditsValides,
                    credits_total: totaux.creditsTotal,
                    decision,
                    eligible_classe_superieure: eligibleClasseSuperieure,
                    ues: uesAvecResultats
                });
            }
        }

        return { etudiants: resultats, admis, deroges, ajournes, sommeMoyennes, totalAvecMoyenne };

    } catch (error) {
        console.error(`❌ Erreur traitement groupe ${groupeId}:`, error.message);
        return { etudiants: [], admis: 0, deroges: 0, ajournes: 0, sommeMoyennes: 0, totalAvecMoyenne: 0 };
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

        const params = [];
        let query;
        let paramIndex;

        if (anneeAcademiqueId) {
            // ✅ vue_position_academique : source unique, couvre à la fois les étudiants encore sur
            // cette position (live) et ceux qui l'ont quittée depuis une réinscription (position
            // figée dans historique_inscription) — autrefois, filtrer sur la position LIVE de
            // l'étudiant (annee_academique_id ne reflète que sa dernière année) ne remontait
            // quasiment aucun résultat pour une année déjà close.
            query = `
                SELECT id, matricule_iipea, nom, prenoms, groupe_id, niveau_id, id_filiere, photo_url,
                       filiere_nom, filiere_sigle, type_filiere, niveau_libelle, groupe_nom,
                       niveau_libelle_etudiant, statut_etudiant, curcus_id
                FROM (
                    SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id, e.niveau_id, e.id_filiere,
                           e.photo_url,
                           f.nom as filiere_nom, f.sigle as filiere_sigle,
                           tf.libelle as type_filiere,
                           n.libelle as niveau_libelle,
                           g.nom as groupe_nom,
                           COALESCE(n.libelle, '') as niveau_libelle_etudiant,
                           e.statut_paiement as statut_etudiant,
                           e.curcus_id
                    FROM vue_position_academique e
                    LEFT JOIN filiere f ON f.id = e.id_filiere
                    LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
                    LEFT JOIN niveau n ON n.id = e.niveau_id
                    LEFT JOIN groupe g ON g.id = e.groupe_id
                    WHERE e.annee_academique_id = $1
                    AND e.standing = 'Inscrit'
                ) src
                WHERE 1=1
            `;
            params.push(anneeAcademiqueId);
            paramIndex = 2;
        } else {
            query = `
                SELECT
                    e.id, e.matricule_iipea, e.nom, e.prenoms, e.groupe_id, e.niveau_id, e.id_filiere,
                    e.photo_url, e.curcus_id,
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
            paramIndex = 1;
        }

        const colPrefix = anneeAcademiqueId ? '' : 'e.';

        if (filiereId) {
            query += ` AND ${colPrefix}id_filiere = $${paramIndex}`;
            params.push(filiereId);
            paramIndex++;
        }

        if (niveauId) {
            query += ` AND ${colPrefix}niveau_id = $${paramIndex}`;
            params.push(niveauId);
            paramIndex++;
        }

        query += ` ORDER BY ${colPrefix}nom, ${colPrefix}prenoms`;

        const result = await db.query(query, params);
        const etudiants = result.rows;

        if (etudiants.length === 0) {
            return res.json({
                success: true,
                total_etudiants: 0,
                semestre: semestreId || null,
                stats: {
                    admis: 0,
                    deroges: 0,
                    ajournes: 0,
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
        // ✅ Fix bug année→filière→niveau (2026-08-17) : `niveau` a une colonne `anneeacademique_id`
        // — cette requête ne la filtrait pas du tout et ramenait donc les niveaux de TOUTES les
        // années pour toutes les filières, faisant apparaître dans le filtre "Niveau" des niveaux
        // appartenant en réalité à la configuration d'une autre année académique. Filtrée ici
        // uniquement quand une année est sélectionnée (comportement inchangé sinon).
        const filieresQuery = `SELECT id, nom, sigle, type_filiere_id FROM filiere ORDER BY nom`;
        const niveauxQuery = anneeAcademiqueId
            ? `SELECT id, libelle, filiere_id, prix_formation FROM niveau WHERE anneeacademique_id = $1 ORDER BY libelle`
            : `SELECT id, libelle, filiere_id, prix_formation FROM niveau ORDER BY libelle`;
        const anneeQuery = `SELECT id, annee FROM anneeacademique ORDER BY annee DESC`;

        const [filieresResult, niveauxResult, anneeResult] = await Promise.all([
            db.query(filieresQuery),
            db.query(niveauxQuery, anneeAcademiqueId ? [anneeAcademiqueId] : []),
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
        let totalDeroges = 0;
        let totalAjournes = 0;
        let sommeMoyennes = 0;
        let totalAvecMoyenne = 0;

        for (const resultat of resultatsParGroupe) {
            resultatsEtudiants.push(...resultat.etudiants);
            totalAdmis += resultat.admis;
            totalDeroges += resultat.deroges;
            totalAjournes += resultat.ajournes;
            sommeMoyennes += resultat.sommeMoyennes;
            totalAvecMoyenne += resultat.totalAvecMoyenne;
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
        // ✅ Le taux de réussite inclut les dérogés (ils passent bien en classe supérieure).
        const tauxReussite = resultatsEtudiants.length > 0
            ? parseFloat((((totalAdmis + totalDeroges) / resultatsEtudiants.length) * 100).toFixed(2))
            : 0;

        res.json({
            success: true,
            total_etudiants: resultatsEtudiants.length,
            semestre: semestreId || null,
            stats: {
                admis: totalAdmis,
                deroges: totalDeroges,
                ajournes: totalAjournes,
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
                eligible_classe_superieure: e.eligible_classe_superieure,
                type_filiere: e.type_filiere || null,
                credits_valides: e.credits_valides,
                credits_total: e.credits_total,
                // ✅ Statut financier SOLDE/NON_SOLDE (2026-08-17) — déjà résolu par année dans la
                // requête étudiants ci-dessus (vue_position_academique.statut_paiement, ou
                // scolarite.statut_etudiant courant si aucune année sélectionnée), transitait déjà
                // à travers traiterUnGroupe (spread `...etudiant`) mais n'était jamais réexposé ici.
                statut_etudiant: e.statut_etudiant || null
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

        const params = [];
        let query;
        let paramIndex;

        if (anneeAcademiqueId) {
            // ✅ vue_position_academique : même bascule que getStatsResultats — retrouve les
            // étudiants réellement positionnés cette année-là, qu'ils y soient encore (live) ou
            // qu'ils l'aient quittée depuis (position figée dans historique_inscription).
            query = `
                SELECT id, groupe_id, niveau_id, id_filiere, filiere_nom, filiere_sigle,
                       niveau_libelle, groupe_nom, niveau_libelle_etudiant, type_filiere, curcus_id
                FROM (
                    SELECT e.id, e.groupe_id, e.niveau_id, e.id_filiere,
                           f.nom as filiere_nom, f.sigle as filiere_sigle,
                           n.libelle as niveau_libelle,
                           g.nom as groupe_nom,
                           COALESCE(n.libelle, '') as niveau_libelle_etudiant,
                           tf.libelle as type_filiere,
                           e.curcus_id
                    FROM vue_position_academique e
                    LEFT JOIN filiere f ON f.id = e.id_filiere
                    LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
                    LEFT JOIN niveau n ON n.id = e.niveau_id
                    LEFT JOIN groupe g ON g.id = e.groupe_id
                    WHERE e.annee_academique_id = $1
                    AND e.standing = 'Inscrit'
                ) src
                WHERE 1=1
            `;
            params.push(anneeAcademiqueId);
            paramIndex = 2;
        } else {
            query = `
                SELECT
                    e.id, e.groupe_id, e.niveau_id, e.id_filiere, e.curcus_id,
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
            paramIndex = 1;
        }

        const colPrefix = anneeAcademiqueId ? '' : 'e.';

        if (filiereId) {
            query += ` AND ${colPrefix}id_filiere = $${paramIndex}`;
            params.push(filiereId);
            paramIndex++;
        }
        if (niveauId) {
            query += ` AND ${colPrefix}niveau_id = $${paramIndex}`;
            params.push(niveauId);
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
                        deroges: 0,
                        ajournes: 0,
                        sommeMoyennes: 0,
                        totalAvecMoyenne: 0
                    });
                }

                const rec = recapMap.get(cle);
                rec.total += 1;
                // ✅ Présentation métier (2026-08-24) : Total / Admis / Dérogés / Ajournés — trois
                // catégories DISTINCTES et mutuellement exclusives (somme = Total), plus de notion
                // de "à reprendre" dans ce récapitulatif (ancienne métrique ECUE, jamais une
                // catégorie de décision — cf. audit précédent). DÉROGÉ reste un cas universitaire
                // uniquement (jamais renvoyé pour typeTraitement 'professionnel').
                if (e.decision === 'ADMIS') rec.admis += 1;
                else if (e.decision === 'DÉROGÉ') rec.deroges += 1;
                else rec.ajournes += 1;
                if (e.moyenne_generale > 0) {
                    rec.sommeMoyennes += e.moyenne_generale;
                    rec.totalAvecMoyenne += 1;
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
                deroges: r.deroges,
                ajournes: r.ajournes,
                // ✅ Le taux de réussite inclut les dérogés (ils passent bien en classe supérieure),
                // conformément au sens métier inchangé de cet indicateur.
                taux_reussite: r.total > 0 ? parseFloat((((r.admis + r.deroges) / r.total) * 100).toFixed(2)) : 0,
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