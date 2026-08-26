// Assistant Fondateur — journal des échecs (2026-08-26).
//
// CE FICHIER EXISTE PARCE QU'UN DÉFAUT A MIS DES SEMAINES À SE VOIR.
//
// L'assistante répondait « il n'y a aucun enseignant » alors que la base en
// comptait 115. Rien, nulle part, n'en gardait la moindre trace : le chat vit
// dans le localStorage du navigateur, le vocal dans la mémoire de la page. Le
// défaut n'a été découvert qu'en le reproduisant à la main, des semaines plus
// tard. Ce fichier fait en sorte qu'un tel cas laisse une ligne, le jour même.
//
// LA CLASSIFICATION SE FAIT À LA SOURCE, JAMAIS SUR LE TEXTE DE LA RÉPONSE.
// C'est le point de conception central. Chercher « je ne peux pas » dans une
// phrase française serait fragile — il y a mille façons de le dire, et autant de
// faux positifs (« je ne peux pas vous donner le détail, mais voici le total »
// est une réponse réussie). Les outils, eux, renvoient des FORMES distinctes :
// `erreur`, `trouve: false`, `ambigu: true`, zéro ligne. Ces formes-là ne
// s'interprètent pas, elles se reconnaissent.
//
// Reste un cas que ces formes ne couvrent pas : l'assistante qui décline SANS
// avoir appelé le moindre outil. D'où l'outil `signaler_impasse`, qu'elle doit
// appeler avant toute réponse de ce type — voir assistantOutils.service.js. Cela
// transforme un aveu noyé dans du texte libre en événement structuré.
//
// ET UN CAS QUI RESTE HORS DE PORTÉE, qu'il faut assumer plutôt que masquer : le
// chiffre FAUX donné avec assurance. Aucun signal ne l'accompagne — ni erreur,
// ni vide, ni hésitation. Le journal montre les pannes et les recherches
// infructueuses ; il ne montre pas les erreurs de jugement. L'écran doit le dire,
// sans quoi un compteur à zéro se lira « aucune erreur » alors qu'il signifie
// « aucune erreur DE CETTE NATURE ».
const db = require('../config/db.config');

/** Rétention, en jours. Décision du 2026-08-26 : dix jours, pas davantage. */
const RETENTION_JOURS = 10;

/** Les genres reconnus, et ce qu'ils signifient pour qui lit la console. */
const GENRES = {
  panne: "l'outil a levé une erreur, ou la base n'a pas répondu",
  vide: "la requête était valide et n'a ramené aucune ligne",
  introuvable: 'aucune personne ne porte ce nom',
  ambigu: "plusieurs homonymes, l'assistante a dû redemander",
  impasse: "l'assistante a déclaré ne pas pouvoir répondre",
  repli: 'le modèle de tête était épuisé, un modèle de secours a répondu',
};

/** Un détail de journal ne doit jamais faire grossir la table sans limite. */
const coupe = (v, n) => (v == null ? null : String(v).slice(0, n));

/**
 * Reconnaît un échec dans ce qu'un outil vient de renvoyer.
 *
 * FONCTION PURE, et c'est délibéré : elle porte toute la règle de décision, donc
 * elle doit être vérifiable sans base ni réseau.
 *
 * @param {string} nom  nom de l'outil appelé
 * @param {object} sortie  ce que `executerOutil` a renvoyé
 * @returns {{genre:string, detail:string, sql:string|null}|null} null si tout va bien
 */
function classer(nom, sortie) {
  if (!sortie || typeof sortie !== 'object') return null;
  const r = sortie.reponse || {};

  if (r.erreur) {
    return { genre: 'panne', detail: coupe(r.erreur, 500), sql: coupe(sortie.trace?.sql, 2000) };
  }
  if (r.trouve === false) {
    return { genre: 'introuvable', detail: coupe(r.message, 500), sql: null };
  }
  if (r.ambigu === true) {
    const noms = (r.candidats || []).map((c) => c?.nom).filter(Boolean).join(', ');
    return {
      genre: 'ambigu',
      detail: coupe(noms ? 'Homonymes : ' + noms : 'Plusieurs correspondances.', 500),
      sql: null,
    };
  }

  // ZÉRO LIGNE — le cas le plus précieux du journal, et le plus délicat à cadrer.
  //
  // On ne le déclare QUE sur une requête réellement exécutée et réussie
  // (`trace.ok`). Un COUNT(*) rend toujours une ligne : ce genre ne peut donc se
  // produire que sur une liste ou un filtre, c'est-à-dire exactement la situation
  // des 115 enseignants cherchés dans une vue vide.
  //
  // `nb_lignes === 0` et non `!nb_lignes` : un outil sans trace laisse ce champ à
  // `undefined`, et le confondre avec zéro journaliserait chaque appel réussi.
  if (sortie.trace?.ok === true && sortie.trace.nb_lignes === 0) {
    return {
      genre: 'vide',
      detail: coupe(sortie.trace.intention || 'Requête sans résultat.', 500),
      sql: coupe(sortie.trace.sql, 2000),
    };
  }

  return null;
}

/**
 * Dernière purge effectuée par ce processus.
 *
 * POURQUOI PAS UN PLANIFICATEUR. Neon n'expose pas `pg_cron` sur ce palier, et
 * ajouter un ordonnanceur au serveur pour supprimer quelques lignes par semaine
 * serait disproportionné. La purge se fait donc au fil des écritures, au plus une
 * fois par heure et par processus. La table reste petite par construction : on
 * n'y écrit que sur échec.
 */
let dernierePurge = 0;
const PURGE_INTERVALLE_MS = 3600 * 1000;

async function purgerSiNecessaire() {
  const maintenant = Date.now();
  if (maintenant - dernierePurge < PURGE_INTERVALLE_MS) return;
  dernierePurge = maintenant;
  try {
    const r = await db.query(
      "DELETE FROM assistant_echec WHERE cree_le < now() - ($1 || ' days')::interval",
      [RETENTION_JOURS],
    );
    if (r.rowCount) console.log('[assistant] journal : ' + r.rowCount + ' echec(s) echu(s) purge(s).');
  } catch (error) {
    console.warn('[assistant] purge du journal impossible :', error.message);
  }
}

/**
 * Écrit un échec.
 *
 * N'ÉCHOUE JAMAIS BRUYAMMENT. Un journal est un observateur : s'il tombe, il ne
 * doit pas emporter la réponse du fondateur avec lui. C'est la règle déjà tenue
 * pour la comptabilisation des jetons, et pour le même motif — on ne prive
 * personne d'une réponse à cause d'une écriture annexe.
 */
async function journaliser({
  siteId, utilisateurId = null, canal, genre,
  outil = null, question = null, detail = null, sql = null,
}) {
  if (!siteId || !GENRES[genre]) return;
  try {
    await db.query(
      `INSERT INTO assistant_echec
         (site_id, utilisateur_id, canal, genre, outil, question, detail, sql_execute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, utilisateurId, canal || 'texte', genre, coupe(outil, 80),
        coupe(question, 1000), coupe(detail, 500), coupe(sql, 2000)],
    );
  } catch (error) {
    console.warn('[assistant] journal indisponible (la réponse est rendue quand même) :', error.message);
    return;
  }
  await purgerSiNecessaire();
}

/**
 * Reconnaît puis journalise en un seul geste — ce qu'appelle `executerOutil`.
 * Renvoie le classement, pour que l'appelant puisse en faire autre chose.
 */
async function journaliserSortieOutil(nom, sortie, contexte = {}) {
  const verdict = classer(nom, sortie);
  if (!verdict) return null;
  await journaliser({
    ...contexte, genre: verdict.genre, outil: nom, detail: verdict.detail, sql: verdict.sql,
  });
  return verdict;
}

/** Les derniers échecs d'un site, du plus récent au plus ancien. */
async function listerEchecs(siteId, limite = 10) {
  const r = await db.query(
    `SELECT id, canal, genre, outil, question, detail, sql_execute, cree_le
     FROM assistant_echec
     WHERE site_id = $1
     ORDER BY cree_le DESC
     LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limite) || 10, 1), 100)],
  );
  return r.rows.map((l) => ({ ...l, genre_libelle: GENRES[l.genre] || l.genre }));
}

module.exports = {
  classer,
  journaliser,
  journaliserSortieOutil,
  listerEchecs,
  GENRES,
  RETENTION_JOURS,
};
