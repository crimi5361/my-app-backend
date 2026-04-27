const db = require('../config/db.config');

exports.createPaiement = async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    const { etudiant_id, montant, methode, veut_kit_ecole, demande_pec, type_pec, pourcentage_reduction, reference_pec } = req.body;
    const userId = req.user.id;
    const userCode = req.user.code;
    const date_paiement = new Date();
    const kitAmount = 5000;

    // Validation des données d'entrée
    if (!etudiant_id || !montant || !methode) {
      throw new Error('Données manquantes: etudiant_id, montant et methode sont requis');
    }

    if (isNaN(parseFloat(montant)) || parseFloat(montant) <= 0) {
      throw new Error('Le montant doit être un nombre positif');
    }

    // Vérifier l'existence de kit et PEC active
    const [kitResult, pecResult] = await Promise.all([
      client.query('SELECT * FROM kit WHERE etudiant_id = $1', [etudiant_id]),
      client.query(
        `SELECT * FROM prise_en_charge 
         WHERE etudiant_id = $1 AND statut = 'valide'`,
        [etudiant_id]
      )
    ]);

    const hasKit = kitResult.rows.length > 0;
    const hasActivePEC = pecResult.rows.length > 0;
    const pecActive = hasActivePEC ? pecResult.rows[0] : null;

    // 1. Vérifier si c'est le premier paiement
    const checkPremierPaiement = await client.query(
      'SELECT COUNT(*) FROM paiement WHERE etudiant_id = $1',
      [etudiant_id]
    );
    const isPremierPaiement = parseInt(checkPremierPaiement.rows[0].count) === 0;

    // Gestion du kit pour le premier paiement - TOUJOURS créer une entrée kit
    if (isPremierPaiement && !hasKit) {
      let kitMontant = 0;
      let kitDeposer = false;
      
      if (veut_kit_ecole) {
        // Cas 1: Case cochée - a payé le kit à l'école
        kitMontant = kitAmount;
        kitDeposer = true;
      }
      // Cas 2: Case non cochée - montant 0 et deposer false
      
      await client.query(
        `INSERT INTO kit (etudiant_id, montant, deposer, date_enregistrement)
         VALUES ($1, $2, $3, $4)`,
        [etudiant_id, kitMontant, kitDeposer, date_paiement]
      );
    }

    // Gestion de la demande de prise en charge
    if (demande_pec && !hasActivePEC) {
      if (!type_pec || !pourcentage_reduction) {
        throw new Error('Données manquantes pour la prise en charge: type_pec et pourcentage_reduction sont requis');
      }

      // Récupérer le montant de la scolarité pour calculer la réduction
      const scolariteResult = await client.query(
        'SELECT montant_scolarite FROM scolarite WHERE id IN (SELECT scolarite_id FROM etudiant WHERE id = $1)',
        [etudiant_id]
      );
      
      if (scolariteResult.rows.length === 0) {
        throw new Error('Scolarité non trouvée pour cet étudiant');
      }
      
      const montantScolarite = parseFloat(scolariteResult.rows[0].montant_scolarite);
      const montantReduction = (montantScolarite * pourcentage_reduction) / 100;

      await client.query(
        `INSERT INTO prise_en_charge 
         (etudiant_id, type_pec, pourcentage_reduction, montant_reduction, reference, statut, date_demande)
         VALUES ($1, $2, $3, $4, $5, 'en_attente', $6)`,
        [etudiant_id, type_pec, pourcentage_reduction, montantReduction, reference_pec || null, date_paiement]
      );
    }

    // 2. Créer le reçu avec un numéro unique
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuQuery = `
      INSERT INTO recu (
        numero_recu, date_emission, montant, emetteur
      ) VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const recuResult = await client.query(recuQuery, [
      numeroRecu,
      date_paiement,
      montant,
      userCode
    ]);
    const recuId = recuResult.rows[0].id;

    // 3. Enregistrement du paiement avec le reçu
    const paiementQuery = `
      INSERT INTO paiement (
        montant, date_paiement, methode, effectue_par, etudiant_id, recu_id
      ) VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING id
    `;
    const paiementResult = await client.query(paiementQuery, [
      montant,
      date_paiement,
      methode,
      userId,
      etudiant_id,
      recuId
    ]);

    // 4. Récupération des infos étudiant AVEC TYPE DE FILIERE
    const etudiantQuery = `
     SELECT 
        e.id, 
        e.curcus_id,
        c.type_parcours as cursus,
        f.nom as filiere, 
        f.sigle as filiere_sigle, 
        f.type_filiere_id,
        tf.libelle as type_filiere,
        n.libelle as niveau,
        s.scolarite_verse, 
        s.montant_scolarite,
        s.scolarite_restante, 
        s.id as scolarite_id,
        s.statut_etudiant,
        p.montant_reduction
      FROM etudiant e
	    JOIN curcus c ON e.curcus_id = c.id
      JOIN scolarite s ON e.scolarite_id = s.id
      JOIN filiere f ON e.id_filiere = f.id
      JOIN typefiliere tf ON f.type_filiere_id = tf.id
      JOIN niveau n ON e.niveau_id = n.id
      LEFT JOIN prise_en_charge p ON p.etudiant_id = e.id AND p.statut = 'valide'
      WHERE e.id = $1
    `;
    const etudiantResult = await client.query(etudiantQuery, [etudiant_id]);

    if (etudiantResult.rows.length === 0) {
      throw new Error('Étudiant non trouvé');
    }

    const etudiant = etudiantResult.rows[0];

    // 5. Calcul des nouvelles valeurs avec parseFloat
    const currentVerse = parseFloat(etudiant.scolarite_verse) || 0;
    const totalScolarite = parseFloat(etudiant.montant_scolarite) || 0;
    const montantPaye = parseFloat(montant);

    // Application de la réduction PEC si active
    let montantReductionPEC = 0;
    let currentRestante;
    
    if (hasActivePEC) {
      // LOGIQUE CORRECTE: Utiliser le montant_reduction de la PEC
      montantReductionPEC = parseFloat(etudiant.montant_reduction) || 0;
      
      // Calcul du restant selon votre logique: total - (verse + réduction)
      const totalVerseVirtuel = currentVerse + montantReductionPEC;
      currentRestante = totalScolarite - totalVerseVirtuel;
    } else {
      // Sans PEC, calcul normal
      if (etudiant.scolarite_restante === null || etudiant.scolarite_restante === undefined) {
        currentRestante = totalScolarite - currentVerse;
      } else {
        currentRestante = parseFloat(etudiant.scolarite_restante) || 0;
      }
    }

    const newScolariteVerse = currentVerse + montantPaye;
    
    // Calcul du nouveau restant selon la même logique
    let newScolariteRestante;
    if (hasActivePEC) {
      const totalVerseVirtuel = newScolariteVerse + montantReductionPEC;
      newScolariteRestante = totalScolarite - totalVerseVirtuel;
    } else {
      newScolariteRestante = currentRestante - montantPaye;
    }

    // Validation des montants
    if (newScolariteRestante < 0) {
      throw new Error('Le montant payé ne peut pas dépasser le montant total de la scolarité');
    }

    // Détermination du statut
    let statutEtudiant = 'NON_SOLDE';
    if (Math.abs(newScolariteRestante) < 0.01) {
      statutEtudiant = 'SOLDE';
    }

    // 6. Mise à jour de la scolarité
    await client.query(
      `UPDATE scolarite 
       SET scolarite_verse = $1, 
           scolarite_restante = $2, 
           statut_etudiant = $3
       WHERE id = $4`,
      [newScolariteVerse, newScolariteRestante, statutEtudiant, etudiant.scolarite_id]
    );

    // 7. Gestion spécifique pour le premier paiement - AVEC CAPACITÉ DYNAMIQUE
    if (isPremierPaiement) {
      const nomClasse = `${etudiant.filiere} ${etudiant.filiere_sigle} ${etudiant.niveau}`;
      const descriptionClass = `${etudiant.filiere} ${etudiant.filiere_sigle} ${etudiant.niveau}  ${etudiant.cursus}`;
      
      // Créer ou trouver la classe
      let classeResult = await client.query(
        'SELECT id FROM classe WHERE nom = $1', [nomClasse]
      );
      
      let classeId;
      if (classeResult.rows.length > 0) {
        classeId = classeResult.rows[0].id;
      } else {
        const newClasseResult = await client.query(
          `INSERT INTO classe (nom, description) 
           VALUES ($1, $2) RETURNING id`,
          [nomClasse, `Classe pour ${descriptionClass}`]
        );
        classeId = newClasseResult.rows[0].id;
      }

      // Déterminer la capacité maximale selon le type de filière
      let capaciteMax;
      switch(etudiant.type_filiere) {
        case 'Universitaire':
        case 'Classique':
          capaciteMax = 100;
          break;
        case 'Professionnelle':
        case 'Technique':
          capaciteMax = 50;
          break;
        default:
          capaciteMax = 50; // Valeur par défaut
      }

      // Trouver le dernier groupe disponible pour cette classe
      let groupeResult = await client.query(
        `SELECT g.id, g.nom, COUNT(e.id) as count_etudiants
         FROM groupe g 
         LEFT JOIN etudiant e ON e.groupe_id = g.id
         WHERE g.classe_id = $1 
         GROUP BY g.id, g.nom, g.capacite_max
         HAVING COUNT(e.id) < g.capacite_max
         ORDER BY g.nom
         LIMIT 1`,
        [classeId]
      );

      let groupeId;
      if (groupeResult.rows.length > 0) {
        // Groupe avec de la place disponible trouvé
        groupeId = groupeResult.rows[0].id;
      } else {
        // Aucun groupe avec de la place, créer un nouveau groupe
        const countGroupesResult = await client.query(
          `SELECT COUNT(*) as count_groupes FROM groupe WHERE classe_id = $1`,
          [classeId]
        );
        
        const numeroNouveauGroupe = parseInt(countGroupesResult.rows[0].count_groupes) + 1;
        const nomGroupe = `${nomClasse} Groupe ${numeroNouveauGroupe}`;
        
        const newGroupe = await client.query(
          `INSERT INTO groupe (nom, capacite_max, classe_id) 
           VALUES ($1, $2, $3) RETURNING id`,
          [nomGroupe, capaciteMax, classeId]
        );
        groupeId = newGroupe.rows[0].id;
      }

      // Assigner l'étudiant au groupe trouvé ou créé
      await client.query(
        `UPDATE etudiant SET groupe_id = $1, standing = 'Inscrit' WHERE id = $2`,
        [groupeId, etudiant_id]
      );
    }

    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      data: {
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuId,
        numero_recu: numeroRecu,
        scolarite_verse: newScolariteVerse,
        scolarite_restante: newScolariteRestante,
        statut_etudiant: statutEtudiant,
        is_premier_paiement: isPremierPaiement,
        kit_ajoute: isPremierPaiement && veut_kit_ecole,
        demande_pec_envoyee: demande_pec && !hasActivePEC,
        reduction_appliquee: hasActivePEC ? montantReductionPEC : 0,
        total_scolarite: totalScolarite,
        total_verse_virtuel: hasActivePEC ? newScolariteVerse + montantReductionPEC : newScolariteVerse,
        type_filiere: etudiant.type_filiere
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de l\'enregistrement du paiement:', error);
    
    res.status(error.message.includes('Données manquantes') ? 400 : 500).json({
      success: false,
      message: error.message || 'Erreur lors de l\'enregistrement du paiement'
    });
  } finally {
    client.release();
  }
};
// =========================================================NOUVEAU CONTRÔLEUR POUR LES DEMANDES PEC SANS PAIEMENT=========================================================================================
exports.demanderPECSeule = async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    const { etudiant_id, type_pec, pourcentage_reduction, reference_pec } = req.body;
    const date_demande = new Date();

    // Validation des données d'entrée
    if (!etudiant_id || !type_pec || !pourcentage_reduction) {
      throw new Error('Données manquantes: etudiant_id, type_pec et pourcentage_reduction sont requis');
    }

    if (isNaN(parseFloat(pourcentage_reduction)) || parseFloat(pourcentage_reduction) <= 0 || parseFloat(pourcentage_reduction) > 100) {
      throw new Error('Le pourcentage de réduction doit être un nombre entre 1 et 100');
    }

    // Vérifier s'il y a déjà une PEC active
    const pecActiveResult = await client.query(
      `SELECT * FROM prise_en_charge 
       WHERE etudiant_id = $1 AND statut = 'valide'`,
      [etudiant_id]
    );

    if (pecActiveResult.rows.length > 0) {
      throw new Error('Une prise en charge active existe déjà pour cet étudiant');
    }

    // Vérifier s'il y a déjà une PEC en attente
    const pecEnAttenteResult = await client.query(
      `SELECT * FROM prise_en_charge 
       WHERE etudiant_id = $1 AND statut = 'en_attente'`,
      [etudiant_id]
    );

    if (pecEnAttenteResult.rows.length > 0) {
      throw new Error('Une demande de prise en charge est déjà en attente pour cet étudiant');
    }

    // Récupérer le montant de la scolarité pour calculer la réduction
    const scolariteResult = await client.query(
      'SELECT montant_scolarite FROM scolarite WHERE id IN (SELECT scolarite_id FROM etudiant WHERE id = $1)',
      [etudiant_id]
    );
    
    if (scolariteResult.rows.length === 0) {
      throw new Error('Scolarité non trouvée pour cet étudiant');
    }
    
    const montantScolarite = parseFloat(scolariteResult.rows[0].montant_scolarite);
    const montantReduction = (montantScolarite * pourcentage_reduction) / 100;

    // Créer la demande de prise en charge AVEC le montant_reduction calculé
    const pecResult = await client.query(
      `INSERT INTO prise_en_charge 
       (etudiant_id, type_pec, pourcentage_reduction, montant_reduction, reference, statut, date_demande)
       VALUES ($1, $2, $3, $4, $5, 'en_attente', $6)
       RETURNING id`,
      [etudiant_id, type_pec, pourcentage_reduction, montantReduction, reference_pec || null, date_demande]
    );

    const pecId = pecResult.rows[0].id;

    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      message: 'Demande de prise en charge envoyée avec succès',
      data: {
        pec_id: pecId,
        date_demande: date_demande,
        montant_reduction: montantReduction,
        statut: 'en_attente'
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de la demande de prise en charge:', error);
    
    res.status(error.message.includes('Données manquantes') ? 400 : 500).json({
      success: false,
      message: error.message || 'Erreur lors de la demande de prise en charge'
    });
  } finally {
    client.release();
  }
};

// =========================================================NOUVEAU CONTRÔLEUR POUR LA VALIDATION DES PEC PAR L'ADMIN=========================================================================================
exports.validerPEC = async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    const { pec_id, action, motif_refus } = req.body;
    const adminId = req.user.id;

    if (!pec_id || !action) {
      throw new Error('Données manquantes: pec_id et action sont requis');
    }

    // Récupérer la PEC avec les informations complètes
    const pecResult = await client.query(
      `SELECT 
         p.id,
         p.etudiant_id,
         p.type_pec,
         p.pourcentage_reduction,
         p.montant_reduction,
         p.statut,
         p.reference,
         p.date_demande,
         s.montant_scolarite, 
         s.scolarite_verse, 
         s.scolarite_restante,
         s.id as scolarite_id,
         s.statut_etudiant, 
         s.prise_en_charge_id
       FROM prise_en_charge p
       JOIN etudiant e ON p.etudiant_id = e.id
       JOIN scolarite s ON e.scolarite_id = s.id
       WHERE p.id = $1`,
      [pec_id]
    );

    if (pecResult.rows.length === 0) {
      throw new Error('Prise en charge non trouvée');
    }

    const pec = pecResult.rows[0];

    if (pec.statut !== 'en_attente') {
      throw new Error('Cette prise en charge a déjà été traitée');
    }

    let reduction = 0;
    let nouveauVerse = 0;
    let nouveauRestant = 0;
    let nouveauStatutEtudiant = 'NON_SOLDE';

    if (action === 'valider') {
      // UTILISER le montant_reduction stocké dans la table
      reduction = parseFloat(pec.montant_reduction) || 0;
      const scolariteVerse = parseFloat(pec.scolarite_verse) || 0;
      const montantScolarite = parseFloat(pec.montant_scolarite) || 0;
      
      // LOGIQUE CORRECTE: La réduction s'ajoute VIRTUELLEMENT au montant versé
      // pour le calcul du restant, mais on ne modifie PAS scolarite_verse
      const totalVerseVirtuel = scolariteVerse + reduction;
      
      // Calcul du nouveau restant selon votre logique
      nouveauRestant = montantScolarite - totalVerseVirtuel;
      
      if (nouveauRestant < 0) {
        throw new Error('La réduction dépasse le montant total de la scolarité');
      }

      // Déterminer le nouveau statut
      if (Math.abs(nouveauRestant) < 0.01) {
        nouveauStatutEtudiant = 'SOLDE';
      }

      // Mettre à jour la scolarité - NE PAS modifier scolarite_verse
      // Seulement mettre à jour scolarite_restante et le statut
      await client.query(
        `UPDATE scolarite 
         SET scolarite_restante = $1, 
             statut_etudiant = $2, 
             prise_en_charge_id = $3
         WHERE id = $4`,
        [nouveauRestant, nouveauStatutEtudiant, pec_id, pec.scolarite_id]
      );

      // Marquer la PEC comme validée
      await client.query(
        `UPDATE prise_en_charge 
         SET statut = 'valide', 
             date_validation = $1, 
             valide_par = $2
         WHERE id = $3`,
        [new Date(), adminId, pec_id]
      );

      // Pour la réponse, on garde les valeurs calculées
      nouveauVerse = scolariteVerse; // Le montant versé réel ne change pas

    // Dans validerPEC, modifiez la partie refus :
} else if (action === 'refuser') {
  // Utiliser le motif fourni ou un motif par défaut
  const motifFinal = motif_refus || "Plus de prise en charge disponible";
  
  await client.query(
    `UPDATE prise_en_charge 
     SET statut = 'refuse', 
         date_validation = $1, 
         valide_par = $2, 
         motif_refus = $3
     WHERE id = $4`,
    [new Date(), adminId, motifFinal, pec_id]
  );

    } else {
      throw new Error('Action non valide: doit être "valider" ou "refuser"');
    }

    await client.query('COMMIT');
    
    // Préparer la réponse selon l'action
    const responseData = {
      success: true,
      message: action === 'valider' ? 'PEC validée avec succès' : 'PEC refusée avec succès'
    };

    // Ajouter les données supplémentaires seulement pour la validation
    if (action === 'valider') {
      responseData.data = {
        montant_reduction: reduction,
        montant_verse_reel: nouveauVerse, // Montant réellement versé (inchangé)
        montant_verse_virtuel: nouveauVerse + reduction, // Montant versé + réduction
        nouveau_montant_restant: nouveauRestant,
        nouveau_statut: nouveauStatutEtudiant
      };
    }

    res.json(responseData);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de la validation PEC:', error);
    
    res.status(error.message.includes('Données manquantes') ? 400 : 500).json({
      success: false,
      message: error.message || 'Erreur lors de la validation de la prise en charge'
    });
  } finally {
    client.release();
  }
};

//==============================================================================
exports.getPaiementCountByEtudiant = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    const countResult = await client.query(
      'SELECT COUNT(*) FROM paiement WHERE etudiant_id = $1',
      [id]
    );
    
    res.json({ 
      success: true, 
      count: parseInt(countResult.rows[0].count) 
    });
  } catch (error) {
    console.error('Erreur comptage paiements:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors du comptage des paiements' 
    });
  } finally {
    client.release();
  }
};
//===================================================
exports.getPaiementCountByEtudiant = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    const countResult = await client.query(
      'SELECT COUNT(*) FROM paiement WHERE etudiant_id = $1',
      [id]
    );
    
    res.json({ 
      success: true, 
      count: parseInt(countResult.rows[0].count) 
    });
  } catch (error) {
    console.error('Erreur comptage paiements:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors du comptage des paiements' 
    });
  } finally {
    client.release();
  }
};

//===================================================================================================

exports.getPaiementsByDepartement = async (req, res) => {
  try {
    const departementId = req.query.departement_id || req.user?.departement_id;
    const { anneeAcademiqueId } = req.query;
    
    if (!departementId) {
      return res.status(400).json({
        success: false,
        message: "ID du département requis",
        code: "DEPARTMENT_ID_REQUIRED"
      });
    }

    // Validation de l'année académique
    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis",
        code: "ACADEMIC_YEAR_REQUIRED"
      });
    }

    // Vérifier que l'année académique existe
    const yearCheck = await db.query(
      `SELECT id, annee, etat FROM anneeacademique WHERE id = $1`,
      [anneeAcademiqueId]
    );

    if (yearCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Année académique non trouvée",
        code: "ACADEMIC_YEAR_NOT_FOUND"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Construction dynamique de la clause WHERE
    let whereClauses = ['d.id = $1', 'e.annee_academique_id = $2'];
    const params = [departementId, anneeAcademiqueId];

    // Ajouter le paramètre de recherche si fourni
    if (req.query.search) {
      const searchTerm = `%${req.query.search}%`;
      whereClauses.push(`
        (e.nom ILIKE $${params.length + 1} OR 
         e.prenoms ILIKE $${params.length + 1} OR 
         r.numero_recu ILIKE $${params.length + 1} OR 
         u.nom ILIKE $${params.length + 1})
      `);
      params.push(searchTerm);
    }

    if (req.query.filiere) {
      whereClauses.push(`f.nom = $${params.length + 1}`);
      params.push(req.query.filiere);
    }
    if (req.query.niveau) {
      whereClauses.push(`n.libelle = $${params.length + 1}`);
      params.push(req.query.niveau);
    }
    if (req.query.date_debut) {
      whereClauses.push(`p.date_paiement >= $${params.length + 1}`);
      params.push(req.query.date_debut);
    }
    if (req.query.date_fin) {
      whereClauses.push(`p.date_paiement <= $${params.length + 1}`);
      params.push(req.query.date_fin);
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // REQUÊTE CORRIGÉE avec exactement les champs demandés
    const dataQuery = `
      SELECT 
        p.montant,
        p.date_paiement,
        p.methode,
        r.numero_recu,
        r.date_emission,
        r.emetteur,
        e.nom as nom_etudiant,
        e.prenoms as prenoms_etudiant,
        d.nom as nom_departement,
        u.nom as nom_utilisateur_effectue_par,
        a.annee as annee_academique,
        a.etat as etat_annee
      FROM paiement p
      INNER JOIN recu r ON p.recu_id = r.id
      INNER JOIN etudiant e ON p.etudiant_id = e.id
      INNER JOIN departement d ON e.departement_id = d.id
      INNER JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN niveau n ON e.niveau_id = n.id
      LEFT JOIN utilisateur u ON p.effectue_par::integer = u.id
      ${whereClause}
      ORDER BY p.date_paiement DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    // REQUÊTE DE COUNT CORRIGÉE
    const countQuery = `
      SELECT COUNT(*) 
      FROM paiement p
      INNER JOIN etudiant e ON p.etudiant_id = e.id
      INNER JOIN departement d ON e.departement_id = d.id
      INNER JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN niveau n ON e.niveau_id = n.id
      ${whereClause}
    `;

    const queryParams = [...params, limit, offset];

    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params)
    ]);

    // STRUCTURATION SIMPLIFIÉE avec exactement les données demandées
    const paiements = dataResult.rows.map(row => ({
      montant: row.montant,
      date_paiement: row.date_paiement,
      methode: row.methode,
      numero_recu: row.numero_recu,
      date_emission: row.date_emission,
      emetteur: row.emetteur,
      nom_etudiant: row.nom_etudiant,
      prenoms_etudiant: row.prenoms_etudiant,
      nom_departement: row.nom_departement,
      nom_utilisateur_effectue_par: row.nom_utilisateur_effectue_par,
      annee_academique: row.annee_academique,
      etat_annee: row.etat_annee
    }));

    return res.status(200).json({
      success: true,
      data: paiements,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
      total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      anneeAcademique: {
        id: anneeAcademiqueId,
        annee: yearCheck.rows[0].annee,
        etat: yearCheck.rows[0].etat
      }
    });

  } catch (err) {
    console.error("Erreur récupération paiements par département:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur",
      code: "SERVER_ERROR",
      details: err.message
    });
  }
};