// Assistant Fondateur — mesure de la consommation (2026-08-12, revu le 2026-08-25).
//
// CE FICHIER MESURE, IL NE COUPE PLUS.
//
// Il a été écrit comme un plafond de dépenses : le fondateur voulait une limite
// à 20 000 FCFA, on la posait ici. Le raisonnement était juste, la prémisse
// fausse — le projet Google était sur le palier GRATUIT, aucune facturation
// n'avait lieu, et la vraie limite était un compteur de 20 requêtes par jour que
// ce fichier ignorait. Il coupait donc sur un montant imaginaire, à côté de la
// contrainte réelle. Le 2026-08-25, la coupure a été retirée et la mesure
// conservée : voir `verifierBudget`.
//
// CE QUI EST STOCKÉ, ET CE QUI EST DÉDUIT. `assistant_consommation` garde les
// quatre compteurs de jetons déclarés par Google, par appel et par modèle : ce
// sont des faits. `cout_usd` en est une valorisation, calculée avec la table de
// tarifs ci-dessous : c'est une estimation. Garder les jetons bruts permet de
// recalculer tout l'historique le jour où un tarif change.
const db = require('../config/db.config');

// $ par million de jetons — relevés sur ai.google.dev/gemini-api/docs/pricing.
//
// LA SOURCE DE VÉRITÉ EST LE NOMBRE DE JETONS, PAS LE MONTANT. `assistant_consommation`
// stocke les quatre compteurs bruts déclarés par Google ; `cout_usd` n'en est
// qu'une valorisation, calculée avec la table ci-dessous. Si un tarif change,
// l'historique reste recalculable — d'où ce choix, tenu depuis l'origine.
//
// PAR MODÈLE, depuis le 2026-08-25 : la chaîne de repli peut faire répondre un
// modèle « lite » ou « pro » à la place du modèle de tête. Appliquer le tarif du
// modèle de tête à la réponse d'un autre fausserait le coût dans les deux sens,
// et c'est précisément ce chiffre qui sert à dimensionner les crédits.
//
// ⚠️ RELEVÉS LE 2026-08-12 ET NON REVÉRIFIÉS DEPUIS. Les tarifs Google évoluent.
// Avant de fonder une décision d'achat de crédits sur `cout_usd`, confronter
// cette table à la page de tarification du jour.
const TARIFS_DEFAUT = { entree: 1.50, sortie: 7.50, audioEntree: 3.00, audioSortie: 12.00 };

const TARIFS_PAR_MODELE = {
  'gemini-3.6-flash':          { entree: 1.50, sortie: 7.50, audioEntree: 3.00, audioSortie: 12.00 },
  'gemini-flash-lite-latest':  { entree: 0.50, sortie: 2.00, audioEntree: 1.00, audioSortie: 4.00 },
  'gemini-3.1-flash-lite':     { entree: 0.50, sortie: 2.00, audioEntree: 1.00, audioSortie: 4.00 },
  'gemini-pro-latest':         { entree: 5.00, sortie: 20.00, audioEntree: 8.00, audioSortie: 30.00 },
  // Live API, audio natif — l'entrée et la sortie audio dominent le coût.
  'gemini-3.1-flash-live-preview':        { entree: 1.50, sortie: 7.50, audioEntree: 3.00, audioSortie: 12.00 },
  'gemini-2.5-flash-native-audio-latest': { entree: 1.50, sortie: 7.50, audioEntree: 3.00, audioSortie: 12.00 },
};

/** Tarif applicable à un modèle, avec repli explicite sur le tarif générique. */
function tarifsDe(modele) {
  return TARIFS_PAR_MODELE[modele] || TARIFS_DEFAUT;
}

const BUDGET_FCFA = Number(process.env.ASSISTANT_BUDGET_MENSUEL_FCFA || 20000);
const TAUX_FCFA = Number(process.env.ASSISTANT_TAUX_FCFA_USD || 600);

// Marge de sécurité : on refuse à 100 % du budget, mais on prévient dès 80 %
// pour que le fondateur ne découvre pas la coupure au pire moment.
const SEUIL_ALERTE = 0.8;

/** Coût en dollars d'un appel, à partir des jetons déclarés et du modèle qui a répondu. */
function calculerCout(
  { jetonsEntree = 0, jetonsSortie = 0, jetonsAudioEntree = 0, jetonsAudioSortie = 0 },
  modele = null,
) {
  const t = tarifsDe(modele);
  return (
    jetonsEntree * t.entree
    + jetonsSortie * t.sortie
    + jetonsAudioEntree * t.audioEntree
    + jetonsAudioSortie * t.audioSortie
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
 *
 * ⚠️ LA COUPURE EST DÉSACTIVÉE — décision du 2026-08-25, assumée et documentée.
 *
 * Ce plafond mesurait une dépense qui n'existait pas. Il valorise les jetons aux
 * tarifs du palier payant, alors que le projet Google était sur le palier
 * GRATUIT : aucune facturation n'avait lieu, et la seule limite réelle était un
 * compteur de 20 requêtes par jour, que ce fichier ignorait totalement. Le
 * fondateur voyait donc « 6 136 / 20 000 FCFA, 31 % » sur un écran pendant que
 * l'assistante se faisait refuser par Google pour une raison sans aucun rapport.
 *
 * Depuis, le projet est passé au palier payant par prépaiement. La contrainte
 * est désormais un SOLDE DE CRÉDITS, tenu chez Google, que ce calcul ne connaît
 * pas davantage. Un plafond applicatif qui se déclenche à côté de la vraie
 * limite ne protège de rien : il coupe l'assistante au mauvais moment, et laisse
 * passer le moment où il aurait fallu s'inquiéter.
 *
 * La mesure, elle, reste : `enregistrer()` continue d'écrire chaque appel dans
 * `assistant_consommation` avec ses jetons réels. C'est ce qui permet de
 * connaître le coût par question et de dimensionner les crédits — voir
 * `getConsommationMois`. On garde donc le compteur, on retire le disjoncteur.
 *
 * POUR LE RÉTABLIR : il faudrait d'abord que ce fichier lise le solde réel chez
 * Google, ce que l'API de facturation ne permet pas aujourd'hui. À défaut,
 * remettre une coupure ici reviendrait à réinstaller le même défaut.
 *
 * @returns {{autorise: boolean, consommation: object, alerte: boolean}}
 */
async function verifierBudget(siteId) {
  const consommation = await getConsommationMois(siteId);

  // L'alerte reste calculée : elle sert aux journaux du serveur, jamais à
  // refuser une réponse ni à afficher quoi que ce soit au fondateur.
  const alerte = BUDGET_FCFA > 0 && consommation.pourcentage >= SEUIL_ALERTE * 100;
  if (alerte) {
    console.warn(
      `[assistant] consommation cumulee du site ${siteId} : `
      + `${consommation.fcfa.toLocaleString('fr-FR')} FCFA equivalents, `
      + `${consommation.appels} appels ce mois-ci. Repere interne, aucune coupure.`
    );
  }

  return { autorise: true, consommation, alerte };
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
  const cout = calculerCout(jetons, modele);

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
  TARIFS_PAR_MODELE,
  tarifsDe,
  BUDGET_FCFA,
  TAUX_FCFA,
};
