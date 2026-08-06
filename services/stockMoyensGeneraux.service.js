// Chantier 10 (2026-08-02) — grand-livre de stock du module Moyens Généraux.
//
// Principe directeur (validé le 2026-08-02) : le solde disponible d'un accessoire n'est JAMAIS
// une colonne qu'on incrémente/décrémente. Chaque mouvement est une ligne insérée dans
// mouvement_stock, jamais modifiée ni supprimée ; le solde est toujours recalculé par SUM signée.
// Cette fonction est le SEUL point d'écriture autorisé sur mouvement_stock — aucun contrôleur ne
// doit faire d'INSERT direct sur cette table, pour garantir qu'aucun développement futur ne
// réintroduit un compteur mutable parallèle au grand-livre.

// 'ajustement_inventaire' (unique, sens ambigu) remplacé par deux types explicites en sous-phase 8
// (migration 009) — la règle du grand-livre veut que `quantite` soit toujours positive, le sens
// devant donc être porté sans ambiguïté par `type`. 'transfert_sortant'/'transfert_entrant'
// existent déjà dans le schéma (architecture prête) mais aucun contrôleur ne les émet encore —
// activation reportée, décision du 2026-08-02.
const TYPES_MOUVEMENT = ['reception', 'distribution', 'ajustement_positif', 'ajustement_negatif', 'transfert_sortant', 'transfert_entrant'];
const TYPES_ENTREE = ['reception', 'ajustement_positif', 'transfert_entrant'];
const TYPES_SORTIE = ['distribution', 'ajustement_negatif', 'transfert_sortant'];

// dbClient : client de transaction déjà ouvert (BEGIN fait par l'appelant, COMMIT/ROLLBACK aussi
// — cette fonction ne gère jamais elle-même la transaction, pour rester composable dans un flux
// plus large, ex. une distribution qui écrit plusieurs mouvements dans la même transaction).
async function enregistrerMouvementStock(dbClient, {
  accessoireId, emplacementStockId, type, quantite, referenceType = null, referenceId = null, effectuePar, motif = null,
}) {
  if (!TYPES_MOUVEMENT.includes(type)) {
    throw new Error(`Type de mouvement invalide : ${type}`);
  }
  if (!Number.isInteger(quantite) || quantite <= 0) {
    throw new Error('La quantité doit être un entier strictement positif.');
  }

  // Toute sortie (distribution, ajustement_negatif, transfert_sortant) est bloquée si elle ferait
  // passer le solde sous zéro — un ajustement_positif n'a pas cette contrainte (une entrée ne peut
  // jamais être "en trop négatif").
  if (TYPES_SORTIE.includes(type)) {
    const solde = await getSoldeStock(dbClient, { emplacementStockId, accessoireId });
    if (solde < quantite) {
      throw new Error(`Stock insuffisant (disponible : ${solde}, demandé : ${quantite}).`);
    }
  }

  const result = await dbClient.query(
    `INSERT INTO mouvement_stock (accessoire_id, emplacement_stock_id, type, quantite, reference_type, reference_id, effectue_par, motif)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [accessoireId, emplacementStockId, type, quantite, referenceType, referenceId, effectuePar, motif]
  );
  return result.rows[0];
}

// Solde d'UN accessoire à UN emplacement — somme signée selon le type de mouvement. Les listes
// SQL ci-dessous DOIVENT rester synchronisées avec TYPES_ENTREE/TYPES_SORTIE (SQL brut, pas
// d'import possible des constantes JS dans la requête).
async function getSoldeStock(dbClient, { emplacementStockId, accessoireId }) {
  const result = await dbClient.query(
    `SELECT COALESCE(SUM(
       CASE WHEN type IN ('reception', 'ajustement_positif', 'transfert_entrant') THEN quantite
            WHEN type IN ('distribution', 'ajustement_negatif', 'transfert_sortant') THEN -quantite
            ELSE 0 END
     ), 0) AS solde
     FROM mouvement_stock
     WHERE emplacement_stock_id = $1 AND accessoire_id = $2`,
    [emplacementStockId, accessoireId]
  );
  return parseInt(result.rows[0].solde, 10);
}

// Statut d'un accessoire selon son solde et son seuil — même règle utilisée par l'écran Stock et
// le Dashboard (une seule définition, jamais dupliquée).
function calculerStatutStock(solde, seuilAlerte) {
  if (solde <= 0) return 'rupture';
  if (solde <= seuilAlerte) return 'stock_faible';
  return 'normal';
}

// Soldes de TOUS les accessoires actifs à un emplacement — pour les écrans d'état du stock /
// dashboard (source commune : toute nouvelle information ajoutée ici profite aux deux sans
// modification séparée). LEFT JOIN pour inclure les accessoires jamais mouvementés (solde 0), pas
// seulement ceux ayant déjà une ligne dans le grand-livre. Inclut la valorisation estimée
// (sous-phase 8) : coût unitaire de référence × solde, NULL si le coût n'est pas encore renseigné
// (aucune valeur inventée — 0 explicitement affiché comme "non valorisé" côté frontend).
async function getSoldesStockParEmplacement(dbClient, emplacementStockId) {
  const result = await dbClient.query(
    `SELECT a.id AS accessoire_id, a.code, a.nom, a.seuil_alerte_defaut, a.cout_unitaire_reference,
       COALESCE(SUM(
         CASE WHEN m.type IN ('reception', 'ajustement_positif', 'transfert_entrant') THEN m.quantite
              WHEN m.type IN ('distribution', 'ajustement_negatif', 'transfert_sortant') THEN -m.quantite
              ELSE 0 END
       ), 0) AS solde
     FROM accessoire a
     LEFT JOIN mouvement_stock m ON m.accessoire_id = a.id AND m.emplacement_stock_id = $1
     WHERE a.actif = true
     GROUP BY a.id, a.code, a.nom, a.seuil_alerte_defaut, a.cout_unitaire_reference
     ORDER BY a.nom`,
    [emplacementStockId]
  );
  return result.rows.map((r) => {
    const solde = parseInt(r.solde, 10);
    const coutUnitaire = r.cout_unitaire_reference !== null ? parseFloat(r.cout_unitaire_reference) : null;
    return {
      accessoire_id: r.accessoire_id,
      code: r.code,
      nom: r.nom,
      seuil_alerte: r.seuil_alerte_defaut,
      solde,
      en_alerte: solde <= r.seuil_alerte_defaut,
      statut: calculerStatutStock(solde, r.seuil_alerte_defaut),
      cout_unitaire_reference: coutUnitaire,
      valeur_estimee: coutUnitaire !== null ? Math.round(coutUnitaire * solde * 100) / 100 : null,
    };
  });
}

// Nombre d'étudiants distincts ayant reçu leur remise pour une année académique donnée, à un
// emplacement de stock donné — partagé entre le Dashboard Moyens Généraux (sous-phase 3) et le
// bloc dédié du Dashboard Fondateur (sous-phase 12), pour ne jamais dupliquer cette requête.
async function getEtudiantsServis(dbClient, { anneeAcademiqueId, emplacementStockId, ecoleId = null }) {
  const ecoleCond = ecoleId !== null
    ? 'AND d.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
    : '';
  const params = ecoleId !== null ? [anneeAcademiqueId, emplacementStockId, ecoleId] : [anneeAcademiqueId, emplacementStockId];
  const result = await dbClient.query(
    `SELECT COUNT(DISTINCT d.etudiant_id) AS total
     FROM distribution d
     WHERE d.annee_academique_id = $1 AND d.emplacement_stock_id = $2 ${ecoleCond}`,
    params
  );
  return parseInt(result.rows[0].total, 10);
}

// Évolution mensuelle du nombre d'étudiants servis sur une année académique (Dashboard Fondateur,
// sous-phase 12) — une remise = un étudiant (contrainte d'unicité etudiant_id/annee_academique_id
// posée en sous-phase 2), COUNT(*) suffit donc, pas besoin de DISTINCT.
async function getEvolutionDistributionsMensuelle(dbClient, { anneeAcademiqueId, emplacementStockId, ecoleId = null }) {
  const ecoleCond = ecoleId !== null
    ? 'AND d.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
    : '';
  const params = ecoleId !== null ? [anneeAcademiqueId, emplacementStockId, ecoleId] : [anneeAcademiqueId, emplacementStockId];
  const result = await dbClient.query(
    `SELECT date_trunc('month', d.date_remise) AS mois, COUNT(*) AS total
     FROM distribution d
     WHERE d.annee_academique_id = $1 AND d.emplacement_stock_id = $2 ${ecoleCond}
     GROUP BY date_trunc('month', d.date_remise) ORDER BY mois`,
    params
  );
  return result.rows.map((r) => ({ mois: r.mois, total: parseInt(r.total, 10) }));
}

// Résout l'unique emplacement_stock d'un site. Provisionnement à la volée si absent (ex. un
// nouveau site créé après la migration 004, qui n'a donc pas reçu son magasin automatiquement) —
// idempotent, jamais de doublon possible grâce à l'index unique sur emplacement_stock(site_id).
async function getEmplacementStockPourSite(dbClient, siteId) {
  const existant = await dbClient.query('SELECT id FROM emplacement_stock WHERE site_id = $1', [siteId]);
  if (existant.rows.length > 0) {
    return existant.rows[0].id;
  }
  const siteResult = await dbClient.query('SELECT nom FROM site WHERE id = $1', [siteId]);
  if (siteResult.rows.length === 0) {
    throw new Error('Site introuvable.');
  }
  const cree = await dbClient.query(
    `INSERT INTO emplacement_stock (site_id, nom) VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET site_id = EXCLUDED.site_id
     RETURNING id`,
    [siteId, `Magasin — ${siteResult.rows[0].nom}`]
  );
  return cree.rows[0].id;
}

module.exports = {
  TYPES_MOUVEMENT,
  TYPES_ENTREE,
  TYPES_SORTIE,
  enregistrerMouvementStock,
  getSoldeStock,
  getSoldesStockParEmplacement,
  getEmplacementStockPourSite,
  calculerStatutStock,
  getEtudiantsServis,
  getEvolutionDistributionsMensuelle,
};
