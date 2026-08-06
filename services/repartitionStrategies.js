// Stratégies de répartition des étudiants dans les groupes créés lors d'un découpage manuel de
// classe (services/decoupageGroupe.service.js). Pattern Strategy : chaque stratégie a la même
// signature et est ajoutée au registre STRATEGIES — le service d'orchestration ne connaît jamais
// le détail d'un algorithme particulier, ce qui permet d'ajouter une nouvelle stratégie (répartition
// équilibrée, alphabétique, par sexe, personnalisée...) sans toucher au reste du module.
//
// Signature commune : (etudiants, groupes) => Map<etudiantId, groupeId>
//   - etudiants : lignes { id, ... } déjà triées dans l'ordre pertinent pour la stratégie choisie
//     (services/decoupageGroupe.service.js les trie par nom/prénoms avant l'appel).
//   - groupes : lignes { id, nom, capacite_max } fraîchement créées, dans l'ordre de saisie de
//     l'administrateur.
//
// Seule `sequentielle` est disponible pour la campagne 2026-2027 (remplit le groupe 1 jusqu'à sa
// capacité, puis le groupe 2, etc. — respecte des capacités différentes par groupe, contrairement
// à un simple partage égal).

function repartitionSequentielle(etudiants, groupes) {
  const affectations = new Map();
  let index = 0;
  for (const groupe of groupes) {
    let placesRestantes = groupe.capacite_max;
    while (placesRestantes > 0 && index < etudiants.length) {
      affectations.set(etudiants[index].id, groupe.id);
      index += 1;
      placesRestantes -= 1;
    }
  }
  return affectations;
}

const STRATEGIES = {
  sequentielle: repartitionSequentielle,
  // Futures stratégies (non implémentées pour cette campagne) : equilibree, alphabetique, sexe,
  // personnalisee — ajouter une fonction ci-dessus + une entrée ici, sans rien changer ailleurs.
};

function getStrategie(nom) {
  const fn = STRATEGIES[nom];
  if (!fn) {
    throw new Error(`Stratégie de répartition inconnue : "${nom}". Disponibles : ${Object.keys(STRATEGIES).join(', ')}.`);
  }
  return fn;
}

module.exports = { getStrategie, STRATEGIES, repartitionSequentielle };
