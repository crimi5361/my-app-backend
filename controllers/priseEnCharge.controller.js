const db = require('../config/db.config');

exports.getActivePECByEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    
    const pecResult = await db.query(
      `SELECT * FROM prise_en_charge 
       WHERE etudiant_id = $1 AND statut = 'valide'`,
      [id]
    );
    
    if (pecResult.rows.length === 0) {
      return res.json({ 
        success: true, 
        data: null 
      });
    }
    
    res.json({ 
      success: true, 
      data: pecResult.rows[0] 
    });
  } catch (error) {
    console.error('Erreur récupération PEC:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors de la récupération de la prise en charge' 
    });
  }
};

///========================================================================

// Récupérer toutes les PEC en attente avec les infos étudiant
exports.getPECEnAttente = async (req, res) => {
  const client = await db.connect();
  
  try {
    const departementId = req.user.departement_id;
    const { anneeAcademiqueId } = req.query;

    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis"
      });
    }

    const query = `
      SELECT 
        p.id as pec_id,
        p.type_pec,
        p.pourcentage_reduction,
        p.reference,
        p.date_demande,
        p.statut,
        e.id as etudiant_id,
        e.matricule_iipea,
        e.nom,
        e.prenoms,
        e.telephone,
        e.email,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        s.montant_scolarite,
        s.scolarite_verse,
        s.scolarite_restante,
        s.statut_etudiant,
        (s.montant_scolarite * p.pourcentage_reduction / 100) as reduction_calculee
      FROM prise_en_charge p
      JOIN etudiant e ON p.etudiant_id = e.id
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN scolarite s ON e.scolarite_id = s.id
      WHERE p.statut = 'en_attente'
        AND e.annee_academique_id = $1
        AND e.departement_id = $2
      ORDER BY p.date_demande DESC
    `;

    const result = await client.query(query, [anneeAcademiqueId, departementId]);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération PEC en attente:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des prises en charge'
    });
  } finally {
    client.release();
  }
};

//===========================================================================================================================

// Récupérer toutes les PEC traitées (validées ET refusées) avec les infos étudiant
exports.getPECTraitees = async (req, res) => {
  const client = await db.connect();
  
  try {
    const departementId = req.user.departement_id;
    const { anneeAcademiqueId } = req.query;

    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis"
      });
    }

    const query = `
      SELECT 
        p.id as pec_id,
        p.type_pec,
        p.pourcentage_reduction,
        p.montant_reduction,
        p.reference,
        p.date_demande,
        p.date_validation,
        p.statut,
        p.motif_refus,  
        e.id as etudiant_id,
        e.matricule_iipea,
        e.nom,
        e.prenoms,
        e.telephone,
        e.email,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        s.montant_scolarite,
        s.scolarite_verse,
        s.scolarite_restante,
        s.statut_etudiant,
        (s.montant_scolarite * p.pourcentage_reduction / 100) as reduction_calculee,
        (s.scolarite_verse + p.montant_reduction) as total_verse_virtuel,
        (s.montant_scolarite - (s.scolarite_verse + p.montant_reduction)) as restant_virtuel
      FROM prise_en_charge p
      JOIN etudiant e ON p.etudiant_id = e.id
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN scolarite s ON e.scolarite_id = s.id
      WHERE p.statut IN ('valide', 'refuse')  
        AND e.annee_academique_id = $1
        AND e.departement_id = $2
      ORDER BY p.date_validation DESC, e.nom, e.prenoms
    `;

    const result = await client.query(query, [anneeAcademiqueId, departementId]);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération PEC traitées:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des prises en charge traitées'
    });
  } finally {
    client.release();
  }
};

//==================== Récupérer les statistiques des PEC validées======================
exports.getStatsPECtraitees = async (req, res) => {
  const client = await db.connect();
  
  try {
    const departementId = req.user.departement_id;
    const { anneeAcademiqueId } = req.query;

    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis"
      });
    }

    const query = `
      SELECT 
        COUNT(*) as total_pec_traitees,
        COUNT(*) FILTER (WHERE p.statut = 'valide') as total_validees,
        COUNT(*) FILTER (WHERE p.statut = 'refuse') as total_refusees,
        COALESCE(SUM(p.montant_reduction), 0) as total_reduction,
        COALESCE(AVG(p.montant_reduction), 0) as moyenne_reduction,
        p.type_pec,
        COUNT(*) as count_type
      FROM prise_en_charge p
      JOIN etudiant e ON p.etudiant_id = e.id
      WHERE p.statut IN ('valide', 'refuse')
        AND e.annee_academique_id = $1
        AND e.departement_id = $2
      GROUP BY p.type_pec
      ORDER BY count_type DESC
    `;

    const result = await client.query(query, [anneeAcademiqueId, departementId]);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération stats PEC traitées:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques'
    });
  } finally {
    client.release();
  }
};