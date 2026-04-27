const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const db = require('../config/db.config');

// ================= MIDDLEWARE POUR BYPASS BODY-PARSER POUR FORMDATA =================
const disableBodyParserForFormData = (req, res, next) => {
  console.log(' Middleware disableBodyParserForFormData appelé');
  const contentType = req.headers['content-type'];
  console.log('Content-Type détecté:', contentType);
  
  const hasContentLength = req.headers['content-length'] && parseInt(req.headers['content-length']) > 0;
  
  if (contentType && contentType.includes('multipart/form-data')) {
    console.log('Désactivation des parsers pour FormData');
    req.body = {};
    req._body = false;
  } else if (req.method === 'POST' && hasContentLength && !contentType) {
    console.log(' Requête POST sans Content-Type détectée, traitement comme FormData');
    req.body = {};
    req._body = false;
  }
  
  next();
};

// ================= FONCTION POUR DÉTERMINER LE TYPE DE TRAITEMENT =================
/**
 * Détermine si un groupe doit être traité comme universitaire ou professionnel
 * Cas spécial: si le groupe est professionnel mais contient "Licence" dans son nom → traitement universitaire
 */
const determinerTypeTraitementPourCalcul = (typeFiliere, groupeNom) => {
    // Si c'est une filière universitaire → traitement universitaire
    if (typeFiliere === 'Universitaire' || typeFiliere === 'universitaire') {
        return 'universitaire';
    }
    
    // Si c'est une filière professionnelle
    if (typeFiliere === 'Professionnelles' || typeFiliere === 'professionnelles') {
        // Vérifier si le nom du groupe contient "Licence" (insensible à la casse)
        if (groupeNom && groupeNom.toUpperCase().includes('LICENCE')) {
            console.log(`🎓 Cas spécial détecté: Groupe professionnel "${groupeNom}" contient "Licence" → calcul universitaire`);
            return 'universitaire';
        }
        // Sinon traitement professionnel normal
        return 'professionnel';
    }
    
    // Par défaut → traitement universitaire
    return 'universitaire';
};

// ================= CONFIGURATION MULTER =================
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      console.log('📁 Multer destination appelée');
      const { groupeId, matiereId } = req.body;
      
      if (!groupeId || !matiereId) {
        console.error('❌ Erreur: groupeId et matiereId sont requis');
        return cb(new Error('groupeId et matiereId sont requis'));
      }
      
      const basePath = path.join(__dirname, '../../uploads/notes');
      const currentYear = new Date().getFullYear();
      const nextYear = currentYear + 1;
      const academicYear = `${currentYear}-${nextYear}`;
      
      const uploadPath = path.join(basePath, academicYear, `groupe-${groupeId}`);
      
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      
      cb(null, uploadPath);
    } catch (error) {
      console.error('❌ Erreur dans multer destination:', error);
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = path.parse(file.originalname).name.replace(/[^a-zA-Z0-9]/g, '_');
    const extension = path.extname(file.originalname);
    const filename = `${originalName}_${timestamp}${extension}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers Excel (.xlsx, .xls) sont autorisés'));
    }
  }
});

const handleUpload = (req, res, next) => {
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('multipart/form-data')) {
    return res.status(400).json({
      success: false,
      error: 'Content-Type doit être multipart/form-data'
    });
  }
  
  upload.single('fichier')(req, res, (err) => {
    if (err) {
      console.error('❌ Erreur upload multer:', err.message);
      let errorMessage = err.message;
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          errorMessage = 'Le fichier est trop volumineux (max 10MB)';
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          errorMessage = 'Nom de champ incorrect. Le fichier doit être envoyé avec le champ "fichier"';
        }
      }
      
      return res.status(400).json({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier fourni',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!req.body.groupeId || !req.body.matiereId) {
      return res.status(400).json({
        success: false,
        error: 'Les champs groupeId et matiereId sont requis',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log('  Upload multer réussi');
    console.log('📁 Fichier:', req.file.originalname);
    console.log('📦 Body:', req.body);
    
    next();
  });
};

// ================= FONCTIONS UTILITAIRES =================

// Fonction pour déterminer le type d'évaluation basé sur les notes cochées
function determinerTypeEvaluation(noteTypes) {
  const types = Array.isArray(noteTypes) ? noteTypes.map(t => t.toUpperCase()) : [noteTypes.toUpperCase()];
  
  const hasNote1 = types.some(t => t.includes('NOTE 1') || t.includes('NOTE1'));
  const hasNote2 = types.some(t => t.includes('NOTE 2') || t.includes('NOTE2'));
  const hasPartiel = types.some(t => t.includes('PARTIEL') || t.includes('FINAL') || t.includes('EXAMEN'));
  
  // Déterminer le type d'évaluation correspondant
  if (hasNote1 && hasNote2 && hasPartiel) {
    return 'note_1_note_2_partiel';
  } else if (hasNote1 && hasPartiel && !hasNote2) {
    return 'note_1_partiel';
  } else if (hasNote2 && hasPartiel && !hasNote1) {
    return 'note_2_partiel';
  } else if (hasPartiel && !hasNote1 && !hasNote2) {
    return 'partiel_only';
  } else if (hasNote1 && hasNote2 && !hasPartiel) {
    return 'note_1_note_2';
  } else if (hasNote1 && !hasNote2 && !hasPartiel) {
    return 'note_1_only';
  } else if (hasNote2 && !hasNote1 && !hasPartiel) {
    return 'note_2_only';
  } else {
    // Par défaut
    return 'note_1_note_2_partiel';
  }
}

// Fonction pour mettre à jour le type d'évaluation d'une matière
async function updateTypeEvaluation(matiereId, typeEvaluation) {
  try {
    console.log(`🔄 Mise à jour type évaluation pour matière ${matiereId}: ${typeEvaluation}`);
    
    const query = `
      UPDATE matiere 
      SET type_evaluation = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, nom, type_evaluation
    `;
    
    const result = await db.query(query, [typeEvaluation, matiereId]);
    
    if (result.rows.length > 0) {
      console.log(`  Type d'évaluation mis à jour: ${result.rows[0].nom} -> ${typeEvaluation}`);
      return result.rows[0];
    }
    
    return null;
  } catch (error) {
    console.error(`❌ Erreur mise à jour type évaluation: ${error.message}`);
    // Ne pas bloquer le traitement si l'update échoue
    return null;
  }
}

async function getGroupeInfo(groupeId) {
  try {
    console.log(`  Récupération info groupe ID: ${groupeId}`);
    const query = `SELECT g.*, c.nom as classe_nom FROM groupe g LEFT JOIN classe c ON g.classe_id = c.id WHERE g.id = $1`;
    const result = await db.query(query, [groupeId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Groupe avec ID ${groupeId} non trouvé`);
    }
    
    return result.rows[0];
  } catch (error) {
    console.error(`❌ Erreur récupération groupe: ${error.message}`);
    throw error;
  }
}

async function getMatiereInfo(matiereId) {
  try {
    console.log(`  Récupération info matière ID: ${matiereId}`);
    const query = `
      SELECT 
        m.*, 
        ue.id as ue_id,
        ue.libelle as ue_libelle,
        ue.semestre_id,
        ue.maquette_id,
        sem.nom as semestre_nom,
        maq.parcour,
        maq.filiere_id,
        f.nom as filiere_nom,
        tf.libelle as type_filiere, 
        COALESCE(m.type_evaluation, 'note_1_note_2_partiel') as type_evaluation
      FROM matiere m
      LEFT JOIN ue ON m.ue_id = ue.id
      LEFT JOIN semestre sem ON ue.semestre_id = sem.id
      LEFT JOIN maquette maq ON ue.maquette_id = maq.id
      LEFT JOIN filiere f ON maq.filiere_id = f.id
      LEFT JOIN typefiliere tf ON f.type_filiere_id = tf.id  
      WHERE m.id = $1
    `;
    
    const result = await db.query(query, [matiereId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Matière avec ID ${matiereId} non trouvée`);
    }
    
    const matiereInfo = result.rows[0];
    const type = matiereInfo.type_evaluation || 'note_1_note_2_partiel';
    
    // Ajouter le type de parcour au format attendu par calculerMoyenne
    matiereInfo.parcour_type = matiereInfo.type_filiere || 'Universitaire'; // Par défaut Universitaire
    
    // Déterminer quelles notes sont actives selon le type
    switch(type) {
      case 'note_1_note_2_partiel':
        matiereInfo.active_notes = { note1: true, note2: true, partiel: true };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'note_1_partiel':
        matiereInfo.active_notes = { note1: true, note2: false, partiel: true };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'note_2_partiel':
        matiereInfo.active_notes = { note1: false, note2: true, partiel: true };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'partiel_only':
        matiereInfo.active_notes = { note1: false, note2: false, partiel: true };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'note_1_note_2':
        matiereInfo.active_notes = { note1: true, note2: true, partiel: false };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'note_1_only':
        matiereInfo.active_notes = { note1: true, note2: false, partiel: false };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      case 'note_2_only':
        matiereInfo.active_notes = { note1: false, note2: true, partiel: false };
        matiereInfo.description_type = getDescriptionTypeEvaluation(type);
        break;
      default:
        matiereInfo.active_notes = { note1: true, note2: true, partiel: true };
        matiereInfo.description_type = "Type non spécifié - toutes notes actives";
    }
    
    // Log pour débogage
    console.log(`  Type de filière détecté: ${matiereInfo.type_filiere} -> parcour_type: ${matiereInfo.parcour_type}`);
    
    return matiereInfo;
  } catch (error) {
    console.error(`❌ Erreur récupération matière: ${error.message}`);
    throw error;
  }
}

// Fonction pour récupérer le nom du groupe (pour déterminer le type de traitement)
async function getGroupeNom(groupeId) {
  try {
    const query = `SELECT nom FROM groupe WHERE id = $1`;
    const result = await db.query(query, [groupeId]);
    if (result.rows.length > 0) {
      return result.rows[0].nom;
    }
    return null;
  } catch (error) {
    console.error(`❌ Erreur récupération nom groupe: ${error.message}`);
    return null;
  }
}

// FONCTION CORRIGÉE : Récupérer ou mettre à jour un enseignement existant
async function getOrUpdateEnseignement(professeurId, matiereId, groupeId, anneeAcademique) {
  try {
    console.log(`🎯 Recherche/mise à jour enseignement: matiere=${matiereId}, groupe=${groupeId}, année=${anneeAcademique}`);
    
    // Vérifier s'il existe déjà un enseignement pour cette matière, groupe et année académique
    const findQuery = `
      SELECT id, professeur_id, created_at 
      FROM enseignement 
      WHERE matiere_id = $1 AND groupe_id = $2 AND annee_academique = $3
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    const existing = await db.query(findQuery, [matiereId, groupeId, anneeAcademique]);
    
    if (existing.rows.length > 0) {
      const enseignement = existing.rows[0];
      console.log(`  Enseignement existant trouvé: ${enseignement.id} (prof: ${enseignement.professeur_id})`);
      
      // Mettre à jour le professeur si différent
      if (enseignement.professeur_id !== parseInt(professeurId)) {
        console.log(`  Mise à jour du professeur: ${enseignement.professeur_id} -> ${professeurId}`);
        const updateQuery = `
          UPDATE enseignement 
          SET professeur_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING id
        `;
        
        const updated = await db.query(updateQuery, [professeurId, enseignement.id]);
        console.log(`✅ Enseignement mis à jour: ${updated.rows[0].id}`);
        return updated.rows[0].id;
      }
      
      console.log(`  Enseignement conservé: ${enseignement.id}`);
      return enseignement.id;
    }
    
    // Créer un nouvel enseignement seulement s'il n'en existe pas
    console.log(`🆕 Création nouvel enseignement`);
    const insertQuery = `
      INSERT INTO enseignement (professeur_id, matiere_id, groupe_id, annee_academique, created_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING id
    `;
    
    const newEnseignement = await db.query(insertQuery, [professeurId, matiereId, groupeId, anneeAcademique]);
    
    console.log(`✅ Nouvel enseignement créé: ${newEnseignement.rows[0].id}`);
    return newEnseignement.rows[0].id;
  } catch (error) {
    console.error(`❌ Erreur création/mise à jour enseignement: ${error.message}`);
    throw error;
  }
}

// Fonction pour récupérer ou créer la session avec format "SESSION 1 2025-2026"
async function getOrCreateSession(groupeId) {
  try {
    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;
    const anneeAcademique = `${currentYear}-${nextYear}`;
    
    console.log(`  Recherche session pour groupe ${groupeId}`);
    
    // 1. Récupérer l'année académique du groupe via un étudiant
    const anneeQuery = `
      SELECT DISTINCT annee_academique_id 
      FROM etudiant 
      WHERE groupe_id = $1 
      AND annee_academique_id IS NOT NULL 
      LIMIT 1
    `;
    
    const anneeResult = await db.query(anneeQuery, [groupeId]);
    let anneeAcademiqueId = null;
    
    if (anneeResult.rows.length > 0) {
      anneeAcademiqueId = anneeResult.rows[0].annee_academique_id;
      console.log(`📅 Année académique ID trouvée: ${anneeAcademiqueId}`);
    } else {
      console.log('⚠️ Aucune année académique trouvée pour le groupe');
      // Chercher l'année académique par son année (annee)
      const anneeNomQuery = `SELECT id, annee FROM anneeacademique WHERE annee = $1`;
      const anneeNomResult = await db.query(anneeNomQuery, [anneeAcademique]);
      if (anneeNomResult.rows.length > 0) {
        anneeAcademiqueId = anneeNomResult.rows[0].id;
        console.log(`📅 Année académique trouvée par annee: ${anneeAcademiqueId}`);
      }
    }
    
    // 2. Chercher une session existante pour cet année académique
    const findQuery = `
      SELECT s.*, a.annee as annee_academique_nom
      FROM session s
      JOIN anneeacademique a ON s.annee_academique_id = a.id
      WHERE s.annee_academique_id = $1 
      ORDER BY s.id DESC 
      LIMIT 1
    `;
    
    let sessionResult;
    if (anneeAcademiqueId) {
      sessionResult = await db.query(findQuery, [anneeAcademiqueId]);
    } else {
      // Fallback: chercher par nom d'année
      const fallbackQuery = `
        SELECT s.*, a.annee as annee_academique_nom
        FROM session s
        JOIN anneeacademique a ON s.annee_academique_id = a.id
        WHERE a.annee LIKE $1 
        ORDER BY s.id DESC 
        LIMIT 1
      `;
      sessionResult = await db.query(fallbackQuery, [`%${anneeAcademique}%`]);
    }
    
    if (sessionResult.rows.length > 0) {
      console.log(`  Session existante trouvée: ${sessionResult.rows[0].nom}`);
      return {
        session: sessionResult.rows[0],
        anneeAcademique: sessionResult.rows[0].annee_academique_nom
      };
    }
    
    // 3. Créer une nouvelle session avec format "SESSION 1 2025-2026"
    console.log(`🔄 Création nouvelle session pour ${anneeAcademique}`);
    
    // Si pas d'année académique ID, on doit d'abord créer l'année académique
    if (!anneeAcademiqueId) {
      const createAnneeQuery = `
        INSERT INTO anneeacademique (annee, etat)
        VALUES ($1, 'Actif')
        RETURNING id
      `;
      const anneeResult = await db.query(createAnneeQuery, [anneeAcademique]);
      anneeAcademiqueId = anneeResult.rows[0].id;
      console.log(`  Nouvelle année académique créée: ${anneeAcademiqueId}`);
    }
    
    // Compter combien de sessions existent pour cette année
    const countQuery = `SELECT COUNT(*) as count FROM session WHERE annee_academique_id = $1`;
    const countResult = await db.query(countQuery, [anneeAcademiqueId]);
    const sessionNumero = parseInt(countResult.rows[0].count) + 1;
    
    const sessionNom = `SESSION ${sessionNumero} ${anneeAcademique}`;
    
    const createQuery = `
      INSERT INTO session (nom, annee_academique_id)
      VALUES ($1, $2)
      RETURNING *
    `;
    
    const newSession = await db.query(createQuery, [sessionNom, anneeAcademiqueId]);
    
    // Récupérer l'année académique pour le retour
    const anneeQueryFinal = `SELECT annee FROM anneeacademique WHERE id = $1`;
    const anneeResultFinal = await db.query(anneeQueryFinal, [anneeAcademiqueId]);
    const anneeAcademiqueNom = anneeResultFinal.rows[0].annee;
    
    console.log(`  Nouvelle session créée: ${newSession.rows[0].nom} (ID: ${newSession.rows[0].id})`);
    
    return {
      session: { ...newSession.rows[0], annee_academique_nom: anneeAcademiqueNom },
      anneeAcademique: anneeAcademiqueNom
    };
  } catch (error) {
    console.error(`❌ Erreur session: ${error.message}`);
    throw new Error(`Erreur session: ${error.message}`);
  }
}

async function getEtudiantsDuGroupe(groupeId) {
  try {
    console.log(`  Récupération étudiants du groupe ID: ${groupeId}`);
    const query = `
      SELECT 
        id, matricule, code_unique, matricule_iipea, 
        nom, prenoms, groupe_id, annee_academique_id
      FROM etudiant 
      WHERE groupe_id = $1 
      ORDER BY nom, prenoms
    `;
    
    const result = await db.query(query, [groupeId]);
    console.log(`📊 ${result.rows.length} étudiants récupérés pour le groupe ${groupeId}`);
    
    return result.rows;
  } catch (error) {
    console.error(`❌ Erreur récupération étudiants: ${error.message}`);
    throw error;
  }
}

function parseExcelFile(filePath, noteTypes) {
  try {
    console.log(`📊 Parsing fichier Excel: ${filePath}`);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Fichier non trouvé: ${filePath}`);
    }
    
    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    
    if (rawData.length < 2) {
      throw new Error('Le fichier Excel est vide ou ne contient pas de données');
    }
    
    const headers = rawData[0].map(h => {
      if (h === null || h === undefined) return '';
      return h.toString().trim().toUpperCase();
    });
    
    console.log('📋 En-têtes détectées:', headers);
    
    const findColumn = (possibleNames) => {
      for (const name of possibleNames) {
        const upperName = name.toUpperCase();
        const index = headers.indexOf(upperName);
        if (index !== -1) {
          return { name: name, index: index, originalHeader: headers[index] };
        }
      }
      
      for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        for (const name of possibleNames) {
          if (header.includes(name.toUpperCase()) || name.toUpperCase().includes(header)) {
            return { name: name, index: i, originalHeader: header };
          }
        }
      }
      
      return null;
    };
    
    const codeCol = findColumn(['CODE', 'MATRICULE', 'MATRICULE_IIPEA', 'NUMERO', 'ID', 'IDENTIFIANT']);
    if (!codeCol) {
      throw new Error(`Colonne "Code" non trouvée. Colonnes disponibles: ${headers.join(', ')}`);
    }
    
    const nomCol = findColumn(['NOM', 'NOM_ETUDIANT', 'NOM FAMILLE', 'LASTNAME']) || 
                  { name: 'NOM', index: codeCol.index + 1, originalHeader: 'NOM' };
    
    const prenomCol = findColumn(['PRENOM', 'PRENOMS', 'PRENOM_ETUDIANT', 'FIRSTNAME']) || 
                     { name: 'PRENOM', index: nomCol.index + 1, originalHeader: 'PRENOM' };
    
    const noteColumns = [];
    const noteMappings = {
      'NOTE 1': ['NOTE 1', 'NOTE1', 'NOTE_1', 'EXAMEN 1', 'EXAMEN1', 'CONTROLE 1', 'CC1'],
      'NOTE 2': ['NOTE 2', 'NOTE2', 'NOTE_2', 'EXAMEN 2', 'EXAMEN2', 'CONTROLE 2', 'CC2'],
      'PARTIEL': ['PARTIEL', 'EXAMEN FINAL', 'FINAL', 'COMPOSITION', 'EXAMEN', 'PARTIEL FINAL']
    };
    
    if (!Array.isArray(noteTypes)) {
      noteTypes = ['Note 1'];
    }
    
    noteTypes.forEach(type => {
      const typeUpper = type.toUpperCase();
      const possibleNames = noteMappings[typeUpper] || [typeUpper.replace(/ /g, '_')];
      const noteCol = findColumn(possibleNames);
      
      if (noteCol) {
        let noteType;
        if (typeUpper.includes('NOTE 1') || typeUpper.includes('NOTE1')) noteType = 'note_1';
        else if (typeUpper.includes('NOTE 2') || typeUpper.includes('NOTE2')) noteType = 'note_2';
        else if (typeUpper.includes('PARTIEL') || typeUpper.includes('FINAL')) noteType = 'partiel';
        else noteType = type.toLowerCase().replace(/ /g, '_');
        
        noteColumns.push({
          originalName: noteCol.name,
          index: noteCol.index,
          type: noteType,
          header: noteCol.originalHeader
        });
      } else {
        noteColumns.push({
          originalName: type,
          index: -1,
          type: type.toLowerCase().replace(/ /g, '_'),
          header: type
        });
      }
    });
    
    const studentsData = [];
    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      
      if (!row || row.length === 0 || row.every(cell => !cell || cell.toString().trim() === '')) {
        continue;
      }
      
      const codeValue = row[codeCol.index];
      const nomValue = row[nomCol.index];
      const prenomValue = row[prenomCol.index];
      
      if (!codeValue || codeValue.toString().trim() === '') {
        continue;
      }
      
      const student = {
        matriculeIipea: codeValue.toString().trim(),
        nom: nomValue ? nomValue.toString().trim() : '',
        prenom: prenomValue ? prenomValue.toString().trim() : '',
        ligne: i + 1,
        note_1: null,
        note_2: null,
        partiel: null
      };
      
      noteColumns.forEach(noteCol => {
        if (noteCol.index !== -1 && noteCol.index < row.length && row[noteCol.index] !== undefined && row[noteCol.index] !== null) {
          let noteValue = row[noteCol.index];
          
          if (typeof noteValue === 'string') {
            noteValue = noteValue.replace(',', '.').trim().toUpperCase();
            
            // RÈGLES DE CONVERSION:
            // - Si c'est vide ou ABSENT, etc. = null (non évalué)
            // - Si c'est "-" = 0 (évalué mais a eu 0)
            // - Si c'est un nombre = la note
            
            if (noteValue === '' || noteValue === 'ABS' || 
                noteValue === 'ABSENT' || noteValue === 'ABJ' || 
                noteValue === 'ABANDON' || noteValue === 'N/A' || 
                noteValue === 'NULL' || noteValue === 'NA') {
              student[noteCol.type] = null;
            }
            else if (noteValue === '-') {
              student[noteCol.type] = 0; // ← "-" devient 0
            }
            else {
              const noteNum = parseFloat(noteValue);
              if (!isNaN(noteNum) && isFinite(noteNum)) {
                student[noteCol.type] = noteNum;
              } else {
                student[noteCol.type] = null;
              }
            }
          }
          else if (noteValue instanceof Date) {
            student[noteCol.type] = null;
          }
          else {
            const noteNum = parseFloat(noteValue);
            if (!isNaN(noteNum) && isFinite(noteNum)) {
              student[noteCol.type] = noteNum;
            } else {
              student[noteCol.type] = null;
            }
          }
        }
      });
      
      studentsData.push(student);
    }
    
    if (studentsData.length === 0) {
      throw new Error('Aucun étudiant valide trouvé dans le fichier Excel.');
    }
    
    console.log(`  ${studentsData.length} étudiants valides extraits du fichier`);
    return studentsData;
    
  } catch (error) {
    console.error(`❌ Erreur parsing Excel: ${error.message}`);
    throw new Error(`Erreur parsing Excel: ${error.message}`);
  }
}

function findEtudiantByMatriculeIipea(etudiants, matriculeIipea) {
  if (!matriculeIipea || !etudiants || etudiants.length === 0) {
    return null;
  }
  
  const matriculeRecherche = matriculeIipea.toString().trim();
  
  for (const etudiant of etudiants) {
    if (etudiant.matricule_iipea && etudiant.matricule_iipea.toString().trim() === matriculeRecherche) {
      return etudiant;
    }
  }
  
  const rechercheSansEspaces = matriculeRecherche.replace(/\s/g, '');
  for (const etudiant of etudiants) {
    const matriculeSansEspaces = etudiant.matricule_iipea ? etudiant.matricule_iipea.toString().trim().replace(/\s/g, '') : '';
    if (matriculeSansEspaces === rechercheSansEspaces) {
      return etudiant;
    }
  }
  
  const rechercheLower = matriculeRecherche.toLowerCase();
  for (const etudiant of etudiants) {
    if (etudiant.matricule_iipea && etudiant.matricule_iipea.toString().trim().toLowerCase() === rechercheLower) {
      return etudiant;
    }
  }
  
  for (const etudiant of etudiants) {
    if (etudiant.code_unique && etudiant.code_unique.toString().trim() === matriculeRecherche) {
      return etudiant;
    }
  }
  
  for (const etudiant of etudiants) {
    if (etudiant.matricule && etudiant.matricule.toString().trim() === matriculeRecherche) {
      return etudiant;
    }
  }
  
  return null;
}

// ================= FONCTION DE CALCUL CORRIGÉE =================
/**
 * Calcule la moyenne selon les règles :
 * - Si typeTraitement = 'universitaire' : utilisation des pondérations
 * - Si typeTraitement = 'professionnel' : moyenne simple
 * 
 * Pondérations pour universitaire selon le type d'évaluation :
 *   - note_1_note_2_partiel : Note1=20%, Note2=20%, Partiel=60%
 *   - note_1_partiel : Note1=40%, Partiel=60%
 *   - note_2_partiel : Note2=40%, Partiel=60%
 *   - partiel_only : Partiel=100%
 *   - note_1_note_2 : Note1=50%, Note2=50%
 *   - note_1_only : Note1=100%
 *   - note_2_only : Note2=100%
 */
function calculerMoyenne(note1, note2, partiel, typeEvaluation, typeTraitement) {
  console.log('\n🔍 ===== DÉBUT CALCUL MOYENNE =====');
  
  console.log('📋 Paramètres reçus:');
  console.log(`   - type_evaluation: "${typeEvaluation}"`);
  console.log(`   - type_traitement: "${typeTraitement}"`);
  console.log(`   - notes brutes - note1:`, note1, `note2:`, note2, `partiel:`, partiel);
  
  const isUniversitaire = typeTraitement === 'universitaire';
  
  // IMPORTANT: null = non saisie (ne pas prendre en compte)
  //            nombre = note saisie (peut être 0)
  const n1 = (note1 !== null && note1 !== undefined) ? parseFloat(note1) : null;
  const n2 = (note2 !== null && note2 !== undefined) ? parseFloat(note2) : null;
  const p = (partiel !== null && partiel !== undefined) ? parseFloat(partiel) : null;
  
  console.log(`📊 Notes parsées - n1: ${n1}, n2: ${n2}, p: ${p}`);
  
  // DÉTERMINER LES NOTES ACTIVES EN FONCTION DU TYPE D'ÉVALUATION
  let active_notes = { note1: false, note2: false, partiel: false };
  
  switch(typeEvaluation) {
    case 'note_1_note_2_partiel':
      active_notes = { note1: true, note2: true, partiel: true };
      console.log(`✅ Type: note_1_note_2_partiel → toutes notes actives`);
      break;
    case 'note_1_partiel':
      active_notes = { note1: true, note2: false, partiel: true };
      console.log(`✅ Type: note_1_partiel → Note1 et Partiel actifs`);
      break;
    case 'note_2_partiel':
      active_notes = { note1: false, note2: true, partiel: true };
      console.log(`✅ Type: note_2_partiel → Note2 et Partiel actifs`);
      break;
    case 'partiel_only':
      active_notes = { note1: false, note2: false, partiel: true };
      console.log(`✅ Type: partiel_only → seulement Partiel actif`);
      break;
    case 'note_1_note_2':
      active_notes = { note1: true, note2: true, partiel: false };
      console.log(`✅ Type: note_1_note_2 → Note1 et Note2 actifs`);
      break;
    case 'note_1_only':
      active_notes = { note1: true, note2: false, partiel: false };
      console.log(`✅ Type: note_1_only → seulement Note1 actif`);
      break;
    case 'note_2_only':
      active_notes = { note1: false, note2: true, partiel: false };
      console.log(`✅ Type: note_2_only → seulement Note2 actif`);
      break;
    default:
      active_notes = { note1: true, note2: true, partiel: true };
      console.log(`⚠️ Type inconnu "${typeEvaluation}", fallback toutes notes actives`);
  }
  
  console.log(`   Notes actives déterminées: note1=${active_notes.note1}, note2=${active_notes.note2}, partiel=${active_notes.partiel}`);
  
  // CAS UNIVERSITAIRE (avec pondérations)
  if (isUniversitaire) {
    let totalPondere = 0;
    let poidsTotal = 0;
    
    console.log(`\n📐 Application des pondérations pour "${typeEvaluation}":`);
    
    // PONDÉRATIONS selon le type d'évaluation
    switch(typeEvaluation) {
      case 'note_1_note_2_partiel':
        console.log(`   → Règle: Note1(20%) + Note2(20%) + Partiel(60%)`);
        
        if (active_notes.note1 && n1 !== null) {
          const contribution = n1 * 0.2;
          totalPondere += contribution;
          poidsTotal += 0.2;
          console.log(`     ✓ Note1: ${n1} × 0.2 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note1) {
          console.log(`     ✗ Note1: non saisie`);
        }
        
        if (active_notes.note2 && n2 !== null) {
          const contribution = n2 * 0.2;
          totalPondere += contribution;
          poidsTotal += 0.2;
          console.log(`     ✓ Note2: ${n2} × 0.2 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note2) {
          console.log(`     ✗ Note2: non saisie`);
        }
        
        if (active_notes.partiel && p !== null) {
          const contribution = p * 0.6;
          totalPondere += contribution;
          poidsTotal += 0.6;
          console.log(`     ✓ Partiel: ${p} × 0.6 = ${contribution.toFixed(2)}`);
        } else if (active_notes.partiel) {
          console.log(`     ✗ Partiel: non saisie`);
        }
        break;
        
      case 'note_1_partiel':
        console.log(`   → Règle: Note1(40%) + Partiel(60%)`);
        
        if (active_notes.note1 && n1 !== null) {
          const contribution = n1 * 0.4;
          totalPondere += contribution;
          poidsTotal += 0.4;
          console.log(`     ✓ Note1: ${n1} × 0.4 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note1) {
          console.log(`     ✗ Note1: non saisie`);
        }
        
        if (active_notes.partiel && p !== null) {
          const contribution = p * 0.6;
          totalPondere += contribution;
          poidsTotal += 0.6;
          console.log(`     ✓ Partiel: ${p} × 0.6 = ${contribution.toFixed(2)}`);
        } else if (active_notes.partiel) {
          console.log(`     ✗ Partiel: non saisie`);
        }
        break;
        
      case 'note_2_partiel':
        console.log(`   → Règle: Note2(40%) + Partiel(60%)`);
        
        if (active_notes.note2 && n2 !== null) {
          const contribution = n2 * 0.4;
          totalPondere += contribution;
          poidsTotal += 0.4;
          console.log(`     ✓ Note2: ${n2} × 0.4 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note2) {
          console.log(`     ✗ Note2: non saisie`);
        }
        
        if (active_notes.partiel && p !== null) {
          const contribution = p * 0.6;
          totalPondere += contribution;
          poidsTotal += 0.6;
          console.log(`     ✓ Partiel: ${p} × 0.6 = ${contribution.toFixed(2)}`);
        } else if (active_notes.partiel) {
          console.log(`     ✗ Partiel: non saisie`);
        }
        break;
        
      case 'partiel_only':
        console.log(`   → Règle: Partiel(100%)`);
        
        if (active_notes.partiel && p !== null) {
          console.log(`     ✓ Partiel seul: ${p}`);
          console.log(`   ✅ Moyenne finale: ${p}`);
          console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
          return Math.round(p * 100) / 100;
        }
        console.log(`     ✗ Partiel: non saisi`);
        console.log(`   ✅ Moyenne finale: 0`);
        console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
        return 0;
        
      case 'note_1_note_2':
        console.log(`   → Règle: Note1(50%) + Note2(50%)`);
        
        if (active_notes.note1 && n1 !== null) {
          const contribution = n1 * 0.5;
          totalPondere += contribution;
          poidsTotal += 0.5;
          console.log(`     ✓ Note1: ${n1} × 0.5 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note1) {
          console.log(`     ✗ Note1: non saisie`);
        }
        
        if (active_notes.note2 && n2 !== null) {
          const contribution = n2 * 0.5;
          totalPondere += contribution;
          poidsTotal += 0.5;
          console.log(`     ✓ Note2: ${n2} × 0.5 = ${contribution.toFixed(2)}`);
        } else if (active_notes.note2) {
          console.log(`     ✗ Note2: non saisie`);
        }
        break;
        
      case 'note_1_only':
        console.log(`   → Règle: Note1(100%)`);
        
        if (active_notes.note1 && n1 !== null) {
          console.log(`     ✓ Note1 seule: ${n1}`);
          console.log(`   ✅ Moyenne finale: ${n1}`);
          console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
          return Math.round(n1 * 100) / 100;
        }
        console.log(`     ✗ Note1: non saisie`);
        console.log(`   ✅ Moyenne finale: 0`);
        console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
        return 0;
        
      case 'note_2_only':
        console.log(`   → Règle: Note2(100%)`);
        
        if (active_notes.note2 && n2 !== null) {
          console.log(`     ✓ Note2 seule: ${n2}`);
          console.log(`   ✅ Moyenne finale: ${n2}`);
          console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
          return Math.round(n2 * 100) / 100;
        }
        console.log(`     ✗ Note2: non saisie`);
        console.log(`   ✅ Moyenne finale: 0`);
        console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
        return 0;
        
      default:
        console.log(`⚠️ Type non reconnu "${typeEvaluation}", fallback moyenne simple`);
        // Fallback: moyenne simple des notes actives présentes
        const notesValides = [];
        if (n1 !== null) notesValides.push(n1);
        if (n2 !== null) notesValides.push(n2);
        if (p !== null) notesValides.push(p);
        
        if (notesValides.length === 0) {
          console.log(`   ✅ Moyenne finale: 0 (aucune note)`);
          console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
          return 0;
        }
        
        const somme = notesValides.reduce((acc, note) => acc + note, 0);
        const moyenne = somme / notesValides.length;
        console.log(`   ✓ Notes valides: ${notesValides.join(', ')}`);
        console.log(`   ✓ Calcul: ${somme} / ${notesValides.length} = ${moyenne.toFixed(2)}`);
        console.log(`   ✅ Moyenne finale: ${moyenne.toFixed(2)}`);
        console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
        return Math.round(moyenne * 100) / 100;
    }
    
    // Si aucune note active n'est présente
    if (poidsTotal === 0) {
      console.log(`   ⚠️ Aucune note active présente`);
      console.log(`   ✅ Moyenne finale: 0`);
      console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
      return 0;
    }
    
    // Calculer la moyenne
    let moyenne;
    if (poidsTotal === 1.0) {
      // Toutes les notes sont présentes, pas de normalisation
      moyenne = totalPondere;
      console.log(`\n📊 Toutes notes présentes (poids total = 100%)`);
      console.log(`   → Moyenne = ${totalPondere.toFixed(2)}`);
    } else {
      // Certaines notes sont manquantes, normalisation
      moyenne = totalPondere / poidsTotal;
      console.log(`\n📊 Normalisation (poids total = ${(poidsTotal * 100).toFixed(0)}%)`);
      console.log(`   → Total pondéré: ${totalPondere.toFixed(2)}`);
      console.log(`   → Poids total: ${poidsTotal}`);
      console.log(`   → Moyenne normalisée: ${totalPondere.toFixed(2)} / ${poidsTotal} = ${moyenne.toFixed(2)}`);
    }
    
    console.log(`   ✅ Moyenne finale: ${moyenne.toFixed(2)}`);
    console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
    
    return Math.round(moyenne * 100) / 100;
  }
  
  // CAS PROFESSIONNEL (moyenne simple)
  else {
    console.log(`\n🏢 Mode professionnel - moyenne simple`);
    const notesValides = [];
    if (n1 !== null) notesValides.push(n1);
    if (n2 !== null) notesValides.push(n2);
    if (p !== null) notesValides.push(p);
    
    if (notesValides.length === 0) {
      console.log(`   ⚠️ Aucune note valide`);
      console.log(`   ✅ Moyenne finale: 0`);
      console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
      return 0;
    }
    
    const somme = notesValides.reduce((acc, note) => acc + note, 0);
    const moyenne = somme / notesValides.length;
    console.log(`   ✓ Notes valides: ${notesValides.join(', ')}`);
    console.log(`   ✓ Calcul: ${somme} / ${notesValides.length} = ${moyenne.toFixed(2)}`);
    console.log(`   ✅ Moyenne finale: ${moyenne.toFixed(2)}`);
    console.log('🔍 ===== FIN CALCUL MOYENNE =====\n');
    
    return Math.round(moyenne * 100) / 100;
  }
}

// Vérifier si une note existe déjà pour un étudiant dans un enseignement donné
async function checkExistingNote(etudiantId, enseignementId, sessionId) {
  try {
    const query = `SELECT id FROM note WHERE etudiant_id = $1 AND enseignement_id = $2 AND session_id = $3 LIMIT 1`;
    const result = await db.query(query, [etudiantId, enseignementId, sessionId]);
    
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    console.error('❌ Erreur vérification note existante:', error.message);
    return null;
  }
}

// Insérer ou mettre à jour une note - VERSION CORRIGÉE
async function upsertNote(noteData, fichierSource, noteId = null) {
  try {
    console.log(`📝 Upsert note avec données:`, {
      note1: noteData.note1,
      note2: noteData.note2,
      partiel: noteData.partiel,
      moyenne: noteData.moyenne,
      coefficient: noteData.coefficient
    });
    
    // VALIDATION ET NORMALISATION DES DONNÉES
    const validateAndFormat = (value) => {
      if (value === null || value === undefined) {
        return null; // NULL pour PostgreSQL
      }
      
      const num = parseFloat(value);
      if (isNaN(num)) {
        return null;
      }
      
      // Arrondir à 2 décimales
      const rounded = Math.round(num * 100) / 100;
      
      // Vérifier les limites (0-20)
      if (rounded < 0) return 0;
      if (rounded > 20) return 20;
      
      return rounded;
    };
    
    // Formater les notes - IMPORTANT: ne pas convertir null en 0
    const note1 = validateAndFormat(noteData.note1);
    const note2 = validateAndFormat(noteData.note2);
    const partiel = validateAndFormat(noteData.partiel);
    const moyenne = validateAndFormat(noteData.moyenne);
    
    // Formater le coefficient
    let coefficient = 1;
    if (noteData.coefficient) {
      const coefNum = parseFloat(noteData.coefficient);
      if (!isNaN(coefNum) && coefNum > 0) {
        coefficient = coefNum;
      }
    }
    
    console.log(`📝 Données formatées:`, {
      note1, note2, partiel, moyenne, coefficient
    });
    
    if (noteId) {
      const updateQuery = `
        UPDATE note SET
          note1 = $1, note2 = $2, partiel = $3, moyenne = $4,
          coefficient = $5, fichier_source = $6, updated_at = CURRENT_TIMESTAMP
        WHERE id = $7
        RETURNING id
      `;
      
      console.log(`🔄 Mise à jour note ID: ${noteId}`);
      const result = await db.query(updateQuery, [
        note1, note2, partiel, moyenne,
        coefficient, fichierSource, noteId
      ]);
      
      console.log(`✅ Note mise à jour: ${result.rows[0].id}`);
      return { action: 'update', id: result.rows[0].id };
    } else {
      const insertQuery = `
        INSERT INTO note (
          note1, note2, partiel, moyenne,
          enseignement_id, etudiant_id, session_id, semestre_id,
          coefficient, fichier_source, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
        RETURNING id
      `;
      
      console.log(`🆕 Insertion nouvelle note`);
      const result = await db.query(insertQuery, [
        note1, note2, partiel, moyenne,
        noteData.enseignementId, noteData.etudiantId, noteData.sessionId, noteData.semestreId,
        coefficient, fichierSource
      ]);
      
      console.log(`✅ Nouvelle note créée: ${result.rows[0].id}`);
      return { action: 'insert', id: result.rows[0].id };
    }
  } catch (error) {
    console.error(`❌ Erreur détaillée upsert note: ${error.message}`);
    console.error('Stack:', error.stack);
    throw error;
  }
}

// Fonction utilitaire pour décrire le type d'évaluation
function getDescriptionTypeEvaluation(type) {
  const descriptions = {
    'note_1_note_2_partiel': "Contrôles continus (CC1:20%, CC2:20%) + Examen final (60%)",
    'note_1_partiel': "Contrôle continu (CC1:40%) + Examen final (60%)",
    'note_2_partiel': "Contrôle continu (CC2:40%) + Examen final (60%)",
    'partiel_only': "Examen final seulement (100%)",
    'note_1_note_2': "Deux contrôles continus (CC1:50%, CC2:50%)",
    'note_1_only': "Premier contrôle continu seulement (100%)",
    'note_2_only': "Deuxième contrôle continu seulement (100%)"
  };
  
  return descriptions[type] || "Type d'évaluation non spécifié";
}

// Fonction helper pour décrire le type d'évaluation
function getEvaluationDescription(type) {
  if (!type) return 'Type non spécifié';
  
  const descriptions = {
    'note_1_note_2_partiel': 'Contrôles continus (CC1, CC2) + Examen final',
    'note_1_partiel': 'Contrôle continu (CC) + Examen final',
    'note_unique': 'Évaluation unique',
    'note_1_note_2': 'Deux contrôles continus',
    'partiel_unique': 'Examen final uniquement',
    'note_1_note_2_moyenne': 'CC1, CC2 et moyenne',
    'tp_projet': 'TP/Projet'
  };
  
  return descriptions[type] || type;
}

// ================= API checkExistingNotes AVEC ENSEIGNEMENT =================
exports.checkExistingNotes = async (req, res) => {
  try {
    const { groupeId, matiereId } = req.params;
    const { professeurId } = req.query;
    
    console.log('🔍 Vérification notes existantes:', { groupeId, matiereId, professeurId });
    
    if (!groupeId || !matiereId) {
      return res.status(400).json({
        success: false,
        error: 'groupeId et matiereId sont requis'
      });
    }
    
    // Vérifier si le groupe existe
    const groupeQuery = 'SELECT id, nom FROM groupe WHERE id = $1';
    const groupeResult = await db.query(groupeQuery, [groupeId]);
    
    if (groupeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Groupe non trouvé'
      });
    }
    
    // Vérifier si la matière existe
    const matiereQuery = 'SELECT id, nom, type_evaluation FROM matiere WHERE id = $1';
    const matiereResult = await db.query(matiereQuery, [matiereId]);
    
    if (matiereResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Matière non trouvée'
      });
    }
    
    // 1. Récupérer le nombre d'étudiants actifs dans le groupe
    const etudiantsQuery = `
      SELECT COUNT(*) as total 
      FROM etudiant 
      WHERE groupe_id = $1 AND standing = 'Inscrit'
    `;
    const etudiantsResult = await db.query(etudiantsQuery, [groupeId]);
    const totalEtudiants = parseInt(etudiantsResult.rows[0].total) || 0;
    
    // 2. Chercher l'enseignement correspondant
    let enseignementId = null;
    let notesExistantes = false;
    let etudiantsAvecNotes = 0;
    let totalNotes = 0;
    let derniereImportation = null;
    let dernierFichier = null;
    
    if (professeurId) {
      // Chercher l'enseignement spécifique pour l'année académique courante
      const currentYear = new Date().getFullYear();
      const nextYear = currentYear + 1;
      const anneeAcademique = `${currentYear}-${nextYear}`;
      
      const enseignementQuery = `
        SELECT id, annee_academique FROM enseignement 
        WHERE professeur_id = $1 AND matiere_id = $2 AND groupe_id = $3 AND annee_academique = $4
        LIMIT 1
      `;
      
      const enseignementResult = await db.query(enseignementQuery, [professeurId, matiereId, groupeId, anneeAcademique]);
      
      if (enseignementResult.rows.length > 0) {
        enseignementId = enseignementResult.rows[0].id;
        const anneeEnseignement = enseignementResult.rows[0].annee_academique;
        console.log(`  Enseignement trouvé: ${enseignementId} (année: ${anneeEnseignement})`);
        
        // Vérifier les notes existantes pour cet enseignement
        // Chercher la session pour cette année académique
        const sessionQuery = `
          SELECT s.id, s.nom, a.annee
          FROM session s
          JOIN anneeacademique a ON s.annee_academique_id = a.id
          WHERE a.annee = $1
          ORDER BY s.id DESC
          LIMIT 1
        `;
        const sessionResult = await db.query(sessionQuery, [anneeEnseignement]);
        const sessionId = sessionResult.rows[0]?.id;
        
        if (sessionId) {
          const notesQuery = `
            SELECT 
              COUNT(DISTINCT n.etudiant_id) as etudiantsAvecNotes,
              COUNT(n.id) as totalNotes,
              MAX(n.created_at) as derniereImportation,
              MAX(n.fichier_source) as dernierFichier
            FROM note n
            INNER JOIN etudiant e ON n.etudiant_id = e.id
            WHERE e.groupe_id = $1 
              AND n.enseignement_id = $2
              AND n.session_id = $3
              AND (n.note1 IS NOT NULL OR n.note2 IS NOT NULL OR n.partiel IS NOT NULL)
          `;
          
          const notesResult = await db.query(notesQuery, [groupeId, enseignementId, sessionId]);
          
          if (notesResult.rows.length > 0) {
            etudiantsAvecNotes = parseInt(notesResult.rows[0].etudiantsavecnotes) || 0;
            totalNotes = parseInt(notesResult.rows[0].totalnotes) || 0;
            derniereImportation = notesResult.rows[0].derniereimportation;
            dernierFichier = notesResult.rows[0].dernierfichier;
            notesExistantes = etudiantsAvecNotes > 0;
          }
        }
      }
    } else {
      // Sans professeurId, chercher l'enseignement le plus récent pour cette matière et groupe
      const enseignementsQuery = `
        SELECT e.id as enseignement_id, e.annee_academique, p.nom as professeur_nom, p.prenom as professeur_prenom
        FROM enseignement e
        LEFT JOIN professeur p ON e.professeur_id = p.id
        WHERE e.matiere_id = $1 AND e.groupe_id = $2
        ORDER BY e.annee_academique DESC, e.created_at DESC
        LIMIT 1
      `;
      
      const enseignementsResult = await db.query(enseignementsQuery, [matiereId, groupeId]);
      
      if (enseignementsResult.rows.length > 0) {
        enseignementId = enseignementsResult.rows[0].enseignement_id;
        const anneeEnseignement = enseignementsResult.rows[0].annee_academique;
        console.log(`  Enseignement trouvé (sans prof): ${enseignementId} (année: ${anneeEnseignement})`);
        
        // Vérifier les notes existantes pour cet enseignement
        // Chercher la session pour cette année académique
        const sessionQuery = `
          SELECT s.id, s.nom, a.annee
          FROM session s
          JOIN anneeacademique a ON s.annee_academique_id = a.id
          WHERE a.annee = $1
          ORDER BY s.id DESC
          LIMIT 1
        `;
        const sessionResult = await db.query(sessionQuery, [anneeEnseignement]);
        const sessionId = sessionResult.rows[0]?.id;
        
        if (sessionId) {
          const notesQuery = `
            SELECT 
              COUNT(DISTINCT n.etudiant_id) as etudiantsAvecNotes,
              COUNT(n.id) as totalNotes,
              MAX(n.created_at) as derniereImportation,
              MAX(n.fichier_source) as dernierFichier
            FROM note n
            INNER JOIN etudiant e ON n.etudiant_id = e.id
            WHERE e.groupe_id = $1 
              AND n.enseignement_id = $2
              AND n.session_id = $3
              AND (n.note1 IS NOT NULL OR n.note2 IS NOT NULL OR n.partiel IS NOT NULL)
          `;
          
          const notesResult = await db.query(notesQuery, [groupeId, enseignementId, sessionId]);
          
          if (notesResult.rows.length > 0) {
            etudiantsAvecNotes = parseInt(notesResult.rows[0].etudiantsavecnotes) || 0;
            totalNotes = parseInt(notesResult.rows[0].totalnotes) || 0;
            derniereImportation = notesResult.rows[0].derniereimportation;
            dernierFichier = notesResult.rows[0].dernierfichier;
            notesExistantes = etudiantsAvecNotes > 0;
          }
        }
      }
    }
    
    // Calculer le pourcentage
    const pourcentage = totalEtudiants > 0 
      ? Math.round((etudiantsAvecNotes / totalEtudiants) * 100) 
      : 0;
    
    // Préparer le message
    let message = '';
    if (notesExistantes) {
      message = `Des notes existent déjà pour ${etudiantsAvecNotes}/${totalEtudiants} étudiants (${pourcentage}%). L'importation mettra à jour les notes existantes.`;
    } else {
      message = 'Aucune note existante. Importation créera de nouvelles notes.';
    }
    
    // Retourner la réponse complète
    return res.json({
      success: true,
      notesExistantes,
      count: totalNotes,
      etudiantsAvecNotes,
      totalEtudiants,
      pourcentage,
      derniereImportation,
      dernierFichier,
      message,
      enseignementId: enseignementId,
      matiereInfo: {
        nom: matiereResult.rows[0].nom,
        type_evaluation: matiereResult.rows[0].type_evaluation || 'note_1_note_2_partiel',
        description_type: getEvaluationDescription(matiereResult.rows[0].type_evaluation)
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur vérification notes:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Erreur serveur'
    });
  }
};

// ================= CONTROLLER PRINCIPAL AVEC ENSEIGNEMENT (CORRIGÉ) =================
exports.uploadNotes = async (req, res) => {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 DÉBUT TRAITEMENT UPLOAD NOTES AVEC TRANSACTION');
  console.log('='.repeat(80));
  
  let uploadedFile = null;
  let fileSaved = false;
  let transactionClient = null;
  let enseignementId = null;
  
  try {
    const { groupeId, matiereId, noteTypes, professeurId } = req.body;
    
    if (!groupeId || !matiereId || !noteTypes) {
      throw new Error('groupeId, matiereId et noteTypes sont requis');
    }

    if (!req.file) {
      throw new Error('Aucun fichier fourni');
    }

    uploadedFile = req.file;
    
    console.log(`📂 Fichier uploadé: ${uploadedFile.originalname} (${uploadedFile.size} bytes)`);
    console.log(`📋 Paramètres: groupeId=${groupeId}, matiereId=${matiereId}, noteTypes=${noteTypes}, professeurId=${professeurId}`);
    
    let parsedNoteTypes;
    try {
      parsedNoteTypes = JSON.parse(noteTypes);
    } catch (parseError) {
      parsedNoteTypes = [noteTypes];
    }
    
    // Vérifier si un professeur est spécifié
    if (!professeurId) {
      throw new Error('Un professeur doit être sélectionné pour créer l\'enseignement');
    }
    
    // ================= ÉTAPE 0: RÉCUPÉRER LE NOM DU GROUPE POUR DÉTERMINER LE TYPE DE TRAITEMENT =================
    const groupeNom = await getGroupeNom(groupeId);
    const groupeInfo = await getGroupeInfo(groupeId);
    const matiereInfo = await getMatiereInfo(matiereId);
    
    // Récupérer le type de filière depuis la matière
    const typeFiliere = matiereInfo.type_filiere || 'Universitaire';
    
    // Déterminer le type de traitement pour le calcul de la moyenne
    const typeTraitement = determinerTypeTraitementPourCalcul(typeFiliere, groupeNom);
    console.log(`🎓 Type de traitement déterminé pour le calcul: ${typeTraitement} (filière: ${typeFiliere}, groupe: ${groupeNom})`);
    
    // ================= DÉBUT DE LA TRANSACTION =================
    transactionClient = await db.connect();
    await transactionClient.query('BEGIN');
    console.log('🔄 Transaction démarrée');
    
    // ================= ÉTAPE 1: DÉTERMINER LE TYPE D'ÉVALUATION =================
    const nouveauTypeEvaluation = determinerTypeEvaluation(parsedNoteTypes);
    console.log(`📊 Type d'évaluation déterminé: ${nouveauTypeEvaluation}`);
    
    // ================= ÉTAPE 2: METTRE À JOUR LE TYPE D'ÉVALUATION DANS LA TRANSACTION =================
    console.log(`🔄 Mise à jour type évaluation pour matière ${matiereId}: ${nouveauTypeEvaluation}`);
    
    const updateTypeQuery = `
      UPDATE matiere 
      SET type_evaluation = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, nom, type_evaluation
    `;
    
    const matiereMiseAJour = await transactionClient.query(updateTypeQuery, [nouveauTypeEvaluation, matiereId]);
    console.log(`✅ Type d'évaluation mis à jour: ${matiereMiseAJour.rows[0].nom}`);
    
    // ================= ÉTAPE 3: RÉCUPÉRER LES INFORMATIONS =================
    const sessionInfo = await getOrCreateSession(groupeId);
    const session = sessionInfo.session;
    const anneeAcademique = sessionInfo.anneeAcademique;
    const etudiants = await getEtudiantsDuGroupe(groupeId);
    
    console.log('\n  Informations récupérées:');
    console.log(`   Groupe: ${groupeInfo.nom} (ID: ${groupeInfo.id})`);
    console.log(`   Matière: ${matiereInfo.nom} (ID: ${matiereInfo.id})`);
    console.log(`   Coefficient matière: ${matiereInfo.coefficient || 1}`);
    console.log(`   Type d'évaluation: ${nouveauTypeEvaluation}`);
    console.log(`   Type de filière: ${typeFiliere}`);
    console.log(`   Type de traitement: ${typeTraitement}`);
    console.log(`   Session: ${session.nom} (ID: ${session.id})`);
    console.log(`   Année académique: ${anneeAcademique}`);
    console.log(`   Professeur ID: ${professeurId}`);
    console.log(`   Étudiants dans le groupe: ${etudiants.length}`);
    
    // ================= ÉTAPE 4 CRITIQUE: CRÉER OU METTRE À JOUR L'ENSEIGNEMENT DANS LA TRANSACTION =================
    // Recherche d'un enseignement existant
    const findEnseignementQuery = `
      SELECT id, professeur_id, created_at 
      FROM enseignement 
      WHERE matiere_id = $1 AND groupe_id = $2 AND annee_academique = $3
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    const existingEnseignement = await transactionClient.query(
      findEnseignementQuery, 
      [matiereId, groupeId, anneeAcademique]
    );
    
    if (existingEnseignement.rows.length > 0) {
      enseignementId = existingEnseignement.rows[0].id;
      console.log(`  Enseignement existant trouvé: ${enseignementId}`);
      
      // Mettre à jour le professeur si différent
      if (existingEnseignement.rows[0].professeur_id !== parseInt(professeurId)) {
        console.log(`  Mise à jour du professeur: ${existingEnseignement.rows[0].professeur_id} -> ${professeurId}`);
        const updateEnseignementQuery = `
          UPDATE enseignement 
          SET professeur_id = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING id
        `;
        
        const updated = await transactionClient.query(updateEnseignementQuery, [professeurId, enseignementId]);
        console.log(`✅ Enseignement mis à jour: ${updated.rows[0].id}`);
      } else {
        console.log(`  Enseignement conservé: ${enseignementId}`);
      }
    } else {
      // Créer un NOUVEL enseignement DANS LA TRANSACTION
      console.log(`🆕 Création nouvel enseignement`);
      const insertEnseignementQuery = `
        INSERT INTO enseignement (professeur_id, matiere_id, groupe_id, annee_academique, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING id
      `;
      
      const newEnseignement = await transactionClient.query(
        insertEnseignementQuery, 
        [professeurId, matiereId, groupeId, anneeAcademique]
      );
      
      enseignementId = newEnseignement.rows[0].id;
      console.log(`✅ Nouvel enseignement créé: ${enseignementId}`);
    }
    
    // ================= ÉTAPE 5: PARSER LE FICHIER =================
    const studentsData = parseExcelFile(uploadedFile.path, parsedNoteTypes);
    console.log(`\n  ${studentsData.length} étudiants trouvés dans le fichier Excel`);
    
    // ================= ÉTAPE 6: TRAITER LES NOTES DANS LA TRANSACTION =================
    const results = {
      processedCount: 0,
      inserted: 0,
      updated: 0,
      errors: [],
      etudiantsNonTrouves: []
    };
    
    // Fonction pour vérifier si une note existe déjà
    const checkExistingNoteInTransaction = async (etudiantId, enseignementId, sessionId) => {
      const query = `SELECT id FROM note WHERE etudiant_id = $1 AND enseignement_id = $2 AND session_id = $3 LIMIT 1`;
      const result = await transactionClient.query(query, [etudiantId, enseignementId, sessionId]);
      return result.rows.length > 0 ? result.rows[0].id : null;
    };
    
    // Fonction pour insérer ou mettre à jour une note dans la transaction
    const upsertNoteInTransaction = async (noteData, fichierSource, noteId = null) => {
      const validateAndFormat = (value) => {
        if (value === null || value === undefined) {
          return null;
        }
        const num = parseFloat(value);
        if (isNaN(num)) {
          return null;
        }
        const rounded = Math.round(num * 100) / 100;
        if (rounded < 0) return 0;
        if (rounded > 20) return 20;
        return rounded;
      };
      
      const note1 = validateAndFormat(noteData.note1);
      const note2 = validateAndFormat(noteData.note2);
      const partiel = validateAndFormat(noteData.partiel);
      const moyenne = validateAndFormat(noteData.moyenne);
      
      let coefficient = 1;
      if (noteData.coefficient) {
        const coefNum = parseFloat(noteData.coefficient);
        if (!isNaN(coefNum) && coefNum > 0) {
          coefficient = coefNum;
        }
      }
      
      if (noteId) {
        const updateQuery = `
          UPDATE note SET
            note1 = $1, note2 = $2, partiel = $3, moyenne = $4,
            coefficient = $5, fichier_source = $6, updated_at = CURRENT_TIMESTAMP
          WHERE id = $7
          RETURNING id
        `;
        
        const result = await transactionClient.query(updateQuery, [
          note1, note2, partiel, moyenne,
          coefficient, fichierSource, noteId
        ]);
        
        return { action: 'update', id: result.rows[0].id };
      } else {
        const insertQuery = `
          INSERT INTO note (
            note1, note2, partiel, moyenne,
            enseignement_id, etudiant_id, session_id, semestre_id,
            coefficient, fichier_source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          RETURNING id
        `;
        
        const result = await transactionClient.query(insertQuery, [
          note1, note2, partiel, moyenne,
          noteData.enseignementId, noteData.etudiantId, noteData.sessionId, noteData.semestreId,
          coefficient, fichierSource
        ]);
        
        return { action: 'insert', id: result.rows[0].id };
      }
    };
    
    // Traiter chaque étudiant
    for (const studentData of studentsData) {
      try {
        console.log(`\n--- Ligne ${studentData.ligne} ---`);
        console.log(`  Recherche: "${studentData.matriculeIipea}"`);
        
        const etudiant = findEtudiantByMatriculeIipea(etudiants, studentData.matriculeIipea);
        
        if (!etudiant) {
          console.log(`❌ Non trouvé dans la base de données`);
          results.etudiantsNonTrouves.push({
            matriculeIipea: studentData.matriculeIipea,
            nom: studentData.nom,
            prenom: studentData.prenom,
            ligne: studentData.ligne
          });
          continue;
        }
        
        const noteValues = {
          note1: studentData.note_1,  // Peut être null
          note2: studentData.note_2,  // Peut être null
          partiel: studentData.partiel // Peut être null
        };
        
        // Calculer la moyenne avec la nouvelle fonction qui prend en compte le type de traitement
        const moyenne = calculerMoyenne(
          noteValues.note1,
          noteValues.note2,
          noteValues.partiel,
          nouveauTypeEvaluation,
          typeTraitement  // ← On passe le type de traitement déterminé
        );
        
        const existingNoteId = await checkExistingNoteInTransaction(
          etudiant.id,
          enseignementId,
          session.id
        );
        
        const noteData = {
          note1: noteValues.note1,
          note2: noteValues.note2,
          partiel: noteValues.partiel,
          moyenne: moyenne,
          enseignementId: enseignementId,
          etudiantId: etudiant.id,
          sessionId: session.id,
          semestreId: matiereInfo.semestre_id,
          coefficient: matiereInfo.coefficient || 1
        };
        
        const upsertResult = await upsertNoteInTransaction(
          noteData,
          uploadedFile.filename,
          existingNoteId
        );
        
        if (upsertResult.action === 'insert') {
          results.inserted++;
          console.log(`  NOUVELLE note pour ${etudiant.nom} ${etudiant.prenoms} (moyenne: ${moyenne})`);
        } else {
          results.updated++;
          console.log(`🔄 Note MIS À JOUR pour ${etudiant.nom} ${etudiant.prenoms} (moyenne: ${moyenne})`);
        }
        
        results.processedCount++;
        
      } catch (error) {
        console.error(`❌ Erreur ligne ${studentData.ligne}:`, error.message);
        results.errors.push({
          matriculeIipea: studentData.matriculeIipea,
          nom: studentData.nom,
          prenom: studentData.prenom,
          ligne: studentData.ligne,
          erreur: error.message
        });
      }
    }
    
    // ================= ÉTAPE 7: VALIDER OU ANNULER LA TRANSACTION =================
    const hasErrors = results.errors.length > 0;
    const noStudentsFound = results.etudiantsNonTrouves.length === studentsData.length;
    const success = results.processedCount > 0 && !hasErrors;
    
    console.log('\n' + '='.repeat(80));
    console.log('📊 RÉSULTAT DU TRAITEMENT');
    console.log('='.repeat(80));
    console.log(`   Total traitées: ${results.processedCount}`);
    console.log(`   Nouvelles notes: ${results.inserted}`);
    console.log(`   Notes mises à jour: ${results.updated}`);
    console.log(`   Étudiants non trouvés: ${results.etudiantsNonTrouves.length}`);
    console.log(`   Erreurs: ${results.errors.length}`);
    console.log(`   Type d'évaluation: ${nouveauTypeEvaluation}`);
    console.log(`   Type de traitement: ${typeTraitement}`);
    console.log(`   Enseignement ID: ${enseignementId}`);
    console.log(`   Succès: ${success ? '  OUI' : '❌ NON'}`);
    
    if (success) {
      // VALIDER LA TRANSACTION
      await transactionClient.query('COMMIT');
      console.log('✅ Transaction COMMITÉE');
      fileSaved = true;
      console.log('💾 Fichier conservé dans:', uploadedFile.path);
      
      // Récupérer le nom du professeur
      let professeurNom = 'Professeur inconnu';
      if (professeurId) {
        try {
          const profQuery = 'SELECT nom, prenom FROM professeur WHERE id = $1';
          const profResult = await db.query(profQuery, [professeurId]);
          if (profResult.rows.length > 0) {
            professeurNom = `${profResult.rows[0].prenom} ${profResult.rows[0].nom}`;
          }
        } catch (error) {
          console.error('Erreur récupération nom professeur:', error.message);
        }
      }
      
      const response = {
        success: true,
        message: `Importation réussie: ${results.processedCount} notes traitées`,
        details: {
          fichier: uploadedFile.originalname,
          fichierSauvegarde: uploadedFile.filename,
          chemin: uploadedFile.path,
          parcour: matiereInfo.parcour || 'Non spécifié',
          matiere: matiereInfo.nom,
          coefficient_matiere: matiereInfo.coefficient || 1,
          groupe: groupeInfo.nom,
          session: session.nom,
          professeur: professeurNom,
          enseignementId: enseignementId,
          type_evaluation: nouveauTypeEvaluation,
          type_traitement: typeTraitement,
          description_type: getDescriptionTypeEvaluation(nouveauTypeEvaluation),
          stats: {
            totalTraitees: results.processedCount,
            notesInserees: results.inserted,
            notesMisesAJour: results.updated,
            erreurs: results.errors.length,
            etudiantsNonTrouves: results.etudiantsNonTrouves.length
          }
        }
      };
      
      if (results.etudiantsNonTrouves.length > 0) {
        response.avertissements = {
          message: `${results.etudiantsNonTrouves.length} étudiant(s) non trouvé(s) dans le groupe`,
          etudiants: results.etudiantsNonTrouves.slice(0, 10),
          total: results.etudiantsNonTrouves.length
        };
      }
      
      res.status(200).json(response);
      
    } else {
      // ANNULER LA TRANSACTION (ROLLBACK)
      await transactionClient.query('ROLLBACK');
      console.log('🔄 Transaction ROLLBACK - aucune donnée sauvegardée');
      
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        try {
          fs.unlinkSync(uploadedFile.path);
          console.log('🗑️ Fichier supprimé:', uploadedFile.path);
        } catch (cleanupError) {
          console.error('❌ Erreur suppression fichier:', cleanupError.message);
        }
      }
      
      let errorMessage = 'Erreur lors de l\'importation';
      if (noStudentsFound) {
        errorMessage = 'Aucun étudiant du fichier Excel n\'a été trouvé dans le groupe. Vérifiez les matricule_iipea.';
      } else if (hasErrors) {
        errorMessage = `${results.errors.length} erreur(s) lors du traitement`;
      } else if (results.processedCount === 0) {
        errorMessage = 'Aucune note n\'a pu être traitée. Vérifiez le format du fichier.';
      }
      
      const errorResponse = {
        success: false,
        error: errorMessage,
        details: {
          enseignementCree: false, // IMPORTANT: enseignement NON créé
          stats: {
            totalTraitees: results.processedCount,
            notesInserees: results.inserted,
            notesMisesAJour: results.updated,
            erreurs: results.errors.length,
            etudiantsNonTrouves: results.etudiantsNonTrouves.length
          }
        },
        timestamp: new Date().toISOString()
      };
      
      if (results.etudiantsNonTrouves.length > 0) {
        errorResponse.avertissements = {
          message: `${results.etudiantsNonTrouves.length} étudiant(s) non trouvé(s) dans le groupe`,
          etudiants: results.etudiantsNonTrouves.slice(0, 5),
          total: results.etudiantsNonTrouves.length
        };
      }
      
      res.status(400).json(errorResponse);
    }

  } catch (error) {
    console.error('\n' + '❌'.repeat(40));
    console.error('❌ ERREUR CRITIQUE UPLOAD NOTES:');
    console.error('❌ Message:', error.message);
    
    // Annuler la transaction en cas d'erreur
    if (transactionClient) {
      try {
        await transactionClient.query('ROLLBACK');
        console.log('🔄 Transaction ROLLBACK (erreur)');
      } catch (rollbackError) {
        console.error('❌ Erreur ROLLBACK:', rollbackError.message);
      } finally {
        transactionClient.release();
      }
    }
    
    if (uploadedFile && fs.existsSync(uploadedFile.path) && !fileSaved) {
      try {
        fs.unlinkSync(uploadedFile.path);
        console.log('🗑️ Fichier supprimé (erreur critique):', uploadedFile.path);
      } catch (cleanupError) {
        console.error('❌ Erreur suppression fichier:', cleanupError.message);
      }
    }
    
    const errorResponse = {
      success: false,
      error: 'Erreur lors de l\'importation',
      details: error.message,
      suggestion: 'Vérifiez que: 1) Le fichier Excel est valide, 2) La colonne "Code" correspond exactement au matricule_iipea, 3) Le groupe et la matière existent, 4) Un professeur est sélectionné',
      timestamp: new Date().toISOString(),
      debug: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        body: req.body,
        file: uploadedFile
      } : undefined
    };
    
    res.status(500).json(errorResponse);
  } finally {
    // Libérer la connexion transactionnelle
    if (transactionClient) {
      transactionClient.release();
    }
  }
};

// ================= TÉLÉCHARGER TEMPLATE =================
exports.downloadTemplate = async (req, res) => {
  try {
    const { groupeId, matiereId } = req.params;
    
    console.log('📥 Génération template pour:', { groupeId, matiereId });
    
    const groupeInfo = await getGroupeInfo(groupeId);
    const matiereInfo = await getMatiereInfo(matiereId);
    const etudiants = await getEtudiantsDuGroupe(groupeId);
    
    console.log(`  Informations récupérées: ${etudiants.length} étudiants`);
    
    const data = [
      ['Code', 'Nom', 'Prénom', 'Note 1', 'Note 2', 'Partiel']
    ];
    
    etudiants.forEach(etudiant => {
      const matricule = etudiant.matricule_iipea || etudiant.matricule || etudiant.code_unique || '';
      data.push([
        matricule,
        etudiant.nom || '',
        etudiant.prenoms || '',
        '', '', ''
      ]);
    });
    
    data.push([]);
    data.push(['INSTRUCTIONS IMPORTANTES:', '', '', '', '', '']);
    data.push(['1. Ne modifiez PAS la colonne "Code" (matricule_iipea)', '', '', '', '', '']);
    data.push(['2. Utilisez la virgule pour les décimales (ex: 15,5)', '', '', '', '', '']);
    data.push(['3. Laissez vide si l\'étudiant n\'a pas été évalué', '', '', '', '', '']);
    data.push(['4. Mettez 0 si l\'étudiant a eu 0/20', '', '', '', '', '']);
    
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(data);
    
    const colWidths = [
      { wch: 25 }, { wch: 25 }, { wch: 25 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }
    ];
    worksheet['!cols'] = colWidths;
    
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Notes');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const safeMatiereName = matiereInfo.nom.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const safeGroupeName = groupeInfo.nom.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = `Template_${safeMatiereName}_${safeGroupeName}.xlsx`;
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    
    console.log('  Template généré:', filename);
    res.send(buffer);
    
  } catch (error) {
    console.error('❌ Erreur génération template:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
};

// ================= API POUR TYPE D'ÉVALUATION =================

// API pour obtenir le type d'évaluation d'une matière
exports.getTypeEvaluation = async (req, res) => {
  try {
    const { matiereId } = req.params;
    
    const query = `
      SELECT 
        id, nom, coefficient, type_evaluation,
        COALESCE(type_evaluation, 'note_1_note_2_partiel') as type_evaluation_actuel,
        updated_at
      FROM matiere 
      WHERE id = $1
    `;
    
    const result = await db.query(query, [matiereId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Matière non trouvée'
      });
    }
    
    const matiere = result.rows[0];
    
    // Mapper les types d'évaluation à des descriptions
    const typesDescription = {
      'note_1_note_2_partiel': {
        nom: "Contrôles continus + Examen",
        description: "CC1 (20%), CC2 (20%), Examen final (60%)",
        notes_actives: ["note1", "note2", "partiel"]
      },
      'note_1_partiel': {
        nom: "CC1 + Examen",
        description: "CC1 (40%), Examen final (60%)",
        notes_actives: ["note1", "partiel"]
      },
      'note_2_partiel': {
        nom: "CC2 + Examen",
        description: "CC2 (40%), Examen final (60%)",
        notes_actives: ["note2", "partiel"]
      },
      'partiel_only': {
        nom: "Examen seulement",
        description: "Examen final (100%)",
        notes_actives: ["partiel"]
      },
      'note_1_note_2': {
        nom: "Deux contrôles continus",
        description: "CC1 (50%), CC2 (50%)",
        notes_actives: ["note1", "note2"]
      },
      'note_1_only': {
        nom: "CC1 seulement",
        description: "Contrôle continu 1 (100%)",
        notes_actives: ["note1"]
      },
      'note_2_only': {
        nom: "CC2 seulement",
        description: "Contrôle continu 2 (100%)",
        notes_actives: ["note2"]
      }
    };
    
    res.json({
      success: true,
      matiere: {
        id: matiere.id,
        nom: matiere.nom,
        coefficient: matiere.coefficient,
        type_evaluation: matiere.type_evaluation_actuel,
        description: typesDescription[matiere.type_evaluation_actuel] || typesDescription['note_1_note_2_partiel']
      },
      options_disponibles: Object.keys(typesDescription).map(key => ({
        value: key,
        label: typesDescription[key].nom,
        description: typesDescription[key].description
      })),
      derniere_mise_a_jour: matiere.updated_at
    });
    
  } catch (error) {
    console.error('❌ Erreur récupération type évaluation:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// API pour mettre à jour le type d'évaluation
exports.updateTypeEvaluation = async (req, res) => {
  try {
    const { matiereId } = req.params;
    const { type_evaluation } = req.body;
    
    if (!type_evaluation) {
      return res.status(400).json({
        success: false,
        error: 'Le type d\'évaluation est requis'
      });
    }
    
    // Valider le type
    const typesValides = [
      'note_1_note_2_partiel',
      'note_1_partiel',
      'note_2_partiel',
      'partiel_only',
      'note_1_note_2',
      'note_1_only',
      'note_2_only'
    ];
    
    if (!typesValides.includes(type_evaluation)) {
      return res.status(400).json({
        success: false,
        error: `Type d'évaluation invalide. Options: ${typesValides.join(', ')}`
      });
    }
    
    const query = `
      UPDATE matiere 
      SET type_evaluation = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, nom, type_evaluation, updated_at
    `;
    
    const result = await db.query(query, [type_evaluation, matiereId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Matière non trouvée'
      });
    }
    
    console.log(`  Type d'évaluation mis à jour pour matière ${matiereId}: ${type_evaluation}`);
    
    res.json({
      success: true,
      message: 'Type d\'évaluation mis à jour avec succès',
      matiere: result.rows[0],
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur mise à jour type évaluation:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ================= AUTRES API =================
exports.getNotesByGroupe = async (req, res) => {
  try {
    const { groupeId } = req.params;
    const query = `
      SELECT 
        n.*, 
        e.nom, e.prenoms, e.matricule_iipea,
        ens.id as enseignement_id,
        p.nom as professeur_nom, p.prenom as professeur_prenom,
        m.nom as matiere_nom
      FROM note n
      INNER JOIN etudiant e ON n.etudiant_id = e.id
      INNER JOIN enseignement ens ON n.enseignement_id = ens.id
      INNER JOIN matiere m ON ens.matiere_id = m.id
      LEFT JOIN professeur p ON ens.professeur_id = p.id
      WHERE e.groupe_id = $1
      ORDER BY e.nom, e.prenoms
    `;
    const result = await db.query(query, [groupeId]);
    
    res.json({
      success: true,
      count: result.rows.length,
      notes: result.rows
    });
  } catch (error) {
    console.error('❌ Erreur récupération notes:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getUploadStatus = async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total_uploads,
        MAX(created_at) as last_upload,
        COUNT(DISTINCT enseignement_id) as enseignements_differents,
        COUNT(DISTINCT session_id) as sessions_differentes
      FROM note
    `;
    const result = await db.query(query);
    
    res.json({
      success: true,
      status: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Erreur statut upload:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getGroupeDetails = async (req, res) => {
  try {
    const { groupeId } = req.params;
    
    // Récupérer les infos du groupe
    const groupeQuery = `
      SELECT g.*, c.nom as classe_nom, COUNT(e.id) as nombre_etudiants
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN etudiant e ON g.id = e.groupe_id
      WHERE g.id = $1
      GROUP BY g.id, c.nom
    `;
    
    const groupeResult = await db.query(groupeQuery, [groupeId]);
    
    if (groupeResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Groupe non trouvé' });
    }
    
    // Récupérer les matières du groupe (via les enseignements)
    const matieresQuery = `
      SELECT DISTINCT 
        m.id, m.nom, m.code, m.type_evaluation,
        p.nom as professeur_nom, p.prenom as professeur_prenom,
        COUNT(n.id) as nombre_notes
      FROM enseignement e
      INNER JOIN matiere m ON e.matiere_id = m.id
      LEFT JOIN professeur p ON e.professeur_id = p.id
      LEFT JOIN note n ON e.id = n.enseignement_id
      WHERE e.groupe_id = $1
      GROUP BY m.id, m.nom, m.code, m.type_evaluation, p.nom, p.prenom
    `;
    
    const matieresResult = await db.query(matieresQuery, [groupeId]);
    
    res.json({
      success: true,
      groupe: groupeResult.rows[0],
      matieres: matieresResult.rows,
      stats: {
        nombre_etudiants: groupeResult.rows[0].nombre_etudiants,
        nombre_matieres: matieresResult.rows.length
      }
    });
  } catch (error) {
    console.error('❌ Erreur détails groupe:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.validateExcelFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier fourni'
      });
    }
    
    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    const headers = data[0].map(h => h ? h.toString().trim() : '');
    
    // Vérifier la présence de colonnes minimales
    const requiredColumns = ['CODE', 'NOM'];
    const missingColumns = requiredColumns.filter(col => 
      !headers.some(header => header.toUpperCase().includes(col))
    );
    
    if (missingColumns.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Colonnes manquantes: ${missingColumns.join(', ')}`,
        headers: headers
      });
    }
    
    // Compter les lignes avec données
    const dataRows = data.slice(1).filter(row => 
      row.some(cell => cell && cell.toString().trim() !== '')
    );
    
    res.json({
      success: true,
      validation: {
        valid: true,
        message: 'Fichier Excel valide',
        details: {
          nombre_lignes: data.length,
          nombre_etudiants: dataRows.length,
          headers: headers,
          fichier: req.file.originalname
        }
      }
    });
  } catch (error) {
    console.error('❌ Erreur validation fichier:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors de la validation du fichier' 
    });
  }
};

// ================= API POUR ENSEIGNEMENT =================
exports.getEnseignementsByGroupe = async (req, res) => {
  try {
    const { groupeId } = req.params;
    
    const query = `
      SELECT 
        e.id as enseignement_id,
        e.annee_academique,
        m.id as matiere_id,
        m.nom as matiere_nom,
        m.coefficient,
        p.id as professeur_id,
        p.nom as professeur_nom,
        p.prenom as professeur_prenom
      FROM enseignement e
      INNER JOIN matiere m ON e.matiere_id = m.id
      LEFT JOIN professeur p ON e.professeur_id = p.id
      WHERE e.groupe_id = $1
      ORDER BY m.nom
    `;
    
    const result = await db.query(query, [groupeId]);
    
    res.json({
      success: true,
      count: result.rows.length,
      enseignements: result.rows
    });
  } catch (error) {
    console.error('❌ Erreur récupération enseignements:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ================= MIDDLEWARE ET EXPORT =================
exports.uploadMiddleware = handleUpload;
exports.disableBodyParserForFormData = disableBodyParserForFormData;
exports.testAPI = async (req, res) => {
  res.json({ success: true, message: 'API fonctionnelle' });
};