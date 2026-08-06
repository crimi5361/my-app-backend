// Découpage manuel d'une classe en groupes (Chantier 6, 2026-08-01) — remplace l'ancienne
// affectation automatique de groupe (retirée de classeGroupe.service.js) par une opération
// explicite déclenchée par un administrateur, quelques jours avant la rentrée, une fois les
// effectifs d'une classe connus.
const { getStrategie } = require('./repartitionStrategies');

// dbClient : client de transaction déjà ouvert (BEGIN fait par l'appelant, COMMIT/ROLLBACK aussi
// — cette fonction ne gère jamais elle-même la transaction, pour rester réutilisable).
async function decouperClasse(dbClient, { classeId, groupes, strategie = 'sequentielle', effectuePar }) {
  const classeResult = await dbClient.query('SELECT id FROM classe WHERE id = $1', [classeId]);
  if (classeResult.rows.length === 0) {
    throw new Error('Classe introuvable.');
  }

  // Verrou anti double-découpage : absent du brouillon divisionGroupe.controller.js original,
  // ajouté ici car une classe déjà découpée ne doit pas être redécoupée par erreur (perdrait la
  // cohérence entre affectations déjà faites et un nouveau découpage concurrent).
  const groupesExistants = await dbClient.query('SELECT id FROM groupe WHERE classe_id = $1', [classeId]);
  if (groupesExistants.rows.length > 0) {
    throw new Error('Cette classe a déjà été découpée en groupes — impossible de redécouper.');
  }

  if (!Array.isArray(groupes) || groupes.length === 0) {
    throw new Error('Au moins un groupe doit être défini.');
  }
  for (const g of groupes) {
    if (!g.nom || typeof g.nom !== 'string' || !g.nom.trim()) {
      throw new Error('Chaque groupe doit avoir un nom.');
    }
    if (!Number.isInteger(g.capacite_max) || g.capacite_max <= 0) {
      throw new Error(`Capacité invalide pour le groupe "${g.nom}" — doit être un entier positif.`);
    }
  }

  // Étudiants de cette classe encore sans groupe — même clé de correspondance que
  // classeGroupe.service.js::affecterClasse (filiere/niveau/annee_academique/curcus).
  const etudiantsResult = await dbClient.query(
    `SELECT e.id FROM etudiant e
     JOIN classe c ON c.id = $1
     WHERE e.groupe_id IS NULL
       AND e.id_filiere = c.filiere_id AND e.niveau_id = c.niveau_id
       AND e.annee_academique_id = c.annee_academique_id
       AND e.curcus_id IS NOT DISTINCT FROM c.curcus_id
     ORDER BY e.nom, e.prenoms`,
    [classeId]
  );
  const etudiants = etudiantsResult.rows;

  const capaciteTotale = groupes.reduce((somme, g) => somme + g.capacite_max, 0);
  if (capaciteTotale < etudiants.length) {
    throw new Error(
      `Capacité totale des groupes (${capaciteTotale}) insuffisante pour les ${etudiants.length} étudiant(s) à répartir.`
    );
  }

  const groupesCrees = [];
  for (const g of groupes) {
    const inserted = await dbClient.query(
      'INSERT INTO groupe (nom, capacite_max, classe_id) VALUES ($1, $2, $3) RETURNING id, nom, capacite_max',
      [g.nom.trim(), g.capacite_max, classeId]
    );
    groupesCrees.push(inserted.rows[0]);
  }

  const repartir = getStrategie(strategie);
  const affectations = repartir(etudiants, groupesCrees);

  for (const [etudiantId, groupeId] of affectations) {
    await dbClient.query('UPDATE etudiant SET groupe_id = $1 WHERE id = $2', [groupeId, etudiantId]);
  }

  const detailGroupes = groupesCrees.map((g) => ({
    groupe_id: g.id,
    nom: g.nom,
    capacite_max: g.capacite_max,
    nb_affectes: [...affectations.values()].filter((id) => id === g.id).length,
  }));

  await dbClient.query(
    `INSERT INTO decoupage_groupe (classe_id, effectue_par, strategie, nombre_groupes, nombre_etudiants_repartis, detail_groupes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [classeId, effectuePar || null, strategie, groupesCrees.length, affectations.size, JSON.stringify(detailGroupes)]
  );

  return { groupes: groupesCrees, nombreEtudiantsRepartis: affectations.size, detailGroupes };
}

// Chantier 11 (2026-08-03) — sous-phase 3 : création d'UN groupe pédagogique à la fois.
// Contrairement à decouperClasse (bulk, un seul appel possible, avec distribution automatique
// immédiate), cette opération est répétable — Groupe 1, puis Groupe 2, puis Groupe 3... — et ne
// déplace jamais d'étudiant : la répartition est un acte séparé et délibéré, voir
// deplacerEtudiantsVersGroupe ci-dessous. Réservée aux classes qui ont déjà un Groupe primaire
// (donc, par construction, aux classes de la nouvelle architecture — voir classeGroupe.service.js)
// : c'est un garde-fou structurel, pas un test sur anneeAcademiqueId.
async function creerGroupePedagogique(dbClient, { classeId, nom, capaciteMax }) {
  const classeResult = await dbClient.query('SELECT id FROM classe WHERE id = $1', [classeId]);
  if (classeResult.rows.length === 0) {
    throw new Error('Classe introuvable.');
  }

  const primaireResult = await dbClient.query(
    'SELECT id FROM groupe WHERE classe_id = $1 AND est_primaire = true',
    [classeId]
  );
  if (primaireResult.rows.length === 0) {
    throw new Error(
      "Cette classe ne dispose pas d'un Groupe primaire — la gestion des groupes pédagogiques n'est disponible que pour les classes de la nouvelle architecture (2026-2027 et suivantes)."
    );
  }

  if (!nom || typeof nom !== 'string' || !nom.trim()) {
    throw new Error('Le nom du groupe est requis.');
  }
  if (!Number.isInteger(capaciteMax) || capaciteMax <= 0) {
    throw new Error('La capacité doit être un entier positif.');
  }

  const nomNormalise = nom.trim();
  // Amélioration par rapport à decouperClasse (qui ne vérifiait pas les doublons de nom au sein
  // d'une même classe) : ici, les groupes se créent un par un dans le temps, le risque de saisir
  // deux fois "Groupe 1" par erreur est réel.
  const doublon = await dbClient.query(
    'SELECT id FROM groupe WHERE classe_id = $1 AND lower(nom) = lower($2)',
    [classeId, nomNormalise]
  );
  if (doublon.rows.length > 0) {
    throw new Error(`Un groupe nommé "${nomNormalise}" existe déjà dans cette classe.`);
  }

  const inserted = await dbClient.query(
    `INSERT INTO groupe (nom, capacite_max, classe_id, est_primaire)
     VALUES ($1, $2, $3, false) RETURNING id, nom, capacite_max`,
    [nomNormalise, capaciteMax, classeId]
  );

  return {
    id: inserted.rows[0].id,
    nom: inserted.rows[0].nom,
    capacite_max: inserted.rows[0].capacite_max,
    effectif: 0,
    taux_remplissage: 0,
  };
}

// Sous-phase 3 : déplacement sélectif d'étudiants vers un groupe pédagogique — Groupe primaire ->
// groupe réel, ou groupe réel -> groupe réel. Le groupe primaire n'est JAMAIS une destination
// valide (règle explicite V1 : un étudiant en sort, il n'y retourne pas ; aucun besoin métier
// identifié pour l'inverse à ce stade). Le groupe source de chaque étudiant est lu depuis
// etudiant.groupe_id — l'appelant ne le précise pas, il choisit seulement la destination.
async function deplacerEtudiantsVersGroupe(dbClient, { classeId, groupeDestinationId, etudiantIds }) {
  if (!Array.isArray(etudiantIds) || etudiantIds.length === 0) {
    throw new Error('Aucun étudiant sélectionné.');
  }

  // FOR UPDATE : sérialise les déplacements concurrents vers ce même groupe — condition
  // nécessaire pour que le contrôle de capacité ci-dessous reste fiable (même logique que
  // l'index unique partiel de la sous-phase 1, mais ici la contrainte est métier, pas déclarative
  // : la capacité peut légitimement changer d'un groupe à l'autre).
  const destResult = await dbClient.query(
    'SELECT id, classe_id, capacite_max, est_primaire FROM groupe WHERE id = $1 FOR UPDATE',
    [groupeDestinationId]
  );
  if (destResult.rows.length === 0) {
    throw new Error('Groupe de destination introuvable.');
  }
  const destination = destResult.rows[0];
  if (destination.classe_id !== classeId) {
    throw new Error("Le groupe de destination n'appartient pas à cette classe.");
  }
  if (destination.est_primaire) {
    throw new Error("Impossible de déplacer un étudiant vers le Groupe primaire — ce groupe n'est jamais une destination valide.");
  }

  const etudiantsResult = await dbClient.query(
    `SELECT e.id, e.groupe_id, g.classe_id
     FROM etudiant e JOIN groupe g ON g.id = e.groupe_id
     WHERE e.id = ANY($1::int[])`,
    [etudiantIds]
  );
  const etudiantsTrouves = new Map(etudiantsResult.rows.map((r) => [r.id, r]));
  for (const id of etudiantIds) {
    const e = etudiantsTrouves.get(id);
    if (!e) {
      throw new Error(`Étudiant ${id} introuvable ou non affecté à un groupe.`);
    }
    if (e.classe_id !== classeId) {
      throw new Error(`Étudiant ${id} n'appartient pas à un groupe de cette classe.`);
    }
    if (e.groupe_id === groupeDestinationId) {
      throw new Error(`Étudiant ${id} est déjà dans ce groupe.`);
    }
  }

  if (destination.capacite_max !== null) {
    const effectifActuel = await dbClient.query('SELECT COUNT(*) FROM etudiant WHERE groupe_id = $1', [groupeDestinationId]);
    const placesRestantes = destination.capacite_max - parseInt(effectifActuel.rows[0].count, 10);
    if (etudiantIds.length > placesRestantes) {
      throw new Error(
        `Capacité insuffisante : ${placesRestantes} place(s) restante(s) dans ce groupe pour ${etudiantIds.length} étudiant(s) sélectionné(s).`
      );
    }
  }

  await dbClient.query('UPDATE etudiant SET groupe_id = $1 WHERE id = ANY($2::int[])', [groupeDestinationId, etudiantIds]);

  return { deplaces: etudiantIds.length, groupeDestinationId };
}

// Note pour une future sous-phase (non demandée ici) : une répartition automatique équilibrée
// s'intégrerait ici en réutilisant repartitionStrategies.js (Strategy pattern déjà en place pour
// l'ancien découpage bulk — voir STRATEGIES dans ce fichier, conçu dès l'origine pour accueillir
// une stratégie "equilibree" sans rien changer ailleurs) plutôt qu'en réinventant un mécanisme :
// il suffirait d'appliquer la stratégie choisie sur les étudiants du Groupe primaire pour obtenir
// une liste de déplacements, puis de les exécuter un par un via deplacerEtudiantsVersGroupe.

// Chantier 11 (2026-08-03) — sous-phase 4.5 : modification d'un groupe pédagogique existant (nom,
// capacité). Le Groupe primaire n'est jamais modifiable ici — garde-fou structurel, comme pour sa
// création et son déplacement.
async function modifierGroupePedagogique(dbClient, { classeId, groupeId, nom, capaciteMax }) {
  const groupeResult = await dbClient.query('SELECT id, classe_id, est_primaire FROM groupe WHERE id = $1', [groupeId]);
  if (groupeResult.rows.length === 0) {
    throw new Error('Groupe introuvable.');
  }
  const groupe = groupeResult.rows[0];
  if (groupe.classe_id !== classeId) {
    throw new Error("Ce groupe n'appartient pas à cette classe.");
  }
  if (groupe.est_primaire) {
    throw new Error('Le Groupe primaire ne peut pas être modifié.');
  }

  if (!nom || typeof nom !== 'string' || !nom.trim()) {
    throw new Error('Le nom du groupe est requis.');
  }
  if (!Number.isInteger(capaciteMax) || capaciteMax <= 0) {
    throw new Error('La capacité doit être un entier positif.');
  }

  const nomNormalise = nom.trim();
  const doublon = await dbClient.query(
    'SELECT id FROM groupe WHERE classe_id = $1 AND lower(nom) = lower($2) AND id <> $3',
    [classeId, nomNormalise, groupeId]
  );
  if (doublon.rows.length > 0) {
    throw new Error(`Un groupe nommé "${nomNormalise}" existe déjà dans cette classe.`);
  }

  // La capacité ne peut jamais descendre sous l'effectif déjà présent — éviterait un groupe
  // "en sur-effectif" qu'aucune action de l'interface ne permet de corriger autrement.
  const effectifActuelResult = await dbClient.query('SELECT COUNT(*) FROM etudiant WHERE groupe_id = $1', [groupeId]);
  const effectif = parseInt(effectifActuelResult.rows[0].count, 10);
  if (capaciteMax < effectif) {
    throw new Error(`Capacité invalide : ce groupe contient déjà ${effectif} étudiant(s) — la capacité ne peut pas être inférieure à ce nombre.`);
  }

  const updated = await dbClient.query(
    'UPDATE groupe SET nom = $1, capacite_max = $2 WHERE id = $3 RETURNING id, nom, capacite_max',
    [nomNormalise, capaciteMax, groupeId]
  );

  return {
    id: updated.rows[0].id,
    nom: updated.rows[0].nom,
    capacite_max: updated.rows[0].capacite_max,
    effectif,
    taux_remplissage: capaciteMax ? Math.round((effectif / capaciteMax) * 100) : 0,
  };
}

// Sous-phase 4.5 : suppression d'un groupe pédagogique VIDE uniquement. Le Groupe primaire ne
// peut jamais être supprimé (même garde-fou que modifierGroupePedagogique). Un groupe encore
// référencé ailleurs (emploi du temps, enseignement — voir l'inventaire de dépendances établi en
// phase d'analyse) remonte un message métier clair plutôt que l'erreur SQL brute de la contrainte
// de clé étrangère.
async function supprimerGroupePedagogique(dbClient, { classeId, groupeId }) {
  const groupeResult = await dbClient.query('SELECT id, classe_id, est_primaire FROM groupe WHERE id = $1', [groupeId]);
  if (groupeResult.rows.length === 0) {
    throw new Error('Groupe introuvable.');
  }
  const groupe = groupeResult.rows[0];
  if (groupe.classe_id !== classeId) {
    throw new Error("Ce groupe n'appartient pas à cette classe.");
  }
  if (groupe.est_primaire) {
    throw new Error('Le Groupe primaire ne peut jamais être supprimé.');
  }

  const effectifActuelResult = await dbClient.query('SELECT COUNT(*) FROM etudiant WHERE groupe_id = $1', [groupeId]);
  const effectif = parseInt(effectifActuelResult.rows[0].count, 10);
  if (effectif > 0) {
    throw new Error(`Ce groupe contient encore ${effectif} étudiant(s) — déplacez-les avant de le supprimer.`);
  }

  try {
    await dbClient.query('DELETE FROM groupe WHERE id = $1', [groupeId]);
  } catch (err) {
    if (err.code === '23503') {
      throw new Error("Ce groupe est référencé ailleurs (emploi du temps, enseignement...) et ne peut pas être supprimé.");
    }
    throw err;
  }

  return { id: groupeId, supprime: true };
}

module.exports = {
  decouperClasse,
  creerGroupePedagogique,
  deplacerEtudiantsVersGroupe,
  modifierGroupePedagogique,
  supprimerGroupePedagogique,
};
