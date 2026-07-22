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

// fonction pour recuperer la scolariter


/**
 * Récupère la scolarité d'un étudiant et vérifie si elle est soldée
 * Condition: scolarite_restante = 0 ET statut_etudiant = 'SOLDE'
 * 
 * La liaison se fait via: etudiant.scolarite_id = scolarite.id
 */
// ✅ Extrait, réutilisable (ex: module Réinscription) : calcul pur sans req/res.
// Retourne null si l'étudiant n'a pas de ligne scolarite (comportement identique à l'ancien 404).
exports.getSituationFinanciere = async (etudiantId) => {
    const query = `
        SELECT
            s.id,
            s.montant_scolarite,
            s.scolarite_verse,
            s.statut_etudiant,
            s.scolarite_restante,
            s.prise_en_charge_id,
            e.id as etudiant_id,
            e.matricule,
            e.nom,
            e.prenoms
        FROM public.scolarite s
        INNER JOIN public.etudiant e ON e.scolarite_id = s.id
        WHERE e.id = $1
        ORDER BY s.id DESC
        LIMIT 1
    `;
    const result = await db.query(query, [etudiantId]);
    if (result.rows.length === 0) return null;

    const scolarite = result.rows[0];
    const isSolde = (Number(scolarite.scolarite_restante) === 0)
                    && scolarite.statut_etudiant?.toUpperCase() === 'SOLDE';

    return {
        is_solde: isSolde,
        scolarite_restante: parseFloat(scolarite.scolarite_restante || 0),
        statut_etudiant: scolarite.statut_etudiant,
        montant_total: parseFloat(scolarite.montant_scolarite || 0),
        montant_verse: parseFloat(scolarite.scolarite_verse || 0),
    };
};

exports.getScolariteByEtudiantId = async (req, res) => {
    try {
        const { etudiant_id } = req.params;

        if (!etudiant_id) {
            return res.status(400).json({
                success: false,
                message: "L'ID de l'étudiant est requis"
            });
        }

        const situation = await exports.getSituationFinanciere(etudiant_id);

        if (!situation) {
            return res.status(404).json({
                success: false,
                message: "Aucune information de scolarité trouvée pour cet étudiant",
                is_solde: false,
                scolarite_restante: null,
                statut_etudiant: null
            });
        }

        return res.status(200).json({
            success: true,
            ...situation,
            message: situation.is_solde
                ? "La scolarité est soldée, l'étudiant peut déposer son mémoire"
                : "La scolarité n'est pas soldée, l'étudiant ne peut pas déposer son mémoire"
        });

    } catch (error) {
        console.error("Erreur dans getScolariteByEtudiantId:", error);
        return res.status(500).json({
            success: false,
            message: "Erreur interne du serveur",
            error: error.message
        });
    }
};

/**
 * Version simplifiée qui retourne juste un booléen (pour l'affichage du bouton)
 */
exports.checkScolariteSolde = async (req, res) => {
    try {
        const { etudiant_id } = req.params;

        if (!etudiant_id) {
            return res.status(400).json({
                success: false,
                is_solde: false
            });
        }

        // Requête simplifiée avec jointure
        const query = `
            SELECT 
                s.scolarite_restante, 
                s.statut_etudiant
            FROM public.scolarite s
            INNER JOIN public.etudiant e ON e.scolarite_id = s.id
            WHERE e.id = $1
            ORDER BY s.id DESC
            LIMIT 1
        `;

        const result = await db.query(query, [etudiant_id]);

        if (result.rows.length === 0) {
            return res.status(200).json({
                success: true,
                is_solde: false
            });
        }

        const scolarite = result.rows[0];
        const isSolde = (Number(scolarite.scolarite_restante) === 0) 
                        && scolarite.statut_etudiant?.toUpperCase() === 'SOLDE';

        return res.status(200).json({
            success: true,
            is_solde: isSolde
        });

    } catch (error) {
        console.error("Erreur dans checkScolariteSolde:", error);
        return res.status(500).json({
            success: false,
            is_solde: false
        });
    }
};


//=============================================================================================================
//                                          STATISTIQUES
//=============================================================================================================

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


//==========================================================================
//             Controller pour charger le pdf
//==========================================================================


exports.postChargerPdf = async (req, res) => {
    
}