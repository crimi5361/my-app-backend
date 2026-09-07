const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 100000, // Fenêtre de 15 minutes
  max: 100000,                 // Max 1000 requêtes par fenêtre
  standardHeaders: true,     // Retourne les headers `RateLimit-*`
  legacyHeaders: false,      // Désactive les headers `X-RateLimit-*`
  message: {
    success: false,
    message: 'Trop de requêtes. Réessayez dans 15 minutes.'
  }
});

module.exports = apiLimiter;