// Module Gestion des Enseignants (2026-08-11) — emploi du temps du Chargé Pédagogique (§3.1).
//
// Distinct de l'ancien controllers/EDT.controller.js, qui ne gère que l'upload d'un PDF
// d'emploi du temps par groupe : ici l'emploi du temps est une donnée structurée
// (trame récurrente → séances datées → salle allouée), seule forme permettant le
// contrôle de disponibilité exigé par le cahier des charges.
const db = require('../config/db.config');
const {
  datesDeLaTrame,
  detecterConflits,
  sallesAvecDisponibilite,
  verifierContractualisation,
} = require('../services/edtPlanification.service');
const { verifierClasseDansPerimetre, clausePerimetre } = require('../services/perimetreCP.service');

// Code PostgreSQL d'une violation de contrainte d'exclusion : ici, toujours
// seance_salle_sans_chevauchement (la salle vient d'être prise par quelqu'un d'autre).
const EXCLUSION_VIOLATION = '23P01';

// ---------------------------------------------------------------------------
//  Trames (maquette théorique)
// ---------------------------------------------------------------------------

exports.getTrames = async (req, res) => {
  try {
    const { classe_id, annee_id } = req.query;
    const perim = clausePerimetre(req, 'c.filiere_id', 'c.niveau_id', 3);

    const result = await db.query(
      `SELECT t.*, c.nom AS classe, m.nom AS matiere, f.nom AS filiere, n.libelle AS niveau,
              e.nom AS enseignant_nom, e.prenoms AS enseignant_prenoms,
              (SELECT COUNT(*)::int FROM seance_edt s WHERE s.trame_id = t.id AND s.statut <> 'annulee') AS nb_seances,
              (SELECT COUNT(*)::int FROM seance_edt s WHERE s.trame_id = t.id AND s.statut <> 'annulee' AND s.salle_id IS NULL) AS nb_sans_salle
       FROM trame_edt t
       JOIN classe c ON c.id = t.classe_id
       LEFT JOIN filiere f ON f.id = c.filiere_id
       LEFT JOIN niveau n ON n.id = c.niveau_id
       LEFT JOIN matiere m ON m.id = t.matiere_id
       LEFT JOIN enseignant e ON e.id = t.enseignant_id
       WHERE t.statut = 'active'
         AND ($1::int IS NULL OR t.classe_id = $1)
         AND ($2::int IS NULL OR t.annee_academique_id = $2)
       ${perim.clause}
       ORDER BY t.jour_semaine, t.heure_debut`,
      [classe_id || null, annee_id || null, ...perim.params]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getTrames:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Création d'un créneau de la maquette : la trame est enregistrée puis matérialisée en
 * séances datées, sans salle (« sans affectation immédiate de salles physiques »).
 * Les conflits classe/enseignant sont signalés séance par séance ; les dates en conflit
 * sont ignorées et retournées à l'appelant plutôt que de faire échouer toute la trame —
 * une trame d'un semestre ne doit pas être perdue à cause d'un seul jour férié planifié.
 */
exports.createTrame = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      annee_academique_id, classe_id, matiere_id, enseignant_id, intitule,
      jour_semaine, heure_debut, heure_fin, type_seance, date_debut, date_fin, frequence,
    } = req.body;

    if (!annee_academique_id || !classe_id || !jour_semaine || !heure_debut || !heure_fin || !date_debut || !date_fin) {
      return res.status(400).json({
        success: false,
        message: 'Année, classe, jour, horaires et période sont obligatoires.',
      });
    }
    if (heure_fin <= heure_debut) {
      return res.status(400).json({ success: false, message: "L'heure de fin doit suivre l'heure de début." });
    }

    const horsPerimetre = await verifierClasseDansPerimetre(req, classe_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    await client.query('BEGIN');

    if (enseignant_id) {
      const refus = await verifierContractualisation(client, enseignant_id, classe_id, annee_academique_id);
      if (refus) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: refus });
      }
    }

    const trame = await client.query(
      `INSERT INTO trame_edt
         (annee_academique_id, classe_id, matiere_id, enseignant_id, intitule, jour_semaine,
          heure_debut, heure_fin, type_seance, date_debut, date_fin, frequence, cree_par)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'CM'), $10, $11, COALESCE($12, 'hebdomadaire'), $13)
       RETURNING *`,
      [
        annee_academique_id, classe_id, matiere_id || null, enseignant_id || null,
        intitule?.trim() || null, jour_semaine, heure_debut, heure_fin,
        type_seance || null, date_debut, date_fin, frequence || null, req.user.id,
      ]
    );

    const dates = datesDeLaTrame(trame.rows[0]);
    const creees = [];
    const ignorees = [];

    for (const date of dates) {
      const conflits = await detecterConflits(client, {
        classe_id, enseignant_id: enseignant_id || null,
        date_seance: date, heure_debut, heure_fin,
      });
      if (conflits.length > 0) {
        ignorees.push({ date, motifs: conflits });
        continue;
      }
      const seance = await client.query(
        `INSERT INTO seance_edt
           (trame_id, classe_id, matiere_id, enseignant_id, intitule, date_seance,
            heure_debut, heure_fin, type_seance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'CM'))
         RETURNING id, date_seance`,
        [
          trame.rows[0].id, classe_id, matiere_id || null, enseignant_id || null,
          intitule?.trim() || null, date, heure_debut, heure_fin, type_seance || null,
        ]
      );
      creees.push(seance.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: trame.rows[0],
      seances_creees: creees.length,
      seances_ignorees: ignorees,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur createTrame:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

/**
 * Modification d'une trame. Les séances déjà passées sont laissées telles quelles
 * (l'historique de ce qui s'est réellement tenu ne se réécrit pas) ; seules les séances
 * à venir sont régénérées.
 */
exports.updateTrame = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const {
      matiere_id, enseignant_id, intitule, jour_semaine, heure_debut, heure_fin,
      type_seance, date_debut, date_fin, frequence,
    } = req.body;

    await client.query('BEGIN');

    const existante = await client.query(`SELECT * FROM trame_edt WHERE id = $1 FOR UPDATE`, [id]);
    if (existante.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Trame introuvable.' });
    }
    const trameActuelle = existante.rows[0];

    const horsPerimetre = await verifierClasseDansPerimetre(req, trameActuelle.classe_id);
    if (horsPerimetre) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: horsPerimetre });
    }

    if (enseignant_id) {
      const refus = await verifierContractualisation(client, enseignant_id, trameActuelle.classe_id, trameActuelle.annee_academique_id);
      if (refus) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: refus });
      }
    }

    const maj = await client.query(
      `UPDATE trame_edt
       SET matiere_id = $1, enseignant_id = $2, intitule = $3, jour_semaine = COALESCE($4, jour_semaine),
           heure_debut = COALESCE($5, heure_debut), heure_fin = COALESCE($6, heure_fin),
           type_seance = COALESCE($7, type_seance), date_debut = COALESCE($8, date_debut),
           date_fin = COALESCE($9, date_fin), frequence = COALESCE($10, frequence), updated_at = now()
       WHERE id = $11 RETURNING *`,
      [
        matiere_id || null, enseignant_id || null, intitule?.trim() || null,
        jour_semaine || null, heure_debut || null, heure_fin || null, type_seance || null,
        date_debut || null, date_fin || null, frequence || null, id,
      ]
    );
    const trame = maj.rows[0];

    await client.query(
      `DELETE FROM seance_edt WHERE trame_id = $1 AND date_seance >= CURRENT_DATE`,
      [id]
    );

    const aujourdhui = new Date().toISOString().slice(0, 10);
    const dates = datesDeLaTrame(trame).filter((d) => d >= aujourdhui);
    const ignorees = [];
    let creees = 0;

    for (const date of dates) {
      const conflits = await detecterConflits(client, {
        classe_id: trame.classe_id, enseignant_id: trame.enseignant_id,
        date_seance: date, heure_debut: trame.heure_debut, heure_fin: trame.heure_fin,
        exclure_trame_id: trame.id,
      });
      if (conflits.length > 0) {
        ignorees.push({ date, motifs: conflits });
        continue;
      }
      await client.query(
        `INSERT INTO seance_edt
           (trame_id, classe_id, matiere_id, enseignant_id, intitule, date_seance,
            heure_debut, heure_fin, type_seance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          trame.id, trame.classe_id, trame.matiere_id, trame.enseignant_id, trame.intitule,
          date, trame.heure_debut, trame.heure_fin, trame.type_seance,
        ]
      );
      creees += 1;
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: trame, seances_creees: creees, seances_ignorees: ignorees });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur updateTrame:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

/** Annulation d'une trame : les séances à venir disparaissent, le passé est conservé. */
exports.annulerTrame = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const trame = await client.query(`SELECT classe_id FROM trame_edt WHERE id = $1`, [id]);
    if (trame.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Trame introuvable.' });
    }
    const horsPerimetre = await verifierClasseDansPerimetre(req, trame.rows[0].classe_id);
    if (horsPerimetre) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: horsPerimetre });
    }

    const supprimees = await client.query(
      `DELETE FROM seance_edt WHERE trame_id = $1 AND date_seance >= CURRENT_DATE RETURNING id`,
      [id]
    );
    await client.query(`UPDATE trame_edt SET statut = 'annulee', updated_at = now() WHERE id = $1`, [id]);

    await client.query('COMMIT');
    res.status(200).json({ success: true, seances_supprimees: supprimees.rowCount });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur annulerTrame:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
//  Séances datées
// ---------------------------------------------------------------------------

exports.getSeances = async (req, res) => {
  try {
    const { date_debut, date_fin, classe_id, enseignant_id, salle_id, sans_salle, annee_id } = req.query;
    if (!date_debut || !date_fin) {
      return res.status(400).json({ success: false, message: 'date_debut et date_fin sont requis.' });
    }

    const perim = clausePerimetre(req, 'c.filiere_id', 'c.niveau_id', 8);
    const result = await db.query(
      `SELECT s.id, s.trame_id, s.classe_id, s.matiere_id, s.enseignant_id, s.salle_id,
              s.intitule, s.date_seance, s.heure_debut, s.heure_fin, s.type_seance,
              s.statut, s.observations,
              c.nom AS classe, m.nom AS matiere,
              sa.code AS salle_code, sa.nom AS salle_nom, sa.capacite AS salle_capacite,
              e.nom AS enseignant_nom, e.prenoms AS enseignant_prenoms,
              f.nom AS filiere, n.libelle AS niveau
       FROM seance_edt s
       JOIN classe c ON c.id = s.classe_id
       LEFT JOIN filiere f ON f.id = c.filiere_id
       LEFT JOIN niveau n ON n.id = c.niveau_id
       LEFT JOIN matiere m ON m.id = s.matiere_id
       LEFT JOIN salle sa ON sa.id = s.salle_id
       LEFT JOIN enseignant e ON e.id = s.enseignant_id
       WHERE s.date_seance BETWEEN $1 AND $2
         AND ($3::int IS NULL OR s.classe_id = $3)
         AND ($4::int IS NULL OR s.enseignant_id = $4)
         AND ($5::int IS NULL OR s.salle_id = $5)
         AND ($6::boolean IS NOT TRUE OR s.salle_id IS NULL)
         AND ($7::int IS NULL OR c.annee_academique_id = $7)
       ${perim.clause}
       ORDER BY s.date_seance, s.heure_debut, c.nom`,
      [
        date_debut, date_fin, classe_id || null, enseignant_id || null, salle_id || null,
        sans_salle === 'true', annee_id || null, ...perim.params,
      ]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getSeances:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Séance ponctuelle, hors trame (rattrapage, examen, cours exceptionnel). */
exports.createSeance = async (req, res) => {
  const client = await db.connect();
  try {
    const {
      classe_id, matiere_id, enseignant_id, salle_id, intitule,
      date_seance, heure_debut, heure_fin, type_seance, observations,
    } = req.body;

    if (!classe_id || !date_seance || !heure_debut || !heure_fin) {
      return res.status(400).json({ success: false, message: 'Classe, date et horaires sont obligatoires.' });
    }
    if (heure_fin <= heure_debut) {
      return res.status(400).json({ success: false, message: "L'heure de fin doit suivre l'heure de début." });
    }

    const horsPerimetre = await verifierClasseDansPerimetre(req, classe_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    await client.query('BEGIN');

    if (enseignant_id) {
      const classe = await client.query(`SELECT annee_academique_id FROM classe WHERE id = $1`, [classe_id]);
      const refus = await verifierContractualisation(client, enseignant_id, classe_id, classe.rows[0]?.annee_academique_id);
      if (refus) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: refus });
      }
    }

    const conflits = await detecterConflits(client, {
      classe_id, enseignant_id: enseignant_id || null, date_seance, heure_debut, heure_fin,
    });
    if (conflits.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: conflits.join(' ') });
    }

    const result = await client.query(
      `INSERT INTO seance_edt
         (classe_id, matiere_id, enseignant_id, salle_id, intitule, date_seance,
          heure_debut, heure_fin, type_seance, observations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'CM'), $10)
       RETURNING *`,
      [
        classe_id, matiere_id || null, enseignant_id || null, salle_id || null,
        intitule?.trim() || null, date_seance, heure_debut, heure_fin,
        type_seance || null, observations?.trim() || null,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === EXCLUSION_VIOLATION) {
      return res.status(409).json({ success: false, message: 'Cette salle est déjà occupée sur ce créneau.' });
    }
    console.error('Erreur createSeance:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

/**
 * Allocation d'une salle à une séance — geste central du §3.1 « Allocation des salles ».
 * salle_id = null libère la salle.
 *
 * La collision est arbitrée par la contrainte d'exclusion en base : le pré-contrôle
 * ci-dessous ne sert qu'à produire un message utile (qui occupe la salle), pas à
 * garantir l'unicité — deux CP peuvent cliquer au même instant.
 */
exports.affecterSalle = async (req, res) => {
  try {
    const { id } = req.params;
    const { salle_id } = req.body;

    const seance = await db.query(
      `SELECT s.*, c.filiere_id, c.niveau_id FROM seance_edt s
       JOIN classe c ON c.id = s.classe_id WHERE s.id = $1`,
      [id]
    );
    if (seance.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Séance introuvable.' });
    }
    const horsPerimetre = await verifierClasseDansPerimetre(req, seance.rows[0].classe_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    if (salle_id) {
      const occupee = await db.query(
        `SELECT c.nom AS classe, m.nom AS matiere, s.heure_debut, s.heure_fin
         FROM seance_edt s
         JOIN classe c ON c.id = s.classe_id
         LEFT JOIN matiere m ON m.id = s.matiere_id
         WHERE s.salle_id = $1 AND s.date_seance = $2
           AND s.heure_debut < $3 AND s.heure_fin > $4
           AND s.statut <> 'annulee' AND s.id <> $5
         LIMIT 1`,
        [salle_id, seance.rows[0].date_seance, seance.rows[0].heure_fin, seance.rows[0].heure_debut, id]
      );
      if (occupee.rows.length > 0) {
        const o = occupee.rows[0];
        return res.status(409).json({
          success: false,
          message: `Salle déjà occupée sur ce créneau par ${o.classe}${o.matiere ? ` — ${o.matiere}` : ''} (${o.heure_debut.slice(0, 5)}–${o.heure_fin.slice(0, 5)}).`,
        });
      }
    }

    const result = await db.query(
      `UPDATE seance_edt SET salle_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [salle_id || null, id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      return res.status(409).json({
        success: false,
        message: "Cette salle vient d'être réservée sur ce créneau. Actualisez la liste des salles disponibles.",
      });
    }
    console.error('Erreur affecterSalle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Allocation en lot : le CP alloue « à la semaine », donc traiter les séances une par
 * une serait un clic par cours. Les séances en conflit sont rapportées individuellement
 * au lieu de faire échouer tout le lot.
 */
exports.affecterSalleEnLot = async (req, res) => {
  const client = await db.connect();
  try {
    const { seance_ids, salle_id } = req.body;
    if (!Array.isArray(seance_ids) || seance_ids.length === 0 || !salle_id) {
      return res.status(400).json({ success: false, message: 'Sélectionnez au moins une séance et une salle.' });
    }

    const reussies = [];
    const echouees = [];

    for (const seanceId of seance_ids) {
      try {
        await client.query('BEGIN');
        const seance = await client.query(`SELECT classe_id FROM seance_edt WHERE id = $1`, [seanceId]);
        if (seance.rows.length === 0) {
          await client.query('ROLLBACK');
          echouees.push({ id: seanceId, motif: 'Séance introuvable.' });
          continue;
        }
        const horsPerimetre = await verifierClasseDansPerimetre(req, seance.rows[0].classe_id);
        if (horsPerimetre) {
          await client.query('ROLLBACK');
          echouees.push({ id: seanceId, motif: horsPerimetre });
          continue;
        }
        await client.query(
          `UPDATE seance_edt SET salle_id = $1, updated_at = now() WHERE id = $2`,
          [salle_id, seanceId]
        );
        await client.query('COMMIT');
        reussies.push(seanceId);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        echouees.push({
          id: seanceId,
          motif: error.code === EXCLUSION_VIOLATION
            ? 'Salle déjà occupée sur ce créneau.'
            : 'Erreur lors de l\'affectation.',
        });
      }
    }

    res.status(200).json({ success: true, affectees: reussies.length, echecs: echouees });
  } catch (error) {
    console.error('Erreur affecterSalleEnLot:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.updateSeance = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { matiere_id, enseignant_id, intitule, heure_debut, heure_fin, type_seance, statut, observations } = req.body;

    await client.query('BEGIN');
    const existante = await client.query(
      `SELECT s.*, c.annee_academique_id FROM seance_edt s
       JOIN classe c ON c.id = s.classe_id WHERE s.id = $1 FOR UPDATE OF s`,
      [id]
    );
    if (existante.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Séance introuvable.' });
    }
    const seance = existante.rows[0];

    const horsPerimetre = await verifierClasseDansPerimetre(req, seance.classe_id);
    if (horsPerimetre) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: horsPerimetre });
    }

    const nouveauDebut = heure_debut || seance.heure_debut;
    const nouvelleFin = heure_fin || seance.heure_fin;
    if (nouvelleFin <= nouveauDebut) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: "L'heure de fin doit suivre l'heure de début." });
    }

    if (enseignant_id && enseignant_id !== seance.enseignant_id) {
      const refus = await verifierContractualisation(client, enseignant_id, seance.classe_id, seance.annee_academique_id);
      if (refus) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: refus });
      }
    }

    const conflits = await detecterConflits(client, {
      classe_id: seance.classe_id,
      enseignant_id: enseignant_id ?? seance.enseignant_id,
      date_seance: seance.date_seance,
      heure_debut: nouveauDebut,
      heure_fin: nouvelleFin,
      exclure_seance_id: Number(id),
    });
    if (conflits.length > 0 && statut !== 'annulee') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: conflits.join(' ') });
    }

    const result = await client.query(
      `UPDATE seance_edt
       SET matiere_id = $1, enseignant_id = $2, intitule = $3,
           heure_debut = $4, heure_fin = $5,
           type_seance = COALESCE($6, type_seance), statut = COALESCE($7, statut),
           observations = $8, updated_at = now()
       WHERE id = $9 RETURNING *`,
      [
        matiere_id ?? seance.matiere_id, enseignant_id ?? seance.enseignant_id,
        intitule?.trim() ?? seance.intitule, nouveauDebut, nouvelleFin,
        type_seance || null, statut || null, observations?.trim() ?? seance.observations, id,
      ]
    );

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === EXCLUSION_VIOLATION) {
      return res.status(409).json({ success: false, message: 'La salle affectée est occupée sur le nouveau créneau.' });
    }
    console.error('Erreur updateSeance:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.supprimerSeance = async (req, res) => {
  try {
    const { id } = req.params;
    const seance = await db.query(`SELECT classe_id FROM seance_edt WHERE id = $1`, [id]);
    if (seance.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Séance introuvable.' });
    }
    const horsPerimetre = await verifierClasseDansPerimetre(req, seance.rows[0].classe_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    await db.query(`DELETE FROM seance_edt WHERE id = $1`, [id]);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erreur supprimerSeance:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Salles du site avec leur état d'occupation sur le créneau d'une séance donnée. */
exports.getSallesPourSeance = async (req, res) => {
  try {
    const { id } = req.params;
    const seance = await db.query(
      `SELECT date_seance, heure_debut, heure_fin FROM seance_edt WHERE id = $1`,
      [id]
    );
    if (seance.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Séance introuvable.' });
    }
    const { date_seance, heure_debut, heure_fin } = seance.rows[0];

    const data = await sallesAvecDisponibilite({
      site_id: req.query.site_id ? Number(req.query.site_id) : req.user?.departement_id,
      date_seance,
      heure_debut,
      heure_fin,
      exclure_seance_id: Number(id),
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Erreur getSallesPourSeance:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};
