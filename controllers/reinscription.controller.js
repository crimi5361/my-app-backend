const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const PVController = require('./PV.controller');
const PaiementEspaceController = require('./PaiementEespaceetudiant.controller');
const TarifController = require('./tarif.controller');
const { validatePhotoFile } = require('./etudiant.controller');
const { avecRetryCodeUnique } = require('../services/codePaiement.service');
const { requiertChoixParcours } = require('../services/parcoursProfessionnel.service');
const { validerReferentielsIdentite } = require('../services/referentielIdentite.service');

// session_bac retiré (obsolète, remplacé par annee_bac) — la colonne reste en base mais n'est
// plus lue ni écrite par aucun code de l'application ; suppression physique différée à une
// migration dédiée ultérieure.
const IDENTITE_FIELDS = [
  'telephone', 'email', 'lieu_residence', 'contact_parent', 'contact_parent_2',
  'adresse_parent_1', 'adresse_parent_2', 'numero_acte_naissance', 'numero_piece_identite',
  'mention_bac', 'annee_bac', 'sexe', 'nationalite', 'pays_naissance', 'serie_bac',
  'etablissement_origine'
];
// Exportée pour réutilisation par le portail Web public et la page Vérification (même liste,
// aucune duplication de la définition).
exports.IDENTITE_FIELDS = IDENTITE_FIELDS;

// Moteur de décision unique (financier + académique) — extrait de traiterDemandeReinscription
// pour être réutilisé tel quel par le portail Web (situation affichée + garde-fou de soumission),
// sans jamais recalculer ces règles une seconde fois côté client.
exports.evaluerEligibiliteReinscription = (situationAcademique, situationFinanciere) => {
  const financierConforme = !situationFinanciere || situationFinanciere.is_solde;
  const academiqueValide = !!situationAcademique && ['ADMIS', 'DÉROGÉ'].includes(situationAcademique.decision);
  return { financierConforme, academiqueValide };
};

// Détecte un changement de cycle (⇒ statut scolaire forcé "Non affecté", et donc tarif calculé
// sur ce statut) — moteur unique réutilisé identiquement par la soumission
// (traiterDemandeReinscription) ET par l'affichage de la situation (getSituationReinscriptionPublic),
// pour que le statut/tarif annoncé au candidat avant soumission soit toujours celui qui sera
// réellement enregistré.
//
// ✅ Une filière est parfois un même "conteneur" pour plusieurs cycles successifs en base (ex.
// LICENCE 3 / MASTER 1 / MASTER 2 d'une même filière partagent le même filiere_id) — comparer
// uniquement filiere_id ne suffit donc pas pour détecter ces 3 transitions, imposées quel que
// soit le filiere_id :
exports.determinerChangementDeCycle = ({
  niveauActuelLibelle, niveauRetenuLibelle, filiereActuelleId, filiereRetenueId, orientationsValides = []
}) => {
  const actuel = (niveauActuelLibelle || '').trim();
  const retenu = (niveauRetenuLibelle || '').trim();

  const transitionForcee =
    (/^BTS\s*2$/i.test(actuel) && /^LICENCE 3 PRO$/i.test(retenu)) ||
    (/^LICENCE\s*3$/i.test(actuel) && !/PRO/i.test(actuel) && /^MASTER\s*1$/i.test(retenu)) ||
    (/^MASTER\s*1$/i.test(actuel) && /^MASTER\s*2$/i.test(retenu));
  if (transitionForcee) return true;

  // Sinon, détection historique par filière différente, avec l'exception "orientation" déjà en
  // place (ex. SCIENCES JURIDIQUES → OPTION PRIVE/PUBLIC en L3 n'est pas un changement de cycle).
  let changement = !!filiereRetenueId && parseInt(filiereRetenueId, 10) !== filiereActuelleId;
  if (changement && orientationsValides.some(o => o.filiere_id === parseInt(filiereRetenueId, 10))) {
    changement = false;
  }
  return changement;
};

// Pièces justificatives d'un dossier de réinscription : le jeu général (contexte='admission',
// toujours) + les 2 pièces spécifiques BTS 2 → Licence 3 PRO (contexte='reinscription') si
// applicable. Unique source de vérité — le frontend n'affiche que cette liste, jamais recalculée
// ni codée en dur côté client. Réutilisée à l'identique par la vérification (dossier déjà créé,
// gating sur niveau_precedent/niveau_retenu déjà enregistrés) et par la création agent (dossier
// pas encore créé, gating sur le niveau ACTUEL de l'étudiant — même signal que celui déjà utilisé
// par getSituationReinscriptionPublic pour exposer options.bts2_l3pro au portail Web).
exports.chargerPiecesReinscription = async (etudiantId, inclureBts2L3Pro) => {
  const contextesDocuments = inclureBts2L3Pro ? "('admission', 'reinscription')" : "('admission')";
  const documentsResult = await db.query(
    `SELECT td.code, td.libelle, td.obligatoire, COALESCE(de.fourni, false) AS fourni,
            COALESCE(de.declare_par_etudiant, false) AS declare_par_etudiant
     FROM type_document td
     LEFT JOIN document_etudiant de ON de.type_document_id = td.id AND de.etudiant_id = $1
     WHERE td.contexte IN ${contextesDocuments} AND td.code != 'PHOTO'
     ORDER BY td.id`,
    [etudiantId]
  );
  return documentsResult.rows;
};

// Année académique "en cour" pour un site donné — jamais laissée au choix de l'agent.
const getAnneeEnCoursPourSite = async (siteId) => {
  const result = await db.query(
    `SELECT a.id, a.annee FROM anneeacademique a
     JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
     WHERE s.site_id = $1 AND s.etat = 'en cour'
     LIMIT 1`,
    [siteId]
  );
  return result.rows[0] || null;
};
// Exportée pour réutilisation par le portail Web public (réinscription en ligne) et la page
// Vérification — même source unique que l'agent, aucune duplication.
exports.getAnneeEnCoursPourSite = getAnneeEnCoursPourSite;

// ✅ Détection dynamique des orientations de filière (ex: SCIENCES JURIDIQUES qui se scinde en
// "(OPTION PRIVE)"/"(OPTION PUBLIC)" en Licence 3). Aucune table de correspondance : on cherche,
// pour l'année/site cible, les filières dont le nom commence par le nom de la filière actuelle,
// est strictement plus long, et contient "OPTION". Fonctionne pour toute future filière à
// options sans modification de code, du moment que la convention de nommage est respectée.
const trouverOrientationsFiliere = async (filiereActuelleId, niveauLibelle, anneeCibleId, siteId) => {
  if (!filiereActuelleId || !niveauLibelle || !anneeCibleId || !siteId) return [];

  // ✅ CRUD Filière/Niveau/Orientation : priorité à la relation explicite filiere.filiere_mere_id
  // (renseignée par le nouvel admin) — plus robuste que le matching par nom. On ne retombe sur
  // la détection dynamique par nom que si aucune filière-option n'est explicitement rattachée,
  // pour ne jamais régresser sur les filières déjà en place avant ce chantier.
  const viaRelationExplicite = await db.query(
    `SELECT DISTINCT f.id AS filiere_id, f.nom, f.sigle, n.id AS niveau_id
     FROM filiere f
     JOIN niveau n ON n.filiere_id = f.id
     WHERE f.filiere_mere_id = $1 AND n.libelle = $2 AND n.anneeacademique_id = $3 AND n.site_id = $4
     ORDER BY f.nom`,
    [filiereActuelleId, niveauLibelle, anneeCibleId, siteId]
  );
  if (viaRelationExplicite.rows.length > 0) return viaRelationExplicite.rows;

  const filiereActuelle = await db.query('SELECT nom FROM filiere WHERE id = $1', [filiereActuelleId]);
  const nomBase = (filiereActuelle.rows[0]?.nom || '').trim();
  if (!nomBase) return [];
  const result = await db.query(
    `SELECT DISTINCT f.id AS filiere_id, f.nom, f.sigle, n.id AS niveau_id
     FROM filiere f
     JOIN niveau n ON n.filiere_id = f.id
     WHERE n.libelle = $1 AND n.anneeacademique_id = $2 AND n.site_id = $3
       AND UPPER(TRIM(f.nom)) LIKE UPPER($4) || '%'
       AND UPPER(TRIM(f.nom)) != UPPER($4)
       AND UPPER(f.nom) LIKE '%OPTION%'
     ORDER BY f.nom`,
    [niveauLibelle, anneeCibleId, siteId, nomBase]
  );
  return result.rows;
};
// Exportée pour la même raison que getAnneeEnCoursPourSite ci-dessus.
exports.trouverOrientationsFiliere = trouverOrientationsFiliere;

// ✅ Chantier "Orientations de réinscription LICENCE 2 PRO → LICENCE 3 PRO" (2026-08-29) —
// SOURCE UNIQUE des orientations explicitement configurées par l'administration (table
// `orientation_reinscription`), pour les filières dont la LICENCE 3 PRO n'existe volontairement
// pas sous le même nom (ex. AD → ADAF/MAM). Exportée pour être appelée À L'IDENTIQUE par
// getDossierReinscription (agent, ci-dessous) ET publicReinscription.controller.js (portail) —
// jamais deux moteurs de résolution différents.
//
// Distincte de `trouverOrientationsFiliere` ci-dessus (qui reste inchangée, toujours utilisée
// pour le cas SEG/filiere_mere_id) : les deux sources sont simplement FUSIONNÉES par les
// appelants, jamais l'une ne remplace l'autre — aucune régression sur SEG.
//
// Cloisonnement par année académique garanti PAR CONSTRUCTION : `niveauOrigineId` désigne un
// niveau.id précis (donc une seule anneeacademique_id) — aucune colonne année supplémentaire
// nécessaire, aucune fuite possible vers une autre année.
const resoudreOrientationsNiveau = async (niveauOrigineId) => {
  if (!niveauOrigineId) return [];
  const result = await db.query(
    `SELECT n.id AS niveau_id, n.libelle AS niveau_libelle, n.filiere_id,
            f.nom AS filiere_nom, f.sigle AS filiere_sigle
     FROM orientation_reinscription orr
     JOIN niveau n ON n.id = orr.niveau_destination_id
     JOIN filiere f ON f.id = n.filiere_id
     WHERE orr.niveau_origine_id = $1
     ORDER BY f.nom`,
    [niveauOrigineId]
  );
  return result.rows;
};
exports.resoudreOrientationsNiveau = resoudreOrientationsNiveau;

// ✅ Libellé du niveau "suivant" générique, déduit du libellé actuel — utilisé UNIQUEMENT comme
// filet de secours pour la recherche d'orientations quand niveau.niveau_suivant_id n'est pas
// configuré (cas des filières génériques qui se scindent en options : leur propre "LICENCE 3"
// n'existe souvent pas en tant que ligne niveau, seules les options l'ont). Ne remplace jamais
// niveau_suivant_id pour la progression normale — sert seulement à savoir QUEL libellé chercher
// parmi les filières dérivées.
const LIBELLE_NIVEAU_SUIVANT = {
  'LICENCE 1': 'LICENCE 2', 'LICENCE 2': 'LICENCE 3', 'LICENCE 3': 'MASTER 1',
  'MASTER 1': 'MASTER 2',
  'LICENCE 1 PRO': 'LICENCE 2 PRO', 'LICENCE 2 PRO': 'LICENCE 3 PRO', 'LICENCE 3 PRO': 'MASTER 1 PRO',
  'MASTER 1 PRO': 'MASTER 2 PRO',
  'BTS 1': 'BTS 2',
};

const libelleNiveauSuivantGenerique = (libelleActuel) =>
  LIBELLE_NIVEAU_SUIVANT[(libelleActuel || '').trim().toUpperCase()] || null;
// ✅ Correctif portail public (2026-08-29) : exportée pour être réutilisée telle quelle par
// publicReinscription.controller.js — jusqu'ici privée à ce module, ce qui empêchait le portail
// de trouver les orientations d'une filière générique (ex. SEG → SEG(ECO)/SEG(GES)) quand
// niveau_suivant_id est légitimement absent. Comportement/table inchangés, uniquement exportée.
exports.libelleNiveauSuivantGenerique = libelleNiveauSuivantGenerique;

// ✅ Parcours JOUR/SOIR : requiertChoixParcours est désormais partagée avec l'admission
// (services/parcoursProfessionnel.service.js), pour que le même niveau académique déclenche
// exactement la même exigence de choix, que l'étudiant y arrive par admission directe,
// progression normale ou changement de cycle en réinscription.

// ─── GET recherche d'étudiant par nom / prénoms / matricule IIPEA ──────────
exports.rechercherEtudiant = async (req, res) => {
  try {
    const { q } = req.query;
    const siteId = req.user?.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site non identifié pour votre compte.' });
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)' : '';
    const params = ecoleId !== null ? [siteId, `%${q.trim()}%`, ecoleId] : [siteId, `%${q.trim()}%`];

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              f.nom AS filiere, n.libelle AS niveau
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       WHERE e.site_id = $1
         AND e.standing = 'Inscrit'
         AND (
           e.nom ILIKE $2 OR e.prenoms ILIKE $2 OR e.matricule_iipea ILIKE $2
           OR (e.nom || ' ' || e.prenoms) ILIKE $2
           OR (e.prenoms || ' ' || e.nom) ILIKE $2
         )
         ${ecoleCond}
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      params
    );

    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET dossier complet d'un étudiant pour réinscription ──────────────────
exports.getDossierReinscription = async (req, res) => {
  try {
    const { id } = req.params;

    const etudiantResult = await db.query(
      `SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.date_naissance, e.photo_url,
              e.telephone, e.email, e.lieu_residence, e.contact_parent, e.contact_parent_2,
              e.nom_parent_1, e.nom_parent_2, e.adresse_parent_1, e.adresse_parent_2,
              e.numero_acte_naissance, e.numero_piece_identite, e.mention_bac, e.annee_bac,
              e.engagement_accepte, e.ip_ministere, e.statut_scolaire,
              e.niveau_id, e.id_filiere, e.site_id, e.annee_academique_id, e.scolarite_id,
              n.libelle AS niveau_libelle, n.niveau_suivant_id,
              f.nom AS filiere_nom, f.departement_id, tf.libelle AS type_filiere_libelle,
              d.nom AS departement_nom, d.ecole_id,
              ec.nom AS ecole_nom,
              s.nom AS site_nom
       FROM etudiant e
       JOIN niveau n ON n.id = e.niveau_id
       JOIN filiere f ON f.id = e.id_filiere
       LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       JOIN site s ON s.id = e.site_id
       WHERE e.id = $1`,
      [id]
    );

    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    // Année académique cible : toujours l'année "en cour" du site, jamais un choix manuel —
    // remontée avant le calcul du niveau proposé, nécessaire pour chercher les orientations.
    const anneeCible = await getAnneeEnCoursPourSite(etudiant.site_id);

    // Situation financière / académique de l'année en cours (services réutilisés)
    const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(etudiant.id);

    let situationAcademique = null;
    let academiqueErreur = null;
    try {
      situationAcademique = await PVController.calculerResultatsAnnuelsEtudiant(etudiant.id);
    } catch (err) {
      academiqueErreur = err.message;
    }

    // ✅ Moteur de décision unique (même fonction que getSituationReinscriptionPublic, portail
    // Web) : une progression n'est jamais calculée pour un étudiant dont la décision académique
    // ne l'autorise pas (AJOURNÉ, ou décision pas encore connue) — seul le redoublement reste
    // possible dans ce cas. Évite de recalculer/dupliquer cette règle une seconde fois ici.
    const { academiqueValide } = exports.evaluerEligibiliteReinscription(situationAcademique, situationFinanciere);

    // Niveau proposé (successeur configuré, même filière) + tarif associé.
    // ⚠️ Avec une filière préparée progressivement (certains niveaux d'une année pas encore
    // ouverts), niveau.niveau_suivant_id peut encore pointer vers un niveau de l'ANCIENNE année
    // (chaînage provisoire, non corrigé tant que le niveau cible n'a pas été créé pour l'année en
    // cours — voir rechainerNiveauCree). On ne propose JAMAIS ce niveau automatiquement dans ce
    // cas : silencieusement rediriger l'agent vers un niveau de la mauvaise année a été la cause
    // du bug historique de classes dupliquées. progressionBloqueeMessage explique pourquoi à
    // l'agent au lieu de résoudre en silence.
    let niveauPropose = null;
    let progressionBloqueeMessage = null;
    if (academiqueValide && etudiant.niveau_suivant_id) {
      const niveauProposeResult = await db.query(
        `SELECT n.id, n.libelle, n.filiere_id, n.anneeacademique_id FROM niveau n WHERE n.id = $1`,
        [etudiant.niveau_suivant_id]
      );
      const candidat = niveauProposeResult.rows[0] || null;
      if (candidat && anneeCible && candidat.anneeacademique_id !== anneeCible.id) {
        progressionBloqueeMessage = `Le niveau "${candidat.libelle}" n'est pas encore configuré pour l'année ${anneeCible.annee} : préparez d'abord cette filière depuis Gestion des filières avant de proposer une progression automatique.`;
      } else {
        niveauPropose = candidat;
      }
    }

    // ✅ Accès Master strict : un passage Licence → Master n'est proposé que si l'année de
    // Licence en cours a été validée en ADMIS (pas DÉROGÉ) — crédits du cycle Licence
    // intégralement validés. Sinon, aucune progression automatique n'est proposée (seuls le
    // redoublement et une éventuelle réorientation manuelle restent possibles côté front).
    const cibleEstMaster = /^MASTER/i.test(niveauPropose?.libelle || '');
    const actuelEstLicence = /^LICENCE/i.test(etudiant.niveau_libelle || '');
    if (niveauPropose && cibleEstMaster && actuelEstLicence && situationAcademique?.decision !== 'ADMIS') {
      niveauPropose = null;
    }

    if (niveauPropose) {
      niveauPropose.tarif = await TarifController.calculerMontantScolarite(niveauPropose.id, etudiant.statut_scolaire, 'reinscription');
    }

    // ✅ Orientations de filière (ex: SCIENCES JURIDIQUES → OPTION PRIVE/PUBLIC en L3) :
    // détectées dynamiquement pour le niveau normalement proposé. Si présentes, la progression
    // automatique ne suffit plus — le front doit imposer un choix explicite.
    //
    // ⚠️ Le libellé cible ne doit JAMAIS dépendre uniquement de niveau.niveau_suivant_id : les
    // filières génériques qui se scindent en options (ex: SCIENCES ECONOMIQUES ET DE GESTION)
    // n'ont souvent aucune ligne "LICENCE 3" pour elles-mêmes — seules leurs options en ont une —
    // donc niveau_suivant_id y est légitimement absent. On utilise le libellé de niveauPropose
    // quand il existe (cas normal), sinon on déduit le libellé suivant générique à partir du
    // niveau actuel (LICENCE 2 → LICENCE 3, etc.) uniquement pour cette recherche.
    //
    // Pas de recherche d'orientation quand la progression n'est pas autorisée (AJOURNÉ) : il n'y
    // a alors aucun "niveau normalement proposé" vers lequel orienter l'étudiant.
    let orientationsDisponibles = [];
    const libelleCibleOrientation = niveauPropose?.libelle || libelleNiveauSuivantGenerique(etudiant.niveau_libelle);
    if (academiqueValide && libelleCibleOrientation && anneeCible) {
      const orientations = await trouverOrientationsFiliere(
        etudiant.id_filiere, libelleCibleOrientation, anneeCible.id, etudiant.site_id
      );

      // ✅ Chantier "Orientations de réinscription" (2026-08-29) : quand il n'existe AUCUNE
      // progression directe (niveau_suivant_id), on complète avec les orientations
      // EXPLICITEMENT configurées par l'administration (orientation_reinscription) — ex. AD
      // LICENCE 2 PRO → ADAF/MAM LICENCE 3 PRO. Fusion, jamais un remplacement : ne casse jamais
      // le cas SEG (filiere_mere_id, ci-dessus), qui continue de fonctionner à l'identique.
      // Dédupliqué par niveau_id — garde défensive, pas de duplicata attendu en pratique.
      if (!niveauPropose) {
        const orientationsExplicites = await resoudreOrientationsNiveau(etudiant.niveau_id);
        const dejaVus = new Set(orientations.map((o) => o.niveau_id));
        for (const o of orientationsExplicites) {
          if (!dejaVus.has(o.niveau_id)) {
            orientations.push({ filiere_id: o.filiere_id, nom: o.filiere_nom, sigle: o.filiere_sigle, niveau_id: o.niveau_id });
            dejaVus.add(o.niveau_id);
          }
        }
      }

      orientationsDisponibles = await Promise.all(orientations.map(async (o) => ({
        ...o,
        tarif: await TarifController.calculerMontantScolarite(o.niveau_id, etudiant.statut_scolaire, 'reinscription')
      })));
    }

    // ✅ Si des orientations existent mais qu'aucun niveau_suivant_id n'a permis de résoudre
    // niveauPropose (cas des filières génériques sans ligne "LICENCE 3" propre), afficher quand
    // même le libellé cible pour information ("Niveau proposé : LICENCE 3") — sans id ni tarif
    // exploitables, puisque le vrai choix se fait via orientations_disponibles, pas ici.
    if (!niveauPropose && orientationsDisponibles.length > 0) {
      niveauPropose = { id: null, libelle: libelleCibleOrientation, filiere_id: null, tarif: null };
    }

    // ✅ Parcours JOUR/SOIR : certains niveaux professionnels avancés exigent un choix explicite
    // avant finalisation (voir requiertChoixParcours) — le front doit bloquer la soumission tant
    // qu'aucune option n'est sélectionnée. parcoursOptions est toujours renvoyée (pas seulement
    // quand parcoursRequis est vrai côté niveau SUGGÉRÉ) : en mode "changement de cycle", le
    // niveau réellement ciblé est choisi librement par l'agent et peut très bien nécessiter un
    // choix de parcours même quand la progression suggérée n'en nécessite pas.
    const parcoursRequis = requiertChoixParcours(etudiant.type_filiere_libelle, niveauPropose?.libelle);
    const parcoursResult = await db.query(
      `SELECT id, type_parcours FROM curcus WHERE type_parcours != 'Universitaire' ORDER BY type_parcours`
    );
    const parcoursOptions = parcoursResult.rows;

    // Progression suggérée : ADMIS/DÉROGÉ → niveau supérieur ; sinon redoublement
    let niveauRetenuPropose = etudiant.niveau_id;
    if (academiqueValide && niveauPropose?.id) {
      niveauRetenuPropose = niveauPropose.id;
    }

    const reinscriptionExistante = await db.query(
      `SELECT * FROM reinscription WHERE etudiant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [etudiant.id]
    );

    const tarifNiveauActuel = await TarifController.calculerMontantScolarite(etudiant.niveau_id, etudiant.statut_scolaire, 'reinscription');

    // ✅ Pièces justificatives — unique source de vérité (chargerPiecesReinscription), même
    // mécanisme que la Vérification. Gating BTS 2 → Licence 3 PRO basé sur le niveau ACTUEL de
    // l'étudiant (dossier pas encore créé à ce stade) — même signal que celui déjà utilisé par
    // getSituationReinscriptionPublic pour exposer options.bts2_l3pro au portail Web. Le frontend
    // n'a donc aucune détection à faire : il affiche exactement cette liste.
    const estBts2Actuel = /^BTS\s*2$/i.test((etudiant.niveau_libelle || '').trim());
    const documents = await exports.chargerPiecesReinscription(etudiant.id, estBts2Actuel);

    res.status(200).json({
      success: true,
      data: {
        etudiant,
        hierarchie: {
          ecole: etudiant.ecole_nom,
          departement: etudiant.departement_nom,
          filiere: etudiant.filiere_nom,
          niveau: etudiant.niveau_libelle,
          site: etudiant.site_nom
        },
        situation_financiere: situationFinanciere,
        situation_academique: situationAcademique,
        situation_academique_erreur: academiqueErreur,
        niveau_propose: niveauPropose,
        progression_bloquee_message: progressionBloqueeMessage,
        niveau_retenu_propose: niveauRetenuPropose,
        parcours_requis: parcoursRequis,
        parcours_options: parcoursOptions,
        orientations_disponibles: orientationsDisponibles,
        tarif_niveau_actuel: tarifNiveauActuel,
        annee_cible: anneeCible,
        reinscription_existante: reinscriptionExistante.rows[0] || null,
        documents
      }
    });
  } catch (error) {
    console.error('Erreur getDossierReinscription:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── Moteur métier partagé (agent / portail Web / Vérification) ────────────
// Extraction du corps de l'ancien demanderReinscription — comportement strictement identique
// pour mode='creation'/sourceInscription='agent' (voir non-régression testée avant tout
// branchement du portail Web). `mode` contrôle uniquement les effets de bord :
//  - 'creation' (agent, portail Web) : génère un nouveau code RI si éligible et qu'aucun code
//    n'existe encore, crée la ligne reinscription si absente.
//  - 'verification' (page Vérification) : opère uniquement sur une ligne déjà existante (erreur
//    DOSSIER_INTROUVABLE sinon — ne crée jamais de dossier), ne régénère jamais code_paiement
//    (réutilise systématiquement celui déjà attribué).
// Retourne { erreur: { status, code, message } } ou le résultat de traitement (erreur: null).
exports.traiterDemandeReinscription = async (client, {
  etudiantId, niveauRetenuId, idFiliereChoisie, curcusId,
  nombreVersementsPrevu, modalitePaiement, identiteFields, photoUrl,
  traitePar, sourceInscription, mode
}) => {
  if (!niveauRetenuId) {
    return { erreur: { status: 400, code: null, message: 'Le niveau retenu est requis.' } };
  }

  const etudiantResult = await client.query('SELECT * FROM etudiant WHERE id = $1', [etudiantId]);
  if (etudiantResult.rows.length === 0) {
    return { erreur: { status: 404, code: null, message: 'Étudiant introuvable.' } };
  }
  const etudiant = etudiantResult.rows[0];

  // Année cible déterminée côté serveur (jamais fournie par le client)
  const anneeCible = await getAnneeEnCoursPourSite(etudiant.site_id);
  if (!anneeCible) {
    return { erreur: { status: 409, code: null, message: "Aucune année académique en cours pour ce site." } };
  }

  // ✅ Garde-fou définitif (filière préparée progressivement) : le niveau retenu — qu'il vienne
  // d'une progression automatique, d'un changement de cycle choisi manuellement ou d'une
  // orientation — doit obligatoirement appartenir à l'année académique cible. Un niveau existant
  // mais rattaché à une autre année (filière pas encore préparée pour cette année) est refusé
  // explicitement ici, jamais résolu silencieusement.
  const niveauRetenuCheck = await client.query('SELECT id, libelle, anneeacademique_id FROM niveau WHERE id = $1', [niveauRetenuId]);
  if (niveauRetenuCheck.rows.length === 0) {
    return { erreur: { status: 404, code: null, message: 'Niveau retenu introuvable.' } };
  }
  if (niveauRetenuCheck.rows[0].anneeacademique_id !== anneeCible.id) {
    return {
      erreur: {
        status: 409,
        code: 'NIVEAU_ANNEE_INCORRECTE',
        message: `Le niveau "${niveauRetenuCheck.rows[0].libelle}" n'est pas configuré pour l'année académique en cours (${anneeCible.annee}). Préparez d'abord cette filière depuis Gestion des filières.`
      }
    };
  }

  const existingResult = await client.query(
    `SELECT * FROM reinscription WHERE etudiant_id = $1 AND anneeacademique_id = $2 FOR UPDATE`,
    [etudiantId, anneeCible.id]
  );
  const existing = existingResult.rows[0] || null;

  if (mode === 'verification' && !existing) {
    return { erreur: { status: 404, code: 'DOSSIER_INTROUVABLE', message: "Aucun dossier de réinscription existant pour cet étudiant." } };
  }

  if (existing && existing.statut === 'inscrit') {
    return {
      erreur: {
        status: 409,
        code: 'DEJA_INSCRIT',
        message: `Cet étudiant est déjà inscrit pour l'année académique ${anneeCible.annee}.`
      }
    };
  }

  const situationFinanciere = await PaiementEspaceController.getSituationFinanciere(etudiantId);
  let situationAcademique = null;
  try {
    situationAcademique = await PVController.calculerResultatsAnnuelsEtudiant(etudiantId);
  } catch (err) {
    console.warn('Résultats académiques indisponibles pour réinscription:', err.message);
  }

  const niveauActuelResult = await client.query('SELECT libelle, niveau_suivant_id FROM niveau WHERE id = $1', [etudiant.niveau_id]);
  const niveauActuelLibelle = niveauActuelResult.rows[0]?.libelle || '';
  const niveauProposeId = niveauActuelResult.rows[0]?.niveau_suivant_id || niveauRetenuId;

  const niveauRetenuInfo = await client.query(
    `SELECT n.libelle, tf.libelle AS type_filiere_libelle
     FROM niveau n
     LEFT JOIN filiere f ON f.id = n.filiere_id
     LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
     WHERE n.id = $1`,
    [niveauRetenuId]
  );
  const niveauRetenuLibelle = niveauRetenuInfo.rows[0]?.libelle || '';
  const typeFiliereRetenueLibelle = niveauRetenuInfo.rows[0]?.type_filiere_libelle || '';

  // ✅ Accès Master strict — filet de sécurité serveur (le front ne doit normalement déjà plus
  // proposer cette option) : un passage Licence → Master exige une décision ADMIS stricte sur
  // l'année de Licence en cours (crédits du cycle intégralement validés, pas de DÉROGÉ).
  if (/^MASTER/i.test(niveauRetenuLibelle) && /^LICENCE/i.test(niveauActuelLibelle)
      && situationAcademique?.decision !== 'ADMIS') {
    return {
      erreur: {
        status: 409,
        code: 'ACCES_MASTER_REFUSE',
        message: `Accès Master refusé : tous les crédits du cycle Licence doivent être validés (décision ADMIS requise, décision actuelle : ${situationAcademique?.decision || 'non évaluée'}).`
      }
    };
  }

  // ✅ Parcours JOUR/SOIR — filet de sécurité serveur (le front ne doit normalement déjà plus
  // permettre la soumission sans choix) : recalculé indépendamment de ce qu'envoie le client.
  let curcusIdValide = null;
  const parcoursRequisServeur = requiertChoixParcours(typeFiliereRetenueLibelle, niveauRetenuLibelle);
  if (parcoursRequisServeur) {
    if (!curcusId) {
      return { erreur: { status: 400, code: 'PARCOURS_REQUIS', message: 'Le choix du parcours (Jour/Soir) est obligatoire pour ce niveau.' } };
    }
    const curcusCheck = await client.query(
      `SELECT id FROM curcus WHERE id = $1 AND type_parcours != 'Universitaire'`,
      [curcusId]
    );
    if (curcusCheck.rows.length === 0) {
      return { erreur: { status: 400, code: 'PARCOURS_INVALIDE', message: 'Parcours sélectionné invalide.' } };
    }
    curcusIdValide = parseInt(curcusId, 10);
  }

  // Changement de cycle → bascule automatique en Non affecté (moteur unique, voir
  // determinerChangementDeCycle) — orientations chargées seulement si la filière diffère
  // (évite une requête inutile dans le cas courant redoublement/progression sans réorientation).
  const filiereRetenueIdNum = idFiliereChoisie ? parseInt(idFiliereChoisie, 10) : etudiant.id_filiere;
  let orientationsValides = [];
  if (filiereRetenueIdNum !== etudiant.id_filiere) {
    orientationsValides = await trouverOrientationsFiliere(
      etudiant.id_filiere, niveauRetenuLibelle, anneeCible.id, etudiant.site_id
    );
  }
  const changementDeCycle = exports.determinerChangementDeCycle({
    niveauActuelLibelle, niveauRetenuLibelle,
    filiereActuelleId: etudiant.id_filiere, filiereRetenueId: idFiliereChoisie,
    orientationsValides
  });
  const statutFinal = changementDeCycle ? 'Non affecté' : etudiant.statut_scolaire;

  // Montant calculé côté serveur (jamais fourni par le client) à partir de la grille de tarifs.
  // contexte='reinscription' : un étudiant déjà Affecté qui progresse dans le même cycle
  // conserve l'ancien tarif (150 000) — un changement de cycle a déjà basculé statutFinal sur
  // "Non affecté" ci-dessus, donc cette distinction ne s'applique jamais dans ce cas.
  const tarifApplicable = await TarifController.calculerMontantScolarite(niveauRetenuId, statutFinal, 'reinscription');
  const montantAnnuel = tarifApplicable ? tarifApplicable.montant : null;

  // Éligibilité : financièrement conforme (soldé) ET (académiquement validé OU redoublement).
  // ✅ Un redoublement (même niveau, même filière que l'actuel) n'exige aucune validation
  // académique par définition — déjà la règle appliquée à l'affichage de la situation
  // (getSituationReinscriptionPublic, candidat "redoublement" jamais gardé sur academiqueValide,
  // commentaire "le contrôle académique n'a jamais empêché un redoublement"). Généralisée ici pour
  // que la soumission ne contredise jamais ce qui a été annoncé au candidat — moteur unique,
  // réutilisé tel quel par le portail Web, l'agent et la vérification.
  const estRedoublement = parseInt(niveauRetenuId, 10) === etudiant.niveau_id && filiereRetenueIdNum === etudiant.id_filiere;
  const { financierConforme, academiqueValide } = exports.evaluerEligibiliteReinscription(situationAcademique, situationFinanciere);
  const eligible = financierConforme && (academiqueValide || estRedoublement) && montantAnnuel !== null;

  const motifs = [];
  if (!financierConforme) {
    motifs.push(`Scolarité de l'année précédente non soldée (reste à payer : ${situationFinanciere.scolarite_restante} FCFA).`);
  }
  if (!academiqueValide && !estRedoublement) {
    motifs.push(`Année académique non validée (décision : ${situationAcademique?.decision || 'non évaluée'}).`);
  }
  if (montantAnnuel === null) {
    motifs.push("Aucun tarif configuré pour ce niveau.");
  }
  const motifNonEligibilite = motifs.length > 0 ? motifs.join(' ') : null;

  // ✅ Le Select frontend guide la saisie mais ne protège pas un appel API direct — le backend
  // reste seul juge des valeurs de référentiel (sexe/nationalite/pays de naissance/série BAC/
  // établissement d'origine), pour les trois points d'entrée qui alimentent identiteFields
  // (portail Web création, agent création, agent vérification).
  const champsInvalides = await validerReferentielsIdentite(identiteFields, etudiant);
  if (champsInvalides.length > 0) {
    return {
      erreur: {
        status: 400,
        code: 'REFERENTIEL_INVALIDE',
        message: `Valeur(s) invalide(s) pour : ${champsInvalides.join(', ')}.`
      }
    };
  }

  await client.query('BEGIN');

  // Champs d'identité éditables + photo — appliqués tout de suite, indépendamment de
  // l'éligibilité au paiement (utile pour compléter les anciennes fiches incomplètes).
  const identiteValues = IDENTITE_FIELDS.map(f => identiteFields?.[f] || null);
  await client.query(
    `UPDATE etudiant SET
       photo_url = COALESCE($1, photo_url),
       telephone = COALESCE($2, telephone),
       email = COALESCE($3, email),
       lieu_residence = COALESCE($4, lieu_residence),
       contact_parent = COALESCE($5, contact_parent),
       contact_parent_2 = COALESCE($6, contact_parent_2),
       adresse_parent_1 = COALESCE($7, adresse_parent_1),
       adresse_parent_2 = COALESCE($8, adresse_parent_2),
       numero_acte_naissance = COALESCE($9, numero_acte_naissance),
       numero_piece_identite = COALESCE($10, numero_piece_identite),
       mention_bac = COALESCE($11, mention_bac),
       annee_bac = COALESCE($12, annee_bac),
       sexe = COALESCE($13, sexe),
       nationalite = COALESCE($14, nationalite),
       pays_naissance = COALESCE($15, pays_naissance),
       serie_bac = COALESCE($16, serie_bac),
       etablissement_origine = COALESCE($17, etablissement_origine)
     WHERE id = $18`,
    [photoUrl, ...identiteValues, etudiantId]
  );

  const decisionAcademique = situationAcademique?.decision || 'NON_EVALUE';
  const versementsPrevu = nombreVersementsPrevu ? parseInt(nombreVersementsPrevu, 10) : null;
  const valideScolariteFinal = sourceInscription === 'agent';

  let codePaiement = null;
  let statutDossier;
  if (eligible) {
    statutDossier = 'en_attente_paiement';
    // Réutilise le code déjà attribué à une précédente demande non finalisée (l'étudiant
    // a pu revenir corriger son dossier) plutôt que d'en régénérer un nouveau à chaque fois.
    codePaiement = existing && existing.code_paiement ? existing.code_paiement : null;
  } else {
    statutDossier = 'non_eligible';
  }
  // mode='verification' : ne jamais générer de nouveau code — la ligne existe forcément
  // (garde plus haut) et conserve son code_paiement d'origine.
  if (mode === 'verification') {
    codePaiement = existing.code_paiement;
  }

  const upsertOnce = async (code) => client.query(
    `INSERT INTO reinscription (
       etudiant_id, anneeacademique_id, niveau_precedent_id, niveau_propose_id, niveau_retenu_id,
       moyenne_annuelle, credits_valides, credits_total, decision_academique, matieres_a_reprendre,
       scolarite_soldee, montant_restant_precedent, montant_annuel_nouveau, statut, traite_par,
       code_paiement, nombre_versements_prevu, modalite_paiement, motif_non_eligibilite,
       id_filiere_retenu, statut_scolaire_retenu, curcus_id, source_inscription, valide_scolarite
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (etudiant_id, anneeacademique_id) DO UPDATE SET
       niveau_retenu_id = EXCLUDED.niveau_retenu_id,
       moyenne_annuelle = EXCLUDED.moyenne_annuelle,
       credits_valides = EXCLUDED.credits_valides,
       credits_total = EXCLUDED.credits_total,
       decision_academique = EXCLUDED.decision_academique,
       matieres_a_reprendre = EXCLUDED.matieres_a_reprendre,
       scolarite_soldee = EXCLUDED.scolarite_soldee,
       montant_restant_precedent = EXCLUDED.montant_restant_precedent,
       montant_annuel_nouveau = EXCLUDED.montant_annuel_nouveau,
       statut = EXCLUDED.statut,
       traite_par = EXCLUDED.traite_par,
       code_paiement = EXCLUDED.code_paiement,
       nombre_versements_prevu = EXCLUDED.nombre_versements_prevu,
       modalite_paiement = EXCLUDED.modalite_paiement,
       motif_non_eligibilite = EXCLUDED.motif_non_eligibilite,
       id_filiere_retenu = EXCLUDED.id_filiere_retenu,
       statut_scolaire_retenu = EXCLUDED.statut_scolaire_retenu,
       curcus_id = EXCLUDED.curcus_id,
       source_inscription = EXCLUDED.source_inscription,
       valide_scolarite = EXCLUDED.valide_scolarite,
       updated_at = now()
     RETURNING id`,
    [
      etudiantId, anneeCible.id, etudiant.niveau_id, niveauProposeId, niveauRetenuId,
      situationAcademique?.moyenne_generale ?? null, situationAcademique?.credits_valides ?? null,
      situationAcademique?.credits_total ?? null, decisionAcademique,
      situationAcademique ? JSON.stringify(situationAcademique.ecue_a_reprendre) : null,
      situationFinanciere?.is_solde ?? false, situationFinanciere?.scolarite_restante ?? 0,
      montantAnnuel, statutDossier, traitePar,
      code, versementsPrevu, modalitePaiement || null, motifNonEligibilite,
      // ✅ id_filiere_retenu doit refléter la filière effectivement choisie (orientation ou
      // changement de cycle) — indépendant de changementDeCycle, qui ne gouverne que le statut
      // d'orientation/tarif (Non affecté vs conservé).
      idFiliereChoisie ? parseInt(idFiliereChoisie, 10) : etudiant.id_filiere, statutFinal, curcusIdValide,
      sourceInscription, valideScolariteFinal
    ]
  );

  let reinscriptionId;
  if (mode !== 'verification' && eligible && !codePaiement) {
    const result = await avecRetryCodeUnique('RI', async (candidat) => {
      const r = await upsertOnce(candidat);
      codePaiement = candidat;
      return r;
    });
    reinscriptionId = result.rows[0].id;
  } else {
    const result = await upsertOnce(codePaiement);
    reinscriptionId = result.rows[0].id;
  }

  await client.query('COMMIT');

  return {
    erreur: null,
    reinscriptionId, etudiantId, anneeAcademiqueId: anneeCible.id, niveauRetenuId,
    montantAnnuel, statutDossier, eligible, codePaiement, motifNonEligibilite, changementDeCycle
  };
};

// ─── POST demander la réinscription (agent) ─────────────────────────────────
// Mince wrapper autour de traiterDemandeReinscription (mode='creation', sourceInscription='agent')
// — comportement strictement identique à l'ancienne implémentation monolithique.
exports.demanderReinscription = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { niveau_retenu_id, id_filiere, nombre_versements_prevu, modalite_paiement, curcus_id } = req.body;

    // Photo (webcam ou remplacement) — optionnelle, appliquée immédiatement : une correction
    // de fiche d'identité n'a pas de raison d'attendre le passage en caisse.
    let photoUrl = null;
    const photoFile = Array.isArray(req.files) ? req.files.find(f => f.fieldname === 'photo') : null;
    if (photoFile) {
      const validation = validatePhotoFile(photoFile);
      if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
      }
      photoUrl = `/uploads/photos/${photoFile.filename}`;
    }

    const identiteFields = Object.fromEntries(IDENTITE_FIELDS.map(f => [f, req.body[f] || null]));

    const result = await exports.traiterDemandeReinscription(client, {
      etudiantId: id,
      niveauRetenuId: niveau_retenu_id,
      idFiliereChoisie: id_filiere,
      curcusId: curcus_id,
      nombreVersementsPrevu: nombre_versements_prevu,
      modalitePaiement: modalite_paiement,
      identiteFields,
      photoUrl,
      traitePar: req.user?.id || null,
      sourceInscription: 'agent',
      mode: 'creation'
    });

    if (result.erreur) {
      return res.status(result.erreur.status).json({
        success: false,
        ...(result.erreur.code ? { code: result.erreur.code } : {}),
        message: result.erreur.message
      });
    }

    // ✅ Pièces justificatives cochées par l'agent — même mécanisme que la Vérification
    // (confirmerReinscriptionVerification) : contrôle physique, écrit directement `fourni`,
    // jamais `declare_par_etudiant`. Upsert manuel, uniquement sur les codes reçus.
    const fourni = req.body.fourni || {};
    for (const [code, valeur] of Object.entries(fourni)) {
      const typeDocResult = await client.query(
        `SELECT id FROM type_document WHERE code = $1 AND contexte IN ('admission', 'reinscription')`,
        [code]
      );
      if (typeDocResult.rows.length === 0) continue;
      const typeDocId = typeDocResult.rows[0].id;
      const estFourni = valeur === true || valeur === 'true';
      const updateResult = await client.query(
        `UPDATE document_etudiant SET fourni = $1 WHERE etudiant_id = $2 AND type_document_id = $3`,
        [estFourni, id, typeDocId]
      );
      if (updateResult.rowCount === 0) {
        await client.query(
          `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni) VALUES ($1, $2, $3)`,
          [id, typeDocId, estFourni]
        );
      }
    }

    res.status(200).json({
      success: true,
      message: result.eligible
        ? 'Demande de réinscription enregistrée : en attente de paiement en caisse.'
        : "Demande de réinscription enregistrée : dossier non éligible au paiement pour le moment.",
      data: {
        reinscription_id: result.reinscriptionId,
        etudiant_id: id,
        anneeacademique_id: result.anneeAcademiqueId,
        niveau_retenu_id,
        montant_annuel: result.montantAnnuel,
        statut: result.statutDossier,
        eligible: result.eligible,
        code_paiement: result.codePaiement,
        motif_non_eligibilite: result.motifNonEligibilite,
        changement_de_cycle: result.changementDeCycle
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur demanderReinscription:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ─── GET fiche récapitulative imprimable (éligible ou non éligible) ────────
exports.afficherFicheReinscription = async (req, res) => {
  try {
    const { reinscriptionId } = req.params;
    const { calculerEcheancier } = require('../services/echeancier.service');

    const result = await db.query(
      `SELECT r.*, e.nom, e.prenoms, e.matricule_iipea, e.date_naissance, e.lieu_naissance,
              e.ip_ministere,
              f.nom AS filiere_nom, f.sigle AS filiere_sigle, n.libelle AS niveau_libelle, a.annee
       FROM reinscription r
       JOIN etudiant e ON e.id = r.etudiant_id
       LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
       JOIN niveau n ON n.id = r.niveau_retenu_id
       JOIN anneeacademique a ON a.id = r.anneeacademique_id
       WHERE r.id = $1`,
      [reinscriptionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Dossier de réinscription introuvable.');
    }
    const dossier = result.rows[0];

    // Historique de l'année précédente : tant que le paiement n'est pas validé, l'état courant
    // de l'étudiant n'a pas encore été écrasé — c'est directement l'ancienne situation. Une fois
    // payé, on relit la trace figée au moment de CETTE validation (historique_inscription).
    let historique = null;
    if (dossier.statut === 'en_attente_paiement' || dossier.statut === 'non_eligible') {
      const etudiantActuel = await db.query(
        `SELECT a.annee, f.nom AS filiere_nom, n.libelle AS niveau_libelle, tf.libelle AS type_filiere,
                g.nom AS groupe_nom, c.nom AS classe_nom, e.statut_scolaire,
                s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant
         FROM etudiant e
         JOIN niveau n ON n.id = e.niveau_id
         JOIN filiere f ON f.id = e.id_filiere
         LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
         LEFT JOIN anneeacademique a ON a.id = e.annee_academique_id
         LEFT JOIN groupe g ON g.id = e.groupe_id
         LEFT JOIN classe c ON c.id = g.classe_id
         LEFT JOIN scolarite s ON s.id = e.scolarite_id
         WHERE e.id = $1`,
        [dossier.etudiant_id]
      );
      historique = etudiantActuel.rows[0] || null;
    } else {
      const histResult = await db.query(
        `SELECT a.annee, f.nom AS filiere_nom, n.libelle AS niveau_libelle, tf.libelle AS type_filiere,
                g.nom AS groupe_nom, c.nom AS classe_nom, h.statut_scolaire,
                h.montant_scolarite, h.scolarite_verse, h.scolarite_restante, h.statut_paiement,
                h.decision_academique, h.moyenne_annuelle
         FROM historique_inscription h
         JOIN niveau n ON n.id = h.niveau_id
         LEFT JOIN filiere f ON f.id = h.id_filiere
         LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
         LEFT JOIN anneeacademique a ON a.id = h.annee_academique_id
         LEFT JOIN groupe g ON g.id = h.groupe_id
         LEFT JOIN classe c ON c.id = g.classe_id
         WHERE h.etudiant_id = $1 AND h.created_at < $2
         ORDER BY h.created_at DESC LIMIT 1`,
        [dossier.etudiant_id, dossier.created_at]
      );
      historique = histResult.rows[0] || null;
    }

    const echeancier = calculerEcheancier({
      montantTotal: dossier.montant_annuel_nouveau,
      nombreVersementsPrevu: dossier.nombre_versements_prevu,
      paiementsEffectues: [],
      dateDepart: dossier.created_at,
    });

    // Rattrapages : dossier.matieres_a_reprendre (jsonb) contient une entrée par ECUE non validée,
    // avec l'UE parente (ue_libelle) — on en déduit la liste des UE concernées par déduplication.
    const matieresAReprendre = dossier.matieres_a_reprendre || [];
    const ecueEnRattrapage = matieresAReprendre.map(m => m.matiere_nom).filter(Boolean);
    const uesEnRattrapage = [...new Set(matieresAReprendre.map(m => m.ue_libelle).filter(Boolean))];

    // Professionnelle (hors Licence Pro) : seule la moyenne annuelle est affichée (pas de logique
    // crédits/UE — même distinction que determinerTypeTraitement dans PV.controller.js : la
    // valeur réelle en base est 'Professionnelles' (avec un « s »), et une Licence Pro, bien que
    // classée 'Professionnelles' en base, se comporte comme une filière universitaire).
    // Universitaire/Licence Pro (et par défaut) : crédits obtenus + moyenne annuelle.
    const estFiliereProfessionnelle = historique?.type_filiere === 'Professionnelles'
      && !/LICENCE/i.test(historique?.niveau_libelle || '');

    // ✅ Même modèle que l'inscription (fiche_admission.ejs, sections ['fiche', 'engagement']
    // dans un seul document PDF) : la fiche de réinscription est suivie de la fiche
    // d'engagement dans la même page, au lieu d'ouvrir un second document séparé.
    res.render('fiche_reinscription', {
      dossier, historique, echeancier,
      ecueEnRattrapage, uesEnRattrapage, estFiliereProfessionnelle,
      sections: ['fiche', 'engagement']
    });
  } catch (error) {
    console.error('Erreur afficherFicheReinscription:', error);
    res.status(500).send('Erreur serveur lors de la génération de la fiche.');
  }
};
