// Ce que ce fichier protège : la règle qui décide ce qu'est un échec.
//
// POURQUOI ELLE MÉRITE DES TESTS À ELLE. Tout le reste de la console
// d'administration lit ce que cette fonction a écrit. Si elle classe trop large,
// le journal se remplit d'appels réussis et le panneau des échecs devient
// illisible — donc inutile. Si elle classe trop étroit, un défaut comme celui
// des 115 enseignants introuvables repasse inaperçu, ce qui est exactement la
// situation qu'on cherche à ne plus revivre.
//
// Le point délicat est le genre « vide ». Un outil qui n'exécute aucune requête
// ne porte pas de trace, et `undefined` se confond avec zéro si on l'écrit sans
// y penser (`!nb_lignes`). Ce piège-là est testé explicitement.
const test = require('node:test');
const assert = require('node:assert');
const journal = require('../services/assistantJournal.service');

const { classer } = journal;

test('une erreur d\'outil est une panne, et emporte le SQL s\'il y en a un', () => {
  const v = classer('interroger_base', {
    reponse: { erreur: 'La base n\'a pas répondu.' },
    trace: { sql: 'SELECT 1', ok: false },
  });
  assert.strictEqual(v.genre, 'panne');
  assert.match(v.detail, /pas répondu/);
  assert.strictEqual(v.sql, 'SELECT 1');
});

test('une requête réussie sans aucune ligne est le genre le plus précieux', () => {
  const v = classer('interroger_base', {
    reponse: { colonnes: ['n'], lignes: [], nb_lignes: 0 },
    trace: { ok: true, nb_lignes: 0, sql: 'SELECT * FROM assistant.v_enseignants', intention: 'Lister les enseignants' },
  });
  assert.strictEqual(v.genre, 'vide');
  assert.match(v.sql, /v_enseignants/);
  assert.match(v.detail, /enseignants/i);
});

test('une requête qui ramène des lignes n\'est pas un échec', () => {
  assert.strictEqual(
    classer('interroger_base', {
      reponse: { lignes: [{ n: 115 }], nb_lignes: 1 },
      trace: { ok: true, nb_lignes: 1, sql: 'SELECT count(*)' },
    }),
    null,
  );
});

// LE PIÈGE. Un outil sans requête ne renseigne pas `nb_lignes` : écrite
// `!sortie.trace?.nb_lignes`, la règle aurait classé « vide » chaque affichage
// de fiche réussi, et noyé le journal sous des succès.
test('un outil sans trace ne peut jamais être classé « vide »', () => {
  assert.strictEqual(classer('afficher_fiche_personne', { reponse: { fiche: { nom: 'X' } } }), null);
  assert.strictEqual(classer('naviguer', { reponse: { ok: true }, trace: { ok: true } }), null);
});

test('une trace en échec ne devient pas « vide » par le seul fait de n\'avoir aucune ligne', () => {
  // `ok: false` porte déjà son propre motif : le classement doit venir de
  // `reponse.erreur`, pas de la trace, sans quoi la même panne serait comptée deux fois.
  const v = classer('interroger_base', {
    reponse: { erreur: 'Requête refusée par le validateur.' },
    trace: { ok: false, nb_lignes: 0, sql: 'DELETE FROM etudiant' },
  });
  assert.strictEqual(v.genre, 'panne');
});

test('un nom introuvable et une homonymie sont deux genres distincts', () => {
  assert.strictEqual(classer('afficher_fiche_personne', { reponse: { trouve: false, message: 'Personne nommee ainsi : Zzz.' } }).genre, 'introuvable');

  const amb = classer('afficher_fiche_personne', {
    reponse: { ambigu: true, candidats: [{ nom: 'Koné A.' }, { nom: 'Koné B.' }] },
  });
  assert.strictEqual(amb.genre, 'ambigu');
  assert.match(amb.detail, /Koné A\.,\s*Koné B\./);
});

test('une entrée absurde ne fait pas tomber le classement', () => {
  assert.strictEqual(classer('x', null), null);
  assert.strictEqual(classer('x', undefined), null);
  assert.strictEqual(classer('x', 'texte'), null);
  assert.strictEqual(classer('x', {}), null);
});

// Le journal n'écrit que des genres qu'il sait rendre en français à l'écran.
// Un genre inventé ailleurs dans le code passerait le typage et échouerait
// silencieusement à l'insertion : `journaliser` le refuse, ce test le fige.
test('les genres produits par le classement sont tous des genres connus', () => {
  const echantillons = [
    { reponse: { erreur: 'x' } },
    { reponse: { trouve: false } },
    { reponse: { ambigu: true } },
    { reponse: {}, trace: { ok: true, nb_lignes: 0 } },
  ];
  for (const e of echantillons) {
    const v = classer('x', e);
    assert.ok(journal.GENRES[v.genre], `genre inconnu : ${v.genre}`);
  }
  // Les deux genres qui ne viennent pas du classement mais du reste du code.
  assert.ok(journal.GENRES.impasse);
  assert.ok(journal.GENRES.repli);
});

test('la rétention annoncée est bien celle qui a été décidée', () => {
  assert.strictEqual(journal.RETENTION_JOURS, 10);
});
