// Reconnaissance d'un accord ou d'un refus (2026-08-14).
//
// Le coût d'une erreur n'est pas symétrique et ce n'est pas anodin : lire un
// rapport entier à quelqu'un qui a dit non est pénible, mais ne rien faire à
// quelqu'un qui a dit oui donne l'impression que l'assistante n'écoute pas.
// D'où le troisième verdict, « ambigu », qui déclenche une relance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { intentionOuiNon } = require('../services/assistantIntention');

test('les accords, tels qu\'on les prononce', () => {
  for (const phrase of [
    'oui', 'Oui', 'ouais', 'OUI !', 'oui, vas-y',
    'vas-y', 'vas y', 'allez-y', 'allons-y',
    "je t'écoute", 'je vous écoute',
    "d'accord", 'daccord', 'ok', 'okay',
    'bien sûr', 'volontiers', 'avec plaisir', 'je veux bien',
    'carrément', 'pourquoi pas', 'ça m’intéresse',
    'montre-moi ça', 'dis-moi tout', 'très bien', 'entendu',
  ]) {
    assert.equal(intentionOuiNon(phrase), 'oui', `« ${phrase} » devrait être un accord`);
  }
});

test('les refus, tels qu\'on les prononce', () => {
  for (const phrase of [
    'non', 'Non.', 'nan', 'non merci',
    'pas maintenant', 'pas tout de suite', 'pas la peine', 'pas besoin',
    'plus tard', 'une autre fois', 'laisse tomber',
    "ce n'est pas la peine", 'sans façon', 'je ne veux pas',
    "je n'ai pas le temps", 'annule',
  ]) {
    assert.equal(intentionOuiNon(phrase), 'non', `« ${phrase} » devrait être un refus`);
  }
});

// ── Les pièges du français ─────────────────────────────────────────────────

test('« pourquoi pas » est un accord, pas un refus', () => {
  // Le piège central : « pas » y est présent, mais l'expression entière dit oui.
  assert.equal(intentionOuiNon('pourquoi pas'), 'oui');
  assert.equal(intentionOuiNon('pourquoi pas, je t\'écoute'), 'oui');
});

test('« je ne veux pas » est un refus, malgré « je veux »', () => {
  assert.equal(intentionOuiNon('je ne veux pas'), 'non');
});

test('la réserve l\'emporte sur l\'accord de politesse', () => {
  // « oui mais pas maintenant » n'est pas un oui : c'est un report.
  assert.equal(intentionOuiNon('oui mais pas maintenant'), 'non');
  assert.equal(intentionOuiNon('oui, plus tard'), 'non');
});

test('un accord dans une phrase complète est reconnu', () => {
  assert.equal(intentionOuiNon('oui je veux bien voir ça'), 'oui');
  assert.equal(intentionOuiNon("d'accord, allez-y je vous écoute"), 'oui');
});

// ── Ce qu'on refuse de deviner ─────────────────────────────────────────────

test('l\'hésitation est ambiguë, elle n\'est pas un oui', () => {
  for (const phrase of [
    'peut-être', 'je ne sais pas', 'hmm', 'euh', 'comment ça',
    'de quoi tu parles', 'quel débriefing', '',
  ]) {
    assert.equal(intentionOuiNon(phrase), 'ambigu', `« ${phrase} » devrait être ambigu`);
  }
});

test('une phrase hors sujet est ambiguë', () => {
  assert.equal(intentionOuiNon('quel est le chiffre du mois'), 'ambigu');
  assert.equal(intentionOuiNon('combien avons-nous d\'étudiants'), 'ambigu');
});

test('une entrée absente ou non textuelle ne fait pas tomber la détection', () => {
  for (const valeur of [null, undefined, 42, {}, []]) {
    assert.equal(intentionOuiNon(valeur), 'ambigu');
  }
});

test('un mot contenant « non » ou « oui » ne compte pas', () => {
  // « nonobstant », « ouistiti » : la comparaison porte sur des mots entiers.
  assert.equal(intentionOuiNon('nonobstant cette remarque'), 'ambigu');
  assert.equal(intentionOuiNon('mononucleose'), 'ambigu');
});
