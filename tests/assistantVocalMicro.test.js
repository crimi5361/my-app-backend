// Barrière serveur du micro coupé (2026-08-14).
//
// Le navigateur débranche sa capture, mais c'est le SERVEUR qui garantit la
// coupure : lui seul décide de relayer une trame à Google. Ce test verrouille
// cette décision, parce qu'elle ne se voit ni à l'écran ni dans les journaux —
// une régression ici rouvrirait le micro sans aucun signe visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routerMessageNavigateur, transcriptionAdmise } = require('../services/assistantVocalProtocole');

const ouvert = { microCoupe: false };
const coupe = { microCoupe: true };

test('micro ouvert : la trame audio part chez le modèle', () => {
  const d = routerMessageNavigateur({ type: 'audio', pcm: 'AAAA' }, ouvert);
  assert.equal(d.action, 'audio');
  assert.equal(d.pcm, 'AAAA');
});

test('micro coupé : la trame audio est jetée, elle ne sort pas du serveur', () => {
  const d = routerMessageNavigateur({ type: 'audio', pcm: 'AAAA' }, coupe);
  assert.equal(d.action, 'ignorer');
  assert.equal(d.motif, 'micro coupé');
});

test('micro coupé : aucune transcription du fondateur n\'est renvoyée', () => {
  // C'est le symptôme exact qui était signalé : le texte continuait de
  // s'inscrire après le clic, parce qu'il décrivait un audio parti avant.
  assert.equal(transcriptionAdmise(ouvert), true);
  assert.equal(transcriptionAdmise(coupe), false);
});

test('le message de coupure est reconnu et normalisé en booléen', () => {
  assert.deepEqual(routerMessageNavigateur({ type: 'micro', coupe: true }, ouvert), { action: 'micro', coupe: true });
  assert.deepEqual(routerMessageNavigateur({ type: 'micro', coupe: false }, coupe), { action: 'micro', coupe: false });
  // Une valeur douteuse ne doit jamais valoir « coupé » par accident.
  assert.deepEqual(routerMessageNavigateur({ type: 'micro' }, ouvert), { action: 'micro', coupe: false });
  assert.deepEqual(routerMessageNavigateur({ type: 'micro', coupe: 'oui' }, ouvert), { action: 'micro', coupe: false });
});

test('le clavier reste utilisable micro coupé', () => {
  // Couper le micro n'est pas quitter la conversation : la question écrite doit
  // continuer de passer.
  const d = routerMessageNavigateur({ type: 'texte', texte: 'Combien d\'inscrits ?' }, coupe);
  assert.equal(d.action, 'texte');
  assert.equal(d.texte, "Combien d'inscrits ?");
});

test('messages hors protocole : ignorés sans exception', () => {
  for (const msg of [null, undefined, 'bonjour', 42, {}, { type: 'inconnu' }, { type: 'audio' }]) {
    assert.equal(routerMessageNavigateur(msg, ouvert).action, 'ignorer');
  }
});
