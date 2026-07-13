// Doit être utilisé après authenticateToken (nécessite req.user.role)
const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user?.role || !roles.includes(req.user.role)) {
    return res.status(403).json({
      message: "Accès refusé : rôle insuffisant",
      roleRequis: roles,
    });
  }
  next();
};

module.exports = authorizeRoles;
