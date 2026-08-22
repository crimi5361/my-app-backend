// Chantier Moyens Généraux — Phase 2B (2026-08-19) : affectation des accessoires aux niveaux.
//
// Une règle relie un accessoire, une année académique, et soit un niveau précis (par libellé),
// soit tous les niveaux de cette année (une seule ligne, jamais une ligne par niveau). Pas de
// reconduction automatique d'une année à l'autre — chaque (accessoire, année, niveau) est une
// ligne indépendante, configurée explicitement.
//
// IMPORTANT : ce fichier ne fait QUE gérer la configuration. Il n'est consommé par aucun endpoint
// de distribution.controller.js à ce stade (Phase 2C, dédiée) — aucune case à cocher automatique
// n'est branchée ici.
const db = require('../config/db.config');

const SELECT_ENRICHI = `SELECT
    r.id, r.accessoire_id, a.nom AS accessoire_nom, a.categorie_id, c.nom AS categorie_nom,
    r.annee_academique_id, aa.annee AS annee_academique,
    r.niveau_libelle, r.tous_niveaux, r.quantite_standard, r.actif,
    r.cree_par, ucr.nom AS cree_par_nom, r.modifie_par, umo.nom AS modifie_par_nom,
    r.created_at, r.updated_at
  FROM regle_distribution_accessoire r
  JOIN accessoire a ON a.id = r.accessoire_id
  LEFT JOIN categorie_accessoire c ON c.id = a.categorie_id
  JOIN anneeacademique aa ON aa.id = r.annee_academique_id
  LEFT JOIN utilisateur ucr ON ucr.id = r.cree_par
  LEFT JOIN utilisateur umo ON umo.id = r.modifie_par`;

// Seul un accessoire distribuable aux étudiants peut recevoir une règle — vérifié ici, jamais
// laissé au seul frontend (un appel direct à l'API doit être refusé tout autant qu'un clic UI).
async function validerAccessoireDistribuable(accessoireId) {
  const id = parseInt(accessoireId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Accessoire invalide.' };
  const result = await db.query('SELECT id, distribuable_etudiant FROM accessoire WHERE id = $1', [id]);
  if (result.rows.length === 0) return { ok: false, message: 'Accessoire introuvable.' };
  if (!result.rows[0].distribuable_etudiant) {
    return { ok: false, message: 'Cet accessoire n\'est pas distribuable aux étudiants — aucune règle de distribution ne peut lui être affectée.' };
  }
  return { ok: true, valeur: id };
}

async function validerAnneeAcademique(anneeAcademiqueId) {
  const id = parseInt(anneeAcademiqueId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Année académique invalide.' };
  const result = await db.query('SELECT id FROM anneeacademique WHERE id = $1', [id]);
  if (result.rows.length === 0) return { ok: false, message: 'Année académique introuvable.' };
  return { ok: true, valeur: id };
}

// Le libellé doit correspondre à au moins une ligne niveau réellement rattachée à cette année
// académique — quelle que soit la filière (audit §12 : une règle par libellé couvre toutes les
// filières partageant ce libellé, jamais une ligne par filière).
async function validerNiveauLibelle(niveauLibelle, anneeAcademiqueId) {
  const libelle = typeof niveauLibelle === 'string' ? niveauLibelle.trim().toUpperCase() : '';
  if (!libelle) return { ok: false, message: 'Le libellé du niveau est requis.' };
  const result = await db.query(
    'SELECT 1 FROM niveau WHERE UPPER(TRIM(libelle)) = $1 AND anneeacademique_id = $2 LIMIT 1',
    [libelle, anneeAcademiqueId]
  );
  if (result.rows.length === 0) {
    return { ok: false, message: `Aucun niveau « ${libelle} » n'existe pour cette année académique.` };
  }
  return { ok: true, valeur: libelle };
}

exports.getRegles = async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.annee_academique_id) {
      params.push(parseInt(req.query.annee_academique_id, 10));
      conditions.push(`r.annee_academique_id = $${params.length}`);
    }
    if (req.query.accessoire_id) {
      params.push(parseInt(req.query.accessoire_id, 10));
      conditions.push(`r.accessoire_id = $${params.length}`);
    }
    if (req.query.actif === 'true' || req.query.actif === 'false') {
      params.push(req.query.actif === 'true');
      conditions.push(`r.actif = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
      `${SELECT_ENRICHI} ${where} ORDER BY aa.annee DESC, a.nom, r.niveau_libelle NULLS FIRST`,
      params
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getRegles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getRegleById = async (req, res) => {
  try {
    const result = await db.query(`${SELECT_ENRICHI} WHERE r.id = $1`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Règle introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur getRegleById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Peuple les cases à cocher « Niveaux » du formulaire de règle pour l'année sélectionnée — mêmes
// libellés que validerNiveauLibelle, sans dupliquer une ligne par filière (audit §12).
exports.getNiveauxDisponibles = async (req, res) => {
  try {
    const anneeAcademiqueId = parseInt(req.query.annee_academique_id, 10);
    if (Number.isNaN(anneeAcademiqueId)) {
      return res.status(400).json({ success: false, message: 'annee_academique_id est requis.' });
    }
    const result = await db.query(
      'SELECT DISTINCT libelle FROM niveau WHERE anneeacademique_id = $1 ORDER BY libelle',
      [anneeAcademiqueId]
    );
    res.status(200).json({ success: true, data: result.rows.map((r) => r.libelle) });
  } catch (error) {
    console.error('Erreur getNiveauxDisponibles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Crée une ou plusieurs règles en un seul appel : soit une unique ligne « tous les niveaux », soit
// une ligne par niveau sélectionné (jamais l'inverse — cf. règle explicite §5). Transactionnel :
// si un seul niveau demandé est invalide ou fait déjà l'objet d'une règle, rien n'est créé.
exports.creerRegles = async (req, res) => {
  const client = await db.connect();
  try {
    const { accessoire_id, annee_academique_id, tous_niveaux, niveaux, quantite_standard } = req.body;

    const accessoire = await validerAccessoireDistribuable(accessoire_id);
    if (!accessoire.ok) return res.status(400).json({ success: false, message: accessoire.message });
    const annee = await validerAnneeAcademique(annee_academique_id);
    if (!annee.ok) return res.status(400).json({ success: false, message: annee.message });

    const quantite = quantite_standard !== undefined && quantite_standard !== null ? parseInt(quantite_standard, 10) : 1;
    if (Number.isNaN(quantite) || quantite <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité standard doit être un entier strictement positif.' });
    }

    const estTousNiveaux = tous_niveaux === true;
    let libellesAInserer = [];
    if (!estTousNiveaux) {
      if (!Array.isArray(niveaux) || niveaux.length === 0) {
        return res.status(400).json({ success: false, message: 'Sélectionnez au moins un niveau, ou choisissez « Tous les niveaux ».' });
      }
      for (const niveauLibelle of niveaux) {
        const niveau = await validerNiveauLibelle(niveauLibelle, annee.valeur);
        if (!niveau.ok) return res.status(400).json({ success: false, message: niveau.message });
        libellesAInserer.push(niveau.valeur);
      }
      libellesAInserer = [...new Set(libellesAInserer)];
    }

    await client.query('BEGIN');

    const idsCrees = [];
    if (estTousNiveaux) {
      const existant = await client.query(
        `SELECT 1 FROM regle_distribution_accessoire
         WHERE accessoire_id = $1 AND annee_academique_id = $2 AND tous_niveaux = true`,
        [accessoire.valeur, annee.valeur]
      );
      if (existant.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Une règle « Tous les niveaux » existe déjà pour cet accessoire et cette année.' });
      }
      const inserted = await client.query(
        `INSERT INTO regle_distribution_accessoire (accessoire_id, annee_academique_id, tous_niveaux, quantite_standard, cree_par)
         VALUES ($1, $2, true, $3, $4) RETURNING id`,
        [accessoire.valeur, annee.valeur, quantite, req.user.id]
      );
      idsCrees.push(inserted.rows[0].id);
    } else {
      for (const niveauLibelle of libellesAInserer) {
        const existant = await client.query(
          `SELECT 1 FROM regle_distribution_accessoire
           WHERE accessoire_id = $1 AND annee_academique_id = $2 AND niveau_libelle = $3 AND tous_niveaux = false`,
          [accessoire.valeur, annee.valeur, niveauLibelle]
        );
        if (existant.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, message: `Une règle existe déjà pour « ${niveauLibelle} » sur cet accessoire et cette année.` });
        }
        const inserted = await client.query(
          `INSERT INTO regle_distribution_accessoire (accessoire_id, annee_academique_id, niveau_libelle, tous_niveaux, quantite_standard, cree_par)
           VALUES ($1, $2, $3, false, $4, $5) RETURNING id`,
          [accessoire.valeur, annee.valeur, niveauLibelle, quantite, req.user.id]
        );
        idsCrees.push(inserted.rows[0].id);
      }
    }

    await client.query('COMMIT');
    const enrichi = await db.query(
      `${SELECT_ENRICHI} WHERE r.id = ANY($1::int[]) ORDER BY r.niveau_libelle NULLS FIRST`,
      [idsCrees]
    );
    res.status(201).json({ success: true, data: enrichi.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Une règle identique existe déjà pour cet accessoire, cette année et ce niveau.' });
    }
    console.error('Erreur creerRegles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// Seule la quantité standard est modifiable après création (§6). Changer l'accessoire, l'année ou
// le(s) niveau(x) d'une règle revient à en créer une autre — désactiver l'ancienne (PATCH
// .../activation) plutôt que de la « renommer » silencieusement.
exports.modifierQuantiteRegle = async (req, res) => {
  try {
    const { id } = req.params;
    const quantite = parseInt(req.body.quantite_standard, 10);
    if (Number.isNaN(quantite) || quantite <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité standard doit être un entier strictement positif.' });
    }
    const result = await db.query(
      `UPDATE regle_distribution_accessoire SET quantite_standard = $1, modifie_par = $2, updated_at = now() WHERE id = $3 RETURNING id`,
      [quantite, req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Règle introuvable.' });
    }
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE r.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    console.error('Erreur modifierQuantiteRegle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setActivationRegle = async (req, res) => {
  try {
    const { id } = req.params;
    const { actif } = req.body;
    if (typeof actif !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Le champ actif (booléen) est requis.' });
    }
    const result = await db.query(
      `UPDATE regle_distribution_accessoire SET actif = $1, modifie_par = $2, updated_at = now() WHERE id = $3 RETURNING id`,
      [actif, req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Règle introuvable.' });
    }
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE r.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    console.error('Erreur setActivationRegle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
