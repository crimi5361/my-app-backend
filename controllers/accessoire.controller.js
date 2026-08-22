// Chantier 10 (2026-08-02) — sous-phase 4 : catalogue des accessoires (référentiel).
// Complété sous-phase 8 : coût unitaire de référence (valorisation du stock).
// Complété Chantier Moyens Généraux, Phase 2A (2026-08-19) : catégorie, variante (article parent),
// distribuable aux étudiants, traçabilité création/modification.
// Complété Chantier Moyens Généraux, Phase 2D — ajustements (2026-08-19) : prix_vente_surplus,
// distinct de cout_unitaire_reference (prix d'ACHAT, déjà utilisé pour la valorisation du stock).
// Le prix de vente d'un surplus est décidé par l'agent, indépendamment du coût d'achat — jamais
// confondu (cf. controllers/demandeSurplus.controller.js, qui lit désormais prix_vente_surplus).
//
// Pas de suppression physique — un accessoire déjà utilisé dans une commande/distribution ne peut
// pas être retiré sans casser l'historique (grand-livre). Désactivation (`actif = false`)
// uniquement, via un endpoint dédié pour rendre cette action explicite côté UI (un bouton
// "Désactiver" ne doit pas pouvoir écraser silencieusement les autres champs).
//
// Modèle de variante validé à l'audit Phase 2 (§G6) : PAS de table séparée — une variante est un
// accessoire ordinaire dont `article_parent_id` pointe vers son parent. Deux niveaux exactement
// (un article, ses variantes) : le parent choisi ne doit lui-même jamais être une variante, et un
// article qui a déjà ses propres variantes ne peut pas à son tour devenir une variante — sinon la
// hiérarchie cesserait d'être un arbre à deux niveaux, ce que rien en aval (stock, dashboard) ne
// sait interpréter.
const db = require('../config/db.config');

const SELECT_ENRICHI = `SELECT
    a.id, a.code, a.nom, a.description, a.actif, a.seuil_alerte_defaut, a.cout_unitaire_reference,
    a.prix_vente_surplus,
    a.distribuable_etudiant, a.created_at, a.updated_at,
    a.categorie_id, c.nom AS categorie_nom,
    a.article_parent_id, p.nom AS article_parent_nom,
    a.cree_par, ucr.nom AS cree_par_nom,
    a.modifie_par, umo.nom AS modifie_par_nom
  FROM accessoire a
  LEFT JOIN categorie_accessoire c ON c.id = a.categorie_id
  LEFT JOIN accessoire p ON p.id = a.article_parent_id
  LEFT JOIN utilisateur ucr ON ucr.id = a.cree_par
  LEFT JOIN utilisateur umo ON umo.id = a.modifie_par`;

function validerCoutUnitaire(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return { ok: true, valeur: null };
  const nombre = parseFloat(valeur);
  if (Number.isNaN(nombre) || nombre < 0) return { ok: false };
  return { ok: true, valeur: Math.round(nombre * 100) / 100 };
}

// Catégorie facultative — NULL accepté explicitement (catalogue existant non catégorisé
// rétroactivement, cf. audit §F.8). Doit être active si renseignée.
async function validerCategorie(categorieId) {
  if (categorieId === undefined || categorieId === null || categorieId === '') return { ok: true, valeur: null };
  const id = parseInt(categorieId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Catégorie invalide.' };
  const result = await db.query('SELECT id FROM categorie_accessoire WHERE id = $1 AND actif = true', [id]);
  if (result.rows.length === 0) return { ok: false, message: 'Catégorie introuvable ou inactive.' };
  return { ok: true, valeur: id };
}

// accessoireIdActuel : lors d'une modification, pour interdire qu'un accessoire soit sa propre
// variante (le CHECK en base le bloquerait aussi, mais avec un message SQL brut, pas exploitable).
async function validerArticleParent(articleParentId, accessoireIdActuel = null) {
  if (articleParentId === undefined || articleParentId === null || articleParentId === '') return { ok: true, valeur: null };
  const id = parseInt(articleParentId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Article parent invalide.' };
  if (accessoireIdActuel !== null && id === accessoireIdActuel) {
    return { ok: false, message: 'Un accessoire ne peut pas être sa propre variante.' };
  }
  const parent = await db.query('SELECT id, article_parent_id FROM accessoire WHERE id = $1', [id]);
  if (parent.rows.length === 0) return { ok: false, message: 'Article parent introuvable.' };
  if (parent.rows[0].article_parent_id !== null) {
    return { ok: false, message: 'L\'article choisi comme parent est lui-même une variante — une variante ne peut pas avoir de sous-variante.' };
  }
  return { ok: true, valeur: id };
}

async function accessoireADesVariantes(accessoireId) {
  const result = await db.query('SELECT 1 FROM accessoire WHERE article_parent_id = $1 LIMIT 1', [accessoireId]);
  return result.rows.length > 0;
}

exports.getAccessoires = async (req, res) => {
  try {
    const result = await db.query(`${SELECT_ENRICHI} ORDER BY a.nom`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getAccessoires:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createAccessoire = async (req, res) => {
  try {
    const {
      code, nom, description, seuil_alerte_defaut, cout_unitaire_reference, prix_vente_surplus,
      categorie_id, article_parent_id, distribuable_etudiant,
    } = req.body;
    if (!code || !code.trim() || !nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le code et le nom sont obligatoires.' });
    }
    const seuil = seuil_alerte_defaut !== undefined && seuil_alerte_defaut !== null ? parseInt(seuil_alerte_defaut, 10) : 0;
    if (Number.isNaN(seuil) || seuil < 0) {
      return res.status(400).json({ success: false, message: 'Le seuil d\'alerte doit être un entier positif ou nul.' });
    }
    const cout = validerCoutUnitaire(cout_unitaire_reference);
    if (!cout.ok) {
      return res.status(400).json({ success: false, message: 'Le coût unitaire de référence (prix d\'achat) doit être un nombre positif ou nul.' });
    }
    const prixVente = validerCoutUnitaire(prix_vente_surplus);
    if (!prixVente.ok) {
      return res.status(400).json({ success: false, message: 'Le prix de vente surplus doit être un nombre positif ou nul.' });
    }
    const categorie = await validerCategorie(categorie_id);
    if (!categorie.ok) return res.status(400).json({ success: false, message: categorie.message });
    const articleParent = await validerArticleParent(article_parent_id);
    if (!articleParent.ok) return res.status(400).json({ success: false, message: articleParent.message });
    // DEFAULT true : un nouvel article est distribuable sauf indication contraire explicite.
    const distribuable = distribuable_etudiant === undefined || distribuable_etudiant === null ? true : Boolean(distribuable_etudiant);

    const inserted = await db.query(
      `INSERT INTO accessoire
         (code, nom, description, seuil_alerte_defaut, cout_unitaire_reference, prix_vente_surplus, categorie_id, article_parent_id, distribuable_etudiant, cree_par)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        code.trim(), nom.trim(), description?.trim() || null, seuil, cout.valeur, prixVente.valeur,
        categorie.valeur, articleParent.valeur, distribuable, req.user.id,
      ]
    );
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE a.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Un accessoire avec ce code ou ce nom existe déjà.' });
    }
    console.error('Erreur createAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateAccessoire = async (req, res) => {
  try {
    const accessoireId = parseInt(req.params.id, 10);
    const {
      code, nom, description, seuil_alerte_defaut, cout_unitaire_reference, prix_vente_surplus,
      categorie_id, article_parent_id, distribuable_etudiant,
    } = req.body;
    if (!code || !code.trim() || !nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le code et le nom sont obligatoires.' });
    }
    const seuil = seuil_alerte_defaut !== undefined && seuil_alerte_defaut !== null ? parseInt(seuil_alerte_defaut, 10) : 0;
    if (Number.isNaN(seuil) || seuil < 0) {
      return res.status(400).json({ success: false, message: 'Le seuil d\'alerte doit être un entier positif ou nul.' });
    }
    const cout = validerCoutUnitaire(cout_unitaire_reference);
    if (!cout.ok) {
      return res.status(400).json({ success: false, message: 'Le coût unitaire de référence (prix d\'achat) doit être un nombre positif ou nul.' });
    }
    const prixVente = validerCoutUnitaire(prix_vente_surplus);
    if (!prixVente.ok) {
      return res.status(400).json({ success: false, message: 'Le prix de vente surplus doit être un nombre positif ou nul.' });
    }
    const categorie = await validerCategorie(categorie_id);
    if (!categorie.ok) return res.status(400).json({ success: false, message: categorie.message });
    const articleParent = await validerArticleParent(article_parent_id, accessoireId);
    if (!articleParent.ok) return res.status(400).json({ success: false, message: articleParent.message });
    if (articleParent.valeur !== null && await accessoireADesVariantes(accessoireId)) {
      return res.status(400).json({
        success: false,
        message: 'Cet article a déjà ses propres variantes — il ne peut pas devenir à son tour une variante d\'un autre article.',
      });
    }
    const distribuable = distribuable_etudiant === undefined || distribuable_etudiant === null ? true : Boolean(distribuable_etudiant);

    const result = await db.query(
      `UPDATE accessoire
       SET code = $1, nom = $2, description = $3, seuil_alerte_defaut = $4, cout_unitaire_reference = $5,
           prix_vente_surplus = $6, categorie_id = $7, article_parent_id = $8, distribuable_etudiant = $9,
           modifie_par = $10, updated_at = now()
       WHERE id = $11
       RETURNING id`,
      [
        code.trim(), nom.trim(), description?.trim() || null, seuil, cout.valeur, prixVente.valeur,
        categorie.valeur, articleParent.valeur, distribuable, req.user.id, accessoireId,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE a.id = $1`, [accessoireId]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Un accessoire avec ce code ou ce nom existe déjà.' });
    }
    console.error('Erreur updateAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutAccessoire = async (req, res) => {
  try {
    const { id } = req.params;
    const { actif } = req.body;
    if (typeof actif !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Le champ actif (booléen) est requis.' });
    }
    const result = await db.query(
      `UPDATE accessoire SET actif = $1, modifie_par = $2, updated_at = now() WHERE id = $3 RETURNING id`,
      [actif, req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE a.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
