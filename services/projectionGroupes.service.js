// Chantier "Projection des listes de classes prévisionnelles" (2026-09-05) — outil d'aide
// administrative isolé, voir migrations/sql/043_projection_groupes.sql pour le contexte complet.
//
// RÈGLE ABSOLUE : ce service ne lit jamais autre chose que des données déjà existantes
// (etudiant, niveau, filiere, anneeacademique, classe, groupe, reinscription) et n'écrit QUE dans
// les 3 tables projection_groupe*. Il ne modifie jamais etudiant.groupe_id, ni aucune table
// métier, ni n'appelle jamais services/classeGroupe.service.js ou decoupageGroupe.service.js.
const db = require('../config/db.config');
const PVController = require('../controllers/PV.controller');

const DECISIONS_ADMISES = ['ADMIS', 'DÉROGÉ'];

// ─── Utilitaire : exécution par lots à concurrence limitée ─────────────────
// calculerResultatsAnnuelsEtudiant recalcule notes/UE/crédits en direct (~46 ms/étudiant,
// mesuré à l'audit) : jamais stocké, donc jamais rejouable en SQL pur sans dupliquer la logique
// métier (crédits, semestres, repêchage). Pour ~600 étudiants, un lot de 15 en parallèle ramène le
// temps total de ~28 s (séquentiel) à quelques secondes, sans lancer des centaines de promesses
// simultanées.
async function executerParLots(items, tailleLot, fn) {
  const resultats = [];
  for (let i = 0; i < items.length; i += tailleLot) {
    const lot = items.slice(i, i + tailleLot);
    const resultatsLot = await Promise.all(lot.map(fn));
    resultats.push(...resultatsLot);
  }
  return resultats;
}

// ─── Fisher-Yates ───────────────────────────────────────────────────────────
function melangerFisherYates(liste) {
  const copie = [...liste];
  for (let i = copie.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

// ─── Détermination du nombre de groupes retenus (Partie "CAPACITÉS", 2026-09-05) ───────────
// Correctif demandé avant commit : le nombre de groupes projetés ne doit plus être "autant de
// groupes qu'il y en avait l'année précédente", mais le plus PETIT nombre de groupes (parmi ceux
// réellement utilisés l'année source, dans leur ordre naturel — voir note ci-dessous) dont la
// capacité cumulée suffit à accueillir la population projetée. Une capacité manquante
// (capacite_max NULL — ne devrait jamais arriver pour un groupe pédagogique réel, seul le Groupe
// primaire en a une, déjà exclu ailleurs) replie défensivement sur l'effectif réel du groupe.
//
// ✅ Ordre retenu : l'ORDRE NATUREL des groupes (Groupe 1, Groupe 2, ...), PAS un tri par
// capacité décroissante — décision justifiée, pas arbitraire : l'exemple de spécification
// ("300 étudiants → 107+105+105=317, donc 3 groupes") additionne explicitement les 3 PREMIERS
// groupes dans leur ordre d'origine, pas les 3 plus grands (qui donneraient 114+107+105=326, un
// calcul différent). L'ordre naturel a aussi l'avantage d'être stable et intuitif pour
// l'administration : "Groupe 1" projeté correspond toujours au premier groupe historique, jamais
// réordonné selon la taille — reproductible à l'identique à chaque régénération tant que les
// groupes source ne changent pas.
//
// Cas de dépassement (population > capacité totale de tous les groupes source) : tous les
// groupes sont retenus (jamais un groupe supplémentaire créé automatiquement), et
// depassementCapacite=true est renvoyé pour affichage d'une alerte à l'administration.
function determinerGroupesRetenus(groupesSourceOrdonnes, populationTotale) {
  let cumul = 0;
  let k = 0;
  for (const g of groupesSourceOrdonnes) {
    cumul += g.capacite_max ?? g.effectif;
    k++;
    if (cumul >= populationTotale) break;
  }
  return {
    groupesRetenus: groupesSourceOrdonnes.slice(0, k),
    depassementCapacite: cumul < populationTotale,
  };
}

// ─── Répartition proportionnelle aux capacités historiques ─────────────────────────────────
// Ne divise plus équitablement (587/6 → 98/98/.../97) : chaque groupe reçoit une part
// proportionnelle à SA capacité de référence parmi les groupes retenus, arrondie par la méthode
// des plus grands restes pour que la somme reste TOUJOURS exactement égale à la population totale
// (jamais un groupe au-delà de sa capacité de référence, sauf le cas de dépassement ci-dessus où
// la population excède la somme de toutes les capacités — alors réparti proportionnellement en
// dépassant, avec l'alerte déjà signalée par determinerGroupesRetenus).
// etudiantsMelanges doit déjà être mélangé (Fisher-Yates) avant l'appel.
function repartirSelonCapacites(etudiantsMelanges, groupesRetenus) {
  const total = etudiantsMelanges.length;
  const capacites = groupesRetenus.map((g) => g.capacite_max ?? g.effectif);
  const capaciteTotale = capacites.reduce((s, c) => s + c, 0);

  const bruts = capacites.map((c) => (c * total) / capaciteTotale);
  const tailles = bruts.map(Math.floor);
  let alloue = tailles.reduce((s, t) => s + t, 0);
  let restant = total - alloue;

  // Plus grands restes : les groupes avec la plus grande partie fractionnaire reçoivent l'unité
  // supplémentaire en priorité, jusqu'à épuisement du reste — garantit une somme exacte.
  const ordreRestes = bruts
    .map((b, i) => ({ i, frac: b - tailles[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < restant; j++) {
    tailles[ordreRestes[j].i] += 1;
  }

  const groupes = [];
  let index = 0;
  for (let i = 0; i < groupesRetenus.length; i++) {
    const taille = tailles[i];
    groupes.push({
      nom: `Groupe ${i + 1}`,
      ordre: i + 1,
      capaciteReference: capacites[i],
      etudiants: etudiantsMelanges.slice(index, index + taille),
    });
    index += taille;
  }
  return groupes;
}

// ─── Niveaux cibles proposables (Partie "NIVEAUX") ─────────────────────────
// Un niveau n'est un niveau "de poursuite" (L2, L3, BTS2...) QUE s'il existe au moins un niveau
// d'une AUTRE année académique dont niveau_suivant_id pointe vers lui. Exclusion explicite des
// pointeurs de MÊME année académique : niveau.niveau_suivant_id d'un niveau d'entrée (L1, BTS1)
// peut, par chaînage provisoire (voir reinscription.controller.js), pointer vers un niveau de sa
// PROPRE année quand la filière est préparée progressivement — ce n'est jamais un vrai
// prédécesseur, juste un artefact de saisie, vérifié réellement en base à l'audit.
async function listerNiveauxCibles({ filiereId, anneeCibleId, siteId }) {
  const result = await db.query(
    `SELECT DISTINCT n.id, n.libelle
     FROM niveau n
     WHERE n.filiere_id = $1 AND n.anneeacademique_id = $2 AND n.site_id = $3
       AND EXISTS (
         SELECT 1 FROM niveau prec
         WHERE prec.niveau_suivant_id = n.id AND prec.anneeacademique_id <> n.anneeacademique_id
       )
     ORDER BY n.libelle`,
    [filiereId, anneeCibleId, siteId]
  );
  return result.rows;
}

// ─── Résolution du niveau source (avec repli explicite) ────────────────────
// Ne bloque jamais silencieusement (exigence explicite) : si niveau_suivant_id ne permet pas de
// résoudre un candidat unique (absent, ou plusieurs candidats — filières génériques qui se
// scindent en options, cas réel constaté à l'audit sur "LICENCE 3 PRO"), lève une erreur claire
// invitant à fournir niveauSourceId explicitement plutôt que de deviner.
async function resoudreNiveauSource({ niveauCibleId, niveauSourceId }) {
  if (niveauSourceId) {
    const explicite = await db.query('SELECT id, libelle, filiere_id, anneeacademique_id, site_id FROM niveau WHERE id = $1', [niveauSourceId]);
    if (explicite.rows.length === 0) {
      throw new Error('Niveau source (fourni explicitement) introuvable.');
    }
    return explicite.rows[0];
  }

  const candidats = await db.query(
    `SELECT prec.id, prec.libelle, prec.filiere_id, prec.anneeacademique_id, prec.site_id
     FROM niveau prec
     JOIN niveau cible ON cible.id = $1
     WHERE prec.niveau_suivant_id = $1 AND prec.anneeacademique_id <> cible.anneeacademique_id`,
    [niveauCibleId]
  );
  if (candidats.rows.length === 0) {
    throw new Error(
      "Impossible de déterminer automatiquement le niveau source (aucun niveau ne pointe vers ce niveau cible via niveau_suivant_id). Fournissez niveauSourceId explicitement."
    );
  }
  if (candidats.rows.length > 1) {
    throw new Error(
      `Plusieurs niveaux sources candidats trouvés (${candidats.rows.map((r) => r.libelle).join(', ')}) — fournissez niveauSourceId explicitement pour lever l'ambiguïté.`
    );
  }
  return candidats.rows[0];
}

// ─── Groupes réellement utilisés (Partie "GROUPES SOURCE") ─────────────────
// Règle validée à l'audit : un groupe est "utilisé" s'il contient au moins un étudiant
// ACTUELLEMENT (pas un simple COUNT(*) des lignes groupe) — exclut explicitement les groupes
// primaires (est_primaire = true, jamais une source pédagogique) et les groupes vides (ex. le
// "Groupe 7" constaté réellement vide sur SIC L1 2025-2026). Agrège toutes les classes
// correspondant à filière+niveau+année, tous parcours confondus (curcus_id), au cas où plusieurs
// classes JOUR/SOIR coexistent.
async function listerGroupesSourceUtilises({ filiereId, niveauSourceId, anneeSourceId }) {
  const result = await db.query(
    `SELECT g.id, g.nom, g.capacite_max, COUNT(e.id) AS effectif
     FROM groupe g
     JOIN classe c ON c.id = g.classe_id
     JOIN etudiant e ON e.groupe_id = g.id
     WHERE c.filiere_id = $1 AND c.niveau_id = $2 AND c.annee_academique_id = $3
       AND g.est_primaire = false
     GROUP BY g.id, g.nom, g.capacite_max
     HAVING COUNT(e.id) > 0
     ORDER BY g.nom`,
    [filiereId, niveauSourceId, anneeSourceId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    nom: r.nom,
    capacite_max: r.capacite_max !== null ? parseInt(r.capacite_max, 10) : null,
    effectif: parseInt(r.effectif, 10),
  }));
}

// ─── Génération / régénération d'une projection ────────────────────────────
async function genererProjection({ filiereId, niveauCibleId, anneeCibleId, utilisateurId, siteId, niveauSourceId = null }) {
  // 1-3. Résolution du niveau cible, du niveau source et donc de l'année source.
  const niveauCible = (await db.query('SELECT id, libelle, filiere_id, anneeacademique_id, site_id FROM niveau WHERE id = $1', [niveauCibleId])).rows[0];
  if (!niveauCible) throw new Error('Niveau cible introuvable.');
  if (niveauCible.filiere_id !== filiereId) throw new Error("Ce niveau n'appartient pas à la filière indiquée.");
  if (niveauCible.anneeacademique_id !== anneeCibleId) throw new Error("Ce niveau n'appartient pas à l'année académique cible indiquée.");
  if (niveauCible.site_id !== siteId) throw new Error("Ce niveau n'appartient pas à votre site.");

  const niveauSource = await resoudreNiveauSource({ niveauCibleId, niveauSourceId });
  if (niveauSource.filiere_id !== filiereId) {
    throw new Error("Le niveau source résolu n'appartient pas à la même filière — vérifiez niveauSourceId.");
  }
  const anneeSourceId = niveauSource.anneeacademique_id;

  // 4. Groupes réellement utilisés l'année source.
  const groupesSource = await listerGroupesSourceUtilises({ filiereId, niveauSourceId: niveauSource.id, anneeSourceId });
  if (groupesSource.length === 0) {
    throw new Error("Aucun groupe réellement utilisé n'a été trouvé pour l'année source — impossible de déterminer un nombre de groupes à projeter.");
  }

  // 5a. Population A — étudiants encore À la position source (etudiant, position courante),
  // site de l'agent uniquement. C'est la population "classique" (majorité des cas, ex. les 611
  // SIC L1 qui n'ont pas encore bougé).
  const etudiantsSource = (await db.query(
    `SELECT id, nom, prenoms, matricule_iipea FROM etudiant
     WHERE id_filiere = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND site_id = $4 AND standing = 'Inscrit'
     ORDER BY nom, prenoms`,
    [filiereId, niveauSource.id, anneeSourceId, siteId]
  )).rows;

  // ✅ Correctif (2026-09-05) — cas réel BERTHE/AMAN (RIT BTS2 2026-2027) : un étudiant déjà
  // réellement réinscrit dans la cible a sa position COURANTE écrasée vers la cible — il ne
  // satisfait donc plus jamais la condition ci-dessus (niveau_id = source) et disparaissait
  // silencieusement de la projection, alors qu'il doit évidemment en faire partie. Règle
  // demandée : population = (Admis/Dérogés de l'année source) UNION (étudiants dont la position
  // RÉELLE VALIDÉE correspond exactement à la cible filière+niveau+année) — dédupliqués par
  // etudiant_id. Population B n'est jamais filtrée sur une décision académique : sa réinscription
  // réelle est un fait déjà accompli, pas une projection à valider.
  const etudiantsDejaReinscrits = (await db.query(
    `SELECT id, nom, prenoms, matricule_iipea FROM etudiant
     WHERE id_filiere = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND site_id = $4 AND standing = 'Inscrit'
     ORDER BY nom, prenoms`,
    [filiereId, niveauCibleId, anneeCibleId, siteId]
  )).rows;

  if (etudiantsSource.length === 0 && etudiantsDejaReinscrits.length === 0) {
    throw new Error("Aucun étudiant trouvé (ni à l'année source, ni déjà réinscrit dans la cible) — rien à projeter.");
  }

  // 6-7. Décision académique — réutilise EXACTEMENT la fonction métier canonique existante,
  // jamais recalculée manuellement. Lots de 15 en parallèle (voir executerParLots ci-dessus).
  // Uniquement pour la population A : la population B est déjà réellement inscrite, sa décision
  // académique de l'année source n'a plus à être revalidée ici.
  const avecDecision = await executerParLots(etudiantsSource, 15, async (etu) => {
    try {
      const resultat = await PVController.calculerResultatsAnnuelsEtudiant(etu.id, anneeSourceId);
      return { ...etu, decision: resultat.decision };
    } catch (err) {
      // Un étudiant sans notes exploitables (dossier incomplet, maquette non résolue...) ne doit
      // jamais faire échouer toute la génération — il est simplement exclu, comme un AJOURNÉ.
      return { ...etu, decision: null, erreur: err.message };
    }
  });

  const admisSource = avecDecision.filter((e) => DECISIONS_ADMISES.includes(e.decision));

  // Union par etudiant_id (Map — dédoublonnage naturel) : un étudiant présent dans les deux
  // populations (cas BERTHE/AMAN : ADMIS à la source ET déjà réinscrit dans la cible) n'apparaît
  // qu'une seule fois.
  const parId = new Map();
  for (const e of admisSource) parId.set(e.id, e);
  for (const e of etudiantsDejaReinscrits) parId.set(e.id, e);
  const admis = [...parId.values()];

  if (admis.length === 0) {
    throw new Error("Aucun étudiant ADMIS/DÉROGÉ ni déjà réinscrit trouvé pour cette cible — rien à projeter.");
  }

  // 8. Détermination du nombre de groupes retenus — le plus petit nombre de groupes source
  // (ordre naturel) dont la capacité cumulée suffit, jamais "autant qu'il y en avait avant".
  const { groupesRetenus, depassementCapacite } = determinerGroupesRetenus(groupesSource, admis.length);

  // 9. Brassage + répartition proportionnelle aux capacités retenues — APRÈS constitution de la
  // population finale (union + dédoublonnage ci-dessus), jamais avant.
  const melanges = melangerFisherYates(admis);
  const groupesProjetes = repartirSelonCapacites(melanges, groupesRetenus);

  // 10. Création/remplacement — transaction unique : DELETE (CASCADE) puis INSERT.
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM projection_groupe WHERE filiere_id = $1 AND niveau_cible_id = $2 AND annee_cible_id = $3',
      [filiereId, niveauCibleId, anneeCibleId]
    );

    const projectionInsert = await client.query(
      `INSERT INTO projection_groupe
         (site_id, filiere_id, niveau_cible_id, niveau_source_id, annee_cible_id, annee_source_id, nombre_admis_source, depassement_capacite, genere_par)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, genere_le`,
      [siteId, filiereId, niveauCibleId, niveauSource.id, anneeCibleId, anneeSourceId, admis.length, depassementCapacite, utilisateurId || null]
    );
    const projectionId = projectionInsert.rows[0].id;

    for (const groupe of groupesProjetes) {
      const ligneInsert = await client.query(
        'INSERT INTO projection_groupe_ligne (projection_id, nom_groupe, ordre, capacite_reference) VALUES ($1, $2, $3, $4) RETURNING id',
        [projectionId, groupe.nom, groupe.ordre, groupe.capaciteReference]
      );
      const ligneId = ligneInsert.rows[0].id;
      for (const etu of groupe.etudiants) {
        await client.query(
          'INSERT INTO projection_groupe_etudiant (projection_groupe_ligne_id, etudiant_id) VALUES ($1, $2)',
          [ligneId, etu.id]
        );
      }
    }

    await client.query('COMMIT');

    // 11. Résultat.
    return {
      projectionId,
      genereLe: projectionInsert.rows[0].genere_le,
      filiereId,
      niveauCible: { id: niveauCible.id, libelle: niveauCible.libelle },
      anneeCibleId,
      niveauSource: { id: niveauSource.id, libelle: niveauSource.libelle },
      anneeSourceId,
      nombreAdmis: admis.length,
      nombreEtudiantsSource: etudiantsSource.length,
      nombreDejaReinscrits: etudiantsDejaReinscrits.length,
      groupesSourceUtilises: groupesSource.length,
      groupesRetenus: groupesRetenus.length,
      depassementCapacite,
      groupes: groupesProjetes.map((g) => ({ nom: g.nom, ordre: g.ordre, capaciteReference: g.capaciteReference, effectif: g.etudiants.length })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Lecture d'une projection existante (jamais de recalcul de décision) ───
// Le statut de réinscription est calculé À LA LECTURE, jamais stocké (exigence explicite) — il
// reste donc à jour même si l'étudiant se réinscrit après la génération de la projection.
async function getProjection({ filiereId, niveauCibleId, anneeCibleId, siteId }) {
  const projection = (await db.query(
    `SELECT pg.id, pg.genere_le, pg.nombre_admis_source, pg.annee_cible_id, pg.depassement_capacite,
            f.nom AS filiere, f.sigle AS filiere_sigle,
            nc.libelle AS niveau_cible, ac.annee AS annee_cible,
            ns.libelle AS niveau_source, asrc.annee AS annee_source
     FROM projection_groupe pg
     JOIN filiere f ON f.id = pg.filiere_id
     JOIN niveau nc ON nc.id = pg.niveau_cible_id
     JOIN anneeacademique ac ON ac.id = pg.annee_cible_id
     JOIN niveau ns ON ns.id = pg.niveau_source_id
     JOIN anneeacademique asrc ON asrc.id = pg.annee_source_id
     WHERE pg.filiere_id = $1 AND pg.niveau_cible_id = $2 AND pg.annee_cible_id = $3 AND pg.site_id = $4`,
    [filiereId, niveauCibleId, anneeCibleId, siteId]
  )).rows[0];
  if (!projection) return null;

  const lignes = (await db.query(
    'SELECT id, nom_groupe, ordre, capacite_reference FROM projection_groupe_ligne WHERE projection_id = $1 ORDER BY ordre',
    [projection.id]
  )).rows;

  const ligneIds = lignes.map((l) => l.id);

  // ✅ Statut de réinscription calculé À LA LECTURE, jamais stocké (exigence explicite) — une
  // seule requête groupée (aucun N+1) :
  //   - "reinscrit"     : la position RÉELLE de l'étudiant a déjà basculé sur l'année cible
  //                       (etudiant.annee_academique_id), source déjà utilisée partout ailleurs.
  //   - "en_attente"    : une ligne reinscription existe pour cette année cible, statut ≠ 'inscrit'.
  //   - "non_reinscrit" : ni l'un ni l'autre.
  const etudiantsResult = await db.query(
    `SELECT pge.projection_groupe_ligne_id, e.id, e.matricule_iipea, e.nom, e.prenoms,
            CASE
              WHEN e.annee_academique_id = $2 THEN 'reinscrit'
              WHEN EXISTS (
                SELECT 1 FROM reinscription r
                WHERE r.etudiant_id = e.id AND r.anneeacademique_id = $2 AND r.statut <> 'inscrit'
              ) THEN 'en_attente'
              ELSE 'non_reinscrit'
            END AS statut_reinscription
     FROM projection_groupe_etudiant pge
     JOIN etudiant e ON e.id = pge.etudiant_id
     WHERE pge.projection_groupe_ligne_id = ANY($1::int[])
     ORDER BY e.nom, e.prenoms`,
    [ligneIds, projection.annee_cible_id]
  );

  const etudiantsParLigne = new Map(ligneIds.map((id) => [id, []]));
  for (const row of etudiantsResult.rows) {
    etudiantsParLigne.get(row.projection_groupe_ligne_id).push({
      id: row.id,
      matricule_iipea: row.matricule_iipea,
      nom: row.nom,
      prenoms: row.prenoms,
      statut: row.statut_reinscription,
    });
  }

  return { projection, lignes, etudiantsParLigne };
}

module.exports = {
  melangerFisherYates,
  determinerGroupesRetenus,
  repartirSelonCapacites,
  listerNiveauxCibles,
  resoudreNiveauSource,
  listerGroupesSourceUtilises,
  genererProjection,
  getProjection,
  executerParLots,
};
