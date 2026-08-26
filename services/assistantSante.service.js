// Assistant Fondateur — les trois voyants de la console (2026-08-26).
//
// ON TESTE, ON NE DEVINE PAS.
//
// Un voyant qui lit un cache ou un drapeau de configuration finit toujours par
// mentir : il reste au vert pendant que l'assistante est muette, parce que la
// clé est bien présente et que la variable d'environnement est bien remplie.
// C'est exactement ce qui s'est produit le 21 août — le fournisseur répondait
// 503 depuis quatre jours pendant que tout, côté serveur, paraissait en ordre.
// Chaque voyant fait donc un appel RÉEL et le chronomètre.
//
// CE QUE COÛTE UN RAFRAÎCHISSEMENT. La vérification du canal écrit envoie une
// requête minuscule au modèle : quelques jetons, une fraction de centime. C'est
// le prix d'un voyant qui dit la vérité, et il est négligeable devant le coût
// d'une démonstration ratée. Le canal vocal, lui, ouvre puis referme une session
// sans envoyer un seul échantillon audio — l'audio est ce qui coûte, et il n'y
// en a pas.
//
// AUCUN NOM DE MODÈLE NE SORT D'ICI. Ces réponses partent vers un écran
// d'administration, mais l'habitude se perd vite : on nomme les canaux par leur
// usage — « base de données », « assistante écrite », « assistante vocale ».
const { GoogleGenAI, Modality } = require('@google/genai');
const { executerRequete } = require('./assistantSql.service');
const db = require('../config/db.config');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Délai au-delà duquel on cesse d'attendre.
 *
 * 12 SECONDES, et ce n'est pas arbitraire : la connexion à Neon a été mesurée
 * entre 2,4 et 3,9 s depuis ce poste, et une réponse du canal écrit tourne autour
 * de 3 s. Douze secondes laissent donc trois fois la marge nécessaire, tout en
 * gardant un écran qui répond. Au-delà, l'information utile n'est plus le temps
 * exact — c'est que ça ne répond pas.
 */
const DELAI_MS = 12000;

/** Un état lisible sans connaître le détail technique. */
const VERT = 'repond';
const ORANGE = 'lent';
const ROUGE = 'muet';

/** Au-delà de ce temps, le service répond mais l'écran doit le signaler. */
const SEUIL_LENT_MS = 6000;

/**
 * Enveloppe une vérification : chronomètre, borne dans le temps, et ne laisse
 * JAMAIS remonter une exception. Un voyant qui plante emporterait l'écran entier
 * — c'est-à-dire précisément l'outil de diagnostic dont on a besoin au moment où
 * quelque chose ne va pas.
 */
async function mesurer(nom, libelle, sonde) {
  const debut = Date.now();
  let expire;
  try {
    const limite = new Promise((_, rejeter) => {
      expire = setTimeout(() => rejeter(new Error(`aucune réponse en ${DELAI_MS / 1000} s`)), DELAI_MS);
    });
    await Promise.race([sonde(), limite]);
    const duree = Date.now() - debut;
    return { nom, libelle, etat: duree > SEUIL_LENT_MS ? ORANGE : VERT, duree_ms: duree, motif: null };
  } catch (erreur) {
    return {
      nom,
      libelle,
      etat: ROUGE,
      duree_ms: Date.now() - debut,
      motif: String(erreur?.message || 'panne').slice(0, 200),
    };
  } finally {
    clearTimeout(expire);
  }
}

/**
 * La base, interrogée AVEC LES DROITS DE L'ASSISTANTE et non ceux du serveur.
 *
 * C'est tout l'intérêt du test : le serveur peut parfaitement joindre la base
 * pendant que le rôle en lecture seule de l'assistante, lui, est cassé ou
 * dépourvu de droits. Passer par `executerRequete` emprunte exactement le chemin
 * qu'emprunte une question du fondateur, validateur SQL compris.
 */
async function sonderBase(siteId, ecoleId) {
  const r = await executerRequete('SELECT 1 AS ok', { siteId, ecoleId });
  if (!r.ok) throw new Error(r.motif || 'requête refusée');
}

/** Le canal écrit, avec la plus petite question possible. */
async function sonderTexte() {
  const modele = process.env.ASSISTANT_MODELE_TEXTE || 'gemini-3.6-flash';
  const r = await ai.models.generateContent({
    model: modele,
    contents: 'ping',
    config: { maxOutputTokens: 1, systemInstruction: 'Réponds par le seul mot : ok' },
  });
  if (!r) throw new Error('réponse vide');
}

/**
 * Le canal vocal : la session s'ouvre puis se referme immédiatement.
 *
 * On n'envoie aucun audio. Ouvrir la session est ce qui échoue quand le modèle
 * Live a été retiré — c'est arrivé le 7 août — et c'est donc ce qu'il faut
 * éprouver. Le reste ne coûterait que des crédits.
 */
async function sonderVocal() {
  const modele = process.env.ASSISTANT_MODELE_VOCAL || 'gemini-3.1-flash-live-preview';
  const session = await ai.live.connect({
    model: modele,
    // AUDIO et non TEXT : les modeles Live employes ici sont a audio natif, et
    // une modalite qu'ils n'acceptent pas ne fait pas echouer l'ouverture — elle
    // la laisse pendre jusqu'au delai. Constate au premier essai : douze secondes
    // de silence la ou le canal fonctionnait parfaitement.
    config: { responseModalities: [Modality.AUDIO] },
    callbacks: { onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => {} },
  });
  try {
    if (typeof session.close === 'function') session.close();
  } catch (_) {
    // Une fermeture qui échoue n'invalide pas l'ouverture, qui est ce qu'on teste.
  }
}

/** Les trois voyants, testés en parallèle : l'écran ne doit pas attendre 3 × 12 s. */
async function voyants({ siteId, ecoleId = null }) {
  return Promise.all([
    mesurer('base', 'Base de données', () => sonderBase(siteId, ecoleId)),
    mesurer('texte', 'Assistante écrite', sonderTexte),
    mesurer('vocal', 'Assistante vocale', sonderVocal),
  ]);
}

/**
 * Le dernier incident notable, tiré du journal.
 *
 * On ne retient que `panne` et `repli` : une recherche infructueuse ou une
 * homonymie sont des échecs de la conversation, pas des incidents du service.
 * Les mélanger ferait clignoter « dernier incident » sur un fondateur qui a
 * simplement demandé quelqu'un qui n'existe pas.
 */
async function dernierIncident(siteId) {
  const { rows } = await db.query(
    `SELECT genre, detail, cree_le FROM assistant_echec
     WHERE site_id = $1 AND genre IN ('panne', 'repli')
     ORDER BY cree_le DESC LIMIT 1`,
    [siteId],
  );
  return rows[0] || null;
}

module.exports = { voyants, dernierIncident, DELAI_MS, SEUIL_LENT_MS, VERT, ORANGE, ROUGE };
