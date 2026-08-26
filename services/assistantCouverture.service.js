// « Ce que l'assistante peut lire » — écran 2 de la console (2026-08-26).
//
// LA QUESTION À LAQUELLE CET ÉCRAN RÉPOND. Non pas « qu'y a-t-il dans la base »,
// mais « qu'est-ce que l'assistante en voit ». Ce n'est pas la même chose : elle
// lit à travers un rôle en lecture seule et un cloisonnement par site, et l'écart
// entre les deux est exactement l'endroit où naissent les réponses fausses.
//
// TOUT EST MESURÉ À TRAVERS SES DROITS À ELLE. Le comptage passe par le pool de
// l'assistante, dans une transaction en lecture seule où le site est posé comme
// il l'est pour une question du fondateur. Compter avec le rôle du serveur
// donnerait des nombres justes et sans rapport avec ce qu'elle voit — le pire
// des deux mondes, puisque l'écran servirait alors à rassurer à tort.
//
// LE PIÈGE, VÉCU AU PREMIER ESSAI : sans `set_config('assistant.site_id')`, les
// vues filtrent sur un site nul et 45 sujets sur 74 paraissent vides, dont les
// étudiants et les paiements. Le cloisonnement n'est pas un détail de sécurité
// qu'on ajoute après, c'est une condition de lecture.
//
// LE SQL EST ENGENDRÉ ICI, À PARTIR DU CATALOGUE DU SCHÉMA. Aucun fragment ne
// vient du navigateur ni du modèle : les noms de vues sortent d'
// `information_schema` et sont filtrés sur `^t_[a-z0-9_]+$` avant d'être
// assemblés. C'est ce qui autorise à emprunter le pool sans repasser par le
// validateur — et cette condition doit le rester.
const { getPool } = require('./assistantSql.service');
const { PAR_VIDE } = require('../config/correspondances');

/** Forme admise d'un nom de vue-reflet. Rien d'autre n'entre dans le SQL. */
const NOM_VUE = /^t_[a-z0-9_]+$/;

/**
 * Ce que la mise en forme automatique ne peut pas deviner.
 *
 * Les noms de tables sont en ASCII et abrégés : « recu » perd sa cédille, « edt »
 * ne veut rien dire pour qui lit l'écran. Un nom de table affiché tel quel est
 * précisément ce qu'on cherche à ne pas montrer ici — l'écran s'adresse à un
 * administrateur, pas à quelqu'un qui connaît le schéma.
 */
const LIBELLES = {
  t_recu: 'Reçus',
  t_reinscription: 'Réinscriptions',
  t_memoire: 'Mémoires',
  t_niveau: 'Niveaux',
  t_seance_edt: 'Séances de cours',
  t_trame_edt: "Trames d'emploi du temps",
  t_emploi_du_temps: 'Emplois du temps',
  t_emplacement_stock: 'Emplacements de stock',
  t_mouvement_stock: 'Mouvements de stock',
  t_prise_en_charge: 'Prises en charge',
  t_inscription_annuelle: 'Inscriptions annuelles',
  t_historique_inscription: 'Historique des inscriptions',
  t_historique_operations_admin: 'Historique des opérations',
  t_anneeacademique_site: 'Années académiques',
  t_etablissement_origine: "Établissements d'origine",
  t_affectation_charge_pedagogique: 'Affectations de charge pédagogique',
  t_etudiant_email_backup: 'Sauvegarde des courriels étudiants',
  t_ligne_distribution: 'Lignes de distribution',
  t_commande_fournisseur: 'Commandes fournisseurs',
  t_document_etudiant: 'Documents des étudiants',
  t_besoin_enseignant: 'Besoins en enseignants',
  t_offre_emploi_enseignant: "Offres d'emploi enseignant",
  t_candidature_enseignant: 'Candidatures enseignants',
  t_candidature_diplome: 'Diplômes des candidats',
  t_candidature_filiere: 'Filières demandées par les candidats',
  t_contrat_enseignant: 'Contrats enseignants',
  t_contrat_classe: 'Contrats de classe',
  t_decoupage_groupe: 'Découpages de groupes',
  t_rolepermission: 'Permissions par rôle',
  t_session_caisse: 'Sessions de caisse',
  t_assistant_consommation: "Consommation de l'assistante",
  t_assistant_reglages: "Réglages de l'assistante",
  t_assistant_google_compte: 'Comptes Google rattachés',
};

/**
 * Un nom de vue rendu lisible : `t_prise_en_charge` devient « Prises en charge ».
 *
 * Aucun mot de base de données à l'écran — ni vue, ni reflet, ni jointure. Le
 * pluriel est ajouté au dernier mot seulement, ce qui suffit pour des noms de
 * tables au singulier ; les cas que cette règle rate sont dans `LIBELLES`.
 */
function libelle(vue) {
  if (LIBELLES[vue]) return LIBELLES[vue];
  const mots = vue.replace(/^t_/, '').split('_');
  const dernier = mots[mots.length - 1];
  if (!/[sx]$/.test(dernier)) mots[mots.length - 1] = `${dernier}s`;
  const phrase = mots.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Ouvre une transaction de lecture cloisonnée sur le site, comme une question. */
async function ouvrirLecture(siteId, ecoleId) {
  const client = await getPool().connect();
  const site = String(Number(siteId));
  const ecole = ecoleId === null || ecoleId === undefined ? '' : String(Number(ecoleId));
  await client.query(
    `BEGIN;
     SET TRANSACTION READ ONLY;
     SELECT set_config('assistant.site_id', '${site}', true);
     SELECT set_config('assistant.ecole_id', '${ecole}', true)`,
  );
  return client;
}

/**
 * Compte les 74 sujets EN UN SEUL ALLER-RETOUR.
 *
 * Soixante-quatorze requêtes séparées coûteraient soixante-quatorze traversées
 * de l'Atlantique, soit une quinzaine de secondes à l'ouverture de l'écran. En
 * `UNION ALL`, l'ensemble tient en 370 ms mesurées.
 */
async function compterLu(client, vues) {
  const sql = vues
    .map((v) => `SELECT '${v}'::text AS vue, count(*)::int AS n FROM assistant.${v}`)
    .join(' UNION ALL ');
  const { rows } = await client.query(sql);
  return new Map(rows.map((r) => [r.vue, r.n]));
}

/**
 * Ce que la base contient, tous sites confondus.
 *
 * C'EST UNE ESTIMATION, ET L'ÉCRAN DOIT LE DIRE. `n_live_tup` est un compteur
 * tenu par PostgreSQL, pas un comptage : sur les grandes tables il s'écarte de
 * quelques lignes. Un comptage exact des 74 sujets demanderait plusieurs
 * secondes à chaque ouverture, pour une précision dont l'écran n'a pas besoin —
 * il cherche des ÉCARTS, et un écart de 2 579 documents ne se confond avec rien.
 * Le détail d'une ligne, lui, comptera exactement.
 */
async function compterBase(client, vues) {
  const tables = vues.map((v) => v.replace(/^t_/, ''));
  const { rows } = await client.query(
    `SELECT relname AS table, n_live_tup::bigint AS n
     FROM pg_stat_all_tables
     WHERE schemaname = 'public' AND relname = ANY($1)`,
    [tables],
  );
  const par = new Map(rows.map((r) => [r.table, Number(r.n)]));
  return new Map(vues.map((v) => [v, par.has(v.replace(/^t_/, '')) ? par.get(v.replace(/^t_/, '')) : null]));
}

/** Le commentaire de chaque vue — c'est là que certaines pistes sont écrites. */
async function lireDescriptions(client, vues) {
  const { rows } = await client.query(
    `SELECT c.relname AS vue, obj_description(c.oid, 'pg_class') AS descr
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'assistant' AND c.relname = ANY($1)`,
    [vues],
  );
  return new Map(rows.map((r) => [r.vue, r.descr || '']));
}

/**
 * Les sujets vides dont le nom recouvre un sujet peuplé.
 *
 * DEUX SOURCES, PARCE QU'UNE SEULE NE SUFFIT PAS :
 *
 *   • DÉTECTÉ — le commentaire du sujet vide nomme lui-même l'endroit où la
 *     donnée vit. C'est vivant : le jour où un commentaire est corrigé, le
 *     détecteur suit sans qu'on touche au code.
 *   • DÉCLARÉ — rien dans `t_seance_edt` ne dit que les emplois du temps sont
 *     ailleurs. Ces cas-là viennent de config/correspondances.js.
 *
 * Dans les deux cas, la cible n'est retenue que si elle est RÉELLEMENT peuplée
 * au moment du contrôle. Une correspondance qui pointe vers un sujet lui-même
 * vide n'apprend rien et ne doit pas alerter.
 */
function detecterAVerifier(vues, lu, descriptions) {
  const resultats = [];

  for (const vue of vues) {
    if (lu.get(vue) !== 0) continue;

    const declaree = PAR_VIDE.get(vue);
    if (declaree && lu.get(declaree.peuple) > 0) {
      resultats.push({
        vide: vue,
        vide_libelle: libelle(vue),
        peuple: declaree.peuple,
        peuple_libelle: libelle(declaree.peuple),
        lignes: lu.get(declaree.peuple),
        mots: declaree.mots,
        origine: 'declare',
      });
      continue;
    }

    // `\bt_[a-z0-9_]+` sur le commentaire : on ne retient que les cibles
    // réellement peuplées, et jamais la vue elle-même.
    const cites = [...new Set(String(descriptions.get(vue) || '').match(/t_[a-z0-9_]+/g) || [])];
    const cible = cites.find((c) => c !== vue && lu.get(c) > 0);
    if (cible) {
      resultats.push({
        vide: vue,
        vide_libelle: libelle(vue),
        peuple: cible,
        peuple_libelle: libelle(cible),
        lignes: lu.get(cible),
        mots: null,
        origine: 'detecte',
      });
    }
  }

  return resultats;
}

/**
 * L'écran entier, en une seule connexion.
 *
 * @returns {Promise<object>} sujets, écarts, sujets vides et cas à vérifier
 */
async function getCouverture({ siteId, ecoleId = null }) {
  const client = await ouvrirLecture(siteId, ecoleId);
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.views
       WHERE table_schema = 'assistant' AND table_name LIKE 't\\_%'
       ORDER BY table_name`,
    );
    // Le filtre n'est pas décoratif : c'est lui qui garantit que rien
    // d'inattendu ne soit concaténé dans le SQL engendré plus bas.
    const vues = rows.map((r) => r.table_name).filter((v) => NOM_VUE.test(v));
    if (!vues.length) return { sujets: [], total: 0, vides: [], a_verifier: [], ecarts: [] };

    const [lu, base, descriptions] = await Promise.all([
      compterLu(client, vues),
      compterBase(client, vues),
      lireDescriptions(client, vues),
    ]);

    const sujets = vues.map((v) => {
      const nLu = lu.get(v) ?? 0;
      const nBase = base.get(v);
      // L'écart n'a de sens que si les deux nombres existent. `null` signifie
      // « pas de table sous-jacente reconnue », pas « écart nul ».
      const ecart = nBase === null || nBase === undefined ? null : nBase - nLu;
      return {
        vue: v,
        libelle: libelle(v),
        dans_la_base: nBase,
        lu_par_assistante: nLu,
        ecart,
        vide: nLu === 0,
      };
    });

    const aVerifier = detecterAVerifier(vues, lu, descriptions);
    const nomsAVerifier = new Set(aVerifier.map((c) => c.vide));

    return {
      total: sujets.length,
      // « Lu en entier » : l'assistante voit tout ce que la base contient. Un
      // écart négatif (elle voit plus que l'estimation) reste « en entier » —
      // c'est l'imprécision de n_live_tup, pas un gain de lignes.
      lus_en_entier: sujets.filter((s) => s.ecart !== null && s.ecart <= 0 && !s.vide).length,
      lus_en_partie: sujets.filter((s) => s.ecart !== null && s.ecart > 0 && !s.vide).length,
      sujets,
      ecarts: sujets.filter((s) => s.ecart !== null && s.ecart > 0 && !s.vide)
        .sort((a, b) => b.ecart - a.ecart),
      // Les sujets vides SANS piste : la donnée n'existe réellement pas, et
      // l'écran doit le dire plutôt que de laisser croire à un problème.
      vides: sujets.filter((s) => s.vide && !nomsAVerifier.has(s.vue)),
      a_verifier: aVerifier,
    };
  } finally {
    // ROLLBACK et non COMMIT : la transaction est en lecture seule, mais la
    // refermer explicitement rend la connexion propre au pool.
    try { await client.query('ROLLBACK'); } catch (_) { /* connexion déjà tombée */ }
    client.release();
  }
}

/**
 * Cinq lignes réelles d'un sujet, telles que l'assistante les lit.
 *
 * Le comptage y est EXACT, contrairement à la vue d'ensemble : sur un seul
 * sujet, la seconde de calcul est disponible et la précision devient utile.
 */
async function getEchantillon({ siteId, ecoleId = null, vue }) {
  if (!NOM_VUE.test(String(vue || ''))) throw new Error('Sujet inconnu.');
  const client = await ouvrirLecture(siteId, ecoleId);
  try {
    // Le nom vient d'être validé contre `^t_[a-z0-9_]+$` ET doit exister dans le
    // catalogue : une vue absente fait échouer la requête sans rien exposer.
    const { rows: existe } = await client.query(
      `SELECT 1 FROM information_schema.views
       WHERE table_schema = 'assistant' AND table_name = $1`,
      [vue],
    );
    if (!existe.length) throw new Error('Sujet inconnu.');

    const compte = await client.query(`SELECT count(*)::int AS n FROM assistant.${vue}`);
    const lignes = await client.query(`SELECT * FROM assistant.${vue} LIMIT 5`);
    return {
      vue,
      libelle: libelle(vue),
      total_exact: compte.rows[0].n,
      colonnes: lignes.fields.map((f) => f.name),
      lignes: lignes.rows,
    };
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) { /* connexion déjà tombée */ }
    client.release();
  }
}

module.exports = { getCouverture, getEchantillon, libelle };
