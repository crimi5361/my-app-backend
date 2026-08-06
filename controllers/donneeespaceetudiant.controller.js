const db = require('../config/db.config');
const path = require('path');
const fs = require('fs');

exports.getStudentProfile = async (req, res) => {
  try {
    const studentId = req.params.id;

    // Requête principale pour récupérer toutes les informations de l'étudiant
    const query = `
      SELECT 
        e.*,
        a.annee as annee_academique,
        aas.etat as etat_annee,
        n.libelle as niveau_libelle,
        n.prix_formation,
        n.type_filiere as type_filiere_niveau,
        f.nom as filiere_nom,
        f.sigle as filiere_sigle,
        tf.libelle as type_filiere_libelle,
        tf.description as type_filiere_description,
        d.extrait_naissance,
        d.justificatif_identite,
        d.dernier_diplome,
        d.fiche_orientation,
        c.type_parcours,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.est_primaire as groupe_est_primaire,
        g.capacite_max,
        cl.nom as classe_nom,
        cl.description as classe_description,
        s.montant_scolarite,
        s.scolarite_verse,
        s.statut_etudiant as statut_scolarite,
        s.scolarite_restante,
        s.prise_en_charge_id
      FROM etudiant e
      LEFT JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = a.id AND aas.site_id = e.site_id
      LEFT JOIN niveau n ON e.niveau_id = n.id
      LEFT JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN typefiliere tf ON f.type_filiere_id = tf.id
      LEFT JOIN document d ON e.document_id = d.id
      LEFT JOIN curcus c ON e.curcus_id = c.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      -- Chantier 6 : classe résolue via les critères d'affectation de l'étudiant, pas via le
      -- groupe (absent tant qu'aucun découpage manuel n'a eu lieu) — même clé que
      -- classeGroupe.service.js / getRecuData / fiche d'admission.
      LEFT JOIN classe cl ON cl.filiere_id = e.id_filiere AND cl.niveau_id = e.niveau_id
        AND cl.annee_academique_id = e.annee_academique_id AND cl.curcus_id IS NOT DISTINCT FROM e.curcus_id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      WHERE e.id = $1
    `;

    const result = await db.query(query, [studentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Étudiant non trouvé' });
    }

    const studentData = result.rows[0];

    // Structurer la réponse de manière organisée
    const formattedResponse = {
      informations_personnelles: {
        id: studentData.id,
        matricule: studentData.matricule,
        nom: studentData.nom,
        prenoms: studentData.prenoms,
        date_naissance: studentData.date_naissance,
        lieu_naissance: studentData.lieu_naissance,
        telephone: studentData.telephone,
        email: studentData.email,
        etablissement_origine: studentData.etablissement_origine,
        lieu_residence: studentData.lieu_residence,
        contact_parent: studentData.contact_parent,
        contact_parent_2: studentData.contact_parent_2,
        contact_etudiant: studentData.contact_etudiant,
        sexe: studentData.sexe,
        nationalite: studentData.nationalite,
        pays_naissance: studentData.pays_naissance,
        photo_url: studentData.photo_url,
        numero_table: studentData.numero_table
      },
      informations_familiales: {
        nom_parent_1: studentData.nom_parent_1,
        nom_parent_2: studentData.nom_parent_2
      },
      informations_academiques: {
        code_unique: studentData.code_unique,
        annee_bac: studentData.annee_bac,
        serie_bac: studentData.serie_bac,
        etablissement_origine: studentData.etablissement_origine,
        annee_academique: studentData.annee_academique,
        etat_annee: studentData.etat_annee,
        niveau: studentData.niveau_libelle,
        prix_formation: studentData.prix_formation,
        filiere: studentData.filiere_nom,
        sigle_filiere: studentData.filiere_sigle,
        type_filiere: studentData.type_filiere_libelle,
        type_parcours: studentData.type_parcours,
        // Chantier 11 (2026-08-04) — sous-phase 2 : le Groupe primaire (technique) n'est jamais
        // affiché à l'étudiant — groupe_id reste toujours le vrai id (logique interne inchangée),
        // seul le nom affiché est masqué ici, au moment de construire la réponse.
        groupe_id: studentData.groupe_id,
        groupe: studentData.groupe_est_primaire ? null : studentData.groupe_nom,
        capacite_groupe: studentData.capacite_max,
        classe: studentData.classe_nom
      },
      documents: {
        extrait_naissance: studentData.extrait_naissance,
        justificatif_identite: studentData.justificatif_identite,
        dernier_diplome: studentData.dernier_diplome,
        fiche_orientation: studentData.fiche_orientation,
        statut_documents: {
          complet: studentData.extrait_naissance === 'oui' && 
                  studentData.justificatif_identite === 'oui' && 
                  studentData.dernier_diplome === 'oui' && 
                  studentData.fiche_orientation === 'oui'
        }
      },
      scolarite: {
        montant_total: studentData.montant_scolarite,
        montant_verse: studentData.scolarite_verse,
        montant_restant: studentData.scolarite_restante,
        statut: studentData.statut_scolarite,
        prise_en_charge_id: studentData.prise_en_charge_id
      },
      statut: {
        statut_scolaire: studentData.statut_scolaire,
        standing: studentData.standing,
        date_inscription: studentData.date_inscription,
        inscrit_par: studentData.inscrit_par
      },
      administration: {
        departement_id: studentData.site_id,
        matricule_iipea: studentData.matricule_iipea,
        ip_ministere: studentData.ip_ministere
      }
    };

    res.status(200).json(formattedResponse);

  } catch (error) {
    console.error('Erreur lors de la récupération du profil étudiant:', error);
    res.status(500).json({ 
      message: 'Erreur serveur lors de la récupération des données',
      error: error.message 
    });
  }
};
// Mise à jour du profil étudiant
// exports.updateStudentProfile = async (req, res) => {
//   try {
//     const studentId = req.params.id;
//     const {
//       etablissement_origine,
//       date_naissance,
//       matricule_mers, // Correspond au champ matricule
//       numero_table_bac, // Correspond au champ numero_table
//       matricule_menet, // Correspond au champ ip_ministere
//       lieu_naissance,
//       sexe,
//       serie_bac,
//       lieu_residence,
//       pays_naissance
//     } = req.body;

//     console.log('Données reçues pour mise à jour:', req.body);

//     // Vérifier que l'étudiant existe
//     const studentCheck = await db.query(
//       'SELECT id, is_profile_complete FROM etudiant WHERE id = $1', 
//       [studentId]
//     );
    
//     if (studentCheck.rows.length === 0) {
//       return res.status(404).json({ 
//         success: false,
//         message: 'Étudiant non trouvé' 
//       });
//     }

//     // Vérifier si le profil est déjà complet et verrouillé
//     const currentStudent = studentCheck.rows[0];
//     if (currentStudent.is_profile_complete) {
//       return res.status(403).json({ 
//         success: false,
//         message: 'Le profil est complet et ne peut plus être modifié. Seule la photo peut être mise à jour (3 modifications maximum).' 
//       });
//     }

//     // Construction de la requête de mise à jour
//     const updateFields = [];
//     const values = [];
//     let paramCount = 1;

//     if (etablissement_origine !== undefined) {
//       updateFields.push(`etablissement_origine = $${paramCount}`);
//       values.push(etablissement_origine);
//       paramCount++;
//     }

//     if (date_naissance !== undefined) {
//       updateFields.push(`date_naissance = $${paramCount}`);
//       values.push(date_naissance);
//       paramCount++;
//     }

//     // matricule_mers → champ matricule
//     if (matricule_mers !== undefined) {
//       updateFields.push(`matricule = $${paramCount}`);
//       values.push(matricule_mers);
//       paramCount++;
//     }

//     // numero_table_bac → champ numero_table
//     if (numero_table_bac !== undefined) {
//       updateFields.push(`numero_table = $${paramCount}`);
//       values.push(numero_table_bac);
//       paramCount++;
//     }

//     // matricule_menet → champ ip_ministere
//     if (matricule_menet !== undefined) {
//       updateFields.push(`ip_ministere = $${paramCount}`);
//       values.push(matricule_menet);
//       paramCount++;
//     }

//     if (lieu_naissance !== undefined) {
//       updateFields.push(`lieu_naissance = $${paramCount}`);
//       values.push(lieu_naissance);
//       paramCount++;
//     }

//     if (sexe !== undefined) {
//       updateFields.push(`sexe = $${paramCount}`);
//       values.push(sexe);
//       paramCount++;
//     }

//     if (serie_bac !== undefined) {
//       updateFields.push(`serie_bac = $${paramCount}`);
//       values.push(serie_bac);
//       paramCount++;
//     }

//     if (lieu_residence !== undefined) {
//       updateFields.push(`lieu_residence = $${paramCount}`);
//       values.push(lieu_residence);
//       paramCount++;
//     }

//     if (pays_naissance !== undefined) {
//       updateFields.push(`pays_naissance = $${paramCount}`);
//       values.push(pays_naissance);
//       paramCount++;
//     }

//     if (updateFields.length === 0) {
//       return res.status(400).json({ 
//         success: false,
//         message: 'Aucune donnée à mettre à jour' 
//       });
//     }

//     // Vérifier si tous les champs requis sont maintenant remplis
//     const requiredFields = [
//       'etablissement_origine',
//       'date_naissance', 
//       'matricule_mers',
//       'numero_table_bac',
//       'matricule_menet',
//       'lieu_naissance',
//       'sexe',
//       'serie_bac',
//       'lieu_residence',
//       'pays_naissance'
//     ];

//     const allFieldsComplete = requiredFields.every(field => {
//       const value = req.body[field];
//       return value !== null && value !== undefined && value !== '';
//     });

//     // Si tous les champs sont complets, marquer le profil comme complet
//     if (allFieldsComplete) {
//       updateFields.push(`is_profile_complete = true`);
//       console.log('Profil marqué comme complet pour l\'étudiant:', studentId);
//     }

//     // Ajouter l'ID de l'étudiant à la fin
//     values.push(studentId);

//     const query = `
//       UPDATE etudiant 
//       SET ${updateFields.join(', ')}
//       WHERE id = $${paramCount}
//       RETURNING *
//     `;

//     const result = await db.query(query, values);
//     const updatedStudent = result.rows[0];

//     console.log('Mise à jour réussie:', updatedStudent);

//     res.status(200).json({
//       success: true,
//       message: allFieldsComplete 
//         ? 'Profil mis à jour avec succès et verrouillé' 
//         : 'Profil mis à jour avec succès',
//       data: updatedStudent,
//       is_profile_complete: allFieldsComplete
//     });

//   } catch (error) {
//     console.error('Erreur lors de la mise à jour du profil étudiant:', error);
//     res.status(500).json({ 
//       success: false,
//       message: 'Erreur serveur lors de la mise à jour du profil',
//       error: error.message 
//     });
//   }
// };

// Mise à jour du profil étudiant
exports.updateStudentProfile = async (req, res) => {
  try {
    const studentId = req.params.id;
    const {
      etablissement_origine,
      date_naissance,
      matricule_mers, // Correspond au champ matricule
      numero_table_bac, // Correspond au champ numero_table
      matricule_menet, // Correspond au champ ip_ministere
      lieu_naissance,
      sexe,
      serie_bac,
      annee_bac, // NOUVEAU CHAMP AJOUTÉ
      lieu_residence,
      pays_naissance
    } = req.body;

    console.log('Données reçues pour mise à jour:', req.body);

    // Vérifier que l'étudiant existe
    const studentCheck = await db.query(
      'SELECT id FROM etudiant WHERE id = $1', 
      [studentId]
    );
    
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Étudiant non trouvé' 
      });
    }

    // Construction de la requête de mise à jour
    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (etablissement_origine !== undefined) {
      updateFields.push(`etablissement_origine = $${paramCount}`);
      values.push(etablissement_origine);
      paramCount++;
    }

    if (date_naissance !== undefined) {
      updateFields.push(`date_naissance = $${paramCount}`);
      values.push(date_naissance);
      paramCount++;
    }

    // matricule_mers → champ matricule
    if (matricule_mers !== undefined) {
      updateFields.push(`matricule = $${paramCount}`);
      values.push(matricule_mers);
      paramCount++;
    }

    // numero_table_bac → champ numero_table
    if (numero_table_bac !== undefined) {
      updateFields.push(`numero_table = $${paramCount}`);
      values.push(numero_table_bac);
      paramCount++;
    }

    // matricule_menet → champ ip_ministere
    if (matricule_menet !== undefined) {
      updateFields.push(`ip_ministere = $${paramCount}`);
      values.push(matricule_menet);
      paramCount++;
    }

    if (lieu_naissance !== undefined) {
      updateFields.push(`lieu_naissance = $${paramCount}`);
      values.push(lieu_naissance);
      paramCount++;
    }

    if (sexe !== undefined) {
      updateFields.push(`sexe = $${paramCount}`);
      values.push(sexe);
      paramCount++;
    }

    if (serie_bac !== undefined) {
      updateFields.push(`serie_bac = $${paramCount}`);
      values.push(serie_bac);
      paramCount++;
    }

    // NOUVEAU CHAMP - annee_bac
    if (annee_bac !== undefined) {
      updateFields.push(`annee_bac = $${paramCount}`);
      values.push(annee_bac);
      paramCount++;
    }

    if (lieu_residence !== undefined) {
      updateFields.push(`lieu_residence = $${paramCount}`);
      values.push(lieu_residence);
      paramCount++;
    }

    if (pays_naissance !== undefined) {
      updateFields.push(`pays_naissance = $${paramCount}`);
      values.push(pays_naissance);
      paramCount++;
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Aucune donnée à mettre à jour' 
      });
    }

    // Ajouter l'ID de l'étudiant à la fin
    values.push(studentId);

    const query = `
      UPDATE etudiant 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await db.query(query, values);
    const updatedStudent = result.rows[0];

    console.log('Mise à jour réussie:', updatedStudent);

    // Vérifier si tous les champs requis sont maintenant remplis
    const requiredFields = [
      'etablissement_origine',
      'date_naissance', 
      'matricule',
      'numero_table',
      'ip_ministere',
      'lieu_naissance',
      'sexe',
      'serie_bac',
      'annee_bac',
      'lieu_residence',
      'pays_naissance'
    ];

    const allFieldsComplete = requiredFields.every(field => {
      const value = updatedStudent[field];
      return value !== null && value !== undefined && value !== '';
    });

    res.status(200).json({
      success: true,
      message: 'Profil mis à jour avec succès',
      data: updatedStudent,
      is_profile_complete: allFieldsComplete
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour du profil étudiant:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de la mise à jour du profil',
      error: error.message 
    });
  }
};

// Mise à jour de la photo de profil
exports.updateStudentPhoto = async (req, res) => {
  console.log('=== DÉBUT MISE À JOUR PHOTO ===');
  
  try {
    const studentId = req.params.id;

    console.log('Student ID:', studentId);
    console.log('Fichier reçu:', req.file ? {
      originalname: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype
    } : 'AUCUN FICHIER');

    if (!req.file) {
      console.log('❌ Aucun fichier reçu dans req.file');
      return res.status(400).json({ 
        success: false,
        message: 'Aucun fichier photo fourni' 
      });
    }

    // Validation de la photo
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
    const allowedExtensions = ['.jpg', '.jpeg', '.png'];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    console.log('📁 Validation fichier:', {
      originalname: req.file.originalname,
      size: req.file.size,
      extension: fileExt,
      maxSize: MAX_FILE_SIZE
    });

    if (!allowedExtensions.includes(fileExt)) {
      console.log('❌ Format invalide:', fileExt);
      // Supprimer le fichier invalide
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ 
        success: false,
        message: 'Format de photo invalide. Formats acceptés: JPG, JPEG, PNG' 
      });
    }

    if (req.file.size > MAX_FILE_SIZE) {
      console.log('❌ Taille excessive:', req.file.size);
      // Supprimer le fichier trop gros
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ 
        success: false,
        message: 'La photo ne doit pas dépasser 2MB' 
      });
    }

    // Vérifier que l'étudiant existe
    console.log('🔍 Vérification étudiant en base...');
    const studentCheck = await db.query(
      'SELECT id, nom, prenoms, photo_url FROM etudiant WHERE id = $1', 
      [studentId]
    );
    
    if (studentCheck.rows.length === 0) {
      console.log('❌ Étudiant non trouvé:', studentId);
      // Supprimer le fichier uploadé
      if (req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ 
        success: false,
        message: 'Étudiant non trouvé' 
      });
    }

    const student = studentCheck.rows[0];
    console.log('✅ Étudiant trouvé:', { id: student.id, nom: student.nom, prenoms: student.prenoms });

    // Supprimer l'ancienne photo si elle existe
    const oldPhotoUrl = student.photo_url;
    if (oldPhotoUrl && oldPhotoUrl.startsWith('/uploads/photos/')) {
      const oldPhotoPath = path.join(__dirname, '..', oldPhotoUrl);
      console.log('🗑️ Ancienne photo à supprimer:', oldPhotoPath);
      
      if (fs.existsSync(oldPhotoPath)) {
        fs.unlinkSync(oldPhotoPath);
        console.log('✅ Ancienne photo supprimée');
      } else {
        console.log('ℹ️ Ancienne photo non trouvée sur le disque');
      }
    } else {
      console.log('ℹ️ Aucune ancienne photo à supprimer');
    }

    // Construire l'URL de la nouvelle photo
    const photoFileName = path.basename(req.file.path);
    const photoUrl = `/uploads/photos/${photoFileName}`;
    console.log('🖼️ Nouvelle photo URL:', photoUrl);

    // Mettre à jour la base de données
    console.log('💾 Mise à jour base de données...');
    const updateQuery = `
      UPDATE etudiant 
      SET photo_url = $1
      WHERE id = $2
      RETURNING id, nom, prenoms, photo_url
    `;

    const result = await db.query(updateQuery, [photoUrl, studentId]);
    const updatedStudent = result.rows[0];

    console.log('✅ Photo mise à jour avec succès:', {
      id: updatedStudent.id,
      nom: updatedStudent.nom,
      prenoms: updatedStudent.prenoms,
      photo_url: updatedStudent.photo_url
    });

    res.status(200).json({
      success: true,
      message: 'Photo de profil mise à jour avec succès',
      data: {
        id: updatedStudent.id,
        nom: updatedStudent.nom,
        prenoms: updatedStudent.prenoms,
        photo_url: updatedStudent.photo_url,
        full_url: `${req.protocol}://${req.get('host')}${updatedStudent.photo_url}`
      }
    });

  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour de la photo:', error);
    
    // Supprimer le fichier uploadé en cas d'erreur
    if (req.file && req.file.path) {
      console.log('🧹 Nettoyage fichier en erreur:', req.file.path);
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
        console.log('✅ Fichier nettoyé');
      }
    }

    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de la mise à jour de la photo',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    console.log('=== FIN MISE À JOUR PHOTO ===\n');
  }
};

// Récupération du profil étudiant
exports.getinfoProfile = async (req, res) => {
  try {
    const studentId = req.params.id;

    const query = `
      SELECT 
        id,
        matricule,
        nom,
        prenoms,
        date_naissance,
        lieu_naissance,
        telephone,
        email,
        etablissement_origine,
        lieu_residence,
        contact_parent,
        contact_parent_2,
        contact_etudiant,
        sexe,
        nationalite,
        pays_naissance,
        photo_url,
        numero_table,
        ip_ministere,
        serie_bac,
        annee_bac,
        code_unique
      FROM etudiant 
      WHERE id = $1
    `;

    const result = await db.query(query, [studentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Étudiant non trouvé' 
      });
    }

    const student = result.rows[0];

    // Vérifier si le profil est complet
    const requiredFields = [
      'etablissement_origine',
      'date_naissance', 
      'matricule',
      'numero_table',
      'ip_ministere',
      'lieu_naissance',
      'sexe',
      'serie_bac',
      'annee_bac', // AJOUTÉ ICI
      'lieu_residence',
      'pays_naissance'
    ];

    const isProfileComplete = requiredFields.every(field => {
      const value = student[field];
      return value !== null && value !== undefined && value !== '';
    });

    // Structurer la réponse selon le format attendu par le frontend
    const responseData = {
      informations_personnelles: {
        id: student.id,
        matricule: student.matricule,
        nom: student.nom,
        prenoms: student.prenoms,
        date_naissance: student.date_naissance,
        lieu_naissance: student.lieu_naissance,
        telephone: student.telephone,
        email: student.email,
        etablissement_origine: student.etablissement_origine,
        lieu_residence: student.lieu_residence,
        contact_parent: student.contact_parent,
        contact_parent_2: student.contact_parent_2,
        contact_etudiant: student.contact_etudiant,
        sexe: student.sexe,
        nationalite: student.nationalite,
        pays_naissance: student.pays_naissance,
        photo_url: student.photo_url,
        numero_table: student.numero_table,
        ip_ministere: student.ip_ministere,
        serie_bac: student.serie_bac,
        annee_bac: student.annee_bac,
        code_unique: student.code_unique,
        is_profile_complete: isProfileComplete
      },
      informations_familiales: {
        nom_parent_1: student.nom_parent_1 || null,
        nom_parent_2: student.nom_parent_2 || null
      }
    };

    res.status(200).json(responseData);

  } catch (error) {
    console.error('Erreur lors de la récupération du profil étudiant:', error);
    res.status(500).json({ 
      success: false,
      message: 'Erreur serveur lors de la récupération du profil',
      error: error.message 
    });
  }
};