// Résolution de la session de caisse ouverte d'un caissier — extrait de caisse.controller.js
// (Phase 3 intégration Wave, 2026-08-18) pour être réutilisé par le nouveau contrôleur
// d'initiation de paiement Wave sans dupliquer cette règle. Comportement strictement inchangé.
async function getSessionOuverte(dbClient, userId, siteId) {
  const result = await dbClient.query(
    `SELECT sc.* FROM session_caisse sc
     JOIN caisse c ON c.id = sc.caisse_id
     WHERE sc.caissier_id = $1 AND c.site_id = $2 AND sc.statut = 'OUVERTE'
     ORDER BY sc.date_ouverture DESC LIMIT 1`,
    [userId, siteId]
  );
  return result.rows[0] || null;
}

// ✅ Chantier Dashboards financiers (2026-08-27, corrigé le même jour) : sessions OUVERTES pour
// tout un SITE (Dashboard Fondateur, "Vue globale des caisses"), avec détail par session
// (caissier, heure d'ouverture, encaissé aujourd'hui, nombre de transactions, et une ventilation
// PAR ANNÉE ACADÉMIQUE puis PAR TYPE DE FRAIS sur toute la durée de la session — pas seulement
// "aujourd'hui") — à ne pas confondre avec getSessionOuverte ci-dessus (scopée à UN caissier,
// utilisée par l'écran caisse et la confirmation Wave, non modifiée, non touchée par ce fichier).
//
// ✅ CORRECTIF (2026-08-27) : la ventilation par type utilisait `date_paiement = CURRENT_DATE`
// (aujourd'hui uniquement, sans distinction d'année académique). Demande corrigée : la
// ventilation doit couvrir TOUTE la session (comme buildRapportSession::parAnneeResult, jamais
// une fenêtre de date) et croiser année académique × type de frais. Source de l'année : la
// colonne réelle `paiement.annee_academique_id` (FK vers anneeacademique, toujours renseignée —
// vérifié : 0 paiement sans cette colonne) — JAMAIS déduite de `date_paiement`, exactement comme
// `buildRapportSession` le fait déjà pour repartition_annee_academique. `encaisse_aujourd_hui`
// reste une statistique séparée, toujours bornée à aujourd'hui (inchangée). Même convention
// type_frais que caisse.controller.js::buildRapportSession
// (COALESCE(NULLIF(type_frais,''),'scolarite')) — aucune nouvelle règle de calcul des paiements.
//
// `ecoleId` (Chantier 3, cloisonnement cumulatif avec le site) : même fragment
// etudiant→filiere→departement→ecole que dashboardFondateur.controller.js::ecoleCondEtudiant —
// une session reste listée (elle appartient au site), mais ses montants ne comptent que les
// paiements de l'école autorisée quand `ecoleId` n'est pas null.
async function getSessionsOuvertesDetailSite(dbClient, siteId, ecoleId = null) {
  // ✅ LEFT JOIN (pas INNER comme buildRapportSession, non modifié) : constat fait en testant ce
  // correctif — des session_caisse OUVERTE peuvent référencer un caissier_id supprimé depuis
  // (utilisateur introuvable). Un INNER JOIN les faisait disparaître silencieusement de la liste
  // tout en restant comptées dans caissesResult.sessions_ouvertes (simple COUNT sans jointure
  // utilisateur). Le LEFT JOIN garde ces sessions dans le détail, avec un nom de repli.
  const sessionsResult = await dbClient.query(
    `SELECT sc.id, sc.date_ouverture, sc.montant_ouverture,
            c.libelle AS caisse_libelle, u.nom AS caissier_nom, u.code AS caissier_code
     FROM session_caisse sc
     JOIN caisse c ON c.id = sc.caisse_id
     LEFT JOIN utilisateur u ON u.id = sc.caissier_id
     WHERE c.site_id = $1 AND sc.statut = 'OUVERTE'
     ORDER BY sc.date_ouverture DESC`,
    [siteId]
  );

  const sessions = sessionsResult.rows;
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const ecoleCond = ecoleId !== null
    ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2))'
    : '';
  const params = ecoleId !== null ? [sessionIds, ecoleId] : [sessionIds];

  const [totauxAujourdhuiResult, repartitionAnneeTypeResult] = await Promise.all([
    // "Encaissé aujourd'hui" — statistique séparée, toujours bornée à la date du jour (inchangé).
    dbClient.query(
      `SELECT p.session_caisse_id, COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p
       WHERE p.session_caisse_id = ANY($1) AND p.date_paiement = CURRENT_DATE ${ecoleCond}
       GROUP BY p.session_caisse_id`,
      params
    ),
    // Ventilation année académique (paiement.annee_academique_id, jamais date_paiement) × type de
    // frais, sur TOUTE la durée de la session — même source que
    // buildRapportSession::parAnneeResult, croisée avec le type.
    dbClient.query(
      `SELECT p.session_caisse_id, p.annee_academique_id, a.annee,
              COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
              COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p
       JOIN anneeacademique a ON a.id = p.annee_academique_id
       WHERE p.session_caisse_id = ANY($1) ${ecoleCond}
       GROUP BY p.session_caisse_id, p.annee_academique_id, a.annee,
                COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
       ORDER BY a.annee ASC`,
      params
    ),
  ]);

  const totauxAujourdhuiParSession = new Map(totauxAujourdhuiResult.rows.map((r) => [r.session_caisse_id, r]));

  // session_id -> annee_academique_id -> { annee_academique_id, annee, total_annee, parType: [] }
  const anneesParSession = new Map();
  for (const row of repartitionAnneeTypeResult.rows) {
    if (!anneesParSession.has(row.session_caisse_id)) anneesParSession.set(row.session_caisse_id, new Map());
    const parAnnee = anneesParSession.get(row.session_caisse_id);
    if (!parAnnee.has(row.annee_academique_id)) {
      parAnnee.set(row.annee_academique_id, {
        annee_academique_id: row.annee_academique_id,
        annee: row.annee,
        total_annee: 0,
        parType: [],
      });
    }
    const entry = parAnnee.get(row.annee_academique_id);
    const montant = parseFloat(row.total);
    entry.total_annee += montant;
    entry.parType.push({ type_frais: row.type_frais, total: montant });
  }

  return sessions.map((s) => {
    const repartitionParAnnee = Array.from(anneesParSession.get(s.id)?.values() || []);
    return {
      session_id: s.id,
      caisse_libelle: s.caisse_libelle,
      // Repli explicite (jamais null/undefined affiché tel quel côté frontend) pour les sessions
      // dont le caissier a été supprimé depuis — voir commentaire LEFT JOIN ci-dessus.
      caissier_nom: s.caissier_nom || 'Caissier introuvable',
      caissier_code: s.caissier_code || null,
      date_ouverture: s.date_ouverture,
      encaisse_aujourd_hui: parseFloat(totauxAujourdhuiParSession.get(s.id)?.total || 0),
      nb_transactions_aujourd_hui: parseInt(totauxAujourdhuiParSession.get(s.id)?.nb || 0, 10),
      // Total de la session (toutes années, tous types confondus) = somme des total_annee — jamais
      // une requête séparée, pour garantir la cohérence mathématique.
      total_session: repartitionParAnnee.reduce((somme, a) => somme + a.total_annee, 0),
      repartition_par_annee: repartitionParAnnee,
    };
  });
}

module.exports = { getSessionOuverte, getSessionsOuvertesDetailSite };
