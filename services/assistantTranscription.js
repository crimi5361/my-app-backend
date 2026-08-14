// Post-traitement des transcriptions (2026-08-14).
//
// La reconnaissance vocale rend un texte sans ponctuation, sans majuscule et
// avec des sigles en minuscules. Ce module remet cela d'aplomb — rien de plus.
// Il ne réécrit pas, ne reformule pas, ne complète pas : ce que le fondateur a
// dit doit rester ce qu'il a dit.
//
// UNE RÈGLE ABSOLUE : ne s'applique qu'à un texte COMPLET, jamais à un fragment.
// Les transcriptions arrivent par morceaux ; capitaliser chaque morceau
// produirait « Bonjour Monsieur Comment Puis-je Vous ». C'est l'appelant qui
// accumule, et qui n'appelle qu'à la fin du tour de parole.
//
// Aucune dépendance : ce module se teste seul.
const { SIGLES, CORRECTIONS, OUVERTURES_QUESTION } = require('../config/vocabulaireMetier');

/** Minuscules sans accent — la forme sur laquelle on compare, jamais celle
 *  qu'on affiche. */
const normaliser = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase();

/** Échappe une chaîne destinée à une expression régulière. */
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applique les corrections de phrases entières.
 *
 * La comparaison se fait sur la forme normalisée, le remplacement sur le texte
 * d'origine : « Commentaire puis-je » et « commentaire puis-je » sont corrigés
 * l'un comme l'autre.
 */
function appliquerCorrections(texte, corrections) {
  let sortie = texte;
  for (const { de, vers } of corrections) {
    // Le motif est construit sur la version normalisée, mais appliqué au texte
    // réel : on autorise donc n'importe quel diacritique sur les voyelles.
    const motif = new RegExp(`\\b${echapper(de).replace(/[aeiouyc]/g, (c) => `[${c}${accentsDe(c)}]`)}\\b`, 'gi');
    sortie = sortie.replace(motif, vers);
  }
  return sortie;
}

/** Variantes accentuées d'une lettre, pour comparer sans imposer l'accent. */
function accentsDe(lettre) {
  const table = {
    a: 'àâä', e: 'éèêë', i: 'îï', o: 'ôö', u: 'ùûü', y: 'ÿ', c: 'ç',
  };
  return table[lettre] || '';
}

/** Rétablit la casse des sigles, sur des mots entiers uniquement. */
function appliquerSigles(texte, sigles) {
  return texte.replace(/[\p{L}\p{M}]+/gu, (mot) => {
    const sigle = sigles[normaliser(mot)];
    return sigle || mot;
  });
}

/** Majuscule en tête de texte et après un point, un point d'exclamation ou
 *  d'interrogation. */
function capitaliser(texte) {
  return texte.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, avant, lettre) => avant + lettre.toUpperCase());
}

/** Le texte pose-t-il une question ? Sert à choisir le signe final. */
function estQuestion(texte, ouvertures = OUVERTURES_QUESTION) {
  const n = normaliser(texte).trim();
  if (!n) return false;
  if (n.includes('est-ce que') || n.includes('est-ce qu')) return true;
  return ouvertures.some((o) => n.startsWith(`${o} `) || n === o);
}

/**
 * Remet d'aplomb une transcription complète.
 *
 * @param {string} brut  texte complet d'un tour de parole
 * @param {{sigles?:object, corrections?:Array}} [config]
 * @returns {string}
 */
function corrigerTranscription(brut, config = {}) {
  const sigles = config.sigles || SIGLES;
  const corrections = config.corrections || CORRECTIONS;

  let texte = String(brut || '')
    .replace(/\s+/g, ' ')
    // Typographie française, et non règle uniforme : pas d'espace avant la
    // virgule et le point, mais un espace avant les signes doubles. Une première
    // version collait tout, ce qui transformait « allez-vous ? » en
    // « allez-vous? » — elle corrigeait un texte déjà correct.
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s*([?!;:])/g, ' $1')
    .trim();
  if (!texte) return '';

  texte = appliquerCorrections(texte, corrections);
  texte = appliquerSigles(texte, sigles);
  texte = capitaliser(texte);

  // Ponctuation finale, si elle manque. Un texte sans point se lit comme une
  // phrase inachevée, et l'oral n'en produit jamais.
  if (!/[.!?…]$/.test(texte)) texte += estQuestion(texte) ? ' ?' : '.';

  return texte;
}

module.exports = { corrigerTranscription, estQuestion, normaliser };
