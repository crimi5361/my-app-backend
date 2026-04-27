const db = require('../config/db.config');

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