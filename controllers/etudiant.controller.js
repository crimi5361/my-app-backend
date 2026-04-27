const db = require('../config/db.config');
const bcrypt = require('bcrypt');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, '../uploads/photos');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Fonction pour générer un code aléatoire (utilisé en fallback)
function generateRandomCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

// Fonction pour générer le code unique selon le nouveau format AVEC DATE DE NAISSANCE
async function generateCodeUnique(nom, prenoms, dateNaissance) {
  try {
    // Normaliser le nom (supprimer accents et espaces)
    const cleanNom = nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
    // Extraire les 3 premières lettres du nom (en majuscules)
    const nomPart = cleanNom.substring(0, 3).toUpperCase();
    
    // Normaliser le prénom et extraire la première lettre du premier prénom
    const cleanPrenoms = prenoms.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
    const prenomParts = cleanPrenoms.split(' ');
    const prenomPart = prenomParts[0].substring(0, 1).toUpperCase();
    
    // Utiliser la DATE DE NAISSANCE au format JJMMAA
    const birthDate = moment(dateNaissance);
    const day = String(birthDate.date()).padStart(2, '0');
    const month = String(birthDate.month() + 1).padStart(2, '0');
    const year = String(birthDate.year()).slice(-2);
    const datePart = `${day}${month}${year}`;
    
    // Compteur séquentiel pour les homonymes
    const countRes = await db.query(
      `SELECT COUNT(*) FROM etudiant 
       WHERE nom = $1 
         AND prenoms LIKE $2 || '%'
         AND date_naissance = $3`,
      [nom.toUpperCase(), prenomParts[0].toUpperCase(), dateNaissance]
    );
    const sequenceNumber = (parseInt(countRes.rows[0].count) + 1);
    const seqPart = String(sequenceNumber).padStart(4, '0');
    
    return `${nomPart}${prenomPart}${datePart}${seqPart}`;
  } catch (error) {
    console.error('Erreur génération code unique:', error);
    const birthDate = moment(dateNaissance);
    const fallbackDate = birthDate.isValid() ? birthDate.format('DDMMYY') : moment().format('DDMMYY');
    return `${nom.substring(0, 3).toUpperCase()}${prenoms.substring(0, 1).toUpperCase()}${fallbackDate}0001`;
  }
}

// Fonction pour générer le matricule IIPEA
async function generateMatriculeIIPEA(anneeAcademiqueId, filiereId) {
  try {
    // Récupérer l'année académique
    const anneeRes = await db.query('SELECT annee FROM anneeacademique WHERE id = $1', [anneeAcademiqueId]);
    let annee = '00';
    
    if (anneeRes.rows[0]?.annee) {
      const yearParts = anneeRes.rows[0].annee.split('-');
      if (yearParts.length === 2) {
        annee = yearParts[1].slice(-2);
      }
    }

    // Récupérer le sigle de la filière
    const filiereRes = await db.query('SELECT sigle FROM filiere WHERE id = $1', [filiereId]);
    const sigle = filiereRes.rows[0]?.sigle || 'XX';

    // Récupérer le dernier numéro séquentiel
    const countRes = await db.query(
      `SELECT COUNT(*) FROM etudiant 
       WHERE matricule_iipea LIKE $1 || $2 || '%'`,
      [annee, sigle]
    );
    const sequenceNumber = (parseInt(countRes.rows[0].count) + 1).toString().padStart(4, '0');

    const randomPart = generateRandomCode(4);

    return `${annee}${sigle}${randomPart}${sequenceNumber}`;
  } catch (error) {
    console.error('Erreur génération matricule IIPEA:', error);
    return `${new Date().getFullYear().toString().slice(-2)}${generateRandomCode(6)}`;
  }
}

// Validation des fichiers photo
function validatePhotoFile(file) {
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
  const allowedExtensions = ['.jpg', '.jpeg', '.png'];
  const fileExt = path.extname(file.originalname).toLowerCase();

  if (!allowedExtensions.includes(fileExt)) {
    return { valid: false, error: 'Format de photo invalide. Formats acceptés: JPG, JPEG, PNG' };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'La photo ne doit pas dépasser 2MB' };
  }

  return { valid: true };
}

exports.addEtudiant = async (req, res) => {
  // Vérification de l'authentification
  if (!req.user?.id) {
    return res.status(401).json({ 
      success: false, 
      error: 'Authentification requise',
      code: 'AUTH_REQUIRED'
    });
  }

  console.log('Fichiers reçus:', req.files);
  console.log('Corps de la requête:', req.body);

  // Démarrer une transaction
  const client = await db.connect();
  let photoUrl = null;

  try {
    await client.query('BEGIN');

    // Transformation et validation des données
    const data = {
      etudiant: req.body.etudiant || {},
      academique: req.body.academique || {},
      inscription: req.body.inscription || {},
      documents: Array.isArray(req.body.documents) ? req.body.documents : []
    };

    // Normalisation des noms de champs
    if (data.inscription.filiere_id) {
      data.inscription.id_filiere = data.inscription.filiere_id;
      delete data.inscription.filiere_id;
    }

    // Validation des champs obligatoires
    const requiredFields = {
      etudiant: ['nom', 'prenoms', 'date_naissance', 'sexe', 'nationalite', 'telephone', 'contact_parent'],
      academique: ['matricule', 'annee_academique_id'],
      inscription: ['niveau_id', 'id_filiere']
    };

    const missingFields = {};
    Object.keys(requiredFields).forEach(section => {
      const fields = requiredFields[section].filter(field => !data[section][field]);
      if (fields.length > 0) missingFields[section] = fields;
    });

    if (Object.keys(missingFields).length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Champs obligatoires manquants',
        missingFields,
        code: 'MISSING_FIELDS'
      });
    }

    // Gestion de la photo
    // Gestion de la photo - CORRECTION ICI (utilisation de diskStorage)
    // Gestion de la photo - VERSION CORRIGÉE
if (req.files?.photo?.[0]) {
  const photoFile = req.files.photo[0];
  console.log('Fichier photo détecté (inscription):', {
    originalname: photoFile.originalname,
    mimetype: photoFile.mimetype,
    size: photoFile.size,
    path: photoFile.path, // Chemin sur le disque
    filename: photoFile.filename
  });

  const validation = validatePhotoFile(photoFile);
  
  if (!validation.valid) {
    // Supprimer le fichier si invalide
    if (photoFile.path && fs.existsSync(photoFile.path)) {
      fs.unlinkSync(photoFile.path);
    }
    return res.status(400).json({
      success: false,
      error: validation.error,
      code: 'INVALID_PHOTO'
    });
  }

  try {
    // AVEC diskStorage, LE FICHIER EST DÉJÀ SAUVEGARDÉ
    // On utilise directement le chemin existant
    photoUrl = `/uploads/photos/${photoFile.filename}`;
    console.log('Photo sauvegardée (inscription):', photoUrl);
    
  } catch (error) {
    // Nettoyer le fichier en cas d'erreur
    if (photoFile.path && fs.existsSync(photoFile.path)) {
      fs.unlinkSync(photoFile.path);
    }
    console.error('Erreur traitement photo (inscription):', error);
    return res.status(500).json({
      success: false,
      error: 'Erreur lors du traitement de la photo',
      code: 'PHOTO_PROCESSING_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
} else {
  console.log('Aucun fichier photo détecté dans la requête (inscription)');
}

    // Génération des identifiants
    const cleanName = (str) => {
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '.').toLowerCase();
    };

    const email = `${cleanName(data.etudiant.prenoms.split(' ')[0])}.${cleanName(data.etudiant.nom)}@iipea.com`;
    const hashedPassword = await bcrypt.hash('@elites@', 10);
    
    // Génération des codes
    const code_unique = await generateCodeUnique(data.etudiant.nom, data.etudiant.prenoms, data.etudiant.date_naissance);
    const matricule_iipea = await generateMatriculeIIPEA(
      data.academique.annee_academique_id,
      data.inscription.id_filiere
    );

    // 1. Insertion de l'étudiant avec le champ ip_ministere
    const etudiantQuery = `
      INSERT INTO etudiant (
        matricule, nom, prenoms, date_naissance, lieu_naissance, pays_naissance, telephone, email,
        lieu_residence, contact_parent, nom_parent_1, nom_parent_2, code_unique, annee_bac, serie_bac, 
        etablissement_origine, inscrit_par, photo_url, departement_id, annee_academique_id, groupe_id,
        niveau_id, statut_scolaire, nationalite, standing, numero_table, sexe, password,
        curcus_id, id_filiere, date_inscription, contact_etudiant, contact_parent_2, matricule_iipea,
        ip_ministere  -- NOUVEAU CHAMP AJOUTÉ
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, NOW(), $31, $32, $33, $34)
      RETURNING id
    `;

    const etudiantValues = [
      data.academique.matricule,
      data.etudiant.nom.toUpperCase(),
      data.etudiant.prenoms.toUpperCase(),
      moment(data.etudiant.date_naissance).format('YYYY-MM-DD'),
      data.etudiant.lieu_naissance,
      data.etudiant.pays_naissance || null,
      data.etudiant.telephone,
      email,
      data.etudiant.lieu_residence,
      data.etudiant.contact_parent,
      data.etudiant.nom_parent_1 || null,
      data.etudiant.nom_parent_2 || null,
      code_unique,
      data.academique.annee_bac || null,
      data.academique.serie_bac || null,
      data.academique.etablissement_origine || null,
      req.user.id,
      photoUrl,
      req.user.departement_id || 1,
      data.academique.annee_academique_id,
      null, // groupe_id
      data.inscription.niveau_id,
      data.academique.statut_scolaire || 'Non affecté',
      data.etudiant.nationalite,
      'en attente',
      data.academique.numero_table || null,
      data.etudiant.sexe,
      hashedPassword,
      data.inscription.curcus_id || null,
      data.inscription.id_filiere,
      data.etudiant.telephone, // contact_etudiant
      data.etudiant.contact_parent_2 || null,
      matricule_iipea,
      data.academique.ip_ministere || null  // NOUVEAU CHAMP - peut être null
    ];

    const etudiantResult = await client.query(etudiantQuery, etudiantValues);
    const etudiantId = etudiantResult.rows[0].id;

    // 2. Insertion des documents
    const parseDocumentValue = (val) => val === 'true' ? 'oui' : 'non';

    const docResult = await client.query(
      `INSERT INTO document (
        extrait_naissance, justificatif_identite, fiche_orientation, dernier_diplome
      ) VALUES ($1, $2, $3, $4)
      RETURNING id`,
      [
        parseDocumentValue(data.documents.find(d => d.nom === 'EXTRAIT_DE_NAISSANCE')?.fourni),
        parseDocumentValue(data.documents.find(d => d.nom === 'JUSTIFICATIF_IDENTITE')?.fourni),
        parseDocumentValue(data.documents.find(d => d.nom === 'FICHE_ORIENTATION')?.fourni),
        parseDocumentValue(data.documents.find(d => d.nom === 'COPIES_BAC')?.fourni)
      ]
    );
    
    // Mise à jour de l'étudiant avec le document_id
    await client.query(
      `UPDATE etudiant SET document_id = $1 WHERE id = $2`,
      [docResult.rows[0].id, etudiantId]
    );

    // 3. Insertion de la scolarité
    const scolariteResult = await client.query(
      `INSERT INTO scolarite (
        montant_scolarite, scolarite_verse, statut_etudiant
      ) VALUES ($1, $2, $3)
      RETURNING id`,
      [
        data.inscription.montant_scolarite || 0,
        0,
        'en attente'
      ]
    );

    // Mise à jour de l'étudiant avec le scolarite_id
    await client.query(
      `UPDATE etudiant SET scolarite_id = $1 WHERE id = $2`,
      [scolariteResult.rows[0].id, etudiantId]
    );

    await client.query('COMMIT');

    // Journalisation de l'action
    console.log(`Nouvel étudiant inscrit: ${data.etudiant.nom} ${data.etudiant.prenoms} (ID: ${etudiantId})`);
    if (data.academique.ip_ministere) {
      console.log(`IP Ministère fourni: ${data.academique.ip_ministere}`);
    }

    return res.status(201).json({
      success: true,
      data: { 
        id: etudiantId, 
        code_unique, 
        email, 
        photoUrl,
        matricule: data.academique.matricule,
        matricule_iipea,
        contact_etudiant: data.etudiant.telephone,
        contact_parent_2: data.etudiant.contact_parent_2 || null,
        ip_ministere: data.academique.ip_ministere || null  // Retourner aussi l'IP ministère
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur DB:', err);

    // Nettoyage de la photo en cas d'erreur
    if (photoUrl) {
      const filepath = path.join(UPLOAD_DIR, path.basename(photoUrl));
      fs.unlink(filepath, () => {});
    }

    // Gestion des erreurs de contrainte unique
    if (err.code === '23505') {
      const field = err.detail.includes('matricule_iipea') ? 'matricule IIPEA' : 
                   err.detail.includes('email') ? 'email' : 
                   err.detail.includes('code_unique') ? 'code unique' : 'matricule';
      return res.status(409).json({
        success: false,
        error: `Un étudiant avec ce ${field} existe déjà`,
        code: 'DUPLICATE_ENTRY',
        field
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Erreur base de données',
      code: 'DATABASE_ERROR',
      details: process.env.NODE_ENV === 'development' ? {
        message: err.message,
        stack: err.stack
      } : undefined
    });
  } finally {
    client.release();
  }
};


///=====================================================================================================================
exports.getEtudiantsByDepartement = async (req, res) => {
  try {
    const departementId = req.query.departement_id || req.user?.departement_id;
    const { anneeAcademiqueId } = req.query;
    const searchTerm = req.query.search || '';
    
    if (!departementId) {
      return res.status(400).json({
        success: false,
        message: "ID du département requis",
        code: "DEPARTMENT_ID_REQUIRED"
      });
    }

    // Validation de l'année académique
    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis",
        code: "ACADEMIC_YEAR_REQUIRED"
      });
    }

    // Vérifier que l'année académique existe
    const yearCheck = await db.query(
      `SELECT id, annee, etat FROM anneeacademique WHERE id = $1`,
      [anneeAcademiqueId]
    );

    if (yearCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Année académique non trouvée",
        code: "ACADEMIC_YEAR_NOT_FOUND"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Construction dynamique de la clause WHERE
    let whereClauses = ['e.departement_id = $1', 'e.annee_academique_id = $2'];
    let params = [departementId, anneeAcademiqueId];
    let paramCounter = 3;

    // Filtre par standing (par défaut 'Inscrit')
    const standingFilter = req.query.standing || 'Inscrit';
    whereClauses.push(`e.standing = $${paramCounter}`);
    params.push(standingFilter);
    paramCounter++;

    // Filtre par filière si fourni
    if (req.query.filiere) {
      whereClauses.push(`f.nom = $${paramCounter}`);
      params.push(req.query.filiere);
      paramCounter++;
    }
    
    // Filtre par niveau si fourni
    if (req.query.niveau) {
      whereClauses.push(`n.libelle = $${paramCounter}`);
      params.push(req.query.niveau);
      paramCounter++;
    }

    // Recherche textuelle si fournie
    if (searchTerm) {
      whereClauses.push(`(
        e.nom ILIKE $${paramCounter} OR 
        e.prenoms ILIKE $${paramCounter} OR 
        e.matricule ILIKE $${paramCounter} OR 
        e.code_unique ILIKE $${paramCounter} OR 
        e.matricule_iipea ILIKE $${paramCounter} OR 
        f.nom ILIKE $${paramCounter} OR 
        f.sigle ILIKE $${paramCounter} OR 
        e.telephone ILIKE $${paramCounter} OR 
        e.nationalite ILIKE $${paramCounter}
      )`);
      params.push(`%${searchTerm}%`);
      paramCounter++;
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Requête principale avec toutes les jointures
    const dataQuery = `
      SELECT 
        e.id,
        e.matricule,
        e.nom,
        e.prenoms,
        e.date_naissance,
        e.lieu_naissance,
        e.pays_naissance, 
        e.telephone,
        e.email,
        e.lieu_residence,
        e.contact_parent,
        e.nom_parent_1, 
        e.nom_parent_2, 
        e.code_unique,
        e.annee_bac,
        e.serie_bac,
        e.ip_ministere,
        e.statut_scolaire,
        e.etablissement_origine,
        e.date_inscription,
        e.nationalite,
        e.standing,
        e.sexe,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,

        f.nom as filiere,
        f.sigle as filiere_sigle,

        n.libelle as niveau,

        a.annee as annee_academique,
        a.etat as etat_annee,

        d.nom as departement,

        c.id as curcus_id,
        c.type_parcours,

        doc.extrait_naissance,
        doc.justificatif_identite,
        doc.dernier_diplome,
        doc.fiche_orientation,
        
        -- Informations de groupe
        g.nom as groupe_nom,
        
        -- Informations de scolarité
        s.montant_scolarite,
        s.scolarite_verse,
        s.scolarite_restante,
        s.statut_etudiant,
        s.prise_en_charge_id,
        COALESCE(s.montant_scolarite, 0) as montant_total_scolarite,
        COALESCE(s.scolarite_verse, 0) as montant_paye,
        COALESCE(s.scolarite_restante, 0) as montant_restant,
        CASE 
          WHEN s.montant_scolarite IS NULL OR s.montant_scolarite = 0 THEN 0
          ELSE ROUND((COALESCE(s.scolarite_verse, 0) / s.montant_scolarite) * 100, 2)
        END as pourcentage_paye
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      JOIN departement d ON e.departement_id = d.id
      LEFT JOIN document doc ON e.document_id = doc.id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN groupe g ON e.groupe_id = g.id 
      LEFT JOIN curcus c ON e.curcus_id = c.id
      ${whereClause}
      ORDER BY e.nom ASC, e.prenoms ASC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `;
    
    // Requête de comptage
    const countQuery = `
      SELECT COUNT(*) 
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      ${whereClause}
    `;

    // Paramètres pour la pagination
    const queryParams = [...params, limit, offset];

    // Exécution des requêtes en parallèle
    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params)
    ]);

    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
      anneeAcademique: {
        id: anneeAcademiqueId,
        annee: yearCheck.rows[0].annee,
        etat: yearCheck.rows[0].etat
      }
    });

  } catch (err) {
    console.error("Erreur récupération étudiants:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur",
      code: "SERVER_ERROR",
      details: err.message
    });
  }
};

//===============================Fcontion d'exportation =======================================================
// Controller pour l'exportation des étudiants (sans pagination, pour Excel)
exports.exportEtudiantsByDepartement = async (req, res) => {
  try {
    const departementId = req.query.departement_id || req.user?.departement_id;
    const { anneeAcademiqueId } = req.query;
    const searchTerm = req.query.search || '';
    
    if (!departementId) {
      return res.status(400).json({
        success: false,
        message: "ID du département requis",
        code: "DEPARTMENT_ID_REQUIRED"
      });
    }

    // Validation de l'année académique
    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis",
        code: "ACADEMIC_YEAR_REQUIRED"
      });
    }

    // Vérifier que l'année académique existe
    const yearCheck = await db.query(
      `SELECT id, annee, etat FROM anneeacademique WHERE id = $1`,
      [anneeAcademiqueId]
    );

    if (yearCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Année académique non trouvée",
        code: "ACADEMIC_YEAR_NOT_FOUND"
      });
    }

    // Construction dynamique de la clause WHERE (mêmes filtres que getEtudiantsByDepartement)
    let whereClauses = ['e.departement_id = $1', 'e.annee_academique_id = $2'];
    let params = [departementId, anneeAcademiqueId];
    let paramCounter = 3;

    // Filtre par standing (par défaut 'Inscrit')
    const standingFilter = req.query.standing || 'Inscrit';
    whereClauses.push(`e.standing = $${paramCounter}`);
    params.push(standingFilter);
    paramCounter++;

    // Filtre par filière si fourni
    if (req.query.filiere) {
      whereClauses.push(`f.nom = $${paramCounter}`);
      params.push(req.query.filiere);
      paramCounter++;
    }
    
    // Filtre par niveau si fourni
    if (req.query.niveau) {
      whereClauses.push(`n.libelle = $${paramCounter}`);
      params.push(req.query.niveau);
      paramCounter++;
    }

    // Recherche textuelle si fournie
    if (searchTerm) {
      whereClauses.push(`(
        e.nom ILIKE $${paramCounter} OR 
        e.prenoms ILIKE $${paramCounter} OR 
        e.matricule ILIKE $${paramCounter} OR 
        e.code_unique ILIKE $${paramCounter} OR 
        e.matricule_iipea ILIKE $${paramCounter} OR 
        f.nom ILIKE $${paramCounter} OR 
        f.sigle ILIKE $${paramCounter} OR 
        e.telephone ILIKE $${paramCounter} OR 
        e.nationalite ILIKE $${paramCounter}
      )`);
      params.push(`%${searchTerm}%`);
      paramCounter++;
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Requête d'exportation simplifiée (sans les champs de documents pour éviter les doublons)
    const exportQuery = `
      SELECT 
        e.id,
        e.matricule,
        e.nom,
        e.prenoms,
        e.date_naissance,
        e.lieu_naissance,
        e.telephone,
        e.email,
        e.contact_parent,
        e.contact_parent_2,
        e.code_unique,
        e.ip_ministere,
        e.matricule_iipea,
        e.statut_scolaire,
        e.date_inscription,
        e.nationalite,
        e.standing,
        e.sexe,
        
        f.nom AS filiere,
        f.sigle AS filiere_sigle,
        
        n.libelle AS niveau,
        
        a.annee AS annee_academique,
        a.etat AS etat_annee,
        
        c.type_parcours,
        
        g.nom AS groupe_nom,
        
        COALESCE(s.montant_scolarite, 0) AS montant_total_scolarite,
        COALESCE(s.scolarite_verse, 0) AS montant_paye,
        COALESCE(s.scolarite_restante, 0) AS montant_restant,
        s.statut_etudiant,
        
        -- Calcul du pourcentage payé
        CASE 
          WHEN s.montant_scolarite IS NULL OR s.montant_scolarite = 0 THEN 0
          ELSE ROUND((COALESCE(s.scolarite_verse, 0) / s.montant_scolarite) * 100, 2)
        END AS pourcentage_paye
        
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      JOIN departement d ON e.departement_id = d.id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN curcus c ON e.curcus_id = c.id
      ${whereClause}
      ORDER BY e.nom ASC, e.prenoms ASC
    `;

    // Exécution de la requête (sans pagination)
    const result = await db.query(exportQuery, params);

    return res.status(200).json({
      success: true,
      data: result.rows,
      total: result.rows.length,
      anneeAcademique: {
        id: anneeAcademiqueId,
        annee: yearCheck.rows[0].annee,
        etat: yearCheck.rows[0].etat
      }
    });

  } catch (err) {
    console.error("Erreur exportation étudiants:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur",
      code: "SERVER_ERROR",
      details: err.message
    });
  }
};
//==============================================================================================================

exports.getEtudiantsByDepartementEnAttente = async (req, res) => {
  try {
    const departementId = req.query.departement_id || req.user?.departement_id;
    const { anneeAcademiqueId } = req.query;
    
    if (!departementId) {
      return res.status(400).json({
        success: false,
        message: "ID du département requis",
        code: "DEPARTMENT_ID_REQUIRED"
      });
    }

    // Validation de l'année académique
    if (!anneeAcademiqueId) {
      return res.status(400).json({
        success: false,
        message: "L'ID de l'année académique est requis",
        code: "ACADEMIC_YEAR_REQUIRED"
      });
    }

    // Vérifier que l'année académique existe
    const yearCheck = await db.query(
      `SELECT id, annee, etat FROM anneeacademique WHERE id = $1`,
      [anneeAcademiqueId]
    );

    if (yearCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Année académique non trouvée",
        code: "ACADEMIC_YEAR_NOT_FOUND"
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Construction dynamique de la clause WHERE
    let whereClauses = ['e.departement_id = $1', 'e.standing = $2', 'e.annee_academique_id = $3'];
    const params = [departementId, 'en attente', anneeAcademiqueId];

    // Ajouter le paramètre de recherche si fourni
    if (req.query.search) {
      const searchTerm = `%${req.query.search}%`;
      whereClauses.push(`
        (e.nom ILIKE $${params.length + 1} OR 
         e.prenoms ILIKE $${params.length + 1} OR 
         e.matricule ILIKE $${params.length + 1} OR 
         e.code_unique ILIKE $${params.length + 1} OR 
         e.matricule_iipea ILIKE $${params.length + 1} OR 
         f.nom ILIKE $${params.length + 1} OR 
         f.sigle ILIKE $${params.length + 1})
      `);
      params.push(searchTerm);
    }

    if (req.query.filiere) {
      whereClauses.push(`f.nom = $${params.length + 1}`);
      params.push(req.query.filiere);
    }
    if (req.query.niveau) {
      whereClauses.push(`n.libelle = $${params.length + 1}`);
      params.push(req.query.niveau);
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const dataQuery = `
      SELECT 
        e.id,
        e.matricule,
        e.nom,
        e.prenoms,
        e.date_naissance,
        e.lieu_naissance,
        e.pays_naissance, 
        e.telephone,
        e.email,
        e.lieu_residence,
        e.contact_parent,
        e.nom_parent_1, 
        e.nom_parent_2, 
        e.code_unique,
        e.annee_bac,
        e.serie_bac,
        e.statut_scolaire,
        e.etablissement_origine,
        e.inscrit_par,
        e.date_inscription,
        e.nationalite,
        e.standing,
        e.numero_table,
        e.sexe,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,
        e.photo_url,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        a.annee as annee_academique,
        a.etat as etat_annee,
        d.nom as departement,
        doc.extrait_naissance,
        doc.justificatif_identite,
        doc.dernier_diplome,
        doc.fiche_orientation
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      JOIN departement d ON e.departement_id = d.id
      LEFT JOIN document doc ON e.document_id = doc.id
      ${whereClause}
      ORDER BY e.date_inscription DESC, e.nom ASC, e.prenoms ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const countQuery = `
      SELECT COUNT(*) 
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      ${whereClause}
    `;

    const queryParams = [...params, limit, offset];

    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params)
    ]);

    return res.status(200).json({
      success: true,
      data: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      page,
      limit,
      anneeAcademique: {
        id: anneeAcademiqueId,
        annee: yearCheck.rows[0].annee,
        etat: yearCheck.rows[0].etat
      }
    });

  } catch (err) {
    console.error("Erreur récupération étudiants en attente:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur",
      code: "SERVER_ERROR",
      details: err.message
    });
  }
};


//==============================================================================================================//

exports.getEtudiantById = async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "ID étudiant invalide",
        code: "INVALID_STUDENT_ID"
      });
    }

    const query = `
      SELECT 
        e.id,
        e.matricule,
        e.nom,
        e.prenoms,
        e.date_naissance,
        e.lieu_naissance,
        e.telephone,
        e.email,
        e.lieu_residence,
        e.contact_parent,
        e.code_unique,
        e.pays_naissance,
        e.nom_parent_1,
        e.nom_parent_2,
        e.date_inscription,
        e.annee_bac,
        e.serie_bac,
        e.statut_scolaire,
        e.etablissement_origine,
        u.email as inscrit_par_email,
        e.date_inscription,
        e.nationalite,
        e.standing,
        e.numero_table,
        e.sexe,
        e.photo_url,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        a.annee as annee_academique,
        d.nom as departement,
        doc.extrait_naissance,
        doc.justificatif_identite,
        doc.dernier_diplome,
        doc.fiche_orientation,
        sc.montant_scolarite,
        sc.scolarite_verse,
        sc.scolarite_restante,
        e.statut_scolaire as statut_etudiant,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        c.id as classe_id,
        c.nom as classe_nom,
        c.description as classe_description,
        -- Informations sur le kit
        k.id as kit_id,
        k.montant as kit_montant,
        k.deposer as kit_deposer,
        k.date_enregistrement as kit_date_enregistrement,
        -- Informations sur la prise en charge
        pec.id as prise_en_charge_id,
        pec.reference as prise_en_charge_reference,
        pec.type_pec as prise_en_charge_type,
        pec.pourcentage_reduction as prise_en_charge_pourcentage,
        pec.montant_reduction as prise_en_charge_montant_reduction,
        pec.statut as prise_en_charge_statut,
        pec.date_demande as prise_en_charge_date_demande,
        pec.date_validation as prise_en_charge_date_validation,
        pec.valide_par as prise_en_charge_valide_par,
        pec.motif_refus as prise_en_charge_motif_refus
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      JOIN departement d ON e.departement_id = d.id
      LEFT JOIN document doc ON e.document_id = doc.id
      LEFT JOIN utilisateur u ON e.inscrit_par::integer = u.id
      LEFT JOIN scolarite sc ON e.scolarite_id = sc.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN kit k ON e.id = k.etudiant_id
      LEFT JOIN prise_en_charge pec ON e.id = pec.etudiant_id
      WHERE e.id = $1
    `;

    const result = await db.query(query, [parseInt(id)]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Étudiant non trouvé",
        code: "STUDENT_NOT_FOUND"
      });
    }

    const etudiantData = result.rows[0];
    
    // Formater les données de base
    const etudiant = {
      ...etudiantData,
      inscrit_par: etudiantData.inscrit_par_email,
      
      // Structurer les informations de groupe et classe
      groupe: {
        id: etudiantData.groupe_id,
        nom: etudiantData.groupe_nom,
        capacite_max: etudiantData.groupe_capacite,
        classe: {
          id: etudiantData.classe_id,
          nom: etudiantData.classe_nom,
          description: etudiantData.classe_description
        }
      },
      
      // Informations sur le kit
      kit: {
        id: etudiantData.kit_id,
        montant: etudiantData.kit_montant,
        deposer: etudiantData.kit_deposer,
        date_enregistrement: etudiantData.kit_date_enregistrement
      },
      
      // Informations sur la prise en charge
      prise_en_charge: {
        id: etudiantData.prise_en_charge_id,
        reference: etudiantData.prise_en_charge_reference,
        type: etudiantData.prise_en_charge_type,
        pourcentage_reduction: etudiantData.prise_en_charge_pourcentage,
        montant_reduction: etudiantData.prise_en_charge_montant_reduction,
        statut: etudiantData.prise_en_charge_statut,
        date_demande: etudiantData.prise_en_charge_date_demande,
        date_validation: etudiantData.prise_en_charge_date_validation,
        valide_par: etudiantData.prise_en_charge_valide_par,
        motif_refus: etudiantData.prise_en_charge_motif_refus
      }
    };
    
    // Supprimer les champs temporaires
    const fieldsToDelete = [
      'groupe_id', 'groupe_nom', 'groupe_capacite', 'classe_id', 'classe_nom', 'classe_description',
      'kit_id', 'kit_montant', 'kit_deposer', 'kit_date_enregistrement',
      'prise_en_charge_id', 'prise_en_charge_reference', 'prise_en_charge_type',
      'prise_en_charge_pourcentage', 'prise_en_charge_montant_reduction',
      'prise_en_charge_statut', 'prise_en_charge_date_demande',
      'prise_en_charge_date_validation', 'prise_en_charge_valide_par',
      'prise_en_charge_motif_refus', 'inscrit_par_email'
    ];
    
    fieldsToDelete.forEach(field => {
      delete etudiant[field];
    });

    // Gérer les cas où la scolarité n'est pas définie
    if (etudiant.montant_scolarite === null) {
      etudiant.montant_scolarite = 0;
      etudiant.scolarite_verse = 0;
      etudiant.scolarite_restante = 0;
      etudiant.statut_etudiant = "NON_DEFINI";
    }

    // Gérer les cas où le kit n'est pas défini
    if (etudiant.kit.id === null) {
      etudiant.kit = null;
    }

    // Gérer les cas où la prise en charge n'est pas définie
    if (etudiant.prise_en_charge.id === null) {
      etudiant.prise_en_charge = null;
    }

    return res.status(200).json({
      success: true,
      data: etudiant
    });

  } catch (err) {
    console.error("Erreur récupération étudiant:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur",
      code: "SERVER_ERROR",
      details: err.message
    });
  }
}

///=================================================================================================

exports.getRecuData = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    // Requête SQL optimisée avec correction des jointures
    const query = `
      SELECT 
        e.id, e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.photo_url,
        e.date_naissance, e.lieu_naissance, e.telephone, e.email, e.lieu_residence,
        e.contact_parent, e.contact_parent_2, e.nationalite, e.sexe, e.code_unique,
        e.statut_scolaire,
        f.nom as filiere, f.sigle as filiere_sigle,
        n.libelle as niveau,
        d.nom as departement,
        aa.annee as annee_academique,
        s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant,
        g.nom as groupe_nom,
        c.nom as classe_nom,
        p.id as paiement_id, p.montant as paiement_montant, p.date_paiement, p.methode,
        r.id as recu_id, r.numero_recu, r.date_emission, r.emetteur,
        k.montant as kit_montant, k.deposer as kit_deposer, k.date_enregistrement as kit_date,
        pec.id as pec_id, pec.type_pec, pec.pourcentage_reduction, pec.montant_reduction, 
        pec.statut as pec_statut, pec.reference as pec_reference,
        pec.date_demande as pec_date_demande, pec.date_validation as pec_date_validation,
        pec.valide_par as pec_valide_par, pec.motif_refus as pec_motif_refus
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN departement d ON e.departement_id = d.id
      LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN paiement p ON p.etudiant_id = e.id
      LEFT JOIN recu r ON p.recu_id = r.id
      LEFT JOIN kit k ON k.etudiant_id = e.id
      LEFT JOIN prise_en_charge pec ON pec.etudiant_id = e.id
      LEFT JOIN utilisateur admin ON pec.valide_par = admin.id
      WHERE e.id = $1
      ORDER BY p.date_paiement DESC, pec.date_demande DESC
    `;

    const result = await client.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }

    // Structurer les données
    const etudiantData = result.rows[0];
    
    // Récupérer toutes les PEC (il peut y en avoir plusieurs)
    const toutesLesPEC = result.rows
      .filter(row => row.pec_id !== null)
      .map(row => ({
        id: row.pec_id,
        type_pec: row.type_pec,
        pourcentage_reduction: row.pourcentage_reduction,
        montant_reduction: row.montant_reduction,
        reference: row.pec_reference,
        statut: row.pec_statut,
        date_demande: row.pec_date_demande,
        date_validation: row.pec_date_validation,
        valide_par: row.pec_valide_par,
        motif_refus: row.pec_motif_refus,
        valide_par_nom: row.admin_nom ? `${row.admin_nom} ${row.admin_prenoms}` : null
      }));

    // Trouver la PEC active (valide) ou la dernière en attente
    const pecActive = toutesLesPEC.find(pec => pec.statut === 'valide');
    const pecEnAttente = toutesLesPEC.find(pec => pec.statut === 'en_attente');
    const pecRefusee = toutesLesPEC.find(pec => pec.statut === 'refuse');

    const response = {
      etudiant: {
        // Informations personnelles
        id: etudiantData.id,
        nom: etudiantData.nom,
        prenoms: etudiantData.prenoms,
        matricule: etudiantData.matricule,
        matricule_iipea: etudiantData.matricule_iipea,
        photo_url: etudiantData.photo_url,
        date_naissance: etudiantData.date_naissance,
        lieu_naissance: etudiantData.lieu_naissance,
        telephone: etudiantData.telephone,
        email: etudiantData.email,
        lieu_residence: etudiantData.lieu_residence,
        contact_parent: etudiantData.contact_parent,
        contact_parent_2: etudiantData.contact_parent_2,
        nationalite: etudiantData.nationalite,
        sexe: etudiantData.sexe,
        code_unique: etudiantData.code_unique,
        statut_scolaire: etudiantData.statut_scolaire,
        
        // Informations académiques
        filiere: etudiantData.filiere,
        filiere_sigle: etudiantData.filiere_sigle,
        niveau: etudiantData.niveau,
        departement: etudiantData.departement,
        annee_academique: etudiantData.annee_academique,
        groupe: etudiantData.groupe_nom ? {
          nom: etudiantData.groupe_nom,
          classe: {
            nom: etudiantData.classe_nom
          }
        } : null,
        
        // Scolarité
        scolarite: {
          montant_scolarite: etudiantData.montant_scolarite,
          scolarite_verse: etudiantData.scolarite_verse || 0,
          scolarite_restante: etudiantData.scolarite_restante || etudiantData.montant_scolarite,
          statut_etudiant: etudiantData.statut_etudiant || 'NON_SOLDE'
        },
        
        // Kit
        kit: etudiantData.kit_montant !== null ? {
          montant: etudiantData.kit_montant,
          deposer: etudiantData.kit_deposer,
          date_enregistrement: etudiantData.kit_date
        } : null,
        
        // Prise en charge - on prend la PEC active ou la dernière en attente
        prise_en_charge: pecActive || pecEnAttente || pecRefusee || null,
        
        // Toutes les PEC pour historique
        toutes_prises_en_charge: toutesLesPEC
      },
      paiements: result.rows
        .filter(row => row.paiement_id !== null)
        .map(row => ({
          id: row.paiement_id,
          montant: row.paiement_montant,
          date_paiement: row.date_paiement,
          methode: row.methode,
          recu: {
            id: row.recu_id,
            numero_recu: row.numero_recu,
            date_emission: row.date_emission,
            emetteur: row.emetteur
          }
        }))
    };

    res.status(200).json({ success: true, data: response });
  } catch (error) {
    console.error('Erreur récupération données reçu:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  } finally {
    client.release();
  }
};