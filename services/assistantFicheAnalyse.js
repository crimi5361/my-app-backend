// Analyse académique d'un étudiant (2026-08-19).
//
// Alimente les visualisations de la fiche et la partie interprétée du rapport.
// TOUT EST CALCULÉ EN SQL : le modèle ne voit jamais une note brute, il lit un
// résultat déjà agrégé. Il ne peut donc pas se tromper d'un point de moyenne.
//
// ─────────────────────────────────────────────────────────────────────────────
//  CE QUE LA BASE NE PERMET PAS, mesuré avant d'écrire ce fichier
// ─────────────────────────────────────────────────────────────────────────────
//
//  ASSIDUITÉ — aucune table. Ni absence, ni retard, ni justificatif, ni
//  sanction : le mot n'apparaît dans aucun nom de table du schéma. Les
//  graphiques d'assiduité demandés sont donc impossibles, et c'est dit
//  explicitement plutôt que passé sous silence.
//
//  ÉVOLUTION ANNUELLE — `inscription_annuelle.moyenne_annuelle` est renseignée
//  sur 2 lignes sur 7 208, et `moyenne_s1` sur aucune. La progression ne peut
//  se lire qu'entre les DEUX SEMESTRES de la table `note`, qui est complète.
//
//  CORRÉLATION ENTRE MATIÈRES — mathématiquement calculable, mais la base ne
//  contient qu'une seule session d'examens. Un coefficient de corrélation sur
//  un seul point de mesure décrirait le hasard ; il n'est pas produit.
const { executerRequete } = require('./assistantSql.service');

/** Au-delà, le radar devient illisible et les libellés se chevauchent. */
const MATIERES_MAX = 12;

/** Découpage de l'histogramme : dix tranches de deux points sur l'échelle 0-20. */
const TRANCHES = 10;

const nombre = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Requêtes d'analyse. Toutes filtrées sur l'étudiant ou sur son groupe, toutes
 * en lecture seule, toutes validées par le contrôleur SQL du service.
 */
const REQUETES = (id) => ({
  // Note par matière, avec la moyenne de la promotion en regard. C'est la
  // jointure qui porte le radar ET le diagramme comparatif.
  par_matiere: `
    SELECT m.nom AS matiere,
           n.semestre_id,
           ROUND(n.moyenne, 2) AS moyenne,
           n.coefficient,
           m.credits
    FROM assistant.t_note n
    JOIN assistant.t_enseignement en ON en.id = n.enseignement_id
    JOIN assistant.t_matiere m ON m.id = en.matiere_id
    WHERE n.etudiant_id = ${id}
    ORDER BY n.semestre_id, m.nom`,

  comparaison: `
    SELECT m.nom AS matiere,
           ROUND(AVG(n.moyenne) FILTER (WHERE n.etudiant_id = ${id}), 2) AS lui,
           ROUND(AVG(n.moyenne), 2) AS promotion,
           COUNT(DISTINCT n.etudiant_id)::int AS effectif
    FROM assistant.t_note n
    JOIN assistant.t_enseignement en ON en.id = n.enseignement_id
    JOIN assistant.t_matiere m ON m.id = en.matiere_id
    WHERE en.groupe_id = (SELECT groupe_id FROM assistant.t_etudiant WHERE id = ${id})
    GROUP BY m.nom
    ORDER BY m.nom`,

  par_semestre: `
    SELECT n.semestre_id,
           ROUND(SUM(n.moyenne * n.coefficient) / NULLIF(SUM(n.coefficient), 0), 2) AS moyenne,
           COUNT(*)::int AS matieres
    FROM assistant.t_note n
    WHERE n.etudiant_id = ${id}
    GROUP BY n.semestre_id
    ORDER BY n.semestre_id`,

  // Moyenne générale pondérée par les coefficients — pas une moyenne de
  // moyennes, qui donnerait un chiffre faux dès que les coefficients diffèrent.
  synthese: `
    SELECT ROUND(SUM(n.moyenne * n.coefficient) / NULLIF(SUM(n.coefficient), 0), 2) AS moyenne,
           COUNT(*)::int AS matieres,
           COUNT(*) FILTER (WHERE n.moyenne >= 10)::int AS matieres_validees,
           SUM(m.credits) FILTER (WHERE n.moyenne >= 10)::int AS credits_valides,
           SUM(m.credits)::int AS credits_total,
           ROUND(MIN(n.moyenne), 2) AS plus_basse,
           ROUND(MAX(n.moyenne), 2) AS plus_haute
    FROM assistant.t_note n
    JOIN assistant.t_enseignement en ON en.id = n.enseignement_id
    JOIN assistant.t_matiere m ON m.id = en.matiere_id
    WHERE n.etudiant_id = ${id}`,

  groupe: `
    WITH moy AS (
      SELECT n.etudiant_id AS eid,
             SUM(n.moyenne * n.coefficient) / NULLIF(SUM(n.coefficient), 0) AS m
      FROM assistant.t_note n
      JOIN assistant.t_enseignement en ON en.id = n.enseignement_id
      WHERE en.groupe_id = (SELECT groupe_id FROM assistant.t_etudiant WHERE id = ${id})
      GROUP BY n.etudiant_id)
    SELECT COUNT(*)::int AS effectif,
           ROUND(AVG(m), 2) AS moyenne_groupe,
           COUNT(*) FILTER (WHERE m > (SELECT m FROM moy WHERE eid = ${id}))::int AS devant
    FROM moy`,

  distribution: `
    WITH moy AS (
      SELECT n.etudiant_id AS eid,
             SUM(n.moyenne * n.coefficient) / NULLIF(SUM(n.coefficient), 0) AS m
      FROM assistant.t_note n
      JOIN assistant.t_enseignement en ON en.id = n.enseignement_id
      WHERE en.groupe_id = (SELECT groupe_id FROM assistant.t_etudiant WHERE id = ${id})
      GROUP BY n.etudiant_id)
    SELECT width_bucket(m, 0, 20, ${TRANCHES}) AS tranche,
           COUNT(*)::int AS effectif
    FROM moy
    GROUP BY width_bucket(m, 0, 20, ${TRANCHES})
    ORDER BY 1`,
});

/** Ce que la base ne sait pas dire, énoncé une fois pour toutes. */
const LACUNES = [
  "Assiduité, absences, retards et sanctions : aucune table ne les enregistre "
  + "dans cette base. Aucun graphique d'assiduité n'est possible.",
  "Évolution d'une année sur l'autre : la moyenne annuelle n'est renseignée que "
  + "sur 2 dossiers sur 7 208. La progression se lit entre les deux semestres.",
  "Corrélation entre matières : la base ne contient qu'une session d'examens. "
  + "Un coefficient calculé sur un seul point décrirait le hasard.",
];

/** Phrase de lecture d'un graphique — écrite à partir des chiffres, jamais par
 *  le modèle, pour qu'elle ne puisse pas les contredire. */
function lecture(cle, d) {
  const ecart = (a, b) => Math.round((nombre(a) - nombre(b)) * 100) / 100;
  switch (cle) {
    case 'radar': {
      const forte = d.reduce((a, b) => (nombre(b.moyenne) > nombre(a.moyenne) ? b : a));
      const faible = d.reduce((a, b) => (nombre(b.moyenne) < nombre(a.moyenne) ? b : a));
      return `Point fort : ${forte.matiere} (${forte.moyenne}). `
        + `Point faible : ${faible.matiere} (${faible.moyenne}).`;
    }
    case 'comparaison': {
      const dessus = d.filter((x) => nombre(x.lui) > nombre(x.promotion)).length;
      return `Au-dessus de la promotion dans ${dessus} matière${dessus > 1 ? 's' : ''} sur ${d.length}.`;
    }
    case 'semestre': {
      if (d.length < 2) return "Un seul semestre est noté : aucune progression n'est mesurable.";
      const e = ecart(d[d.length - 1].moyenne, d[0].moyenne);
      if (Math.abs(e) < 0.5) return 'La moyenne est stable entre les deux semestres.';
      return `La moyenne ${e > 0 ? 'progresse' : 'recule'} de ${Math.abs(e)} point${Math.abs(e) > 1 ? 's' : ''} entre les deux semestres.`;
    }
    default:
      return '';
  }
}

/**
 * Produit l'analyse académique complète d'un étudiant.
 *
 * Rend toujours un objet : quand l'étudiant n'a aucune note, `disponible` est
 * faux et `motif` l'explique. Un écran vide sans explication laisserait croire
 * à une panne.
 */
async function analyseEtudiant(id, { siteId, ecoleId = null }) {
  const n = Number(id);
  if (!Number.isInteger(n)) return { disponible: false, motif: 'Identifiant invalide.', lacunes: LACUNES };

  const req = REQUETES(n);
  const cles = Object.keys(req);
  const res = await Promise.all(
    cles.map((k) => executerRequete(req[k], { siteId, ecoleId, limiteLignes: 300 })),
  );
  const lu = {};
  cles.forEach((k, i) => { lu[k] = res[i].ok ? res[i].lignes : []; });

  const s = lu.synthese[0] || {};
  if (!nombre(s.matieres)) {
    return {
      disponible: false,
      motif: "Aucune note n'est enregistrée pour cet étudiant.",
      lacunes: LACUNES,
    };
  }

  const g = lu.groupe[0] || {};
  const effectif = nombre(g.effectif) || 0;
  const rang = nombre(g.devant) === null ? null : nombre(g.devant) + 1;

  // Les matières du radar : les plus fortes ET les plus faibles, pour que le
  // profil soit lisible sans être tronqué par un ordre alphabétique.
  const matieres = lu.par_matiere.filter((m) => nombre(m.moyenne) !== null);
  const radar = matieres.length > MATIERES_MAX
    ? [...matieres].sort((a, b) => nombre(b.moyenne) - nombre(a.moyenne))
      .filter((_, i, t) => i < MATIERES_MAX / 2 || i >= t.length - MATIERES_MAX / 2)
    : matieres;

  const comparaison = lu.comparaison.filter((c) => nombre(c.lui) !== null).slice(0, MATIERES_MAX);

  // Position de l'étudiant dans l'histogramme : la tranche où tombe sa moyenne.
  const saTranche = Math.min(
    Math.max(Math.ceil((nombre(s.moyenne) / 20) * TRANCHES), 1), TRANCHES,
  );

  return {
    disponible: true,
    synthese: {
      moyenne: nombre(s.moyenne),
      matieres: nombre(s.matieres),
      matieres_validees: nombre(s.matieres_validees),
      credits_valides: nombre(s.credits_valides) || 0,
      credits_total: nombre(s.credits_total) || 0,
      plus_basse: nombre(s.plus_basse),
      plus_haute: nombre(s.plus_haute),
      rang,
      effectif,
      moyenne_groupe: nombre(g.moyenne_groupe),
    },
    graphiques: [
      matieres.length >= 3 && {
        type: 'radar', titre: 'Profil par matière', cle: 'matiere', serie: 'moyenne',
        donnees: radar.map((m) => ({ matiere: m.matiere, moyenne: nombre(m.moyenne) })),
        lecture: lecture('radar', matieres),
      },
      comparaison.length >= 2 && {
        type: 'barres', titre: 'Comparaison à la promotion', cle: 'matiere',
        series: [{ colonne: 'lui', libelle: 'Cet étudiant' }, { colonne: 'promotion', libelle: 'Promotion' }],
        donnees: comparaison.map((c) => ({
          matiere: c.matiere, lui: nombre(c.lui), promotion: nombre(c.promotion),
        })),
        lecture: lecture('comparaison', comparaison),
      },
      lu.par_semestre.length >= 1 && {
        type: 'courbe', titre: 'Évolution par semestre', cle: 'semestre', serie: 'moyenne',
        donnees: lu.par_semestre.map((x) => ({
          semestre: `Semestre ${x.semestre_id}`, moyenne: nombre(x.moyenne), matieres: nombre(x.matieres),
        })),
        lecture: lecture('semestre', lu.par_semestre),
      },
      lu.distribution.length >= 2 && {
        type: 'histogramme', titre: 'Distribution des moyennes de la promotion', cle: 'tranche', serie: 'effectif',
        donnees: lu.distribution.map((x) => ({
          tranche: `${(nombre(x.tranche) - 1) * 2}–${nombre(x.tranche) * 2}`,
          effectif: nombre(x.effectif),
          est_le_sien: nombre(x.tranche) === saTranche,
        })),
        lecture: rang
          ? `Cet étudiant est ${rang}${rang === 1 ? 'er' : 'e'} sur ${effectif}.`
          : 'Position non déterminable.',
      },
    ].filter(Boolean),
    lacunes: LACUNES,
  };
}

module.exports = { analyseEtudiant, LACUNES, MATIERES_MAX };
