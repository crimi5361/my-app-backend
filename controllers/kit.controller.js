const db = require('../config/db.config');
const { isKitSuspenduPourAnnee } = require('../services/kitCampagne.service');

// Permet au frontend (formulaire de paiement) de savoir si la case "kit école" doit être
// proposée ou non pour l'année académique en cours de l'étudiant, sans dupliquer la règle de
// suspension (KIT_ANNEES_SUSPENDUES) déjà utilisée côté écriture/lecture du reçu.
exports.getEtatCampagne = async (req, res) => {
  try {
    const { etudiantId } = req.params;

    const etudiantResult = await db.query(
      'SELECT annee_academique_id FROM etudiant WHERE id = $1',
      [etudiantId]
    );

    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }

    const suspendu = await isKitSuspenduPourAnnee(db, etudiantResult.rows[0].annee_academique_id);

    res.json({ success: true, data: { suspendu } });
  } catch (error) {
    console.error('Erreur récupération état campagne kit:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de l\'état du module kit'
    });
  }
};

exports.getKitByEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    
    const kitResult = await db.query(
      'SELECT * FROM kit WHERE etudiant_id = $1',
      [id]
    );
    
    if (kitResult.rows.length === 0) {
      return res.json({ 
        success: true, 
        data: null 
      });
    }
    
    res.json({ 
      success: true, 
      data: kitResult.rows[0] 
    });
  } catch (error) {
    console.error('Erreur récupération kit:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors de la récupération du kit' 
    });
  }
};