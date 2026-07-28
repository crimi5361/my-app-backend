// Affectation classe/groupe d'un étudiant à sa filière+niveau courants.
// Extrait de paiyement.controller.js (logique historique du premier paiement d'une nouvelle
// admission) pour être réutilisé partout où un étudiant doit être rattaché au bon groupe —
// notamment lors d'une réinscription, où l'étudiant doit toujours appartenir au groupe de la
// NOUVELLE classe (nouvelle année/niveau), jamais rester dans son ancien groupe.

// Capacité max d'un groupe selon le type de filière — même règle que l'admission historique.
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

// Trouve ou crée la classe (nom dérivé filière+sigle+niveau), puis un groupe de cette classe
// ayant de la place (ou en crée un nouveau), et affecte l'étudiant à ce groupe. Ne touche pas
// à `standing` — laissé à la charge de l'appelant (l'admission le passe à 'Inscrit' au premier
// paiement ; une réinscription peut avoir sa propre logique de statut).
// Régime (Jour/Soir) extrait du texte du parcours — même regex déjà éprouvée côté frontend
// (Pages/Gestion_academique/DetailClasse.tsx::extractRegime) pour désambiguïser deux classes
// d'une même filière+niveau qui ne diffèrent que par ce régime.
const extraireSuffixeRegime = (texteCursus) => {
  const match = (texteCursus || '').match(/(Jour|Soir)/i);
  return match ? match[1].toUpperCase() : null;
};

exports.affecterClasseEtGroupe = async (dbClient, { etudiantId, filiereNom, filiereSigle, niveauLibelle, cursus, curcusId = null, typeFiliere, anneeAcademiqueId, filiereId, niveauId }) => {
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
  let classeResult = await dbClient.query(
    'SELECT id FROM classe WHERE filiere_id = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND curcus_id IS NOT DISTINCT FROM $4',
    [filiereId, niveauId, anneeAcademiqueId, curcusId]
  );
  let classeId;
  if (classeResult.rows.length > 0) {
    classeId = classeResult.rows[0].id;
  } else {
    const newClasse = await dbClient.query(
      `INSERT INTO classe (nom, description, annee_academique_id, filiere_id, niveau_id, curcus_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [nomClasse, `Classe pour ${descriptionClasse}`, anneeAcademiqueId, filiereId, niveauId, curcusId]
    );
    classeId = newClasse.rows[0].id;
  }

  const capaciteMax = capaciteParTypeFiliere(typeFiliere);

  const groupeResult = await dbClient.query(
    `SELECT g.id FROM groupe g
     LEFT JOIN etudiant e ON e.groupe_id = g.id
     WHERE g.classe_id = $1
     GROUP BY g.id, g.nom, g.capacite_max
     HAVING COUNT(e.id) < g.capacite_max
     ORDER BY g.nom
     LIMIT 1`,
    [classeId]
  );

  let groupeId;
  if (groupeResult.rows.length > 0) {
    groupeId = groupeResult.rows[0].id;
  } else {
    const countGroupes = await dbClient.query(
      'SELECT COUNT(*) AS count_groupes FROM groupe WHERE classe_id = $1',
      [classeId]
    );
    const numeroNouveauGroupe = parseInt(countGroupes.rows[0].count_groupes) + 1;
    const nomGroupe = `${nomClasse} Groupe ${numeroNouveauGroupe}`;
    const newGroupe = await dbClient.query(
      `INSERT INTO groupe (nom, capacite_max, classe_id) VALUES ($1, $2, $3) RETURNING id`,
      [nomGroupe, capaciteMax, classeId]
    );
    groupeId = newGroupe.rows[0].id;
  }

  await dbClient.query(`UPDATE etudiant SET groupe_id = $1 WHERE id = $2`, [groupeId, etudiantId]);
  return { classeId, groupeId };
};
