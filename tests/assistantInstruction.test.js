// Ce que ce fichier protège : aucun bloc de l'instruction système ne doit
// arriver au modèle sous la forme du mot « undefined ».
//
// LE DÉFAUT VÉCU. Le 25 août 2026, `BLOC_SYNONYMES` a été ajouté à
// assistantOutils, importé par les deux canaux et interpolé dans leur
// instruction — mais oublié dans `module.exports`. JavaScript ne dit rien : une
// propriété absente vaut `undefined`, et `${undefined}` s'écrit « undefined »
// dans le gabarit. Le prompt partait donc chez Google avec un trou, sans la
// moindre erreur, et rien dans les réponses ne le signalait.
//
// Il a fallu le remarquer par hasard. Ce test le remarquera à la place.
const test = require('node:test');
const assert = require('node:assert');
const outils = require('../services/assistantOutils.service');

/** Les blocs interpolés dans l'instruction des deux canaux. */
const BLOCS = [
  'BLOC_PHOTOS', 'BLOC_PROTECTION', 'BLOC_NAVIGATION', 'BLOC_RECHERCHE',
  'BLOC_SYNONYMES', 'BLOC_GRAPHIQUES', 'BLOC_EXPERTISE', 'BLOC_AUDIT',
  'BLOC_PRUDENCE',
];

const FABRIQUES = ['construireIdentite', 'construireCapacites'];

test('tous les blocs interpolés dans le prompt sont exportés', () => {
  const absents = BLOCS.filter((b) => outils[b] === undefined);
  assert.deepStrictEqual(absents, [],
    `ces blocs s'écriraient « undefined » dans le prompt : ${absents.join(', ')}`);
});

test('les blocs sont des chaînes non vides', () => {
  for (const b of BLOCS) {
    assert.strictEqual(typeof outils[b], 'string', `${b} n'est pas une chaîne`);
    assert.ok(outils[b].trim().length > 40, `${b} est suspicieusement court`);
  }
});

test('les fabriques rendent une chaîne, avec et sans argument', () => {
  for (const f of FABRIQUES) {
    assert.strictEqual(typeof outils[f], 'function', `${f} n'est pas exportée`);
    assert.strictEqual(typeof outils[f](), 'string', `${f}() ne rend pas une chaîne`);
  }
});

test("aucun bloc ne contient le mot « undefined »", () => {
  // Une interpolation ratée À L'INTÉRIEUR d'un bloc laisse la même trace.
  for (const b of BLOCS) {
    assert.ok(!/\bundefined\b/.test(outils[b]), `${b} contient « undefined »`);
  }
  assert.ok(!/\bundefined\b/.test(outils.construireIdentite('Ada')));
  assert.ok(!/\bundefined\b/.test(outils.construireCapacites({ google: false })));
  assert.ok(!/\bundefined\b/.test(outils.construireCapacites({ google: true })));
});

test('le catalogue de capacités suit les outils réellement disponibles', () => {
  const sans = outils.construireCapacites({ google: false });
  const avec = outils.construireCapacites({ google: true });
  assert.ok(!/agenda|réunion|messagerie/i.test(sans.split("Tu n'as PAS")[0]),
    'le catalogue annonce Google alors que Google est indisponible');
  assert.ok(/agenda/i.test(avec), 'le catalogue omet Google alors qu\'il est disponible');
  const compte = (t) => (t.match(/^\d+\. /gm) || []).length;
  assert.ok(compte(avec) > compte(sans), 'la liste ne s\'allonge pas quand Google est là');
});

test('la table des types de graphique nomme les quatre types disponibles', () => {
  for (const type of ['camembert', 'barres', 'lignes', 'aire']) {
    assert.ok(outils.BLOC_GRAPHIQUES.includes(type), `type absent de la table : ${type}`);
  }
});

test('les types indisponibles sont nommés, pour que le refus soit prévisible', () => {
  // Ce sont ceux que le fondateur demande : sans consigne, le modèle hésitait
  // entre échouer en silence et promettre ce qu'il ne peut pas produire.
  for (const type of ['radar', 'carte de chaleur', 'boite a moustaches', 'nuage de points']) {
    assert.ok(outils.BLOC_GRAPHIQUES.toLowerCase().includes(type),
      `type indisponible non traité : ${type}`);
  }
});
