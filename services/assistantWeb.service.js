// Assistant Fondateur — consultation du web (2026-08-13).
//
// POURQUOI UN APPEL SÉPARÉ plutôt que l'ancrage Google branché sur la
// conversation principale : selon les versions de l'API, Gemini refuse de
// combiner `googleSearch` avec des déclarations de fonctions dans un même
// appel. Or l'assistante a besoin de ses outils maison en permanence. On isole
// donc la recherche dans un appel qui ne porte QUE l'ancrage — la question du
// cumul ne se pose plus, et le procédé restera valable quelle que soit
// l'évolution de cette contrainte.
//
// Ce découplage a un second mérite : le serveur voit passer la réponse web et
// ses sources, il peut donc les renvoyer séparément pour que l'écran distingue
// clairement ce qui vient du web de ce qui vient de la base.
const { GoogleGenAI } = require('@google/genai');
const { enregistrer, extraireUsage } = require('./assistantBudget.service');
const { executerRequete } = require('./assistantSql.service');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODELE_WEB = process.env.ASSISTANT_MODELE_WEB || 'gemini-3.6-flash';

/** Au-delà, ce n'est plus une question mais un texte : on refuse plutôt que de
 *  laisser filer une requête coûteuse. */
const LONGUEUR_MAX = 400;

const INSTRUCTION = `Tu réponds à une question posée par le fondateur d'une université
ivoirienne, à partir de sources web actuelles.

- Réponds en français, en trois phrases au plus.
- Donne les chiffres et les dates que tu trouves, avec leur date de validité.
- Si les sources se contredisent ou sont anciennes, dis-le.
- Si tu ne trouves rien de fiable, dis-le franchement plutôt que d'approximer.
- N'invente aucune donnée sur l'IIPEA : tu n'as accès qu'au web ici, pas à sa base.`;

/**
 * Refuse une question qui emporterait une donnee personnelle vers Google.
 *
 * C'est le point faible de toute recherche web branchee sur une base : le
 * modele compose la question, et rien ne l'empeche d'y glisser le nom d'un
 * etudiant ou le matricule d'un agent. La question partirait alors chez un
 * tiers, hors de tout perimetre maitrise.
 *
 * Le controle est fait EN BASE, pas par une liste de mots : on demande a
 * l'annuaire si l'un des mots de la question designe quelqu'un. Une requete
 * indexee, et aucune liste a maintenir.
 */
const MOTIF_MATRICULE = /\d{6,}[A-Za-z]?/;

/** Mots frequents assez longs pour passer le filtre mais qui ne designent
 *  personne. Sans cette liste, une question anodine serait refusee des qu'elle
 *  contient « informations » ou « etablissement ». */
const MOTS_COURANTS = new Set([
  'quel', 'quelle', 'quels', 'quelles', 'quoi', 'combien', 'comment', 'pourquoi',
  'cherche', 'trouve', 'donne', 'peux', 'peut', 'dois', 'faut', 'sais', 'sait',
  'informations', 'information', 'internet', 'donnees', 'donnee', 'question',
  'etablissement', 'universite', 'ecole', 'etudiant', 'etudiants', 'agent',
  'agents', 'annee', 'annees', 'taux', 'montant', 'cote', 'ivoire', 'abidjan',
  'aujourd', 'actuel', 'actuelle', 'general', 'generale', 'IIPEA',
]);

/**
 * Refuse une question qui emporterait une donnee personnelle vers Google.
 *
 * C'est le point faible de toute recherche web branchee sur une base : le
 * modele compose la question, et rien ne l'empeche d'y glisser le nom d'un
 * etudiant ou le matricule d'un agent. La question partirait alors chez un
 * tiers, hors de tout perimetre maitrise.
 *
 * Le controle interroge l'ANNUAIRE, il ne s'appuie sur aucune liste de noms a
 * maintenir. L'operateur && d'intersection de tableaux repond exactement a la
 * question posee : l'un des mots de la question est-il un mot d'un nom ? Une
 * premiere version utilisait assistant.correspond, qui exige au contraire que
 * TOUS les mots soient dans le nom — elle ne bloquait donc jamais rien.
 */
async function comporteDonneePersonnelle(question, siteId, ecoleId) {
  if (MOTIF_MATRICULE.test(question)) return 'un matricule';

  const mots = [...new Set(
    String(question)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((m) => m.length >= 4 && !MOTS_COURANTS.has(m)),
  )].slice(0, 12);
  if (!mots.length) return null;

  const liste = mots.map((m) => `'${m}'`).join(', ');
  const r = await executerRequete(
    `SELECT 1 FROM assistant.v_personnes WHERE assistant.mots(nom_complet) && ARRAY[${liste}] LIMIT 1`,
    { siteId, ecoleId, limiteLignes: 1 },
  );
  return r.ok && r.lignes.length ? "le nom d'une personne de l'etablissement" : null;
}

/**
 * Interroge le web via l'ancrage Google de Gemini.
 *
 * @returns {Promise<{ok:true, reponse:string, sources:Array}|{ok:false, motif:string}>}
 */
async function chercherWeb({ question, siteId, utilisateurId = null }) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, motif: 'Question vide.' };
  if (q.length > LONGUEUR_MAX) {
    return { ok: false, motif: `Question trop longue (${q.length} caractères, ${LONGUEUR_MAX} au maximum).` };
  }

  // Barriere avant l'appel : une fois la question partie, il est trop tard.
  const fuite = await comporteDonneePersonnelle(q, siteId, null);
  if (fuite) {
    return {
      ok: false,
      motif: `Recherche refusee : la question contient ${fuite}. Les donnees de `
        + "l'etablissement ne sortent pas vers un moteur de recherche. Reformule "
        + 'la question en termes generaux, sans citer personne.',
    };
  }

  try {
    const r = await ai.models.generateContent({
      model: MODELE_WEB,
      contents: q,
      config: { systemInstruction: INSTRUCTION, tools: [{ googleSearch: {} }] },
    });

    // Comptabilisé comme le reste : une recherche web consomme des jetons, elle
    // doit peser sur le même plafond mensuel.
    await enregistrer({
      siteId, utilisateurId, canal: 'web', modele: MODELE_WEB,
      usage: extraireUsage(r?.usageMetadata),
    });

    const ancrage = r.candidates?.[0]?.groundingMetadata;
    const sources = (ancrage?.groundingChunks || [])
      .map((c) => ({ titre: c.web?.title || null, lien: c.web?.uri || null }))
      .filter((s) => s.lien)
      .slice(0, 5);

    const texte = (r.text || '').trim();
    if (!texte) return { ok: false, motif: "Le web n'a rien renvoyé d'exploitable." };

    return { ok: true, reponse: texte, sources, ancre: sources.length > 0 };
  } catch (error) {
    const m = String(error.message || '');
    if (/RESOURCE_EXHAUSTED|quota|429/i.test(m)) {
      return { ok: false, motif: 'Quota Gemini atteint : la recherche web est momentanément indisponible.' };
    }
    // L'ancrage Google n'est pas ouvert sur tous les modèles ni tous les plans.
    if (/google_search|grounding|not supported|INVALID_ARGUMENT/i.test(m)) {
      return {
        ok: false,
        motif: "La recherche web n'est pas disponible sur ce modèle ou ce plan Google. "
          + "Dis-le simplement au fondateur : tu réponds sur la base, pas sur le web.",
      };
    }
    console.error('[web] recherche:', error);
    return { ok: false, motif: 'La recherche web a échoué.' };
  }
}

module.exports = { chercherWeb, MODELE_WEB };
