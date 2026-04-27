const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    console.log('Headers reçus:', req.headers);
    console.log('URL appelée:', req.originalUrl);
    
    const token = req.headers.authorization?.split(' ')[1] || 
                req.headers['x-access-token'] || 
                req.query.token;
    
    console.log('Token extrait:', token);
    
    if (!token) {
        console.log('Aucun token trouvé dans la requête. Headers:', req.headers);
        return res.status(401).json({ 
            message: 'Token manquant',
            solution: 'Ajoutez un header Authorization: Bearer <token>'
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.error('Erreur de vérification du token:', err.name);
            
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ 
                    message: 'Token expiré',
                    solution: 'Connectez-vous à nouveau pour obtenir un nouveau token'
                });
            }
            
            return res.status(403).json({ 
                message: 'Token invalide',
                error: err.message
            });
        }

        if (!decoded?.id || !decoded?.role) {
            return res.status(403).json({ 
                message: 'Token mal formé',
                details: 'Le token doit contenir id et role'
            });
        }

        // CORRECTION ICI : Utilisez decoded au lieu de user
        req.user = {
          id: decoded.id,
          role: decoded.role,
          code: decoded.code,
          departement_id: decoded.departement_id // ← Utilisez decoded.departement_id
        };
        
        console.log('Utilisateur authentifié:', req.user);
        next();
    });
};

module.exports = authenticateToken;