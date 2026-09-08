// Chantier "Suivi des accessoires par niveau" — dashboard Moyens Généraux (2026-09-08), suite de
// l'audit lecture seule validé le même jour. Réutilise EXACTEMENT la même définition de "accessoire
// dû à un niveau" que services/distributionSuivi.service.js (regle_distribution_accessoire.actif /
// tous_niveaux / niveau_libelle, accessoire.distribuable_etudiant / actif) — jamais une nouvelle
// interprétation de ces règles — et le même filtre étudiant (construireFiltresEtudiant), pour rester
// cohérent avec /suivi (site/école/filière/niveau, jamais de groupe sur ce tableau croisé, cf.
// controllers/distribution.controller.js::getStatistiquesParNiveau).
//
// Regroupement par LIBELLÉ de niveau (n.libelle), jamais par niveau_id — vérifié en base : plusieurs
// lignes `niveau` partagent un même libellé (une par filière, ex. "LICENCE 1" existe pour au moins 2
// filières sur les données réelles) ; regrouper par id aurait scindé une même ligne visuelle du
// tableau ("LICENCE 1") en plusieurs lignes selon la filière, contrairement à l'exemple métier
// attendu (une ligne par niveau). C'est aussi exactement la requête canonique déjà utilisée par
// dashboardMoyensGeneraux.controller.js:71-76 (`GROUP BY n.libelle`), reprise ici sans modification
// de sa logique. regle_distribution_accessoire lui-même ne raisonne QUE par niveau_libelle (jamais
// par id) — ce regroupement est donc cohérent de bout en bout avec l'existant, pas une nouvelle règle.
//
// Un accessoire n'apparaît en colonne pour un niveau donné QUE s'il lui est réellement "dû" — une
// cellule (niveau, accessoire) hors de cette combinaison vaut `null` (jamais 0 : "pas prévu" et "0
// récupérateur" sont deux informations différentes, jamais confondues côté frontend).
//
// Performance : 3 requêtes fixes, jamais une par niveau/accessoire/cellule — (1) accessoires dus par
// niveau_libelle (petite table de règles, jamais filtrée par filière : regle_distribution_accessoire
// n'a pas de notion de filière), (2) inscrits par niveau_libelle (requête canonique), (3)
// récupérateurs par niveau_libelle × accessoire (une seule agrégation sur ligne_distribution) —
// assemblées (pivot) en mémoire.
const { construireFiltresEtudiant } = require('./distributionSuivi.service');

async function getStatistiquesAccessoiresParNiveau(client, {
  siteId, ecoleId, anneeAcademiqueId, filiereId = null, niveauId = null,
}) {
  // 1) Accessoires dus, PAR NIVEAU (libellé) — même définition que le CTE dus_par_niveau de
  // distributionSuivi.service.js. Jamais filtrée par niveauId/filiereId : c'est une petite table de
  // référence (règles), pas le volume d'étudiants ; le filtre niveauId/filiereId s'applique aux
  // requêtes (2)/(3) ci-dessous, et la ligne résultante ne conservera de toute façon que les
  // niveau_libelle réellement présents dans (2).
  const dusResult = await client.query(`
    SELECT DISTINCT n.libelle AS niveau, a.id AS accessoire_id, a.nom AS accessoire_nom
    FROM niveau n
    JOIN regle_distribution_accessoire r
      ON r.annee_academique_id = $1 AND r.actif = true
      AND (r.tous_niveaux = true OR r.niveau_libelle = n.libelle)
    JOIN accessoire a ON a.id = r.accessoire_id AND a.distribuable_etudiant = true AND a.actif = true
  `, [anneeAcademiqueId]);

  const accessoiresMap = new Map(); // accessoire_id -> nom
  const dusParNiveauLibelle = new Map(); // niveau (libellé) -> Set(accessoire_id)
  for (const row of dusResult.rows) {
    accessoiresMap.set(row.accessoire_id, row.accessoire_nom);
    if (!dusParNiveauLibelle.has(row.niveau)) dusParNiveauLibelle.set(row.niveau, new Set());
    dusParNiveauLibelle.get(row.niveau).add(row.accessoire_id);
  }
  const accessoires = Array.from(accessoiresMap.entries())
    .map(([id, nom]) => ({ id, nom }))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

  // 2) Inscrits par niveau — requête CANONIQUE reprise à l'identique de
  // dashboardMoyensGeneraux.controller.js:71-76 (mêmes filtres site/école/filière/niveau que le
  // reste du module Moyens Généraux, jamais de groupe sur ce tableau croisé).
  const paramsInscrits = [anneeAcademiqueId, siteId];
  const whereInscrits = construireFiltresEtudiant({ siteId, ecoleId, filiereId, niveauId, groupeId: null, search: null }, paramsInscrits);
  const inscritsResult = await client.query(`
    SELECT n.libelle AS niveau, COUNT(*) AS inscrits
    FROM vue_position_academique e JOIN niveau n ON n.id = e.niveau_id
    WHERE ${whereInscrits.join(' AND ')}
    GROUP BY n.libelle
    ORDER BY n.libelle
  `, paramsInscrits);

  // 3) Récupérateurs par niveau × accessoire — un étudiant compte une seule fois par accessoire
  // (COUNT DISTINCT), surplus payant exclu (est_supplementaire = false), même règle que recus_agg
  // dans distributionSuivi.service.js.
  const paramsRecus = [anneeAcademiqueId, siteId];
  const whereRecus = construireFiltresEtudiant({ siteId, ecoleId, filiereId, niveauId, groupeId: null, search: null }, paramsRecus);
  const recuperateursResult = await client.query(`
    SELECT n.libelle AS niveau, ld.accessoire_id, COUNT(DISTINCT ld.etudiant_id) AS recuperateurs
    FROM ligne_distribution ld
    JOIN vue_position_academique e ON e.id = ld.etudiant_id AND e.annee_academique_id = ld.annee_academique_id
    JOIN niveau n ON n.id = e.niveau_id
    WHERE ld.annee_academique_id = $1 AND ld.est_supplementaire = false
      AND ${whereRecus.join(' AND ')}
    GROUP BY n.libelle, ld.accessoire_id
  `, paramsRecus);

  const recusParCle = new Map(); // `${niveau}-${accessoire_id}` -> recuperateurs
  for (const row of recuperateursResult.rows) {
    recusParCle.set(`${row.niveau}-${row.accessoire_id}`, parseInt(row.recuperateurs, 10));
  }

  const niveaux = inscritsResult.rows.map((row) => {
    const accessoiresDus = dusParNiveauLibelle.get(row.niveau) ?? new Set();
    const accessoiresCell = {};
    for (const acc of accessoires) {
      accessoiresCell[acc.id] = accessoiresDus.has(acc.id)
        ? (recusParCle.get(`${row.niveau}-${acc.id}`) ?? 0)
        : null;
    }
    return {
      niveau: row.niveau,
      inscrits: parseInt(row.inscrits, 10),
      accessoires: accessoiresCell,
    };
  });

  return { accessoires, niveaux };
}

// Étudiants inscrits (vue_position_academique, standing = 'Inscrit') d'un niveau (LIBELLÉ, pas un
// id — cf. commentaire d'en-tête) n'ayant AUCUNE ligne_distribution gratuite (est_supplementaire =
// false) pour l'accessoire demandé — un surplus payant déjà acheté ne compte jamais comme la
// dotation gratuite due (même règle que recus_agg). `niveau` et `accessoireId` sont obligatoires :
// ce détail répond toujours à un clic sur UNE cellule précise du tableau croisé.
async function getNonRecuperateurs(client, {
  siteId, ecoleId, anneeAcademiqueId, niveau, accessoireId, filiereId = null, groupeId = null,
}) {
  const params = [anneeAcademiqueId, siteId];
  // niveauId volontairement absent d'ici : le filtre niveau se fait par LIBELLÉ (n.libelle) ci-dessous,
  // pas par id, pour rester cohérent avec le regroupement de getStatistiquesAccessoiresParNiveau.
  const whereEtudiant = construireFiltresEtudiant({ siteId, ecoleId, filiereId, niveauId: null, groupeId, search: null }, params);
  params.push(niveau);
  const niveauIdx = params.length;
  params.push(accessoireId);
  const accessoireIdx = params.length;

  const result = await client.query(`
    SELECT e.matricule_iipea, e.nom, e.prenoms, e.telephone,
           f.nom AS filiere, n.libelle AS niveau, g.nom AS groupe
    FROM vue_position_academique e
    JOIN filiere f ON f.id = e.id_filiere
    JOIN niveau n ON n.id = e.niveau_id
    LEFT JOIN groupe g ON g.id = e.groupe_id
    WHERE ${whereEtudiant.join(' AND ')}
      AND n.libelle = $${niveauIdx}
      AND NOT EXISTS (
        SELECT 1 FROM ligne_distribution ld
        WHERE ld.etudiant_id = e.id AND ld.accessoire_id = $${accessoireIdx}
          AND ld.annee_academique_id = $1 AND ld.est_supplementaire = false
      )
    ORDER BY e.nom, e.prenoms
  `, params);

  return result.rows;
}

module.exports = { getStatistiquesAccessoiresParNiveau, getNonRecuperateurs };
