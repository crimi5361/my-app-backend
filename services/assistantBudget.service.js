// Assistant Fondateur — plafond de dépenses applicatif (2026-08-12).
//
// POURQUOI CE FICHIER EXISTE
// Le plafond de Google (250 $/mois au Niveau 1) n'est pas réglable : c'est une
// limite imposée, pas un réglage. Le fondateur voulait un plafond à SA valeur
// (20 000 FCFA). On le pose donc ici, où on maîtrise réellement la décision.
//
// L'arrêt se produit AVANT l'appel au modèle, jamais après : une fois les jetons
// consommés, ils sont facturés. `verifierBudget()` doit donc être appelé en amont
// de tout appel à Gemini, et `enregistrer()` juste après.
//
// Les tarifs sont ici, en dur et datés. Ils changent : quand ce sera le cas, cette
// constante est le seul endroit à modifier, et l'historique reste recalculable
// puisqu'on stocke les jetons bruts en base, pas seulement le coût.
const db = require('../config/db.config');

// $ par million de jetons — relevés sur ai.google.dev/gemini-api/docs/pricing le 2026-08-12.
const TARIFS = {
  texte:  { entree: 1.50, sortie: 7.50 },   // gemini-3.6-flash (palier payant)
  audio:  { entree: 3.00, sortie: 12.00 },  // Live API, audio natif
};

const BUDGET_FCFA = Number(process.env.ASSISTANT_BUDGET_MENSUEL_FCFA || 20000);
const TAUX_FCFA = Number(process.env.ASSISTANT_TAUX_FCFA_USD || 600);

// Marge de sécurité : on refuse à 100 % du budget, mais on prévient dès 80 %
// pour que le fondateur ne découvre pas la coupure au pire moment.
const SEUIL_ALERTE = 0.8;

/** Coût en dollars d'un appel, à partir des jetons déclarés. */
function calculerCout({ jetonsEntree = 0, jetonsSortie = 0, jetonsAudioEntree = 0, jetonsAudioSortie = 0 }) {
  return (
    jetonsEntree * TARIFS.texte.entree
    + jetonsSortie * TARIFS.texte.sortie
    + jetonsAudioEntree * TARIFS.audio.entree
    + jetonsAudioSortie * TARIFS.audio.sortie
  ) / 1e6;
}

/** Dépense du site sur le mois calendaire en cours. */
async function getConsommationMois(siteId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(cout_usd), 0)::float AS usd,
            COUNT(*)::int                     AS appels
     FROM assistant_consommation
     WHERE site_id = $1 AND cree_le >= date_trunc('month', CURRENT_DATE)`,
    [siteId]
  );
  const usd = r.rows[0].usd;
  const fcfa = usd * TAUX_FCFA;
  return {
    usd,
    fcfa: Math.round(fcfa),
    appels: r.rows[0].appels,
    budget_fcfa: BUDGET_FCFA,
    restant_fcfa: Math.max(Math.round(BUDGET_FCFA - fcfa), 0),
    pourcentage: BUDGET_FCFA > 0 ? Math.min(Math.round((fcfa / BUDGET_FCFA) * 100), 999) : 0,
  };
}

/**
 * À appeler AVANT tout appel au modèle.
 * @returns {{autorise: boolean, motif?: string, consommation: object}}
 */
async function verifierBudget(siteId) {
  const consommation = await getConsommationMois(siteId);

  if (consommation.fcfa >= BUDGET_FCFA) {
    return {
      autorise: false,
      consommation,
      motif:
        `Budget mensuel atteint : ${consommation.fcfa.toLocaleString('fr-FR')} FCFA consommés `
        + `sur ${BUDGET_FCFA.toLocaleString('fr-FR')} FCFA. L'assistant reprendra au début du mois `
        + `prochain, ou dès que le plafond sera relevé (ASSISTANT_BUDGET_MENSUEL_FCFA).`,
    };
  }

  return { autorise: true, consommation, alerte: consommation.pourcentage >= SEUIL_ALERTE * 100 };
}

/**
 * À appeler APRÈS chaque appel au modèle, avec les jetons réellement consommés.
 * N'échoue jamais bruyamment : une erreur de comptabilité ne doit pas priver le
 * fondateur de sa réponse — elle est journalisée et la requête continue.
 */
async function enregistrer({ siteId, utilisateurId = null, canal, modele, usage = {} }) {
  const jetons = {
    jetonsEntree: usage.promptTokenCount || 0,
    jetonsSortie: usage.candidatesTokenCount || 0,
    jetonsAudioEntree: usage.audioPromptTokenCount || 0,
    jetonsAudioSortie: usage.audioCandidatesTokenCount || 0,
  };
  const cout = calculerCout(jetons);

  try {
    await db.query(
      `INSERT INTO assistant_consommation
         (site_id, utilisateur_id, canal, modele,
          jetons_entree, jetons_sortie, jetons_audio_entree, jetons_audio_sortie, cout_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [siteId, utilisateurId, canal, modele,
       jetons.jetonsEntree, jetons.jetonsSortie, jetons.jetonsAudioEntree, jetons.jetonsAudioSortie, cout]
    );
  } catch (error) {
    console.error('[assistant] comptabilisation échouée (la réponse est rendue quand même) :', error.message);
  }

  return { cout_usd: cout, cout_fcfa: cout * TAUX_FCFA };
}

/**
 * Extrait les compteurs de jetons d'une réponse Gemini, texte ou Live.
 * Les deux surfaces exposent `usageMetadata` mais pas sous la même forme : en Live,
 * le détail par modalité est dans un tableau `*TokensDetails`.
 */
function extraireUsage(usageMetadata) {
  if (!usageMetadata) return {};

  const parModalite = (details, modalite) =>
    (details || []).filter((d) => d.modality === modalite).reduce((s, d) => s + (d.tokenCount || 0), 0);

  const audioEntree = parModalite(usageMetadata.promptTokensDetails, 'AUDIO');
  const audioSortie = parModalite(
    usageMetadata.responseTokensDetails || usageMetadata.candidatesTokensDetails, 'AUDIO'
  );

  return {
    // Les jetons audio sont retirés du total texte pour ne pas être facturés deux fois.
    promptTokenCount: Math.max((usageMetadata.promptTokenCount || 0) - audioEntree, 0),
    candidatesTokenCount: Math.max((usageMetadata.candidatesTokenCount || 0) - audioSortie, 0),
    audioPromptTokenCount: audioEntree,
    audioCandidatesTokenCount: audioSortie,
  };
}

module.exports = {
  verifierBudget,
  enregistrer,
  getConsommationMois,
  extraireUsage,
  calculerCout,
  TARIFS,
  BUDGET_FCFA,
  TAUX_FCFA,
};
