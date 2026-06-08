// ============================================================
//  app.js  –  Point d'entrée principal du serveur Express
// ============================================================

const path    = require('path');
const express = require('express');
const cors    = require('cors');
require('dotenv').config();

// Swagger
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

// Middleware personnalisés
const apiLimiter = require('./middleware/limiter.middleware');

const app = express();

// ─────────────────────────────────────────────────────────────
//  CONFIGURATION GÉNÉRALE
// ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'Views'));

// ─────────────────────────────────────────────────────────────
//  CORS
// ─────────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'https://myiipea.ci',
    'https://www.myiipea.ci',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Authorization', 'Content-Disposition', 'Content-Length'],
};

app.use(cors(corsOptions));

// ─────────────────────────────────────────────────────────────
//  RATE LIMITING  (appliqué à toutes les routes /api/*)
// ─────────────────────────────────────────────────────────────
app.use('/api/', apiLimiter);

// ─────────────────────────────────────────────────────────────
//  FICHIERS STATIQUES
// ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public',  express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
//  PARSING DU BODY
//  • multipart/form-data → laissé à Multer (pas de parsing ici)
//  • JSON / URL-encoded  → parsé normalement
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    console.log('📂 FormData détecté – parsing délégué à Multer');
    return next();
  }

  // JSON
  express.json({ limit: '50mb' })(req, res, (err) => {
    if (err) return next(err);
    // URL-encoded
    express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
  });
});

// ─────────────────────────────────────────────────────────────
//  ROUTES API
// ─────────────────────────────────────────────────────────────
console.log('\n🔍 Chargement des routes...');

const apiRoutes = [
  // Auth & droits
  { path: '/api/auth',              route: require('./routes/auth.routes') },
  { path: '/api/permissions',       route: require('./routes/permission.routes') },
  { path: '/api/rolepermissions',   route: require('./routes/rolePermission.routes') },
  { path: '/api/roles',             route: require('./routes/role.routes') },
  { path: '/api/utilisateurs',      route: require('./routes/user.routes') },

  // Structure académique
  { path: '/api/departements',      route: require('./routes/departement.routes') },
  { path: '/api/typesfiliere',      route: require('./routes/typesFiliere.routes') },
  { path: '/api/filieres',          route: require('./routes/filieres.routes') },
  { path: '/api/annees',            route: require('./routes/anne.routes') },
  { path: '/api/curcus',            route: require('./routes/curcus.routes') },
  { path: '/api/niveaux',           route: require('./routes/niveau.routes') },
  { path: '/api/classes',           route: require('./routes/classes.routes') },
  { path: '/api/semestres',         route: require('./routes/semestre.routes') },
  { path: '/api/maquettes',         route: require('./routes/maquette.routes') },
  { path: '/api/categorie',         route: require('./routes/categorie.routes') },
  { path: '/api/ues',               route: require('./routes/ue.routes') },
  { path: '/api/matiere',           route: require('./routes/matiere.routes') },

  // Étudiants & inscriptions
  { path: '/api/etudiants',         route: require('./routes/etudiant.routes') },
  { path: '/api/effectifs',         route: require('./routes/effectifs.routes') },
  { path: '/api/StatsInscriptions', route: require('./routes/StatsInscriptions.routes') },

  // Paiements
  { path: '/api/paiements',                 route: require('./routes/payement.routes') },
  { path: '/api/priseEnCharge',             route: require('./routes/priseEnCharge.routes') },
  { path: '/api/kit',                       route: require('./routes/kit.routes') },
  { path: '/api/etudiant-payement-espace',  route: require('./routes/PaiementEespaceetudiant.routes') },

  // Certificats & documents
  { path: '/api/CertificatScolarite',       route: require('./routes/CertificatScolarite.routes') },
  { path: '/api/CertificaFrentation',       route: require('./routes/CertificatFrequentation.routes') },
  { path: '/api/Certificat_Scolarite',      route: require('./routes/Certificat_scolarite.routes') },
  { path: '/api/certificats-frequentation', route: require('./routes/Certificat_frequentation.routes') },

  // Évaluations & notes
  { path: '/api/notes',       route: require('./routes/notes.routes') },
  { path: '/api/evaluation',  route: require('./routes/evaluation.routes') },
  { path: '/api/PV',          route: require('./routes/PV.routes') },
  { path: '/api/professeur',  route: require('./routes/professeur.routes') },

  // Statistiques & tableaux de bord
  { path: '/api/data',            route: require('./routes/data.routes') },
  { path: '/api/StatDashboard',   route: require('./routes/StatDashboard.routes') },
  { path: '/api/statistiques',    route: require('./routes/StatistiqueGeneral.routes') },

  // Espace étudiant
  { path: '/api/donneeespaceetudiant',    route: require('./routes/donneeespaceetudiant.routes') },
  { path: '/api/detailaffichageMaquette', route: require('./routes/DetailAffichageMaquette.routes') },

  // Emploi du temps & divers
  { path: '/api/emploiDuTemps',   route: require('./routes/EDT.routes') },
  { path: '/api/public',          route: require('./routes/public.routes') },
  { path: '/api/change_Password', route: require('./routes/changePassWord.routes') },
];

apiRoutes.forEach(({ path: routePath, route }) => {
  app.use(routePath, route);
  console.log(`  ✅ ${routePath}`);
});

console.log('\n🎉 Toutes les routes API sont chargées !\n');

// ─────────────────────────────────────────────────────────────
//  ROUTES UTILITAIRES
// ─────────────────────────────────────────────────────────────

/** Santé du serveur */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/** Vérification des chemins d'images publiques */
app.get('/test-images', (req, res) => {
  const base = process.env.API_URL || 'http://localhost:5000';
  res.json({
    logo:      `${base}/public/logo.png`,
    photoroom: `${base}/public/IIPEA-Photoroom.png`,
    baseUrl:   base,
  });
});

/** Test de réception FormData (développement uniquement) */
app.post('/api/test-formdata', (req, res) => {
  res.json({
    success:     true,
    message:     'Test endpoint opérationnel',
    contentType: req.headers['content-type'],
    bodyKeys:    Object.keys(req.body || {}),
    hasFile:     !!req.file,
  });
});

// ─────────────────────────────────────────────────────────────
//  SWAGGER – Documentation interactive
//  Accessible via : https://myiipea.ci/api-docs/
// ─────────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title:       'API IIPEA',
      version:     '1.0.0',
      description: 'Documentation interactive du backend IIPEA',
    },
    servers: [
      { url: process.env.API_URL || 'https://myiipea.ci', description: 'Production' },
      { url: 'http://localhost:5000',                      description: 'Local direct' },
    ],
  },
  apis: ['./routes/*.js'],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ─────────────────────────────────────────────────────────────
//  GESTIONNAIRE D'ERREURS GLOBAL
// ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.stack}`);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erreur interne du serveur',
  });
});

// ─────────────────────────────────────────────────────────────
//  DÉMARRAGE DU SERVEUR
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré  → http://localhost:${PORT}`);
  console.log(`📖 Swagger UI       → http://localhost:${PORT}/api-docs`);
  console.log(`🌐 Production       → ${process.env.API_URL || 'https://myiipea.ci'}/api-docs`);
});

module.exports = app; // utile pour les tests (Jest / Supertest)