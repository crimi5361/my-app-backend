// Affectation classe d'un étudiant à sa filière+niveau courants.
// Extrait de paiyement.controller.js (logique historique du premier paiement d'une nouvelle
// admission) pour être réutilisé partout où un étudiant doit être rattaché à la bonne classe —
// notamment lors d'une réinscription, où l'étudiant doit toujours appartenir à la classe de la
// NOUVELLE année/niveau, jamais rester dans son ancienne classe.
//
// Chantier 6 (2026-08-01) : cette fonction n'affecte plus automatiquement de GROUPE. Elle
// s'appelait auparavant `affecterClasseEtGroupe` et créait/choisissait aussi un groupe ayant de
// la place ; cette partie est retirée (pas désactivée par variable d'environnement comme le
// module Kit — il s'agit d'une refonte définitive du fonctionnement, pas d'une bascule
// réversible par campagne). L'étudiant reste avec `groupe_id = NULL` jusqu'au découpage manuel
// de sa classe par un administrateur (voir services/decoupageGroupe.service.js). Les anciens
// étudiants déjà affectés à un groupe avant ce chantier ne sont pas concernés : cette fonction
// ne touche jamais `groupe_id`, ni en lecture ni en écriture.
//
// Chantier 11 (2026-08-03) — sous-phase 2 : réintroduction d'une affectation AUTOMATIQUE, mais
// uniquement au groupe technique "primaire" (jamais à un groupe pédagogique réel — ceux-ci
// restent affectés manuellement via le futur écran Gestion des groupes). Le primaire n'est créé
// QUE lorsque la classe elle-même vient d'être créée par CET appel (voir `classeVientDetreCree`
// ci-dessous) — jamais rétroactivement sur une classe déjà existante. Comme toutes les classes
// des années antérieures à 2026-2027 existent déjà, elles ne passeront plus jamais par la
// branche de création : ce mécanisme ne peut donc jamais leur attribuer un primaire, ni modifier
// un groupe existant. C'est le seul garde-fou nécessaire — il n'y a pas besoin de tester
// anneeAcademiqueId explicitement.
//
// Sous-phase 2.5 : le test de concurrence de la sous-phase 2 a révélé que deux appels quasi
// simultanés pouvaient chacun créer leur propre classe pour le même couple filière/niveau/
// année/cursus (aucune contrainte d'unicité n'existait). `trouverOuCreerClasse` s'appuie
// maintenant sur l'index unique partiel idx_classe_unique_filiere_niveau_annee_curcus
// (migrations/sql/012_classe_unicite.sql) pour garantir qu'une seule des deux transactions crée
// réellement la classe — `classeVientDetreCree` reflète donc qui a VRAIMENT gagné la création,
// pas seulement "le SELECT initial n'a rien trouvé" (sinon les deux appels croiraient chacun
// avoir créé la classe, et créeraient chacun leur propre groupe primaire pour deux classes
// distinctes). Cet index est volontairement absent pour l'année 2025-2026 (id=1), qui contient
// déjà des doublons historiques réels qu'il est hors de question de toucher.

// Capacité par défaut suggérée pour un groupe selon le type de filière — n'est plus appliquée
// automatiquement ici ; conservée et exportée comme valeur par défaut proposée à l'administrateur
// lors du découpage manuel d'une classe (services/decoupageGroupe.service.js).
const capaciteParTypeFiliere = (typeFiliere) => {
  switch (typeFiliere) {
    case 'Universitaire':
    case 'Classique':
      return 100;
    case 'Professionnelle':
    case 'Technique':
      return 50;
    default:
      return 50;
  }
};

// Trouve ou crée la classe (nom dérivé filière+sigle+niveau). Ne touche pas à `standing` —
// laissé à la charge de l'appelant (l'admission le passe à 'Inscrit' au premier paiement ; une
// réinscription peut avoir sa propre logique de statut).
// Régime (Jour/Soir) extrait du texte du parcours — même regex déjà éprouvée côté frontend
// (Pages/Gestion_academique/DetailClasse.tsx::extractRegime) pour désambiguïser deux classes
// d'une même filière+niveau qui ne diffèrent que par ce régime.
const extraireSuffixeRegime = (texteCursus) => {
  const match = (texteCursus || '').match(/(Jour|Soir)/i);
  return match ? match[1].toUpperCase() : null;
};

exports.affecterClasse = async (dbClient, { etudiantId, filiereNom, filiereSigle, niveauLibelle, cursus, curcusId = null, anneeAcademiqueId, filiereId, niveauId }) => {
  const suffixeRegime = curcusId ? extraireSuffixeRegime(cursus) : null;
  const nomClasse = suffixeRegime
    ? `${filiereNom} ${filiereSigle} ${niveauLibelle} - ${suffixeRegime}`
    : `${filiereNom} ${filiereSigle} ${niveauLibelle}`;
  const descriptionClasse = `${filiereNom} ${filiereSigle} ${niveauLibelle}  ${cursus || ''}`.trim();

  // Une classe appartient à UNE année académique, UNE filière et UN niveau précis (par id, pas
  // par nom généré) : deux filières distinctes peuvent partager le même nom affiché (doublons de
  // référentiel constatés en base — ex. deux lignes "filiere" identiques), ce qui provoquait des
  // fusions de classes incorrectes quand la recherche ne portait que sur le nom.
  // ✅ Parcours JOUR/SOIR : curcus_id fait désormais partie de la clé de recherche/création —
  // IS NOT DISTINCT FROM gère correctement le cas NULL=NULL (niveaux sans notion de parcours),
  // pour lesquels le comportement reste strictement identique à avant.
  // Cette même clé (filiere_id, niveau_id, annee_academique_id, curcus_id) sert aussi, ailleurs
  // dans le code, à retrouver la classe d'un étudiant SANS passer par groupe_id (etudiant n'a
  // pas de colonne classe_id — voir getRecuData, _chargerDonneesFicheAdmission,
  // donneeespaceetudiant.controller.js) — ne pas modifier cette clé sans répercuter le changement
  // partout où elle est dupliquée.
  let classeResult = await dbClient.query(
    'SELECT id FROM classe WHERE filiere_id = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND curcus_id IS NOT DISTINCT FROM $4',
    [filiereId, niveauId, anneeAcademiqueId, curcusId]
  );
  let classeId;
  let classeVientDetreCree = false;
  if (classeResult.rows.length > 0) {
    classeId = classeResult.rows[0].id;
  } else {
    const resultatClasse = await trouverOuCreerClasse(dbClient, {
      nomClasse,
      descriptionClasse: `Classe pour ${descriptionClasse}`,
      anneeAcademiqueId,
      filiereId,
      niveauId,
      curcusId,
    });
    classeId = resultatClasse.classeId;
    classeVientDetreCree = resultatClasse.creeParCetAppel;
  }

  let groupePrimaireId = null;
  if (classeVientDetreCree) {
    groupePrimaireId = await trouverOuCreerGroupePrimaire(dbClient, classeId);
  } else {
    const primaireExistant = await dbClient.query(
      'SELECT id FROM groupe WHERE classe_id = $1 AND est_primaire = true',
      [classeId]
    );
    if (primaireExistant.rows.length > 0) {
      groupePrimaireId = primaireExistant.rows[0].id;
    }
  }

  return { classeId, groupePrimaireId };
};

// Sous-phase 2.5 : même stratégie ON CONFLICT DO NOTHING que trouverOuCreerGroupePrimaire, cette
// fois sur idx_classe_unique_filiere_niveau_annee_curcus. N'est appelée que lorsque le SELECT
// initial (clé filiere_id/niveau_id/annee_academique_id/curcus_id) n'a rien trouvé — si une
// transaction concurrente gagne la course, `creeParCetAppel: false` empêche l'appelant de croire
// qu'il doit créer un groupe primaire pour une classe qu'il n'a pas réellement créée.
async function trouverOuCreerClasse(dbClient, { nomClasse, descriptionClasse, anneeAcademiqueId, filiereId, niveauId, curcusId }) {
  const insere = await dbClient.query(
    `INSERT INTO classe (nom, description, annee_academique_id, filiere_id, niveau_id, curcus_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (annee_academique_id, filiere_id, niveau_id, curcus_id) WHERE annee_academique_id <> 1 DO NOTHING
     RETURNING id`,
    [nomClasse, descriptionClasse, anneeAcademiqueId, filiereId, niveauId, curcusId]
  );
  if (insere.rows.length > 0) {
    return { classeId: insere.rows[0].id, creeParCetAppel: true };
  }

  // Conflit : une transaction concurrente vient de créer cette classe entre notre SELECT et
  // notre INSERT — on relit la ligne gagnante (même clé IS NOT DISTINCT FROM que le SELECT
  // initial, pour rester cohérent avec le cas curcus_id NULL).
  const existante = await dbClient.query(
    'SELECT id FROM classe WHERE filiere_id = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND curcus_id IS NOT DISTINCT FROM $4',
    [filiereId, niveauId, anneeAcademiqueId, curcusId]
  );
  return { classeId: existante.rows[0].id, creeParCetAppel: false };
}

// Idempotent et sûr en cas d'appel concurrent : deux transactions arrivant en même temps sur la
// MÊME classe fraîchement créée peuvent toutes deux tenter l'INSERT ; l'index unique partiel
// idx_groupe_primaire_unique_par_classe (sous-phase 1) empêche le doublon, et ON CONFLICT DO
// NOTHING absorbe le conflit sans jamais lever d'erreur ni invalider la transaction en cours
// (contrairement à un conflit non géré, qui aurait obligé à un ROLLBACK/SAVEPOINT) — la
// transaction perdante relit simplement la ligne créée par la gagnante.
async function trouverOuCreerGroupePrimaire(dbClient, classeId) {
  const insere = await dbClient.query(
    `INSERT INTO groupe (nom, capacite_max, classe_id, est_primaire)
     VALUES ('Groupe primaire', NULL, $1, true)
     ON CONFLICT (classe_id) WHERE est_primaire = true DO NOTHING
     RETURNING id`,
    [classeId]
  );
  if (insere.rows.length > 0) {
    return insere.rows[0].id;
  }

  const existant = await dbClient.query(
    'SELECT id FROM groupe WHERE classe_id = $1 AND est_primaire = true',
    [classeId]
  );
  return existant.rows[0].id;
}

exports.capaciteParTypeFiliere = capaciteParTypeFiliere;
