// Assistant Fondateur — vocabulaire dicté à la reconnaissance vocale (2026-08-13).
//
// CONSTAT. Les transcriptions étaient truffées de fautes : « Comment puis-je
// vous aider » devenait « Commentaire puis-je vous athlète », « un prénom »
// devenait « ONU prénom », « Boga Christian » devenait « Boga chrétien ». Deux
// causes, toutes deux dans la configuration :
//
//   1. `inputAudioTranscription: {}` et `outputAudioTranscription: {}` laissent
//      la DÉTECTION AUTOMATIQUE de langue décider. Sur du français parlé avec
//      des noms ivoiriens, elle hésite et se rabat sur des approximations.
//
//   2. Aucun vocabulaire n'était fourni. Or l'API accepte une liste de termes
//      qui biaisent la reconnaissance — c'est exactement ce qu'il faut pour des
//      noms propres que le modèle acoustique n'a jamais rencontrés.
//
// Ce service construit cette liste À PARTIR DE LA BASE : les agents, les écoles
// et les filières du site. Le vocabulaire d'un établissement n'est pas devinable,
// il est dans ses données.
const { executerRequete } = require('./assistantSql.service');
// Source unique du vocabulaire métier — voir config/vocabulaireMetier.js. La
// liste vivait ici ; elle en est sortie pour que le chat écrit et le mode vocal
// biaisent et corrigent sur exactement les mêmes termes.
const { TERMES_METIER } = require('../config/vocabulaireMetier');

/** Plafond volontaire : une liste trop longue dilue le biais au lieu de le
 *  concentrer, et alourdit chaque ouverture de session. */
const MAX_TERMES = 220;

/** Un cache par site : le vocabulaire change au rythme des recrutements, pas à
 *  celui des conversations. Rafraîchi toutes les heures. */
const cache = new Map();
const DUREE_CACHE_MS = 60 * 60 * 1000;

/**
 * Extrait les mots utiles d'un nom complet. Les mots d'un seul caractère et les
 * particules n'apportent rien au biais et occupent une place limitée.
 */
function motsUtiles(valeur) {
  return String(valeur || '')
    .split(/[\s,'’-]+/)
    .map((m) => m.trim())
    .filter((m) => m.length >= 3);
}

async function construireVocabulaire({ siteId, ecoleId = null }) {
  const termes = new Set(TERMES_METIER);

  const requetes = [
    // Les noms d'agents sont ceux que le fondateur prononce le plus souvent, et
    // ceux que la reconnaissance rate le plus : ils passent en premier.
    "SELECT agent AS v FROM assistant.v_agents ORDER BY agent",
    "SELECT DISTINCT ecole AS v FROM assistant.v_structure WHERE ecole IS NOT NULL",
    "SELECT DISTINCT filiere AS v FROM assistant.v_structure WHERE filiere IS NOT NULL",
  ];

  for (const sql of requetes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await executerRequete(sql, { siteId, ecoleId, limiteLignes: 200 });
    if (!r.ok) continue;
    for (const ligne of r.lignes) {
      // Le nom complet ET ses mots : « KONE ISMAEL » aide sur la formule
      // entière, « KONE » seul aide quand le fondateur ne dit que le nom.
      const complet = String(ligne.v || '').trim();
      if (complet.length >= 3) termes.add(complet);
      motsUtiles(complet).forEach((m) => termes.add(m));
      if (termes.size >= MAX_TERMES) break;
    }
    if (termes.size >= MAX_TERMES) break;
  }

  return [...termes].slice(0, MAX_TERMES);
}

async function getVocabulaire({ siteId, ecoleId = null }) {
  const cle = `${siteId}:${ecoleId ?? ''}`;
  const enCache = cache.get(cle);
  if (enCache && Date.now() - enCache.date < DUREE_CACHE_MS) return enCache.termes;

  try {
    const termes = await construireVocabulaire({ siteId, ecoleId });
    cache.set(cle, { termes, date: Date.now() });
    return termes;
  } catch (error) {
    console.warn('[vocal] vocabulaire indisponible :', error.message);
    // Un vocabulaire absent dégrade la transcription, il ne doit pas empêcher
    // la conversation : on retombe sur les seuls termes métier.
    return TERMES_METIER;
  }
}

module.exports = { getVocabulaire, TERMES_METIER, MAX_TERMES };
