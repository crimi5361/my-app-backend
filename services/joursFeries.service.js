// Jours fériés de Côte d'Ivoire — utilisé pour reporter automatiquement toute échéance de
// paiement tombant un jour non ouvrable (week-end ou férié) au prochain jour ouvrable.
const moment = require('moment');

// Algorithme de Meeus/Jones/Butcher (calendrier grégorien) — calcul exact de Pâques, aucune
// approximation. Sert de base aux fêtes chrétiennes mobiles (Lundi de Pâques, Ascension,
// Pentecôte), dont la date varie chaque année selon une règle purement arithmétique.
function calculerPaques(annee) {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31); // 3 = mars, 4 = avril
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return moment(`${annee}-${mois}-${jour}`, 'YYYY-M-D');
}

function joursFeriesFixes(annee) {
  return [
    `${annee}-01-01`, // Jour de l'an
    `${annee}-05-01`, // Fête du Travail
    `${annee}-08-07`, // Fête de l'Indépendance
    `${annee}-08-15`, // Assomption
    `${annee}-11-01`, // Toussaint
    `${annee}-11-15`, // Journée Nationale de la Paix
    `${annee}-12-25`, // Noël
  ];
}

function joursFeriesMobilesChretiens(annee) {
  const paques = calculerPaques(annee);
  return [
    paques.clone().add(1, 'day').format('YYYY-MM-DD'),   // Lundi de Pâques
    paques.clone().add(39, 'days').format('YYYY-MM-DD'),  // Ascension
    paques.clone().add(50, 'days').format('YYYY-MM-DD'),  // Lundi de Pentecôte
  ];
}

// Fêtes musulmanes (Maouloud, Aïd el-Fitr, Tabaski) : dates fixées chaque année par arrêté
// ministériel selon l'observation lunaire, non calculables de façon fiable par une formule.
// À compléter manuellement dès leur confirmation officielle pour l'année concernée — ne jamais
// deviner une date ici, une erreur romprait silencieusement la garantie "jour ouvrable".
const JOURS_FERIES_MUSULMANS_CONFIRMES = new Set([
  // '2026-02-18', // Exemple : Maouloud (à confirmer/ajuster selon l'annonce officielle)
]);

function estJourFerie(date) {
  const m = moment(date);
  const iso = m.format('YYYY-MM-DD');
  const annee = m.year();
  if (joursFeriesFixes(annee).includes(iso)) return true;
  if (joursFeriesMobilesChretiens(annee).includes(iso)) return true;
  if (JOURS_FERIES_MUSULMANS_CONFIRMES.has(iso)) return true;
  return false;
}

function estJourOuvrable(date) {
  const m = moment(date);
  const jourSemaine = m.day(); // 0 = dimanche, 6 = samedi
  if (jourSemaine === 0 || jourSemaine === 6) return false;
  return !estJourFerie(m);
}

// Bug corrigé le 2026-08-01 (trouvé en testant le Chantier 6, sans rapport avec son contenu) :
// avec une date invalide (ex. `date_inscription` NULL en base), `estJourOuvrable` renvoie
// toujours `false` et `m.add(1, 'day')` sur une date invalide reste indéfiniment invalide — la
// boucle ne se terminait jamais, bloquant tout le processus Node (mono-thread). Deux garde-fous :
// (1) une date invalide en entrée est renvoyée telle quelle, sans boucler ; (2) une limite
// d'itérations en filet de sécurité, au cas où un autre cas non prévu produirait le même effet
// (aucun jour férié/week-end connu n'excède quelques jours consécutifs en Côte d'Ivoire — 60
// jours est très largement suffisant pour un cas normal, jamais atteint en pratique).
const LIMITE_ITERATIONS_JOUR_OUVRABLE = 60;

function prochainJourOuvrable(date) {
  let m = moment(date);
  if (!m.isValid()) return m;
  let iterations = 0;
  while (!estJourOuvrable(m)) {
    if (++iterations > LIMITE_ITERATIONS_JOUR_OUVRABLE) {
      throw new Error(`prochainJourOuvrable: aucun jour ouvrable trouvé après ${LIMITE_ITERATIONS_JOUR_OUVRABLE} jours à partir de ${m.format()} — vérifier les données de jours fériés.`);
    }
    m = m.add(1, 'day');
  }
  return m;
}

module.exports = { estJourOuvrable, prochainJourOuvrable, estJourFerie };
