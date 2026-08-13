// Assistant Fondateur — point du jour (2026-08-13).
//
// Une phrase affichée à l'ouverture, sans que le fondateur ait à demander.
// C'est ce qui fait passer l'assistante d'un outil qu'on interroge à un outil
// qui alerte.
//
// CALCULÉ EN SQL, PAS PAR LE MODÈLE — décision de conception. Trois raisons :
// le résultat est déterministe et vérifiable, il ne consomme aucun jeton alors
// qu'il s'affiche à chaque ouverture, et il ne peut pas contenir de chiffre
// inventé. Le modèle n'intervient jamais ici.
const { executerRequete } = require('./assistantSql.service');

/** Nombre de jours couverts par le point. Une journée seule serait vide un
 *  lundi matin ; sept jours diluent l'actualité. */
const FENETRE_JOURS = 7;

const REQUETES = {
  inscriptions: `
    SELECT COUNT(*)::int AS n
    FROM assistant.v_etudiants
    WHERE date_inscription >= CURRENT_DATE - INTERVAL '${FENETRE_JOURS} days'`,

  encaissements: `
    SELECT COUNT(*)::int AS n, COALESCE(SUM(volume), 0)::numeric AS montant
    FROM assistant.v_activite_agents
    WHERE acte = 'Encaissement'
      AND horodatage >= CURRENT_DATE - INTERVAL '${FENETRE_JOURS} days'`,

  // Point de vigilance permanent : un compte desactive qui agit encore est
  // exactement ce qu'un audit cherche.
  comptes_desactives_actifs: `
    SELECT COUNT(*)::int AS n
    FROM assistant.v_synthese_agents
    WHERE statut = 'desactive' AND actes_30_jours > 0`,

  annee_ouverte: `
    SELECT COUNT(*)::int AS n
    FROM assistant.v_annees_academiques
    WHERE etat = 'en cour'`,
};

const nombre = (v) => Number(v || 0);

/** « 3 245 800 » plutôt que « 3245800.00 » : cette phrase se lit, elle ne se calcule pas. */
function montantLisible(v) {
  const n = nombre(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} milliard${n >= 2e9 ? 's' : ''} de francs`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} million${n >= 2e6 ? 's' : ''} de francs`;
  return `${Math.round(n).toLocaleString('fr-FR')} francs`;
}

/**
 * Produit le point du jour d'un site.
 *
 * @returns {Promise<{ok:boolean, phrases:string[], alertes:string[], fenetre_jours:number}>}
 */
async function pointDuJour({ siteId, ecoleId = null }) {
  if (!siteId) return { ok: false, phrases: [], alertes: [], fenetre_jours: FENETRE_JOURS };

  const noms = Object.keys(REQUETES);
  const resultats = await Promise.all(
    noms.map((n) => executerRequete(REQUETES[n], { siteId, ecoleId })),
  );

  const lu = {};
  noms.forEach((n, i) => {
    lu[n] = resultats[i].ok && resultats[i].lignes.length ? resultats[i].lignes[0] : null;
  });

  const phrases = [];
  const alertes = [];

  const inscriptions = nombre(lu.inscriptions?.n);
  const nbEnc = nombre(lu.encaissements?.n);
  const montant = nombre(lu.encaissements?.montant);

  if (inscriptions > 0) {
    phrases.push(`${inscriptions} inscription${inscriptions > 1 ? 's' : ''}`);
  }
  if (nbEnc > 0) {
    phrases.push(`${montantLisible(montant)} encaissé${nbEnc > 1 ? 's' : ''} en ${nbEnc} opération${nbEnc > 1 ? 's' : ''}`);
  }

  // Les alertes ne sont pas des nouvelles : ce sont des situations qui durent et
  // qu'il faut voir même une semaine sans activité.
  const desactives = nombre(lu.comptes_desactives_actifs?.n);
  if (desactives > 0) {
    alertes.push(
      `${desactives} compte${desactives > 1 ? 's' : ''} désactivé${desactives > 1 ? 's ont' : ' a'} `
      + 'eu de l\'activité sur les trente derniers jours',
    );
  }
  if (nombre(lu.annee_ouverte?.n) === 0) {
    alertes.push("aucune année académique n'est ouverte sur ce site");
  }

  return { ok: true, phrases, alertes, fenetre_jours: FENETRE_JOURS };
}

module.exports = { pointDuJour, FENETRE_JOURS };
