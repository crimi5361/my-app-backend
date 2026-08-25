// Assistant Fondateur — exécution contrôlée du SQL produit par le modèle (2026-08-12).
//
// ORDRE DES GARANTIES — à garder en tête avant de modifier ce fichier :
//
//   1. Le rôle PostgreSQL `assistant_ro` n'a AUCUN privilège d'écriture et ne voit
//      que le schéma `assistant`. Vérifié par test adverse : 23 tentatives
//      (DELETE, DROP, TRUNCATE, GRANT, SET ROLE, pg_read_file, lecture des mots de
//      passe…) toutes refusées par PostgreSQL. C'est LA garantie : elle ne dépend
//      d'aucune ligne de ce fichier.
//
//   2. La vérification post-exécution (verifierPerimetre) : après la requête et
//      AVANT de rendre les lignes, on relit les variables de cloisonnement. Si
//      elles ont bougé, le résultat est jeté. Ça rattrape `set_config` et toute
//      autre manière — connue ou non — de changer de périmètre en cours de requête.
//
//   3. Le validateur statique ci-dessous : il ne garantit rien à lui seul, et ce
//      n'est pas son rôle. Il sert à (a) renvoyer au modèle une erreur précise
//      dont il peut se corriger, (b) bloquer les requêtes légales mais coûteuses,
//      (c) imposer un LIMIT.
//
// L'analyse par mots-clés seule est insuffisante — démontré : `WITH s AS (DELETE …)
// SELECT …` passe tout filtre naïf et détruit des données. D'où l'analyse d'arbre,
// et surtout d'où l'ordre ci-dessus.
const { Pool } = require('pg');
const { Parser } = require('node-sql-parser');
const { protegerPool } = require('../config/poolResilient');

const parser = new Parser();

const LIMITE_LIGNES_DEFAUT = 500;
const LIMITE_LIGNES_MAX = 5000;
const TIMEOUT_MS = 10000;

// Fonctions refusées : évasion de périmètre, accès système, épuisement de ressources.
// Comparées en minuscules, avec ou sans préfixe de schéma.
const FONCTIONS_INTERDITES = new Set([
  'set_config',                                    // changerait le site/école en cours de requête
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',    // blocage volontaire
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export',
  'dblink', 'dblink_exec', 'dblink_connect',
  'pg_terminate_backend', 'pg_cancel_backend',
  'pg_reload_conf', 'pg_rotate_logfile',
  'query_to_xml', 'database_to_xml',               // contournent le schéma via du SQL imbriqué
]);

// Filet supplémentaire, volontairement grossier : si l'arbre n'a pas été analysable
// et qu'on tolère la requête, ces motifs restent bloqués. Ce n'est PAS la barrière
// principale (cf. en-tête) — juste une redondance bon marché.
const MOTIFS_INTERDITS = /\b(set_config|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_sleep)\s*\(/i;

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!process.env.ASSISTANT_DATABASE_URL) {
    throw new Error(
      "ASSISTANT_DATABASE_URL absente. Lancez : node migrations/setup-role-assistant.js"
    );
  }
  pool = new Pool({
    connectionString: process.env.ASSISTANT_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    // MESURÉ le 2026-08-21 : ouvrir une connexion vers l'endpoint Neon prend
    // 2 400 à 3 900 ms depuis Abidjan, et davantage quand le compute sort de
    // veille. À 5 000 ms, un pic ordinaire suffisait à faire échouer la lecture —
    // et le modèle, privé de résultat, répondait de tête. Ne pas redescendre.
    connectionTimeoutMillis: 20000,
    keepAlive: true,
  });
  // Sans cette protection, une connexion coupée par Neon fait tomber TOUT le
  // serveur Express — y compris pendant qu'elle est empruntée. Voir
  // config/poolResilient.js pour le détail du mécanisme.
  protegerPool(pool, 'assistant');
  return pool;
}

/** Parcourt l'arbre et remonte tous les noms de fonctions appelées, quelle que soit leur forme. */
function collecterFonctions(noeud, trouvees = new Set()) {
  if (!noeud || typeof noeud !== 'object') return trouvees;

  if (Array.isArray(noeud)) {
    noeud.forEach((n) => collecterFonctions(n, trouvees));
    return trouvees;
  }

  if (noeud.type === 'function' || noeud.type === 'aggr_func') {
    // Le parseur expose le nom sous plusieurs formes selon les versions :
    // 'nom', { name: 'nom' }, { name: [{ value: 'nom' }] }, { schema, name: [...] }.
    const brut = noeud.name;
    const noms = [];
    if (typeof brut === 'string') noms.push(brut);
    else if (brut && typeof brut === 'object') {
      if (typeof brut.name === 'string') noms.push(brut.name);
      if (Array.isArray(brut.name)) brut.name.forEach((p) => { if (p?.value) noms.push(p.value); });
    }
    noms.forEach((n) => trouvees.add(String(n).toLowerCase().replace(/^pg_catalog\./, '')));
  }

  Object.values(noeud).forEach((v) => collecterFonctions(v, trouvees));
  return trouvees;
}

/** Remonte les tables/vues référencées, pour vérifier qu'on reste dans le schéma assistant. */
function collecterRelations(noeud, trouvees = new Set()) {
  if (!noeud || typeof noeud !== 'object') return trouvees;
  if (Array.isArray(noeud)) {
    noeud.forEach((n) => collecterRelations(n, trouvees));
    return trouvees;
  }
  if (noeud.table && typeof noeud.table === 'string') {
    trouvees.add(`${noeud.db || noeud.schema || ''}.${noeud.table}`.toLowerCase().replace(/^\./, ''));
  }
  Object.values(noeud).forEach((v) => collecterRelations(v, trouvees));
  return trouvees;
}

/**
 * Valide une requête produite par le modèle.
 * @returns {{ok: true, sql: string} | {ok: false, motif: string}}
 *          `motif` est rédigé pour être renvoyé au modèle : il doit lui permettre
 *          de corriger sa requête tout seul, sans deviner.
 */
function validerRequete(sqlBrut, { limiteLignes = LIMITE_LIGNES_DEFAUT } = {}) {
  if (typeof sqlBrut !== 'string' || !sqlBrut.trim()) {
    return { ok: false, motif: 'Requête vide.' };
  }

  let sql = sqlBrut.trim().replace(/;\s*$/, '');

  if (MOTIFS_INTERDITS.test(sql)) {
    return {
      ok: false,
      motif: "Cette requête appelle une fonction interdite (set_config, pg_sleep, accès fichier…). "
        + "Écris une requête de lecture simple sur les vues du schéma assistant.",
    };
  }

  let arbre;
  try {
    arbre = parser.astify(sql, { database: 'postgresql' });
  } catch (e) {
    // Échec fermé : on préfère refuser une requête valide mais exotique que
    // laisser passer une construction qu'on n'a pas su analyser. Le modèle peut
    // reformuler — et la grammaire du parseur ne couvre pas tout PostgreSQL.
    return {
      ok: false,
      motif: `Requête non analysable (${e.message.split('\n')[0].slice(0, 90)}). `
        + 'Reformule plus simplement : SELECT ... FROM assistant.v_xxx WHERE ... GROUP BY ... ORDER BY ... LIMIT ...',
    };
  }

  const instructions = Array.isArray(arbre) ? arbre : [arbre];

  if (instructions.length !== 1) {
    return { ok: false, motif: 'Une seule instruction SQL à la fois. Retire les points-virgules.' };
  }

  const instruction = instructions[0];
  if (instruction.type !== 'select') {
    return {
      ok: false,
      motif: `Seule la lecture est autorisée : "${String(instruction.type).toUpperCase()}" est refusé. `
        + "Tu ne peux pas créer, modifier ni supprimer quoi que ce soit — uniquement SELECT.",
    };
  }

  // SELECT ... INTO crée une table : l'analyseur le classe pourtant en 'select'.
  if (instruction.into && (instruction.into.position || instruction.into.expr)) {
    return { ok: false, motif: 'SELECT ... INTO est refusé (il créerait une table). Retire la clause INTO.' };
  }

  const fonctions = collecterFonctions(instruction);
  const interdite = [...fonctions].find((f) => FONCTIONS_INTERDITES.has(f));
  if (interdite) {
    return {
      ok: false,
      motif: `La fonction "${interdite}" est interdite. Utilise uniquement des fonctions d'agrégation `
        + 'et de date (count, sum, avg, min, max, date_trunc, extract…).',
    };
  }

  // Le rôle ne peut de toute façon lire que le schéma assistant ; ce contrôle sert
  // à renvoyer un message utile plutôt qu'un "permission denied" opaque.
  const relations = [...collecterRelations(instruction)].filter(Boolean);
  const horsSchema = relations.filter((r) => r.includes('.') && !r.startsWith('assistant.'));
  if (horsSchema.length > 0) {
    return {
      ok: false,
      motif: `Table hors périmètre : ${horsSchema.join(', ')}. `
        + "Tu ne peux lire que les vues du schéma assistant (liste dans assistant.v_dictionnaire).",
    };
  }

  // LIMIT imposé : borne le volume rendu au modèle et le coût de la requête.
  const aUnLimit = instruction.limit
    && (Array.isArray(instruction.limit.value) ? instruction.limit.value.length > 0 : instruction.limit.value != null);
  const plafond = Math.min(limiteLignes, LIMITE_LIGNES_MAX);
  if (!aUnLimit) sql = `${sql}\nLIMIT ${plafond}`;

  return { ok: true, sql };
}

/**
 * Exécute une requête validée, dans une transaction en lecture seule cloisonnée
 * au site (et à l'école) du fondateur connecté.
 *
 * siteId/ecoleId viennent du JWT — jamais de la requête du modèle.
 */
async function executerRequeteUneFois(sqlBrut, { siteId, ecoleId = null, limiteLignes } = {}) {
  if (!siteId) throw new Error('Site absent : impossible de cloisonner la requête.');

  const validation = validerRequete(sqlBrut, { limiteLignes });
  if (!validation.ok) return { ok: false, motif: validation.motif };

  // siteId/ecoleId viennent du JWT, mais ils sont interpolés dans une commande
  // groupée (le protocole simple n'accepte pas de paramètres) : on impose donc
  // qu'ils soient des entiers, sans exception.
  const site = Number(siteId);
  if (!Number.isInteger(site) || site <= 0) throw new Error('Identifiant de site invalide.');
  let ecole = '';
  if (ecoleId != null && ecoleId !== '') {
    const e = Number(ecoleId);
    if (!Number.isInteger(e) || e <= 0) throw new Error("Identifiant d'école invalide.");
    ecole = String(e);
  }

  // L'ouverture de connexion est le point de fragilité : elle traverse
  // l'Atlantique et réveille parfois un compute en veille. Un échec ici doit
  // produire un `{ok:false}` PROPRE — jamais une exception. Une exception
  // remonte jusqu'à la boucle d'outils, qui n'envoie alors aucune réponse au
  // modèle : privé de résultat, il improvise un chiffre. C'est précisément le
  // défaut qu'on corrige. Un second essai couvre la coupure de connexion
  // isolée, qui est la panne la plus courante avec Neon.
  let client;
  try {
    client = await getPool().connect();
  } catch (premier) {
    try {
      client = await getPool().connect();
    } catch (second) {
      console.warn('[assistant] connexion de lecture impossible :', second.message);
      return {
        ok: false,
        indisponible: true,
        motif: "La base de données n'a pas répondu (connexion impossible). "
          + "Ne donne AUCUN chiffre : dis au fondateur que la base est momentanément "
          + 'injoignable et propose de réessayer.',
      };
    }
  }

  const debut = Date.now();

  try {
    // Groupé en une seule commande : chaque aller-retour vers Neon coûte ~200 ms,
    // et les faire séparément triplait la latence de chaque question (1210 ms → 420 ms).
    // Le cloisonnement est posé ici et lu par les vues (assistant.site_courant()) ;
    // is_local = true le limite à cette transaction.
    await client.query(
      `BEGIN;
       SET TRANSACTION READ ONLY;
       SET LOCAL statement_timeout = ${TIMEOUT_MS};
       SELECT set_config('assistant.site_id', '${site}', true);
       SELECT set_config('assistant.ecole_id', '${ecole}', true)`
    );

    const resultat = await client.query(validation.sql);

    // ── Vérification post-exécution ────────────────────────────────────────
    // Si la requête a réussi à déplacer le périmètre (par set_config ou par un
    // moyen qu'on n'a pas anticipé), on jette le résultat. C'est le filet qui
    // ne dépend pas de la capacité du validateur à tout prévoir.
    // Contrôle et ROLLBACK dans le même aller-retour (le protocole simple rend
    // les deux résultats ; on lit celui du SELECT).
    const controle = await client.query(
      `SELECT current_setting('assistant.site_id', true) AS site,
              COALESCE(current_setting('assistant.ecole_id', true), '') AS ecole;
       ROLLBACK`
    );
    const ligneControle = (Array.isArray(controle) ? controle[0] : controle).rows[0];
    const siteApres = ligneControle.site;
    const ecoleApres = ligneControle.ecole;

    if (siteApres !== String(site) || ecoleApres !== ecole) {
      console.warn(
        `[assistant] ÉVASION DE PÉRIMÈTRE bloquée — attendu site=${site} école=${ecole}, `
        + `trouvé site=${siteApres} école=${ecoleApres}. Requête : ${validation.sql.slice(0, 200)}`
      );
      return {
        ok: false,
        motif: "Cette requête tente de modifier le périmètre de consultation. Refusée.",
      };
    }

    // Le ROLLBACK a déjà été émis avec le contrôle ci-dessus — rien à valider,
    // tout est en lecture.
    const plafond = Math.min(limiteLignes || LIMITE_LIGNES_DEFAUT, LIMITE_LIGNES_MAX);
    const lignes = resultat.rows.slice(0, plafond);

    return {
      ok: true,
      lignes,
      nb_lignes: lignes.length,
      tronque: resultat.rows.length > plafond,
      colonnes: resultat.fields.map((f) => f.name),
      duree_ms: Date.now() - debut,
      sql_execute: validation.sql,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction déjà avortée */ }

    // Une panne de transport (connexion coupée, compute en veille, délai
    // dépassé) n'est pas une erreur dont le modèle peut se corriger : lui
    // renvoyer « corrige ta requête » l'amène à en écrire une autre, à échouer
    // encore, puis à répondre de tête. On la nomme donc pour ce qu'elle est.
    // 25P03 : Neon coupe une transaction restee inactive. 57P01/57P03 : le
    // compute s'arrete ou redemarre. 08xxx : la connexion elle-meme a laché.
    // Aucune de ces pannes ne se corrige en reecrivant le SQL.
    const transport = !error.code
      || ['08P01', '08006', '08003', '08000', '08007', '57P01', '57P02', '57P03', '25P03',
        'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code);
    if (transport) {
      console.warn('[assistant] lecture interrompue :', error.code || '', error.message);
      return {
        ok: false,
        indisponible: true,
        motif: "La base de données a interrompu la lecture. Ne donne AUCUN chiffre : "
          + 'dis au fondateur que la base est momentanément injoignable et propose de réessayer.',
        code: error.code,
      };
    }

    // L'erreur PostgreSQL est renvoyée au modèle : c'est ce qui lui permet de
    // corriger un nom de colonne ou une jointure sans intervention humaine.
    return {
      ok: false,
      motif: `Erreur PostgreSQL : ${error.message}`,
      code: error.code,
    };
  } finally {
    client.release();
  }
}

/**
 * Catalogue du schéma — ce que le modèle lit pour découvrir les données.
 *
 * DEUX NIVEAUX DE DÉTAIL, et c'est délibéré. Le schéma expose 91 objets et 830
 * colonnes ; tout injecter coûtait 11 700 jetons À CHAQUE conversation, sur un
 * quota de 20 requêtes par jour. Le modèle s'y noyait autant que le budget.
 *
 *   • les vues métier `v_*` sont données EN ENTIER : jointures déjà faites,
 *     libellés lisibles, règles de gestion dans le commentaire. C'est le chemin
 *     recommandé, il doit être le plus facile à emprunter ;
 *   • les reflets de table `t_*` sont seulement NOMMÉS, avec une phrase. Le
 *     modèle appelle `decrire_table` quand il en a besoin d'un.
 *
 * Résultat : la portée passe de 29 à 73 tables, et le catalogue reste plus
 * léger qu'avant.
 */
async function getDictionnaire({ siteId, ecoleId = null }) {
  const resultat = await executerRequete(
    'SELECT vue, description, colonne, type FROM assistant.v_dictionnaire',
    { siteId, ecoleId, limiteLignes: LIMITE_LIGNES_MAX }
  );
  if (!resultat.ok) throw new Error(resultat.motif);

  const parVue = new Map();
  for (const l of resultat.lignes) {
    if (!parVue.has(l.vue)) parVue.set(l.vue, { vue: `assistant.${l.vue}`, description: l.description, colonnes: [] });
    parVue.get(l.vue).colonnes.push(`${l.colonne} (${l.type})`);
  }
  const tout = [...parVue.values()];
  return {
    metier: tout.filter((v) => !v.vue.startsWith('assistant.t_')),
    tables: tout.filter((v) => v.vue.startsWith('assistant.t_'))
      .map((v) => ({ vue: v.vue, resume: premierePhrase(v.description), nb_colonnes: v.colonnes.length })),
  };
}

/** Première phrase d'un commentaire — assez pour choisir une table, pas assez
 *  pour peser en contexte. */
function premierePhrase(texte) {
  const t = String(texte || '').trim();
  if (!t) return '';
  const fin = t.search(/\.\s|\.$/);
  return (fin > 0 ? t.slice(0, fin + 1) : t).slice(0, 170);
}

/**
 * Colonnes d'un objet du schéma assistant, à la demande.
 *
 * Le nom est validé contre le catalogue plutôt que concaténé : c'est une entrée
 * qui vient du modèle, donc du texte non fiable.
 */
async function decrireTable(nom, { siteId, ecoleId = null }) {
  const propre = String(nom || '').replace(/^assistant\./, '').trim();
  if (!/^[a-z0-9_]+$/i.test(propre)) return { ok: false, motif: 'Nom invalide.' };

  const r = await executerRequete(
    `SELECT vue, description, colonne, type FROM assistant.v_dictionnaire WHERE vue = '${propre}'`,
    { siteId, ecoleId, limiteLignes: LIMITE_LIGNES_MAX }
  );
  if (!r.ok) return { ok: false, motif: r.motif };
  if (!r.lignes.length) return { ok: false, motif: `Aucun objet nommé « ${propre} » dans le schéma assistant.` };

  return {
    ok: true,
    objet: `assistant.${propre}`,
    description: r.lignes[0].description || null,
    colonnes: r.lignes.map((l) => `${l.colonne} (${l.type})`),
  };
}

/**
 * Exécute la requête, avec UNE reprise en cas de panne de transport.
 *
 * POURQUOI UNE REPRISE. Les pannes rencontrées avec Neon sont transitoires par
 * nature : une connexion coupée, un compute qui sort de veille, une transaction
 * expirée. Le deuxième essai réussit presque toujours — et il coûte trois
 * secondes, là où l'échec coûtait une réponse fausse : privée de résultat,
 * l'assistante répondait de tête.
 *
 * UNE SEULE, et seulement sur le transport. Une requête refusée par le
 * validateur ou par PostgreSQL (colonne inexistante, jointure fautive) échoue
 * pour une raison que la relance ne changera pas : la relancer ne ferait que
 * doubler l'attente avant de dire la même chose.
 */
async function executerRequete(sqlBrut, options = {}) {
  const premier = await executerRequeteUneFois(sqlBrut, options);
  if (premier.ok || !premier.indisponible) return premier;

  console.warn('[assistant] lecture reprise apres panne de transport');
  const second = await executerRequeteUneFois(sqlBrut, options);
  if (second.ok) return second;

  return {
    ...second,
    motif: "La base de données n'a pas répondu, malgré une seconde tentative. "
      + "Ne donne AUCUN chiffre et n'avance aucune estimation : dis au fondateur que la "
      + 'base est momentanément injoignable, et propose de réessayer dans un instant.',
  };
}

module.exports = { validerRequete, executerRequete, getDictionnaire, decrireTable };
