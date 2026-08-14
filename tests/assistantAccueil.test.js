// Phrase d'accueil et mise en forme du nom (2026-08-14).
//
// Le nom vient de la base, où il est saisi en capitales. Lu tel quel par une
// synthèse vocale, « KONE ISMAEL » se prononce correctement mais s'affiche comme
// un cri. Ce sont ces deux exigences — un texte lisible ET une phrase exacte au
// mot près — que ces tests verrouillent.
const test = require('node:test');
const assert = require('node:assert/strict');
// Le module de texte est requis directement plutôt que via le service : ce
// dernier ouvre une connexion à la base au chargement, et un test qui vérifie
// une majuscule n'a rien à faire en production.
const { construirePhraseAccueil, formaterNom } = require('../services/assistantAccueilTexte');

test('un nom tout en capitales est remis en forme', () => {
  assert.equal(formaterNom('KONE ISMAEL'), 'Kone Ismael');
  assert.equal(formaterNom('  KONE ISMAEL  '), 'Kone Ismael');
});

test('les apostrophes et les tirets gardent leur majuscule', () => {
  // Cas réels de cette base.
  assert.equal(formaterNom("N'GORAN ESTHER AKISSI"), "N'Goran Esther Akissi");
  assert.equal(formaterNom('BOGA ANGE CHRISTIAN GUEMA'), 'Boga Ange Christian Guema');
  assert.equal(formaterNom('MARIE-CLAIRE KOUAME'), 'Marie-Claire Kouame');
});

test('un nom déjà mis en forme n\'est pas défait', () => {
  // Le piège inverse : abaisser la casse de « Christopher Tape » le dégraderait.
  assert.equal(formaterNom('Christopher Tape'), 'Christopher Tape');
  assert.equal(formaterNom('Jean-Baptiste N\'Dri'), "Jean-Baptiste N'Dri");
});

test('un nom absent ne fait pas tomber la mise en forme', () => {
  for (const vide of ['', '   ', null, undefined]) assert.equal(formaterNom(vide), '');
});

test('la phrase d\'accueil est exacte, au mot près', () => {
  assert.equal(
    construirePhraseAccueil({ nom: 'KONE ISMAEL', civilite: 'Monsieur' }),
    "Bonjour Monsieur Kone Ismael, j'espère que vous allez bien. "
    + "Voulez-vous que je vous fasse un débriefing des mouvements d'hier ?",
  );
});

test('la civilité est celle du réglage, pas une constante', () => {
  assert.match(construirePhraseAccueil({ nom: 'DIALLO AWA', civilite: 'Madame' }), /^Bonjour Madame Diallo Awa,/);
});

test('sans civilité, la formule reste correcte et neutre', () => {
  // C'est le repli quand le réglage est vide : on ne suppose rien du genre.
  assert.match(construirePhraseAccueil({ nom: 'KONE ISMAEL', civilite: '' }), /^Bonjour Kone Ismael,/);
});

test('sans nom du tout, la phrase reste prononçable', () => {
  // Ne devrait pas arriver, mais une phrase qui commencerait par « Bonjour , »
  // s'entendrait immédiatement.
  const phrase = construirePhraseAccueil({ nom: '', civilite: '' });
  assert.match(phrase, /^Bonjour, j'espère/);
  assert.doesNotMatch(phrase, /\s,/);
});

test('la question posée est bien celle à laquelle on attend oui ou non', () => {
  const phrase = construirePhraseAccueil({ nom: 'KONE ISMAEL', civilite: 'Monsieur' });
  assert.ok(phrase.trim().endsWith('?'), 'la phrase doit se terminer par une question');
});
