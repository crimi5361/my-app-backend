// Débriefing des mouvements de la veille (2026-08-14).
//
// CALCULÉ EN SQL, PAS PAR LE MODÈLE — même principe que le point du jour. Le
// résultat est déterministe, vérifiable, ne consomme aucun jeton et ne peut pas
// contenir de chiffre inventé. Le modèle ne fait que lire le résumé à voix
// haute ; il n'a jamais les données brutes entre les mains.
//
// ─────────────────────────────────────────────────────────────────────────────
//  DEUX LIMITES DE LA BASE, constatées avant d'écrire ce service
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. PAS D'HEURE. `etudiant.date_inscription`, `paiement.date_paiement` et
//     `prise_en_charge.date_validation` sont de type `date`, sans heure. Le
//     graphique « volume par heure » demandé est donc IMPOSSIBLE sur
//     l'historique : tous les actes tomberaient à minuit. Il est remplacé par
//     un volume PAR JOUR sur quatorze jours, qui répond à la même question —
//     est-ce une journée normale ? — avec les données qui existent réellement.
//
//  2. CRÉATIONS SEULEMENT. `historique_operations_admin` et
//     `historique_inscription` sont vides : rien n'enregistre les connexions,
//     les consultations, les modifications ni les suppressions. L'activité est
//     reconstruite depuis les colonnes « auteur » des tables métier. Les cinq
//     types d'acte ci-dessous sont donc les seuls qui existent, et le résumé le
//     dit explicitement plutôt que de laisser croire à un journal complet.
//
//  PÉRIMÈTRE. `assistant.v_activite_agents` ne contient que des agents de la
//  table `utilisateur` — donc l'administration et le personnel, jamais les
//  étudiants — et exclut déjà l'administrateur de la plateforme. Le
//  cloisonnement site/école est appliqué par les vues, pas par ce code.
const { executerRequete } = require('./assistantSql.service');

/** Fenêtre du graphique de tendance. Quatorze jours couvrent deux semaines
 *  complètes : on voit le rythme hebdomadaire sans noyer la veille. */
const FENETRE_JOURS = 14;

const REQUETES = {
  // Volumétrie de la veille.
  total: `
    SELECT COUNT(*)::int AS actes,
           COUNT(DISTINCT agent_id)::int AS agents
    FROM assistant.v_activite_agents
    WHERE horodatage >= CURRENT_DATE - INTERVAL '1 day'
      AND horodatage < CURRENT_DATE`,

  // Répartition par type d'acte. Les cinq seuls types que la base sait produire.
  par_acte: `
    SELECT acte,
           domaine,
           COUNT(*)::int AS actes,
           COALESCE(SUM(volume), 0)::numeric AS montant
    FROM assistant.v_activite_agents
    WHERE horodatage >= CURRENT_DATE - INTERVAL '1 day'
      AND horodatage < CURRENT_DATE
    GROUP BY acte, domaine
    ORDER BY COUNT(*) DESC`,

  // Agents les plus actifs de la veille.
  par_agent: `
    SELECT a.agent,
           a.role,
           COUNT(*)::int AS actes
    FROM assistant.v_activite_agents j
    JOIN assistant.v_agents a ON a.agent_id = j.agent_id
    WHERE j.horodatage >= CURRENT_DATE - INTERVAL '1 day'
      AND j.horodatage < CURRENT_DATE
    GROUP BY a.agent, a.role
    ORDER BY COUNT(*) DESC
    LIMIT 8`,

  // Tendance : un chiffre isolé ne dit rien, c'est la série qui parle.
  par_jour: `
    SELECT CAST(horodatage AS date) AS jour,
           COUNT(*)::int AS actes
    FROM assistant.v_activite_agents
    WHERE horodatage >= CURRENT_DATE - INTERVAL '${FENETRE_JOURS} days'
      AND horodatage < CURRENT_DATE
    GROUP BY CAST(horodatage AS date)
    ORDER BY CAST(horodatage AS date)`,

  // Moyenne des sept jours PRÉCÉDANT la veille : la veille elle-même en est
  // exclue, sinon on la comparerait en partie à elle-même.
  moyenne_semaine: `
    SELECT ROUND(COUNT(*)::numeric / 7, 1) AS moyenne
    FROM assistant.v_activite_agents
    WHERE horodatage >= CURRENT_DATE - INTERVAL '8 days'
      AND horodatage < CURRENT_DATE - INTERVAL '1 day'`,

  // Repli quand la veille est vide : dire QUAND il s'est passé quelque chose
  // pour la dernière fois vaut mieux qu'un simple « rien ».
  dernier_jour_actif: `
    SELECT CAST(horodatage AS date) AS jour,
           COUNT(*)::int AS actes
    FROM assistant.v_activite_agents
    WHERE horodatage < CURRENT_DATE
    GROUP BY CAST(horodatage AS date)
    ORDER BY CAST(horodatage AS date) DESC
    LIMIT 1`,
};

const nombre = (v) => Number(v || 0);

const pluriel = (n, singulier, plurielMot) => `${n} ${n > 1 ? plurielMot : singulier}`;

/** « 3 245 800 francs » plutôt que « 3245800.00 » : cette phrase se prononce. */
function montantLisible(v) {
  const n = nombre(v);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} milliard${n >= 2e9 ? 's' : ''} de francs`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} million${n >= 2e6 ? 's' : ''} de francs`;
  return `${Math.round(n).toLocaleString('fr-FR')} francs`;
}

/** « mercredi 13 août » — la date telle qu'on la dit, pas telle qu'on la stocke. */
function dateLisible(valeur) {
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Construit les graphiques dans le format que l'écran sait déjà afficher.
 *
 * On réutilise volontairement la forme `{visualisation, donnees}` du graphique
 * poussé par le modèle : le composant qui la rend existe, il est éprouvé, et il
 * n'y a aucune raison d'en écrire un second.
 */
function construireGraphiques({ parJour, parActe, parAgent, veille, moyenne }) {
  const graphiques = [];

  if (parJour.length > 1) {
    graphiques.push({
      visualisation: {
        type: 'lignes',
        titre: `Activité des ${FENETRE_JOURS} derniers jours`,
        axe_x: 'jour',
        series: [{ colonne: 'actes', libelle: "Actes tracés" }],
        format_valeur: 'nombre',
      },
      donnees: parJour.map((l) => ({
        jour: dateCourte(l.jour),
        actes: nombre(l.actes),
      })),
    });
  }

  if (parActe.length > 0) {
    graphiques.push({
      visualisation: {
        type: 'camembert',
        titre: 'Répartition par type d\'acte',
        axe_x: 'acte',
        series: [{ colonne: 'actes', libelle: 'Actes' }],
        format_valeur: 'nombre',
      },
      donnees: parActe.map((l) => ({ acte: l.acte, actes: nombre(l.actes) })),
    });
  }

  if (parAgent.length > 0) {
    graphiques.push({
      visualisation: {
        type: 'barres',
        titre: 'Agents les plus actifs',
        axe_x: 'agent',
        series: [{ colonne: 'actes', libelle: 'Actes' }],
        format_valeur: 'nombre',
      },
      donnees: parAgent.map((l) => ({ agent: l.agent, actes: nombre(l.actes) })),
    });
  }

  // Comparaison. Deux barres seulement : c'est une mise en regard, pas une série.
  graphiques.push({
    visualisation: {
      type: 'barres',
      titre: 'La veille comparée à la semaine',
      axe_x: 'periode',
      series: [{ colonne: 'actes', libelle: 'Actes' }],
      format_valeur: 'nombre',
    },
    donnees: [
      { periode: 'Hier', actes: veille },
      { periode: 'Moyenne 7 jours', actes: moyenne },
    ],
  });

  return graphiques;
}

/** « 13/08 » — assez court pour tenir sur un axe de quatorze points. */
function dateCourte(valeur) {
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/**
 * Produit le débriefing de la veille.
 *
 * @returns {Promise<{ok:boolean, aucune_activite:boolean, phrases:string[],
 *                    graphiques:Array, date:string|null}>}
 */
async function debriefingVeille({ siteId, ecoleId = null }) {
  if (!siteId) {
    return { ok: false, aucune_activite: true, phrases: [], graphiques: [], date: null };
  }

  const noms = Object.keys(REQUETES);
  const resultats = await Promise.all(
    noms.map((n) => executerRequete(REQUETES[n], { siteId, ecoleId, limiteLignes: 200 })),
  );

  const lu = {};
  noms.forEach((n, i) => { lu[n] = resultats[i].ok ? resultats[i].lignes : []; });

  const veille = nombre(lu.total[0]?.actes);
  const agents = nombre(lu.total[0]?.agents);
  const moyenne = nombre(lu.moyenne_semaine[0]?.moyenne);

  const hier = new Date();
  hier.setDate(hier.getDate() - 1);
  const dateVeille = dateLisible(hier);

  // ── Journée sans mouvement ───────────────────────────────────────────────
  // Message explicite et AUCUN graphique : une série de barres à zéro donnerait
  // l'impression d'une panne. Mais dire seulement « rien » est peu utile — on
  // indique donc le dernier jour où il s'est passé quelque chose.
  if (veille === 0) {
    const dernier = lu.dernier_jour_actif[0];
    const phrases = [`Aucun mouvement enregistré hier, ${dateVeille}.`];
    if (dernier) {
      phrases.push(
        `Le dernier jour avec de l'activité est le ${dateLisible(dernier.jour)}, `
        + `avec ${pluriel(nombre(dernier.actes), 'acte', 'actes')}.`,
      );
    } else {
      phrases.push("Aucune activité n'est tracée sur ce site pour le moment.");
    }
    return { ok: true, aucune_activite: true, phrases, graphiques: [], date: dateVeille };
  }

  // ── Journée avec mouvements ──────────────────────────────────────────────
  const phrases = [];

  phrases.push(
    `Hier, ${dateVeille}, ${pluriel(veille, 'acte a été tracé', 'actes ont été tracés')} `
    + `par ${pluriel(agents, 'agent', 'agents')}.`,
  );

  // Comparaison à la semaine : c'est elle qui dit si la journée sort de
  // l'ordinaire, pas le chiffre brut.
  if (moyenne > 0) {
    const ecart = Math.round(((veille - moyenne) / moyenne) * 100);
    if (Math.abs(ecart) < 15) {
      phrases.push(`C'est une journée ordinaire : la moyenne des sept jours précédents est de ${moyenne}.`);
    } else {
      phrases.push(
        `C'est ${Math.abs(ecart)} pour cent ${ecart > 0 ? 'de plus' : 'de moins'} `
        + `que la moyenne des sept jours précédents, qui est de ${moyenne}.`,
      );
    }
  }

  const principal = lu.par_acte[0];
  if (principal) {
    phrases.push(
      `L'essentiel porte sur ${principal.acte.toLowerCase()}, `
      + `avec ${pluriel(nombre(principal.actes), 'opération', 'opérations')}.`,
    );
  }

  const encaisse = lu.par_acte
    .filter((l) => l.acte === 'Encaissement')
    .reduce((s, l) => s + nombre(l.montant), 0);
  if (encaisse > 0) phrases.push(`Les encaissements représentent ${montantLisible(encaisse)}.`);

  const premier = lu.par_agent[0];
  if (premier) {
    phrases.push(`L'agent le plus actif est ${premier.agent}, avec ${pluriel(nombre(premier.actes), 'acte', 'actes')}.`);
  }

  return {
    ok: true,
    aucune_activite: false,
    date: dateVeille,
    // Cinq phrases au plus : au-delà, on ne suit plus à l'oral.
    phrases: phrases.slice(0, 5),
    graphiques: construireGraphiques({
      parJour: lu.par_jour,
      parActe: lu.par_acte,
      parAgent: lu.par_agent,
      veille,
      moyenne,
    }),
  };
}

module.exports = {
  debriefingVeille,
  FENETRE_JOURS,
  // Exportés pour les tests : ce sont les fonctions pures qui décident de ce que
  // le fondateur voit et entend. Elles se vérifient sans base.
  construireGraphiques,
  montantLisible,
};
