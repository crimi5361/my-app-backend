// Outil d'administration "opérations exceptionnelles" — changement de filière, de parcours ou de
// cycle EN COURS D'ANNÉE (par opposition à la réinscription, qui opère toujours au passage d'une
// année académique à l'autre et reste historisée dans `historique_inscription`). Ces opérations
// ne touchent jamais l'année académique de l'étudiant ni `historique_inscription` — elles sont
// tracées séparément dans `historique_operations_admin` (migration 018).
const db = require('../config/db.config');
const { affecterClasse } = require('../services/classeGroupe.service');
const { resoudreFormationEtParcours } = require('../services/parcoursProfessionnel.service');
const { determinerChangementDeCycle } = require('./reinscription.controller');

// ─── Helper : situation complète d'un étudiant (position + scolarité + parcours) ──────────────
const chargerSituationEtudiant = async (dbClient, etudiantId) => {
  const r = await dbClient.query(`
    SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.standing, e.statut_scolaire,
           e.niveau_id, n.libelle AS niveau_libelle, n.ordre AS niveau_ordre,
           e.id_filiere, f.nom AS filiere_nom, f.sigle AS filiere_sigle, tf.libelle AS type_filiere_libelle,
           e.curcus_id, cu.type_parcours,
           e.groupe_id, g.nom AS groupe_nom, c.id AS classe_id, c.nom AS classe_nom,
           e.scolarite_id, s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant AS statut_paiement,
           e.annee_academique_id, a.annee
    FROM etudiant e
    JOIN niveau n ON n.id = e.niveau_id
    JOIN filiere f ON f.id = e.id_filiere
    LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
    LEFT JOIN curcus cu ON cu.id = e.curcus_id
    LEFT JOIN groupe g ON g.id = e.groupe_id
    LEFT JOIN classe c ON c.id = g.classe_id
    LEFT JOIN scolarite s ON s.id = e.scolarite_id
    JOIN anneeacademique a ON a.id = e.annee_academique_id
    WHERE e.id = $1
  `, [etudiantId]);
  return r.rows[0] || null;
};

// ─── Helper : snapshot des champs suivis par l'audit (jsonb anciennes_valeurs/nouvelles_valeurs) ──
const snapshotPourAudit = (situation) => ({
  id_filiere: situation.id_filiere, filiere_nom: situation.filiere_nom,
  niveau_id: situation.niveau_id, niveau_libelle: situation.niveau_libelle,
  curcus_id: situation.curcus_id, type_parcours: situation.type_parcours,
  groupe_id: situation.groupe_id, classe_id: situation.classe_id, classe_nom: situation.classe_nom,
  scolarite_id: situation.scolarite_id, montant_scolarite: situation.montant_scolarite,
  scolarite_verse: situation.scolarite_verse, scolarite_restante: situation.scolarite_restante,
  statut_scolaire: situation.statut_scolaire,
});

const enregistrerOperation = async (dbClient, { etudiantId, typeOperation, anciennesValeurs, nouvellesValeurs, motif, utilisateurId }) => {
  await dbClient.query(`
    INSERT INTO historique_operations_admin (etudiant_id, type_operation, anciennes_valeurs, nouvelles_valeurs, motif, utilisateur_id)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [etudiantId, typeOperation, JSON.stringify(anciennesValeurs), JSON.stringify(nouvellesValeurs), motif, utilisateurId]);
};

// ─── GET situation actuelle d'un étudiant (fiche de départ des 3 opérations) ───────────────────
exports.getSituationEtudiant = async (req, res) => {
  try {
    const situation = await chargerSituationEtudiant(db, req.params.id);
    if (!situation) return res.status(404).json({ message: 'Étudiant introuvable.' });
    res.status(200).json({ success: true, data: situation });
  } catch (error) {
    console.error('Erreur getSituationEtudiant:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET historique des opérations administratives d'un étudiant ──────────────────────────────
exports.getHistoriqueOperations = async (req, res) => {
  try {
    const r = await db.query(`
      SELECT h.id, h.type_operation, h.anciennes_valeurs, h.nouvelles_valeurs, h.motif, h.created_at,
             u.nom AS utilisateur_nom
      FROM historique_operations_admin h
      LEFT JOIN utilisateur u ON u.id = h.utilisateur_id
      WHERE h.etudiant_id = $1
      ORDER BY h.created_at DESC
    `, [req.params.id]);
    res.status(200).json({ success: true, data: r.rows });
  } catch (error) {
    console.error('Erreur getHistoriqueOperations:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── POST simulation d'un changement de niveau/filière/parcours — AUCUNE écriture ──────────────
// Réutilisée par le changement de filière ET le changement de cycle (même calcul sous-jacent :
// étant donné un niveau cible + un parcours, quel est le statut scolaire par défaut, le tarif
// applicable, la classe cible ?). Le statut proposé n'est JAMAIS imposé : c'est une suggestion
// affichée à l'administrateur, qui reste libre de la modifier avant validation (voir changerCycle
// / changerFiliere, qui exigent le statut EXPLICITEMENT dans le body, sans recalcul serveur).
exports.simulerChangement = async (req, res) => {
  try {
    const { id } = req.params;
    const { niveau_cible_id, curcus_id, statut_scolaire_force } = req.body;
    if (!niveau_cible_id) return res.status(400).json({ message: 'niveau_cible_id est requis.' });

    const situationActuelle = await chargerSituationEtudiant(db, id);
    if (!situationActuelle) return res.status(404).json({ message: 'Étudiant introuvable.' });

    const niveauCibleResult = await db.query(
      `SELECT n.id, n.libelle, n.filiere_id, n.anneeacademique_id, f.nom AS filiere_nom, f.sigle AS filiere_sigle
       FROM niveau n JOIN filiere f ON f.id = n.filiere_id WHERE n.id = $1`,
      [niveau_cible_id]
    );
    if (niveauCibleResult.rows.length === 0) return res.status(404).json({ message: 'Niveau cible introuvable.' });
    const niveauCible = niveauCibleResult.rows[0];

    if (niveauCible.anneeacademique_id !== situationActuelle.annee_academique_id) {
      return res.status(409).json({
        code: 'NIVEAU_ANNEE_INCORRECTE',
        message: `Le niveau "${niveauCible.libelle}" n'est pas configuré pour l'année académique de l'étudiant (${situationActuelle.annee}). Préparez d'abord cette filière depuis Gestion des filières.`
      });
    }

    const changementDeCycle = determinerChangementDeCycle({
      niveauActuelLibelle: situationActuelle.niveau_libelle,
      niveauRetenuLibelle: niveauCible.libelle,
      filiereActuelleId: situationActuelle.id_filiere,
      filiereRetenueId: niveauCible.filiere_id,
      orientationsValides: [],
    });

    const statutPropose = statut_scolaire_force || (changementDeCycle ? 'Non affecté' : situationActuelle.statut_scolaire);

    const resolution = await resoudreFormationEtParcours(db, {
      niveauId: niveau_cible_id, filiereId: niveauCible.filiere_id, curcusId: curcus_id || null, statutScolaire: statutPropose,
    });
    if (resolution.erreur) return res.status(resolution.erreur.status).json(resolution.erreur);

    const parcoursOptions = await db.query(
      `SELECT DISTINCT parcour FROM maquette WHERE niveau_id = $1 AND anneeacademique_id = $2 ORDER BY parcour`,
      [niveau_cible_id, niveauCible.anneeacademique_id]
    );

    const classeExistante = await db.query(
      `SELECT id, nom FROM classe WHERE filiere_id = $1 AND niveau_id = $2 AND annee_academique_id = $3 AND curcus_id IS NOT DISTINCT FROM $4`,
      [niveauCible.filiere_id, niveau_cible_id, niveauCible.anneeacademique_id, curcus_id || null]
    );

    res.status(200).json({
      success: true,
      data: {
        situation_actuelle: situationActuelle,
        niveau_cible: niveauCible,
        changement_de_cycle_detecte: changementDeCycle,
        statut_scolaire_propose: statutPropose,
        parcours_requis: resolution.parcoursRequis,
        parcours_disponibles: parcoursOptions.rows.map(r => r.parcour),
        tarif_propose: resolution.tarif,
        classe_cible: classeExistante.rows[0] ? { existe: true, ...classeExistante.rows[0] } : { existe: false },
      }
    });
  } catch (error) {
    console.error('Erreur simulerChangement:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── Helper interne commun : applique un changement de niveau/filière/parcours/statut, en
// recréant une scolarité (jamais de modification en place — même principe que la réinscription)
// UNIQUEMENT si le tarif change. Utilisé par changerFiliere et changerCycle (mêmes écritures,
// seul le type_operation et le champ obligatoire diffèrent).
const appliquerChangementPosition = async (client, { etudiantId, niveauCibleId, curcusId, statutScolaire, motif, utilisateurId, typeOperation }) => {
  const situationActuelle = await chargerSituationEtudiant(client, etudiantId);
  if (!situationActuelle) return { erreur: { status: 404, message: 'Étudiant introuvable.' } };
  if (situationActuelle.standing !== 'Inscrit') {
    return { erreur: { status: 409, message: `Cet étudiant n'est pas "Inscrit" (statut actuel : ${situationActuelle.standing}) — opération impossible.` } };
  }

  const niveauCibleResult = await client.query(
    `SELECT n.id, n.libelle, n.filiere_id, n.anneeacademique_id, f.nom AS filiere_nom, f.sigle AS filiere_sigle, f.type_filiere_id, tf.libelle AS type_filiere_libelle
     FROM niveau n JOIN filiere f ON f.id = n.filiere_id LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id WHERE n.id = $1`,
    [niveauCibleId]
  );
  if (niveauCibleResult.rows.length === 0) return { erreur: { status: 404, message: 'Niveau cible introuvable.' } };
  const niveauCible = niveauCibleResult.rows[0];

  if (niveauCible.anneeacademique_id !== situationActuelle.annee_academique_id) {
    return {
      erreur: {
        status: 409, code: 'NIVEAU_ANNEE_INCORRECTE',
        message: `Le niveau "${niveauCible.libelle}" n'est pas configuré pour l'année académique de l'étudiant (${situationActuelle.annee}).`
      }
    };
  }

  const resolution = await resoudreFormationEtParcours(client, {
    niveauId: niveauCibleId, filiereId: niveauCible.filiere_id, curcusId: curcusId || null, statutScolaire: statutScolaire,
  });
  if (resolution.erreur) return { erreur: resolution.erreur };

  let cursusLabel = null;
  if (curcusId) {
    const curcusRow = await client.query('SELECT type_parcours FROM curcus WHERE id = $1', [curcusId]);
    cursusLabel = curcusRow.rows[0]?.type_parcours || null;
  }

  const { classeId, groupePrimaireId } = await affecterClasse(client, {
    etudiantId, filiereNom: niveauCible.filiere_nom, filiereSigle: niveauCible.filiere_sigle,
    niveauLibelle: niveauCible.libelle, cursus: cursusLabel,
    curcusId: curcusId || null, anneeAcademiqueId: niveauCible.anneeacademique_id,
    filiereId: niveauCible.filiere_id, niveauId: niveauCibleId,
  });
  if (!groupePrimaireId) return { erreur: { status: 500, message: "Impossible de résoudre le groupe de la classe cible." } };

  const nouveauMontant = resolution.tarif.montant;
  const scolariteVerseActuelle = parseFloat(situationActuelle.scolarite_verse || 0);
  const tarifIdentique = parseFloat(situationActuelle.montant_scolarite || 0) === nouveauMontant && situationActuelle.niveau_id === niveauCibleId;

  let nouvelleScolariteId = situationActuelle.scolarite_id;
  if (!tarifIdentique) {
    const nouveauRestant = nouveauMontant - scolariteVerseActuelle;
    const nouveauStatutPaiement = Math.abs(nouveauRestant) < 0.01 ? 'SOLDE' : 'NON_SOLDE';
    const scolariteResult = await client.query(`
      INSERT INTO scolarite (montant_scolarite, scolarite_verse, scolarite_restante, statut_etudiant)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [nouveauMontant, scolariteVerseActuelle, nouveauRestant, nouveauStatutPaiement]);
    nouvelleScolariteId = scolariteResult.rows[0].id;
  }

  await client.query(`
    UPDATE etudiant SET id_filiere = $1, niveau_id = $2, groupe_id = $3, curcus_id = $4, scolarite_id = $5, statut_scolaire = $6
    WHERE id = $7
  `, [niveauCible.filiere_id, niveauCibleId, groupePrimaireId, curcusId || null, nouvelleScolariteId, statutScolaire, etudiantId]);

  const situationApres = await chargerSituationEtudiant(client, etudiantId);

  await enregistrerOperation(client, {
    etudiantId, typeOperation,
    anciennesValeurs: snapshotPourAudit(situationActuelle),
    nouvellesValeurs: snapshotPourAudit(situationApres),
    motif, utilisateurId,
  });

  return { situationApres, classeId };
};

// ─── POST changement de filière (même année académique) ───────────────────────────────────────
exports.changerFiliere = async (req, res) => {
  const { id } = req.params;
  const { niveau_cible_id, curcus_id, statut_scolaire, motif } = req.body;
  if (!niveau_cible_id || !statut_scolaire || !motif) {
    return res.status(400).json({ message: 'niveau_cible_id, statut_scolaire et motif sont requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const resultat = await appliquerChangementPosition(client, {
      etudiantId: id, niveauCibleId: niveau_cible_id, curcusId: curcus_id, statutScolaire: statut_scolaire,
      motif, utilisateurId: req.user?.id, typeOperation: 'changement_filiere',
    });
    if (resultat.erreur) {
      await client.query('ROLLBACK');
      return res.status(resultat.erreur.status).json(resultat.erreur);
    }
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Changement de filière effectué avec succès.', data: resultat.situationApres });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur changerFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ─── POST changement de cycle (le plus sensible — statut scolaire toujours explicite) ─────────
exports.changerCycle = async (req, res) => {
  const { id } = req.params;
  const { niveau_cible_id, curcus_id, statut_scolaire, motif } = req.body;
  if (!niveau_cible_id || !statut_scolaire || !motif) {
    return res.status(400).json({ message: 'niveau_cible_id, statut_scolaire et motif sont requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const resultat = await appliquerChangementPosition(client, {
      etudiantId: id, niveauCibleId: niveau_cible_id, curcusId: curcus_id, statutScolaire: statut_scolaire,
      motif, utilisateurId: req.user?.id, typeOperation: 'changement_cycle',
    });
    if (resultat.erreur) {
      await client.query('ROLLBACK');
      return res.status(resultat.erreur.status).json(resultat.erreur);
    }
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Changement de cycle effectué avec succès.', data: resultat.situationApres });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur changerCycle:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ─── POST changement de parcours (formations professionnelles uniquement, même niveau/filière) ─
// Ne touche jamais le niveau, la filière, ni la scolarité — uniquement curcus_id + classe/groupe.
exports.changerParcours = async (req, res) => {
  const { id } = req.params;
  const { nouveau_curcus_id, motif } = req.body;
  if (!nouveau_curcus_id || !motif) {
    return res.status(400).json({ message: 'nouveau_curcus_id et motif sont requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const situationActuelle = await chargerSituationEtudiant(client, id);
    if (!situationActuelle) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Étudiant introuvable.' }); }
    if (situationActuelle.standing !== 'Inscrit') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Cet étudiant n'est pas "Inscrit" (statut actuel : ${situationActuelle.standing}) — opération impossible.` });
    }
    if (situationActuelle.type_filiere_libelle !== 'Professionnelles') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Le changement de parcours est réservé aux formations professionnelles.' });
    }

    const curcusCheck = await client.query('SELECT id, type_parcours FROM curcus WHERE id = $1', [nouveau_curcus_id]);
    if (curcusCheck.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Parcours introuvable.' }); }

    const parcoursDisponible = await client.query(
      `SELECT 1 FROM maquette WHERE niveau_id = $1 AND anneeacademique_id = $2 AND parcour = $3`,
      [situationActuelle.niveau_id, situationActuelle.annee_academique_id, curcusCheck.rows[0].type_parcours]
    );
    if (parcoursDisponible.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Le parcours "${curcusCheck.rows[0].type_parcours}" n'est pas configuré pour ce niveau cette année.` });
    }

    const { groupePrimaireId } = await affecterClasse(client, {
      etudiantId: id, filiereNom: situationActuelle.filiere_nom, filiereSigle: situationActuelle.filiere_sigle,
      niveauLibelle: situationActuelle.niveau_libelle, cursus: curcusCheck.rows[0].type_parcours,
      curcusId: nouveau_curcus_id, anneeAcademiqueId: situationActuelle.annee_academique_id,
      filiereId: situationActuelle.id_filiere, niveauId: situationActuelle.niveau_id,
    });
    if (!groupePrimaireId) { await client.query('ROLLBACK'); return res.status(500).json({ message: 'Impossible de résoudre le groupe de la classe cible.' }); }

    await client.query('UPDATE etudiant SET curcus_id = $1, groupe_id = $2 WHERE id = $3', [nouveau_curcus_id, groupePrimaireId, id]);

    const situationApres = await chargerSituationEtudiant(client, id);
    await enregistrerOperation(client, {
      etudiantId: id, typeOperation: 'changement_parcours',
      anciennesValeurs: snapshotPourAudit(situationActuelle),
      nouvellesValeurs: snapshotPourAudit(situationApres),
      motif, utilisateurId: req.user?.id,
    });

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Changement de parcours effectué avec succès.', data: situationApres });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur changerParcours:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
