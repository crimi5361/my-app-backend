// Post-traitement des transcriptions (2026-08-14).
//
// Le risque de ce module n'est pas de corriger trop peu, c'est de corriger trop :
// une transcription qui change les mots du fondateur est pire qu'une
// transcription fautive, parce qu'elle est crédible. La moitié de ces tests
// vérifie donc ce qui NE doit PAS bouger.
const test = require('node:test');
const assert = require('node:assert/strict');
const { corrigerTranscription, estQuestion } = require('../services/assistantTranscription');

test('majuscule et point final sur une phrase nue', () => {
  assert.equal(corrigerTranscription('le chiffre du mois est bon'), 'Le chiffre du mois est bon.');
});

test('une question reçoit un point d\'interrogation, pas un point', () => {
  assert.equal(corrigerTranscription('combien d\'inscrits cette annee'), "Combien d'inscrits cette annee ?");
  assert.equal(corrigerTranscription('est-ce que la caisse est ouverte'), 'Est-ce que la caisse est ouverte ?');
});

test('les sigles sont rétablis en capitales', () => {
  assert.equal(corrigerTranscription('combien de bts a iipea'), 'Combien de BTS a IIPEA ?');
  assert.equal(corrigerTranscription('exporte en pdf'), 'Exporte en PDF.');
});

test('les confusions observées en production sont corrigées', () => {
  // Le cas signalé : « Comment puis-je vous aider » rendu en
  // « Commentaire puis-je vous athlète ».
  assert.equal(
    corrigerTranscription('commentaire puis-je vous athlete'),
    'Comment puis-je vous aider ?',
  );
});

test('la correction est insensible à la casse et aux accents', () => {
  assert.equal(corrigerTranscription('Commentaire puis-je vous athlète'), 'Comment puis-je vous aider ?');
});

test('la ponctuation déjà présente est respectée', () => {
  assert.equal(corrigerTranscription('Bonjour. Comment allez-vous ?'), 'Bonjour. Comment allez-vous ?');
});

test('typographie française : espace avant les signes doubles, pas avant le point', () => {
  assert.equal(corrigerTranscription('combien d\'inscrits?'), "Combien d'inscrits ?");
  assert.equal(corrigerTranscription('attention !'), 'Attention !');
  assert.equal(corrigerTranscription('voici le total : 12'), 'Voici le total : 12.');
});

test('majuscule après chaque point', () => {
  assert.equal(
    corrigerTranscription('le mois est bon. les encaissements montent'),
    'Le mois est bon. Les encaissements montent.',
  );
});

test('espaces parasites et espace avant ponctuation', () => {
  assert.equal(corrigerTranscription('  le   total  est  bon .'), 'Le total est bon.');
});

// ── Ce qui ne doit surtout pas bouger ──────────────────────────────────────

test('un sigle à l\'intérieur d\'un mot n\'est pas touché', () => {
  // « rh » est un sigle, mais pas dans « marchandise ».
  assert.equal(corrigerTranscription('la marchandise est arrivee'), 'La marchandise est arrivee.');
});

test('les noms propres et les chiffres sont laissés tels quels', () => {
  assert.equal(
    corrigerTranscription('Kone Ismael a valide 1 250 000 francs'),
    'Kone Ismael a valide 1 250 000 francs.',
  );
});

test('un texte vide reste vide', () => {
  assert.equal(corrigerTranscription(''), '');
  assert.equal(corrigerTranscription('   '), '');
  assert.equal(corrigerTranscription(null), '');
  assert.equal(corrigerTranscription(undefined), '');
});

test('aucun mot n\'est ajouté ni retiré hors corrections déclarées', () => {
  const brut = 'les effectifs de la filiere informatique sont stables cette annee';
  const corrige = corrigerTranscription(brut);
  assert.equal(corrige.replace(/[.?]$/, '').toLowerCase(), brut);
});

test('estQuestion distingue les deux formes', () => {
  assert.equal(estQuestion('combien d\'etudiants'), true);
  assert.equal(estQuestion('pourquoi ce recul'), true);
  assert.equal(estQuestion('le total est bon'), false);
  assert.equal(estQuestion(''), false);
});
