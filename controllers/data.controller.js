const db = require('../config/db.config');

exports.getAllville = async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT id, nom FROM ville ORDER BY nom ASC`);
        res.status(200).json({
            success: true,
            data: rows,
            count: rows.length
        });
    } catch (error) {
        console.error('Error fetching cities:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erreur serveur lors de la récupération des villes' 
        });
    }
};

exports.getAllserie = async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT id, nom FROM serie_bac ORDER BY nom ASC`);
        res.status(200).json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('Error fetching BAC series:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur serveur lors de la récupération des séries'
        });
    }
};

exports.getAllannee = async (req, res) => {
    try {
        const { rows } = await db.query(`SELECT id, annee as nom FROM annee_bac ORDER BY annee DESC`);
        res.status(200).json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('Error fetching BAC years:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur serveur lors de la récupération des années'
        });
    }
};