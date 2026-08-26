// Assistant Fondateur — crédits, consommation et seuil d'alerte (2026-08-26).
//
// CE QUE CE FICHIER SAIT, ET CE QU'IL NE PEUT PAS SAVOIR.
//
// Le solde réel est tenu chez le fournisseur, qui ne l'expose par aucune API
// exploitable ici. L'ancien plafond applicatif s'est déjà fait piéger par cette
// asymétrie : il coupait l'assistante sur un montant imaginaire pendant que la
// vraie limite était ailleurs. On ne devine donc plus. L'administrateur DÉCLARE
// ce qu'il a rechargé ; le solde se déduit de cette déclaration moins la
// consommation réellement mesurée.
//
// LE SOLDE EST UNE ESTIMATION, ET L'ÉCRAN DOIT LE DIRE. Il repose sur la table
// de tarifs d'assistantBudget.service.js, relevée le 12 août et non revérifiée
// depuis. Si un tarif change, le solde dérive sans que rien ne le signale. C'est
// un ordre de grandeur pour décider quand recharger, jamais un relevé de compte.
//
// ON COMPTE DEPUIS LA PREMIÈRE RECHARGE, PAS DEPUIS L'ORIGINE DU PROJET. Avant
// elle, le projet était sur le palier gratuit : aucune facturation n'avait lieu,
// et imputer cette période aux crédits achetés donnerait un solde faux dès le
// premier écran.
const db = require('../config/db.config');
const { TAUX_FCFA } = require('./assistantBudget.service');

/** Seuil retenu quand l'administrateur n'en a jamais fixé. */
const SEUIL_DEFAUT = 80;

/**
 * Écart au-delà duquel deux appels appartiennent à deux questions différentes.
 *
 * POURQUOI IL FAUT ESTIMER PLUTÔT QUE COMPTER. `assistant_consommation`
 * enregistre des APPELS AU MODÈLE, pas des questions. À l'écrit, une question en
 * consomme deux à quatre : le modèle appelle ses outils, puis rédige. Diviser le
 * coût total par le nombre d'appels donnerait un « coût par question » trois
 * fois trop bas, et donc trois fois trop de questions restantes annoncées.
 *
 * 90 SECONDES. Les appels d'une même question s'enchaînent en quelques secondes
 * — le plus long mesuré tenait sous vingt. Deux questions séparées par moins de
 * quatre-vingt-dix secondes sont possibles mais rares, et les fondre en une
 * seule reste du bon côté de l'erreur : cela SURESTIME le coût par question,
 * donc sous-estime ce qui reste. Un compteur de crédits doit se tromper dans ce
 * sens-là.
 */
const ECART_QUESTION = '90 seconds';

const nombre = (v) => Number(v || 0);

/** Le seuil d'alerte du site, avec son défaut. */
async function getSeuil(siteId) {
  const { rows } = await db.query(
    'SELECT seuil_pourcentage FROM assistant_alerte WHERE site_id = $1',
    [siteId],
  );
  return rows.length ? rows[0].seuil_pourcentage : SEUIL_DEFAUT;
}

async function majSeuil(siteId, utilisateurId, seuil) {
  const valeur = Math.min(Math.max(Math.round(Number(seuil)), 1), 100);
  if (!Number.isFinite(valeur)) throw new Error('Seuil invalide.');
  await db.query(
    `INSERT INTO assistant_alerte (site_id, seuil_pourcentage, maj_le, maj_par)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (site_id) DO UPDATE
       SET seuil_pourcentage = EXCLUDED.seuil_pourcentage, maj_le = now(), maj_par = EXCLUDED.maj_par`,
    [siteId, valeur, utilisateurId || null],
  );
  return valeur;
}

/** Enregistre une recharge déclarée. Le montant est en dollars. */
async function ajouterRecharge({ siteId, utilisateurId, montantUsd, dateRecharge = null, note = null }) {
  const montant = Number(montantUsd);
  if (!Number.isFinite(montant) || montant <= 0) throw new Error('Montant de recharge invalide.');
  const { rows } = await db.query(
    `INSERT INTO assistant_recharge (site_id, montant_usd, date_recharge, saisi_par, note)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5)
     RETURNING id, montant_usd, date_recharge, cree_le`,
    [siteId, montant, dateRecharge, utilisateurId || null, note ? String(note).slice(0, 300) : null],
  );
  return rows[0];
}

/** Les recharges du site, avec le nom de qui les a saisies. */
async function listerRecharges(siteId, limite = 20) {
  const { rows } = await db.query(
    `SELECT r.id, r.montant_usd::float AS montant_usd, r.date_recharge, r.note, r.cree_le,
            -- La table utilisateur ne porte qu'une colonne nom, qui contient le
            -- nom complet : il n'y a pas de prenom a concatener.
            u.nom AS saisi_par
     FROM assistant_recharge r
     LEFT JOIN utilisateur u ON u.id = r.saisi_par
     WHERE r.site_id = $1
     ORDER BY r.date_recharge DESC, r.id DESC
     LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limite) || 20, 1), 200)],
  );
  return rows;
}

/**
 * Consommation et nombre de QUESTIONS depuis une date.
 *
 * Les deux canaux ne se comptent pas de la même façon, et c'est voulu :
 *
 *   • À LA VOIX, l'API facture un appel par tour de parole. Un appel vaut donc
 *     une question, et `COUNT(*)` est exact.
 *   • À L'ÉCRIT, une question déclenche une rafale d'appels. On les regroupe par
 *     proximité dans le temps : un appel ouvre une nouvelle question s'il est le
 *     premier, ou s'il suit le précédent de plus de `ECART_QUESTION`.
 *
 * Le regroupement est partitionné par utilisateur : deux personnes qui
 * interrogent l'assistante en même temps ne doivent pas voir leurs appels fondus
 * en une seule question.
 */
async function getConsommationDepuis(siteId, depuis) {
  const { rows } = await db.query(
    `WITH appels AS (
       SELECT canal, cout_usd, cree_le, utilisateur_id,
              LAG(cree_le) OVER (PARTITION BY utilisateur_id, canal ORDER BY cree_le) AS precedent
       FROM assistant_consommation
       WHERE site_id = $1 AND ($2::timestamptz IS NULL OR cree_le >= $2::timestamptz)
     )
     SELECT canal,
            COUNT(*)::int                            AS appels,
            COALESCE(SUM(cout_usd), 0)::float        AS cout_usd,
            SUM(
              CASE
                WHEN canal = 'vocal' THEN 1
                WHEN precedent IS NULL THEN 1
                WHEN cree_le - precedent > interval '${ECART_QUESTION}' THEN 1
                ELSE 0
              END
            )::int                                   AS questions
     FROM appels
     GROUP BY canal`,
    [siteId, depuis],
  );

  const total = { appels: 0, cout_usd: 0, questions: 0 };
  const parCanal = {};
  for (const l of rows) {
    parCanal[l.canal] = { appels: l.appels, cout_usd: l.cout_usd, questions: l.questions };
    total.appels += l.appels;
    total.cout_usd += l.cout_usd;
    total.questions += l.questions;
  }
  return { total, parCanal };
}

/** Consommation jour par jour et par canal, pour l'histogramme des 7 jours. */
async function getUsageParJour(siteId, jours = 7) {
  const { rows } = await db.query(
    `SELECT (cree_le AT TIME ZONE 'UTC')::date AS jour, canal,
            COUNT(*)::int                     AS appels,
            COALESCE(SUM(cout_usd), 0)::float AS cout_usd
     FROM assistant_consommation
     WHERE site_id = $1 AND cree_le >= CURRENT_DATE - ($2::int - 1)
     GROUP BY 1, 2
     ORDER BY 1`,
    [siteId, Math.min(Math.max(Number(jours) || 7, 1), 90)],
  );
  return rows;
}

/**
 * Ce à quoi un modèle a servi, dit en français.
 *
 * L'ÉCRAN NE MONTRE PAS DE NOMS DE MODÈLES, même à l'administrateur. Non par
 * secret — il y a droit — mais parce que « gemini-3.1-flash-lite » ne lui
 * apprend rien, alors que « modèle de secours, 18 appels » lui apprend qu'un
 * repli s'est produit dix-huit fois. C'est le second qui déclenche une action.
 *
 * La classification se fait sur la FORME du nom et sur la configuration en
 * cours, jamais sur une liste figée : un modèle changé dans l'environnement
 * reste correctement rangé sans qu'on touche à ce fichier.
 */
function roleDeModele(modele) {
  const nom = String(modele || '');
  if (/live|native-audio/i.test(nom)) return 'vocal';
  if (nom === (process.env.ASSISTANT_MODELE_TEXTE || 'gemini-3.6-flash')) return 'texte';
  if (/lite|pro/i.test(nom)) return 'secours';
  // Ni le modèle de tête, ni un repli déclaré : c'est une trace d'une
  // configuration passée. La voir est utile — elle date l'historique.
  return 'retire';
}

const LIBELLES_ROLE = {
  texte: 'Assistante écrite',
  vocal: 'Assistante vocale',
  secours: 'Modèle de secours',
  retire: 'Ancienne configuration',
};

/** Répartition par modèle — c'est elle qui rend un repli visible. */
async function getUsageParModele(siteId, depuis) {
  const { rows } = await db.query(
    `SELECT modele, COUNT(*)::int AS appels, COALESCE(SUM(cout_usd), 0)::float AS cout_usd
     FROM assistant_consommation
     WHERE site_id = $1 AND ($2::timestamptz IS NULL OR cree_le >= $2::timestamptz)
     GROUP BY modele
     ORDER BY appels DESC`,
    [siteId, depuis],
  );

  // Regroupé par RÔLE et non par modèle : deux modèles de secours successifs
  // sont le même fait pour qui lit l'écran, et les séparer masquerait qu'il y a
  // eu vingt replis en tout.
  const parRole = new Map();
  for (const l of rows) {
    const role = roleDeModele(l.modele);
    const acc = parRole.get(role) || { role, libelle: LIBELLES_ROLE[role], appels: 0, cout_usd: 0 };
    acc.appels += l.appels;
    acc.cout_usd += l.cout_usd;
    parRole.set(role, acc);
  }
  return [...parRole.values()].sort((a, b) => b.appels - a.appels);
}

/**
 * L'état des crédits du site : ce qui a été mis, ce qui a été dépensé, ce qu'il
 * reste, et si le seuil est franchi.
 *
 * TANT QU'AUCUNE RECHARGE N'EST SAISIE, on ne prétend pas connaître un solde.
 * `configure: false` le dit à l'écran, qui affichera une invitation à saisir la
 * première recharge plutôt qu'un solde négatif de toute la consommation passée.
 */
async function getEtatCredits(siteId) {
  const [{ rows: cumul }, seuil] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(montant_usd), 0)::float AS recharge_usd,
              MIN(date_recharge)                   AS premiere
       FROM assistant_recharge WHERE site_id = $1`,
      [siteId],
    ),
    getSeuil(siteId),
  ]);

  const rechargeUsd = nombre(cumul[0].recharge_usd);
  const premiere = cumul[0].premiere;
  const configure = rechargeUsd > 0;

  /*
   * DEUX FENÊTRES DE TEMPS, ET NON UNE SEULE. C'est un défaut constaté au premier
   * essai : tout calculé depuis la première recharge, le coût moyen annonçait
   * 104 FCFA par question au lieu des 29 mesurés — parce que la recharge datait
   * du jour même et que la moyenne ne portait que sur trois questions.
   *
   *   • Le SOLDE se compte depuis la première recharge, obligatoirement : avant
   *     elle, le projet était sur le palier gratuit et rien n'était facturé.
   *   • La MOYENNE se calcule sur tout l'historique, parce qu'une moyenne a
   *     besoin d'un échantillon. Elle sert à projeter « il reste N questions »,
   *     et une moyenne bâtie sur trois questions ne projette rien.
   */
  const [conso, historique] = await Promise.all([
    getConsommationDepuis(siteId, premiere || null),
    premiere ? getConsommationDepuis(siteId, null) : null,
  ]);
  const consommeUsd = nombre(conso.total.cout_usd);
  const questions = nombre(conso.total.questions);

  const echantillon = historique ? historique.total : conso.total;
  const coutParQuestionUsd = nombre(echantillon.questions) > 0
    ? nombre(echantillon.cout_usd) / nombre(echantillon.questions)
    : 0;
  const soldeUsd = rechargeUsd - consommeUsd;
  const pourcentage = configure ? Math.round((consommeUsd / rechargeUsd) * 100) : 0;

  return {
    configure,
    premiere_recharge: premiere,
    recharge_usd: rechargeUsd,
    consomme_usd: consommeUsd,
    solde_usd: soldeUsd,
    pourcentage,
    seuil_pourcentage: seuil,
    alerte: configure && pourcentage >= seuil,
    appels: conso.total.appels,
    questions,
    cout_par_question_usd: coutParQuestionUsd,
    cout_par_question_fcfa: Math.round(coutParQuestionUsd * TAUX_FCFA),
    // Sur combien de questions la moyenne est établie. L'écran doit pouvoir dire
    // « moyenne sur 12 questions » plutôt que de présenter comme une constante ce
    // qui n'est encore qu'un premier relevé.
    questions_echantillon: nombre(echantillon.questions),
    // Ce qu'il reste à ce rythme. Zéro quand le solde est épuisé — et non un
    // nombre négatif, qui ne veut rien dire pour qui lit l'écran.
    questions_restantes: coutParQuestionUsd > 0 ? Math.max(Math.floor(soldeUsd / coutParQuestionUsd), 0) : null,
    par_canal: conso.parCanal,
    taux_fcfa: TAUX_FCFA,
  };
}

module.exports = {
  getEtatCredits,
  getSeuil,
  majSeuil,
  ajouterRecharge,
  listerRecharges,
  getConsommationDepuis,
  getUsageParJour,
  getUsageParModele,
  roleDeModele,
  SEUIL_DEFAUT,
  ECART_QUESTION,
};
