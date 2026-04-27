const db = require('../config/db.config');

// Récupérer tous les paiements d'un étudiant spécifique
exports.getPaiementsByEtudiantId = async (req, res) => {
    try {
        const { etudiant_id } = req.params;
        
        const query = `
            SELECT p.id, p.montant, p.date_paiement, p.methode, 
                   p.effectue_par, p.etudiant_id, p.recu_id,
                   r.numero_recu, r.date_emission, r.emetteur
            FROM public.paiement p
            LEFT JOIN public.recu r ON p.recu_id = r.id
            WHERE p.etudiant_id = $1
            ORDER BY p.date_paiement DESC
        `;
        
        const result = await db.query(query, [etudiant_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows,
            count: result.rowCount
        });
        
    } catch (error) {
        console.error('Erreur lors de la récupération des paiements:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de la récupération des paiements',
            error: error.message
        });
    }
};

// Récupérer un paiement spécifique avec son reçu associé
exports.getPaiementWithRecu = async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT p.id, p.montant, p.date_paiement, p.methode, 
                   p.effectue_par, p.etudiant_id, p.recu_id,
                   r.numero_recu, r.date_emission, r.emetteur
            FROM public.paiement p
            LEFT JOIN public.recu r ON p.recu_id = r.id
            WHERE p.id = $1
        `;
        
        const result = await db.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Paiement non trouvé'
            });
        }
        
        res.status(200).json({
            success: true,
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('Erreur lors de la récupération du paiement:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de la récupération du paiement',
            error: error.message
        });
    }
};

// Récupérer tous les reçus d'un étudiant
exports.getRecusByEtudiantId = async (req, res) => {
    try {
        const { etudiant_id } = req.params;
        
        const query = `
            SELECT r.id, r.numero_recu, r.date_emission, r.montant, r.emetteur,
                   p.id as paiement_id, p.date_paiement, p.methode
            FROM public.recu r
            INNER JOIN public.paiement p ON r.id = p.recu_id
            WHERE p.etudiant_id = $1
            ORDER BY r.date_emission DESC
        `;
        
        const result = await db.query(query, [etudiant_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows,
            count: result.rowCount
        });
        
    } catch (error) {
        console.error('Erreur lors de la récupération des reçus:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de la récupération des reçus',
            error: error.message
        });
    }
};

// Récupérer les statistiques de paiement d'un étudiant
exports.getPaiementStatsByEtudiantId = async (req, res) => {
    try {
        const { etudiant_id } = req.params;
        
        const query = `
            SELECT 
                COUNT(*) as total_paiements,
                SUM(montant) as total_montant,
                MIN(date_paiement) as premier_paiement,
                MAX(date_paiement) as dernier_paiement
            FROM public.paiement
            WHERE etudiant_id = $1
        `;
        
        const result = await db.query(query, [etudiant_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows[0]
        });
        
    } catch (error) {
        console.error('Erreur lors de la récupération des statistiques:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de la récupération des statistiques',
            error: error.message
        });
    }
};