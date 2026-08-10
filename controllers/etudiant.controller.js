const db = require('../config/db.config');
const bcrypt = require('bcrypt');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const { isKitSuspenduPourAnnee } = require('../services/kitCampagne.service');
const { v4: uuidv4 } = require('uuid');
const { genererCodeCandidat } = require('../services/codePaiement.service');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { validerReferentielsIdentite } = require('../services/referentielIdentite.service');

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

exports.validatePhotoFile = validatePhotoFile;
exports.generateMatriculeIIPEA = generateMatriculeIIPEA;
exports.generateCodeUnique = generateCodeUnique;

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

    // Code de paiement unique — l'admission est de facto "en attente de paiement" dès sa
    // création ; la vérification d'existence se fait via SELECT (jamais de violation de
    // contrainte possible ici), donc aucun risque d'empoisonner la transaction en cours.
    let codePaiementAdmission = null;
    for (let tentative = 0; tentative < 8 && !codePaiementAdmission; tentative++) {
      const candidat = genererCodeCandidat('AD');
      const existe = await client.query('SELECT 1 FROM etudiant WHERE code_paiement = $1', [candidat]);
      if (existe.rows.length === 0) codePaiementAdmission = candidat;
    }
    if (!codePaiementAdmission) {
      throw new Error("Impossible de générer un code de paiement unique après plusieurs tentatives.");
    }

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
      etudiant: ['nom', 'prenoms', 'date_naissance', 'sexe', 'nationalite', 'telephone', 'email_personnel', 'contact_parent'],
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

    if (req.body.engagement_accepte !== 'true') {
      return res.status(400).json({
        success: false,
        error: "L'engagement (certification d'exactitude des informations) doit être accepté.",
        code: 'ENGAGEMENT_REQUIRED'
      });
    }

    // ✅ Résolution atomique formation+tarif+parcours (services/parcoursProfessionnel.service.js) :
    // jamais de calcul de tarif ou de garde-fou parcours isolé — les deux dépendent du même niveau
    // et doivent être cohérents entre eux, pour l'admission agent comme pour le portail Web et la
    // future vérification scolarité. Ne jamais faire confiance au montant envoyé par le client.
    const { resoudreFormationEtParcours } = require('../services/parcoursProfessionnel.service');
    const resolution = await resoudreFormationEtParcours(client, {
      niveauId: data.inscription.niveau_id,
      filiereId: data.inscription.id_filiere,
      curcusId: data.inscription.curcus_id,
      statutScolaire: data.academique.statut_scolaire,
    });
    if (resolution.erreur) {
      return res.status(resolution.erreur.status).json({
        success: false,
        error: resolution.erreur.message,
        code: resolution.erreur.code
      });
    }
    data.inscription.montant_scolarite = resolution.tarif.montant;
    data.academique.statut_scolaire = resolution.tarif.statut_applique;

    // req.files est un tableau plat depuis upload.any() (photo + doc_<CODE> mêlés)
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const photoFile0 = uploadedFiles.find(f => f.fieldname === 'photo');

    // Gestion de la photo
    // Gestion de la photo - CORRECTION ICI (utilisation de diskStorage)
    // Gestion de la photo - VERSION CORRIGÉE
if (photoFile0) {
  const photoFile = photoFile0;
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
        email_personnel,
        lieu_residence, contact_parent, nom_parent_1, nom_parent_2, code_unique, annee_bac, serie_bac,
        etablissement_origine, inscrit_par, photo_url, site_id, annee_academique_id, groupe_id,
        niveau_id, statut_scolaire, nationalite, standing, numero_table, sexe, password,
        curcus_id, id_filiere, date_inscription, contact_etudiant, contact_parent_2, matricule_iipea,
        ip_ministere,
        numero_acte_naissance, numero_piece_identite, mention_bac,
        adresse_parent_1, adresse_parent_2, engagement_accepte, code_paiement, nombre_versements_prevu
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, NOW(), $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43)
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
      data.etudiant.email_personnel,
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
      data.academique.ip_ministere || null,  // = identifiant permanent
      data.etudiant.numero_acte_naissance || null,
      data.etudiant.numero_piece_identite || null,
      data.academique.mention_bac || null,
      data.etudiant.adresse_parent_1 || null,
      data.etudiant.adresse_parent_2 || null,
      req.body.engagement_accepte === 'true',
      codePaiementAdmission,
      data.inscription.nombre_versements ? parseInt(data.inscription.nombre_versements, 10) : null
    ];

    const etudiantResult = await client.query(etudiantQuery, etudiantValues);
    const etudiantId = etudiantResult.rows[0].id;

    // 2. Insertion des documents
    // data.documents : [{ code: 'EXTRAIT_NAISSANCE', fourni: true }, ...] (codes = type_document.code)
    // uploadedFiles contient aussi les fichiers réels envoyés sous le nom de champ doc_<CODE>
    const isFourni = (code) => {
      const declared = data.documents.find(d => d.code === code)?.fourni;
      const hasFile = uploadedFiles.some(f => f.fieldname === `doc_${code}`);
      return declared === true || declared === 'true' || hasFile;
    };
    const parseDocumentValue = (fourni) => (fourni ? 'oui' : 'non');

    const docResult = await client.query(
      `INSERT INTO document (
        extrait_naissance, justificatif_identite, fiche_orientation, dernier_diplome
      ) VALUES ($1, $2, $3, $4)
      RETURNING id`,
      [
        parseDocumentValue(isFourni('EXTRAIT_NAISSANCE')),
        parseDocumentValue(isFourni('PIECE_IDENTITE')),
        parseDocumentValue(isFourni('FICHE_ORIENTATION')),
        parseDocumentValue(isFourni('DIPLOME_BAC'))
      ]
    );

    // Mise à jour de l'étudiant avec le document_id
    await client.query(
      `UPDATE etudiant SET document_id = $1 WHERE id = $2`,
      [docResult.rows[0].id, etudiantId]
    );

    // 2b. Insertion détaillée par pièce dans document_etudiant (fichier réel si fourni)
    const typeDocResult = await client.query(`SELECT id, code FROM type_document`);
    for (const typeDoc of typeDocResult.rows) {
      const file = uploadedFiles.find(f => f.fieldname === `doc_${typeDoc.code}`);
      const fourni = isFourni(typeDoc.code);
      if (!fourni && !file) continue;
      await client.query(
        `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, fichier_path, date_upload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          etudiantId,
          typeDoc.id,
          fourni,
          file ? `/uploads/documents/${file.filename}` : null,
          file ? new Date() : null
        ]
      );
    }

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
        ip_ministere: data.academique.ip_ministere || null,  // = identifiant permanent
        code_paiement: codePaiementAdmission
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
                   err.detail.includes('code_unique') ? 'code unique' :
                   err.detail.includes('code_paiement') ? 'code de paiement' : 'matricule';
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

// ─── Chargement des données de la fiche d'inscription (partagé par les 3 vues ci-dessous) ──
async function _chargerDonneesFicheAdmission(id) {
  const { calculerEcheancier } = require('../services/echeancier.service');

  const result = await db.query(
    `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.standing, e.code_paiement,
            e.photo_url, e.sexe, e.date_naissance, e.telephone, e.email,
            e.mention_bac, e.annee_bac, e.contact_parent, e.contact_parent_2,
            e.date_inscription, e.nombre_versements_prevu, e.inscrit_par,
            e.valide_scolarite, e.statut_scolaire, e.ip_ministere,
            f.nom AS filiere_nom, n.libelle AS niveau_libelle, a.annee,
            ec.nom AS ecole_nom,
            s.montant_scolarite, s.scolarite_verse, s.scolarite_restante,
            u.nom AS agent_nom,
            c.nom AS classe_nom, g.nom AS groupe_nom, g.est_primaire
     FROM etudiant e
     JOIN filiere f ON f.id = e.id_filiere
     JOIN niveau n ON n.id = e.niveau_id
     LEFT JOIN anneeacademique a ON a.id = e.annee_academique_id
     LEFT JOIN scolarite s ON s.id = e.scolarite_id
     LEFT JOIN utilisateur u ON u.id::text = e.inscrit_par
     LEFT JOIN departement dep ON dep.id = f.departement_id
     LEFT JOIN ecole ec ON ec.id = dep.ecole_id
     -- Chantier 6 : classe résolue par les critères d'affectation de l'étudiant (pas via le
     -- groupe, absent tant qu'aucun découpage manuel n'a eu lieu) — même clé que
     -- classeGroupe.service.js et getRecuData.
     LEFT JOIN classe c ON c.filiere_id = e.id_filiere AND c.niveau_id = e.niveau_id
       AND c.annee_academique_id = e.annee_academique_id AND c.curcus_id IS NOT DISTINCT FROM e.curcus_id
     LEFT JOIN groupe g ON g.id = e.groupe_id
     WHERE e.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const dossier = result.rows[0];

  // Chantier 11 (2026-08-04) — sous-phase 2 : le Groupe primaire (technique) ne doit jamais
  // apparaître sur les fiches imprimées — la requête ci-dessus ramène toujours le vrai groupe
  // (avec est_primaire), la décision de le masquer se prend uniquement ici, au moment de
  // construire les données envoyées au template (déjà conditionnel : `<% if (dossier.groupe_nom) %>`).
  if (dossier.est_primaire) {
    dossier.groupe_nom = null;
  }

  // Suivi du dossier administratif : chaque pièce demandée à l'admission, avec son statut
  // (fournie ou non) tel que coché lors de l'inscription.
  const piecesResult = await db.query(
    `SELECT td.id, td.code, td.libelle, td.obligatoire, COALESCE(de.fourni, false) AS fourni,
            COALESCE(de.declare_par_etudiant, false) AS declare_par_etudiant
     FROM type_document td
     LEFT JOIN document_etudiant de ON de.type_document_id = td.id AND de.etudiant_id = $1
     WHERE td.contexte = 'admission'
     ORDER BY td.id`,
    [id]
  );
  const piecesJustificatives = piecesResult.rows;

  const echeancier = calculerEcheancier({
    montantTotal: dossier.montant_scolarite,
    nombreVersementsPrevu: dossier.nombre_versements_prevu,
    paiementsEffectues: dossier.scolarite_verse > 0
      ? [{ montant: dossier.scolarite_verse, date: dossier.date_inscription }]
      : [],
    dateDepart: dossier.date_inscription,
  });

  return { dossier, echeancier, piecesJustificatives };
}

// ─── GET fiche récapitulative d'inscription complète (fiche + engagement) ──────────────────
// Route agent authentifiée uniquement — admission réalisée directement à l'école (Cas n°1,
// comportement inchangé) : l'agent imprime les deux pages ensemble pour faire signer sur place.
exports.afficherFicheAdmission = async (req, res) => {
  try {
    const donnees = await _chargerDonneesFicheAdmission(req.params.id);
    if (!donnees) return res.status(404).send('Dossier d\'inscription introuvable.');
    res.render('fiche_admission', { ...donnees, sections: ['fiche', 'engagement'] });
  } catch (error) {
    console.error('Erreur afficherFicheAdmission:', error);
    res.status(500).send('Erreur serveur lors de la génération de la fiche.');
  }
};

// ─── GET fiche d'inscription seule (portail public) ─────────────────────────────────────────
// La fiche d'engagement n'est plus téléchargeable depuis le portail Web (Cas n°2) — elle n'est
// imprimée qu'au moment de l'activation du code de paiement par l'agent (cf.
// afficherFicheEngagementSeule ci-dessous).
exports.afficherFicheInscriptionPublique = async (req, res) => {
  try {
    const donnees = await _chargerDonneesFicheAdmission(req.params.id);
    if (!donnees) return res.status(404).send('Dossier d\'inscription introuvable.');
    res.render('fiche_admission', { ...donnees, sections: ['fiche'] });
  } catch (error) {
    console.error('Erreur afficherFicheInscriptionPublique:', error);
    res.status(500).send('Erreur serveur lors de la génération de la fiche.');
  }
};

// ─── GET fiche d'engagement seule (route agent authentifiée) ───────────────────────────────
// Ouverte automatiquement par l'application métier juste après la confirmation d'un dossier
// d'admission Web ("Confirmer pour paiement" = activation du code de paiement), pour impression
// et signature immédiates par l'étudiant.
exports.afficherFicheEngagementSeule = async (req, res) => {
  try {
    const donnees = await _chargerDonneesFicheAdmission(req.params.id);
    if (!donnees) return res.status(404).send('Dossier d\'inscription introuvable.');
    res.render('fiche_admission', { ...donnees, sections: ['engagement'] });
  } catch (error) {
    console.error('Erreur afficherFicheEngagementSeule:', error);
    res.status(500).send('Erreur serveur lors de la génération de la fiche.');
  }
};

///=====================================================================================================================
// ✅ Amélioration tableaux Gestion des statuts / Liste des étudiants (2026-08-08) — construction
// PARTAGÉE du WHERE (filtres + recherche), utilisée à l'IDENTIQUE par getEtudiantsByDepartement
// (paginé) et exportEtudiantsByDepartement (export complet) : garantit que l'export retourne
// toujours exactement les mêmes lignes que la liste filtrée à l'écran, jamais une logique de
// filtrage divergente recalculée séparément (source des écarts liste/export avant ce chantier).
// Tous les nouveaux filtres sont optionnels et combinables (AND), par identifiant (jamais par
// libellé texte, sauf les paramètres `filiere`/`niveau` déjà existants, conservés tels quels pour
// compatibilité ascendante).
function _construireFiltresEtudiants(req, siteId, anneeAcademiqueId, ecoleId) {
  const whereClauses = ['e.site_id = $1', 'e.annee_academique_id = $2'];
  const params = [siteId, anneeAcademiqueId];
  let paramCounter = 3;

  // Filtre par standing (par défaut 'Inscrit')
  const standingFilter = req.query.standing || 'Inscrit';
  whereClauses.push(`e.standing = $${paramCounter}`);
  params.push(standingFilter);
  paramCounter++;

  // École (académique) — indépendant du cloisonnement de sécurité ecoleId, appliqué plus bas.
  if (req.query.ecole_id) {
    whereClauses.push(`dpt.ecole_id = $${paramCounter}`);
    params.push(req.query.ecole_id);
    paramCounter++;
  }

  // Département académique — nom de paramètre distinct de `departement_id` (déjà utilisé
  // ailleurs dans ce contrôleur comme site_id, ne pas réutiliser pour éviter toute confusion).
  if (req.query.academique_departement_id) {
    whereClauses.push(`f.departement_id = $${paramCounter}`);
    params.push(req.query.academique_departement_id);
    paramCounter++;
  }

  // Filière — par ID (filtre UI) ou par nom exact (paramètre historique, conservé)
  if (req.query.filiere_id) {
    whereClauses.push(`e.id_filiere = $${paramCounter}`);
    params.push(req.query.filiere_id);
    paramCounter++;
  } else if (req.query.filiere) {
    whereClauses.push(`f.nom = $${paramCounter}`);
    params.push(req.query.filiere);
    paramCounter++;
  }

  // Niveau — par ID (filtre UI) ou par libellé exact (paramètre historique, conservé)
  if (req.query.niveau_id) {
    whereClauses.push(`e.niveau_id = $${paramCounter}`);
    params.push(req.query.niveau_id);
    paramCounter++;
  } else if (req.query.niveau) {
    whereClauses.push(`n.libelle = $${paramCounter}`);
    params.push(req.query.niveau);
    paramCounter++;
  }

  if (req.query.classe_id) {
    whereClauses.push(`g.classe_id = $${paramCounter}`);
    params.push(req.query.classe_id);
    paramCounter++;
  }

  if (req.query.groupe_id) {
    whereClauses.push(`e.groupe_id = $${paramCounter}`);
    params.push(req.query.groupe_id);
    paramCounter++;
  }

  if (req.query.curcus_id) {
    whereClauses.push(`e.curcus_id = $${paramCounter}`);
    params.push(req.query.curcus_id);
    paramCounter++;
  }

  if (req.query.sexe) {
    whereClauses.push(`e.sexe = $${paramCounter}`);
    params.push(req.query.sexe);
    paramCounter++;
  }

  if (req.query.statut_scolaire) {
    whereClauses.push(`e.statut_scolaire = $${paramCounter}`);
    params.push(req.query.statut_scolaire);
    paramCounter++;
  }

  // ✅ Recherche élargie — nom, prénoms, matricule MERS, matricule IIPEA, code unique,
  // téléphone, email, ainsi que "nom prénom"/"prénom nom" concaténés (recherche combinée
  // naturelle). Toutes les colonnes ILIKE'd disposent désormais d'un index trigram GIN (voir
  // migrations/sql/020_etudiant_recherche_trgm.sql — nom/prénoms/matricule_iipea en avaient déjà,
  // matricule/code_unique/telephone/email nouvellement indexés).
  const searchTerm = req.query.search || '';
  if (searchTerm) {
    whereClauses.push(`(
      e.nom ILIKE $${paramCounter} OR
      e.prenoms ILIKE $${paramCounter} OR
      e.matricule ILIKE $${paramCounter} OR
      e.code_unique ILIKE $${paramCounter} OR
      e.matricule_iipea ILIKE $${paramCounter} OR
      e.telephone ILIKE $${paramCounter} OR
      e.email ILIKE $${paramCounter} OR
      f.nom ILIKE $${paramCounter} OR
      f.sigle ILIKE $${paramCounter} OR
      e.nationalite ILIKE $${paramCounter} OR
      (e.nom || ' ' || e.prenoms) ILIKE $${paramCounter} OR
      (e.prenoms || ' ' || e.nom) ILIKE $${paramCounter}
    )`);
    params.push(`%${searchTerm}%`);
    paramCounter++;
  }

  // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site, appliqué uniquement
  // si l'agent est restreint à une école (ecoleId non nul). Vue globale inchangée.
  if (ecoleId !== null) {
    whereClauses.push(`dpt.ecole_id = $${paramCounter}`);
    params.push(ecoleId);
    paramCounter++;
  }

  return { whereClause: 'WHERE ' + whereClauses.join(' AND '), params, paramCounter };
}

exports.getEtudiantsByDepartement = async (req, res) => {
  try {
    const departementId = req.query.departement_id || req.user?.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
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
      `SELECT a.id, a.annee, s.etat
       FROM anneeacademique a
       LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $2
       WHERE a.id = $1`,
      [anneeAcademiqueId, departementId]
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

    // ✅ Filtres + recherche — construction partagée avec exportEtudiantsByDepartement, voir
    // _construireFiltresEtudiants ci-dessus.
    const { whereClause, params, paramCounter } = _construireFiltresEtudiants(req, departementId, anneeAcademiqueId, ecoleId);

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
        aas.etat as etat_annee,

        st.nom as departement,

        c.id as curcus_id,
        c.type_parcours,

        doc.extrait_naissance,
        doc.justificatif_identite,
        doc.dernier_diplome,
        doc.fiche_orientation,

        -- Informations de groupe/classe
        g.nom as groupe_nom,
        g.est_primaire as groupe_est_primaire,
        cl.nom as classe_nom,

        -- Informations de scolarité — sourcées depuis vue_position_academique (montants déjà
        -- corrects par branche, live pour l'année courante, figés depuis historique_inscription
        -- pour une année déjà quittée) plutôt que via etudiant.scolarite_id, un pointeur COURANT
        -- qui ne retrouve plus rien pour un étudiant depuis réinscrit.
        e.montant_scolarite,
        e.scolarite_verse,
        e.scolarite_restante,
        e.statut_paiement AS statut_etudiant,
        s.prise_en_charge_id,
        COALESCE(e.montant_scolarite, 0) as montant_total_scolarite,
        COALESCE(e.scolarite_verse, 0) as montant_paye,
        COALESCE(e.scolarite_restante, 0) as montant_restant,
        CASE
          WHEN e.montant_scolarite IS NULL OR e.montant_scolarite = 0 THEN 0
          ELSE ROUND((COALESCE(e.scolarite_verse, 0) / e.montant_scolarite) * 100, 2)
        END as pourcentage_paye
      FROM vue_position_academique e
      JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN departement dpt ON f.departement_id = dpt.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = a.id AND aas.site_id = e.site_id
      JOIN site st ON e.site_id = st.id
      LEFT JOIN document doc ON e.document_id = doc.id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe cl ON g.classe_id = cl.id
      LEFT JOIN curcus c ON e.curcus_id = c.id
      ${whereClause}
      ORDER BY e.nom ASC, e.prenoms ASC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `;

    // Requête de comptage
    const countQuery = `
      SELECT COUNT(*)
      FROM vue_position_academique e
      JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN departement dpt ON f.departement_id = dpt.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
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

    // Chantier 11 (2026-08-04) — sous-phase 2 : le Groupe primaire (technique) ne doit jamais
    // apparaître dans les listes/exports affichés à l'agent — masqué ici uniquement, au moment de
    // construire la réponse ; groupe_id et toute autre donnée restent inchangés.
    const etudiantsAffiches = dataResult.rows.map((row) => ({
      ...row,
      groupe_nom: row.groupe_est_primaire ? null : row.groupe_nom,
    }));

    return res.status(200).json({
      success: true,
      data: etudiantsAffiches,
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
    const ecoleId = getEcoleScopeFromUser(req);
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
      `SELECT a.id, a.annee, s.etat
       FROM anneeacademique a
       LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $2
       WHERE a.id = $1`,
      [anneeAcademiqueId, departementId]
    );

    if (yearCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Année académique non trouvée",
        code: "ACADEMIC_YEAR_NOT_FOUND"
      });
    }

    // ✅ Filtres + recherche — EXACTEMENT la même construction que getEtudiantsByDepartement
    // (_construireFiltresEtudiants), pour garantir que l'export contient toujours 100% des lignes
    // correspondant aux filtres appliqués à l'écran, jamais une logique divergente.
    const { whereClause, params } = _construireFiltresEtudiants(req, departementId, anneeAcademiqueId, ecoleId);

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
        aas.etat AS etat_annee,

        c.type_parcours,

        g.nom AS groupe_nom,
        g.est_primaire AS groupe_est_primaire,
        cl.nom AS classe_nom,

        COALESCE(e.montant_scolarite, 0) AS montant_total_scolarite,
        COALESCE(e.scolarite_verse, 0) AS montant_paye,
        COALESCE(e.scolarite_restante, 0) AS montant_restant,
        e.statut_paiement AS statut_etudiant,

        -- Calcul du pourcentage payé
        CASE
          WHEN e.montant_scolarite IS NULL OR e.montant_scolarite = 0 THEN 0
          ELSE ROUND((COALESCE(e.scolarite_verse, 0) / e.montant_scolarite) * 100, 2)
        END AS pourcentage_paye

      FROM vue_position_academique e
      JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN departement dpt ON f.departement_id = dpt.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = a.id AND aas.site_id = e.site_id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe cl ON g.classe_id = cl.id
      LEFT JOIN curcus c ON e.curcus_id = c.id
      ${whereClause}
      ORDER BY e.nom ASC, e.prenoms ASC
    `;

    // Exécution de la requête (sans pagination)
    const result = await db.query(exportQuery, params);

    // Chantier 11 (2026-08-04) — sous-phase 2 : Groupe primaire jamais exporté (même principe
    // que getEtudiantsByDepartement ci-dessus).
    const etudiantsExportes = result.rows.map((row) => ({
      ...row,
      groupe_nom: row.groupe_est_primaire ? null : row.groupe_nom,
    }));

    return res.status(200).json({
      success: true,
      data: etudiantsExportes,
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
    const ecoleId = getEcoleScopeFromUser(req);
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
      `SELECT a.id, a.annee, s.etat
       FROM anneeacademique a
       LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $2
       WHERE a.id = $1`,
      [anneeAcademiqueId, departementId]
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
    let whereClauses = ['e.site_id = $1', 'e.standing = $2', 'e.annee_academique_id = $3'];
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

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site, appliqué uniquement
    // si l'agent est restreint (ecoleId non nul).
    if (ecoleId !== null) {
      whereClauses.push(`dpt.ecole_id = $${params.length + 1}`);
      params.push(ecoleId);
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
        e.code_paiement,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        a.annee as annee_academique,
        aas.etat as etat_annee,
        s.nom as departement,
        doc.extrait_naissance,
        doc.justificatif_identite,
        doc.dernier_diplome,
        doc.fiche_orientation
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN departement dpt ON f.departement_id = dpt.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = a.id AND aas.site_id = e.site_id
      JOIN site s ON e.site_id = s.id
      LEFT JOIN document doc ON e.document_id = doc.id
      ${whereClause}
      ORDER BY e.date_inscription DESC, e.nom ASC, e.prenoms ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN departement dpt ON f.departement_id = dpt.id
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
        e.email_personnel,
        e.nom_parent_1,
        e.nom_parent_2,
        e.date_inscription,
        e.annee_bac,
        e.serie_bac,
        e.statut_scolaire,
        e.etablissement_origine,
        e.numero_acte_naissance,
        e.numero_piece_identite,
        e.mention_bac,
        e.adresse_parent_1,
        e.adresse_parent_2,
        e.engagement_accepte,
        e.ip_ministere,
        u.nom as inscrit_par_nom,
        u.email as inscrit_par_email,
        uv.nom as verifie_par_nom,
        uv.email as verifie_par_email,
        e.date_verification,
        e.date_inscription,
        e.nationalite,
        e.standing,
        e.numero_table,
        e.sexe,
        e.photo_url,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,
        e.nombre_versements_prevu,
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        a.annee as annee_academique,
        s.nom as site,
        dept.nom as departement,
        ec.nom as ecole,
        cur.type_parcours as cursus,
        sc.montant_scolarite,
        sc.scolarite_verse,
        sc.scolarite_restante,
        sc.statut_etudiant as statut_paiement,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.est_primaire as groupe_est_primaire,
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
      JOIN site s ON e.site_id = s.id
      LEFT JOIN departement dept ON dept.id = f.departement_id
      LEFT JOIN ecole ec ON ec.id = dept.ecole_id
      LEFT JOIN curcus cur ON cur.id = e.curcus_id
      LEFT JOIN utilisateur u ON e.inscrit_par::integer = u.id
      LEFT JOIN utilisateur uv ON e.verifie_par = uv.id
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
      cree_par: etudiantData.inscrit_par_nom || etudiantData.inscrit_par_email || null,
      verifie_par: etudiantData.verifie_par_nom || etudiantData.verifie_par_email || null,
      compte_actif: etudiantData.standing === 'Inscrit',

      // Structurer les informations de groupe et classe — Chantier 11 (2026-08-04) sous-phase 2 :
      // le Groupe primaire (technique) n'est jamais affiché, seul son nom est masqué ici ; la
      // classe imbriquée ci-dessous reste toujours disponible, id/capacite_max inchangés.
      groupe: {
        id: etudiantData.groupe_id,
        nom: etudiantData.groupe_est_primaire ? null : etudiantData.groupe_nom,
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
      'groupe_id', 'groupe_nom', 'groupe_est_primaire', 'groupe_capacite', 'classe_id', 'classe_nom', 'classe_description',
      'kit_id', 'kit_montant', 'kit_deposer', 'kit_date_enregistrement',
      'prise_en_charge_id', 'prise_en_charge_reference', 'prise_en_charge_type',
      'prise_en_charge_pourcentage', 'prise_en_charge_montant_reduction',
      'prise_en_charge_statut', 'prise_en_charge_date_demande',
      'prise_en_charge_date_validation', 'prise_en_charge_valide_par',
      'prise_en_charge_motif_refus', 'inscrit_par_email', 'inscrit_par_nom',
      'verifie_par_email', 'verifie_par_nom'
    ];
    
    fieldsToDelete.forEach(field => {
      delete etudiant[field];
    });

    // Gérer les cas où la scolarité n'est pas définie
    if (etudiant.montant_scolarite === null) {
      etudiant.montant_scolarite = 0;
      etudiant.scolarite_verse = 0;
      etudiant.scolarite_restante = 0;
      etudiant.statut_paiement = "NON_DEFINI";
    }

    // Gérer les cas où le kit n'est pas défini
    if (etudiant.kit.id === null) {
      etudiant.kit = null;
    }

    // Gérer les cas où la prise en charge n'est pas définie
    if (etudiant.prise_en_charge.id === null) {
      etudiant.prise_en_charge = null;
    }

    // Pièces justificatives détaillées (checkbox + fichier éventuel, cf. module archivage)
    const documentsResult = await db.query(
      `SELECT td.code, td.libelle, td.obligatoire, de.fourni, de.fichier_path, de.storage_provider, de.date_upload
       FROM type_document td
       LEFT JOIN document_etudiant de ON de.type_document_id = td.id AND de.etudiant_id = $1
       ORDER BY td.id`,
      [parseInt(id)]
    );
    etudiant.documents_justificatifs = documentsResult.rows;

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
// Fiche étudiant (Chantier Fiche Étudiant V1, 2026-08) : édition des informations personnelles
// (état civil, contacts, parents) depuis la fiche, pour un étudiant DÉJÀ 'Inscrit' — délibérément
// distincte de `confirmerVerification` (verification.controller.js), qui reste réservée au flux de
// vérification d'un dossier Web non finalisé (source_inscription='web', standing≠'Inscrit') et
// déclenche des effets de bord propres à ce flux (valide_scolarite, verifie_par, re-résolution de
// formation/tarif) qui n'ont pas leur place dans un simple correctif de fiche. Aucune colonne
// académique (niveau/filière/curcus) n'est modifiable ici — hors périmètre V1, cf. fiche étudiant.
exports.updateInformationsPersonnelles = async (req, res) => {
  try {
    const { id } = req.params;
    const identite = req.body || {};

    const etudiantResult = await db.query(
      `SELECT nom, prenoms, sexe, nationalite, pays_naissance FROM etudiant WHERE id = $1`,
      [id]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiantActuel = etudiantResult.rows[0];

    const champsRequis = ['nom', 'prenoms', 'date_naissance', 'sexe', 'nationalite', 'telephone', 'email_personnel', 'contact_parent'];
    const manquants = champsRequis.filter(f => !identite[f]);
    if (manquants.length > 0) {
      return res.status(400).json({ success: false, message: 'Champs obligatoires manquants.', missingFields: manquants, code: 'MISSING_FIELDS' });
    }

    const champsInvalides = await validerReferentielsIdentite(identite, etudiantActuel);
    if (champsInvalides.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'REFERENTIEL_INVALIDE',
        message: `Valeur(s) invalide(s) pour : ${champsInvalides.join(', ')}.`
      });
    }

    const result = await db.query(
      `UPDATE etudiant SET
         nom = $1, prenoms = $2, date_naissance = $3, sexe = $4, nationalite = $5,
         telephone = $6, email_personnel = $7, contact_parent = $8, contact_parent_2 = $9,
         lieu_naissance = $10, pays_naissance = $11, lieu_residence = $12,
         nom_parent_1 = $13, nom_parent_2 = $14, adresse_parent_1 = $15, adresse_parent_2 = $16
       WHERE id = $17
       RETURNING id`,
      [
        identite.nom.toUpperCase(), identite.prenoms.toUpperCase(),
        moment(identite.date_naissance).format('YYYY-MM-DD'),
        identite.sexe, identite.nationalite, identite.telephone, identite.email_personnel,
        identite.contact_parent, identite.contact_parent_2 || null,
        identite.lieu_naissance || null, identite.pays_naissance || null, identite.lieu_residence || null,
        identite.nom_parent_1 || null, identite.nom_parent_2 || null,
        identite.adresse_parent_1 || null, identite.adresse_parent_2 || null,
        id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }

    res.status(200).json({ success: true, message: 'Informations personnelles mises à jour.' });
  } catch (error) {
    console.error('Erreur updateInformationsPersonnelles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Remplacement de la photo depuis la fiche étudiant — endpoint dédié, indépendant de l'admission
// et de la vérification (aucun des deux flux existants n'exposait de route seule pour ça).
// L'ancien fichier n'est volontairement pas supprimé du disque (même choix que
// verification.controller.js::confirmerVerification), seul le pointeur photo_url change.
exports.updatePhotoEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucune photo reçue.', code: 'NO_FILE' });
    }
    const validation = validatePhotoFile(req.file);
    if (!validation.valid) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: validation.error, code: 'INVALID_PHOTO' });
    }

    const photoUrl = `/uploads/photos/${req.file.filename}`;
    const result = await db.query(
      `UPDATE etudiant SET photo_url = $1 WHERE id = $2 RETURNING photo_url`,
      [photoUrl, id]
    );
    if (result.rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }

    res.status(200).json({ success: true, message: 'Photo mise à jour.', data: { photo_url: photoUrl } });
  } catch (error) {
    console.error('Erreur updatePhotoEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

///=================================================================================================
// Archivage a posteriori d'une pièce justificative (rôle archiviste) : la pièce a déjà été
// cochée "fourni" à l'inscription, l'archiviste vient seulement y attacher le fichier numérisé.
exports.uploadDocumentJustificatif = async (req, res) => {
  try {
    const { id, typeDocumentCode } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucun fichier reçu.' });
    }

    const typeDocResult = await db.query('SELECT id FROM type_document WHERE code = $1', [typeDocumentCode]);
    if (typeDocResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Type de document inconnu.' });
    }
    const typeDocumentId = typeDocResult.rows[0].id;

    const existing = await db.query(
      'SELECT fichier_path, storage_provider, drive_file_id FROM document_etudiant WHERE etudiant_id = $1 AND type_document_id = $2',
      [id, typeDocumentId]
    );

    const etudiantResult = await db.query(
      `SELECT e.nom, e.prenoms, e.matricule_iipea,
              f.nom AS filiere_nom, n.libelle AS niveau_libelle,
              d.nom AS departement_nom, ec.nom AS ecole_nom
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       WHERE e.id = $1`,
      [id]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etu = etudiantResult.rows[0];
    const hierarchy = {
      ecole: etu.ecole_nom,
      departement: etu.departement_nom,
      filiere: etu.filiere_nom,
      niveau: etu.niveau_libelle,
      nomDossierEtudiant: `${etu.nom} ${etu.prenoms} - ${etu.matricule_iipea}`,
      typeDocumentCode,
    };

    const { saveDocument, deleteDocument } = require('../services/documentStorage.service');
    const saved = await saveDocument({ file: req.file, hierarchy });

    if (existing.rows.length > 0 && (existing.rows[0].fichier_path || existing.rows[0].drive_file_id)) {
      await deleteDocument({
        fichierPath: existing.rows[0].fichier_path,
        provider: existing.rows[0].storage_provider,
        driveFileId: existing.rows[0].drive_file_id,
      });
    }

    let result;
    if (existing.rows.length > 0) {
      result = await db.query(
        `UPDATE document_etudiant SET fourni = true, fichier_path = $1, storage_provider = $2,
                drive_file_id = $3, drive_folder_id = $4, date_upload = now()
         WHERE etudiant_id = $5 AND type_document_id = $6 RETURNING *`,
        [saved.url, saved.provider, saved.driveFileId || null, saved.driveFolderId || null, id, typeDocumentId]
      );
    } else {
      result = await db.query(
        `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, fichier_path, storage_provider, drive_file_id, drive_folder_id, date_upload)
         VALUES ($1, $2, true, $3, $4, $5, $6, now()) RETURNING *`,
        [id, typeDocumentId, saved.url, saved.provider, saved.driveFileId || null, saved.driveFolderId || null]
      );
    }

    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur uploadDocumentJustificatif:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

///=================================================================================================

exports.getRecuData = async (req, res) => {
  const client = await db.connect();

  try {
    const { id } = req.params;
    const anneeAcademiqueIdParam = req.query.anneeAcademiqueId ? parseInt(req.query.anneeAcademiqueId, 10) : null;
    const { calculerEcheancier } = require('../services/echeancier.service');

    // Requête SQL optimisée avec correction des jointures
    const query = `
      SELECT
        e.id, e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.photo_url,
        e.date_naissance, e.lieu_naissance, e.telephone, e.email, e.lieu_residence,
        e.contact_parent, e.contact_parent_2, e.nationalite, e.sexe, e.code_unique,
        e.statut_scolaire, e.nombre_versements_prevu, e.date_inscription, e.annee_academique_id,
        f.nom as filiere, f.sigle as filiere_sigle,
        n.libelle as niveau,
        st.nom as departement,
        aa.annee as annee_academique,
        s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant,
        g.nom as groupe_nom,
        -- Chantier 11 (2026-08-04) — correctif régression : la classe doit TOUJOURS s'afficher,
        -- que l'étudiant ait un groupe ou non (primaire ou réel) — jamais l'un OU l'autre. Priorité
        -- à la classe du groupe réellement affecté (gc, non filtré par est_primaire — contrairement
        -- à g ci-dessus qui, lui, sert uniquement à decider si le NOM du groupe est affiché) :
        -- fiable, indépendante du cursus. Repli sur le matching filière/niveau/année/curcus
        -- uniquement si l'étudiant n'a aucun groupe — nécessaire pour certaines classes 2025-2026
        -- dont le curcus_id n'a jamais été renseigné (donnée héritée, non corrigée ici).
        COALESCE(cgc.nom, c.nom) as classe_nom,
        p.id as paiement_id, p.montant as paiement_montant, p.date_paiement, p.methode,
        r.id as recu_id, r.numero_recu, r.date_emission, r.emetteur,
        k.montant as kit_montant, k.deposer as kit_deposer, k.date_enregistrement as kit_date,
        k.annee_academique_id as kit_annee_academique_id,
        pec.id as pec_id, pec.type_pec, pec.pourcentage_reduction, pec.montant_reduction,
        pec.statut as pec_statut, pec.reference as pec_reference,
        pec.date_demande as pec_date_demande, pec.date_validation as pec_date_validation,
        pec.valide_par as pec_valide_par, pec.motif_refus as pec_motif_refus
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN scolarite s ON e.scolarite_id = s.id
      LEFT JOIN site st ON e.site_id = st.id
      LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      -- Chantier 11 (2026-08-04) — sous-phase 1 : le Groupe primaire (technique, interne au
      -- moteur d'inscription) ne doit jamais apparaître sur le reçu — tant qu'un étudiant n'est
      -- pas affecté à un vrai groupe pédagogique, seule la classe est affichée (voir plus bas,
      -- groupe_nom restera NULL, et le champ groupe de la réponse JSON est déjà construit de
      -- façon conditionnelle : null tant que groupe_nom est vide, sans changement frontend requis).
      LEFT JOIN groupe g ON e.groupe_id = g.id AND g.est_primaire = false
      -- gc : le groupe RÉEL de l'étudiant, jamais filtré par est_primaire (contrairement à g
      -- ci-dessus) — sert uniquement à retrouver sa classe de façon fiable via gc.classe_id.
      LEFT JOIN groupe gc ON gc.id = e.groupe_id
      LEFT JOIN classe cgc ON cgc.id = gc.classe_id
      -- Chantier 6 : repli historique, utilisé seulement si l'étudiant n'a aucun groupe — résolution
      -- depuis les critères d'affectation (mêmes filiere/niveau/annee_academique/curcus que
      -- classeGroupe.service.js utilise pour trouver/créer la classe).
      LEFT JOIN classe c ON c.filiere_id = e.id_filiere AND c.niveau_id = e.niveau_id
        AND c.annee_academique_id = e.annee_academique_id AND c.curcus_id IS NOT DISTINCT FROM e.curcus_id
      LEFT JOIN paiement p ON p.etudiant_id = e.id AND p.annee_academique_id = COALESCE($2::int, e.annee_academique_id)
      LEFT JOIN recu r ON p.recu_id = r.id
      LEFT JOIN kit k ON k.etudiant_id = e.id
      LEFT JOIN prise_en_charge pec ON pec.etudiant_id = e.id
      LEFT JOIN utilisateur admin ON pec.valide_par = admin.id
      WHERE e.id = $1
      ORDER BY p.date_paiement DESC, pec.date_demande DESC
    `;

    const result = await client.query(query, [id, anneeAcademiqueIdParam]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }

    // Structurer les données
    const etudiantData = result.rows[0];

    // Année demandée différente de l'année courante de l'étudiant : AUCUNE information
    // académique ne doit venir de l'état live de `etudiant` (filiere/niveau/classe/groupe
    // peuvent avoir changé depuis, via une réinscription) — tout provient de l'instantané figé
    // dans historique_inscription pour cette année précise, y compris classe et groupe
    // (régression corrigée le 2026-08-04 : avant ce correctif, classe_nom/groupe_nom restaient
    // ceux résolus par la requête principale sur l'état live de l'étudiant, jamais réécrits ici).
    const isAnneeCourante = !anneeAcademiqueIdParam || Number(anneeAcademiqueIdParam) === Number(etudiantData.annee_academique_id);
    if (!isAnneeCourante) {
      const historiqueResult = await client.query(
        `SELECT hi.montant_scolarite, hi.scolarite_verse, hi.scolarite_restante, hi.statut_paiement,
                n.libelle AS niveau, f.nom AS filiere, f.sigle AS filiere_sigle, aa.annee AS annee_academique,
                g.nom AS groupe_nom, g.est_primaire AS groupe_est_primaire,
                -- Classe historique : priorité au groupe de l'époque (fiable, capté à chaque
                -- admission/réinscription/clôture) ; repli sur un matching filière/niveau/année
                -- si ce groupe est introuvable (ex. tout premier historique, avant tout
                -- découpage). Ce repli ne connaît pas le cursus (curcus_id n'existe pas dans
                -- historique_inscription) — limite acceptée et documentée, sans impact ici
                -- puisque le reçu n'a jamais affiché de cursus.
                COALESCE(
                  cl.nom,
                  (SELECT c2.nom FROM classe c2
                   WHERE c2.filiere_id = hi.id_filiere AND c2.niveau_id = hi.niveau_id
                     AND c2.annee_academique_id = hi.annee_academique_id
                   ORDER BY c2.id LIMIT 1)
                ) AS classe_nom
         FROM historique_inscription hi
         LEFT JOIN niveau n ON n.id = hi.niveau_id
         LEFT JOIN filiere f ON f.id = hi.id_filiere
         LEFT JOIN anneeacademique aa ON aa.id = hi.annee_academique_id
         LEFT JOIN groupe g ON g.id = hi.groupe_id
         LEFT JOIN classe cl ON cl.id = g.classe_id
         WHERE hi.etudiant_id = $1 AND hi.annee_academique_id = $2
         ORDER BY hi.created_at DESC LIMIT 1`,
        [id, anneeAcademiqueIdParam]
      );
      if (historiqueResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Aucun historique trouvé pour cette année académique.' });
      }
      const historique = historiqueResult.rows[0];
      etudiantData.niveau = historique.niveau;
      etudiantData.filiere = historique.filiere;
      etudiantData.filiere_sigle = historique.filiere_sigle;
      etudiantData.annee_academique = historique.annee_academique;
      etudiantData.montant_scolarite = historique.montant_scolarite;
      etudiantData.scolarite_verse = historique.scolarite_verse;
      etudiantData.scolarite_restante = historique.scolarite_restante;
      etudiantData.statut_etudiant = historique.statut_paiement;
      // Chantier 11 (2026-08-04) — même règle de masquage du Groupe primaire que pour l'année
      // courante, appliquée ici au groupe HISTORIQUE (pas au groupe live).
      etudiantData.classe_nom = historique.classe_nom;
      etudiantData.groupe_nom = historique.groupe_est_primaire ? null : historique.groupe_nom;
    }

    // Modalités de paiement du cycle en cours : priorité à la réinscription si elle correspond
    // à l'année actuelle de l'étudiant (sinon celles renseignées à l'admission). Ne concerne que
    // le cycle en cours — une année passée n'a plus d'échéancier projeté.
    const reinscriptionActuelle = isAnneeCourante ? await client.query(
      `SELECT nombre_versements_prevu, modalite_paiement, created_at
       FROM reinscription WHERE etudiant_id = $1 AND anneeacademique_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [id, etudiantData.annee_academique_id || null]
    ) : { rows: [] };
    const modalites = reinscriptionActuelle.rows[0];
    const nombreVersementsPrevu = modalites?.nombre_versements_prevu ?? etudiantData.nombre_versements_prevu;
    const dateDepart = modalites?.created_at || etudiantData.date_inscription || new Date();

    // Paiements dédupliqués (la jointure paiement × prise_en_charge peut produire des doublons
    // par ligne PEC) — nécessaire pour un calcul d'échéancier exact.
    const paiementsUniques = Array.from(
      new Map(
        result.rows.filter(row => row.paiement_id !== null).map(row => [row.paiement_id, row])
      ).values()
    ).sort((a, b) => new Date(a.date_paiement) - new Date(b.date_paiement));

    const echeancier = isAnneeCourante ? calculerEcheancier({
      montantTotal: etudiantData.montant_scolarite,
      nombreVersementsPrevu,
      paiementsEffectues: paiementsUniques.map(p => ({ montant: p.paiement_montant, date: p.date_paiement })),
      dateDepart,
    }) : null;

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

    // Le kit peut être suspendu pour la campagne à laquelle il se rattache (cf.
    // KIT_ANNEES_SUSPENDUES) — dans ce cas le bloc est entièrement masqué du reçu, jamais
    // affiché à 0/non déposé. Basé sur l'année propre au kit (kit_annee_academique_id), pas sur
    // l'année courante de l'étudiant, pour ne jamais masquer un kit d'une campagne antérieure.
    const kitSuspendu = await isKitSuspenduPourAnnee(client, etudiantData.kit_annee_academique_id);

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
        // Chantier 6 : classe et groupe sont désormais deux champs indépendants (avant, `classe`
        // n'était accessible qu'imbriquée dans `groupe`, donc invisible tant qu'aucun groupe
        // n'existait). La classe est connue dès le premier paiement ; le groupe seulement après
        // découpage manuel de la classe par un administrateur.
        classe: etudiantData.classe_nom ? { nom: etudiantData.classe_nom } : null,
        groupe: etudiantData.groupe_nom ? { nom: etudiantData.groupe_nom } : null,

        // Scolarité
        scolarite: {
          montant_scolarite: etudiantData.montant_scolarite,
          scolarite_verse: etudiantData.scolarite_verse || 0,
          scolarite_restante: etudiantData.scolarite_restante || etudiantData.montant_scolarite,
          statut_etudiant: etudiantData.statut_etudiant || 'NON_SOLDE'
        },
        
        // Kit (masqué si le module est suspendu pour l'année à laquelle ce kit se rattache)
        kit: (etudiantData.kit_montant !== null && !kitSuspendu) ? {
          montant: etudiantData.kit_montant,
          deposer: etudiantData.kit_deposer,
          date_enregistrement: etudiantData.kit_date
        } : null,
        
        // Prise en charge - on prend la PEC active ou la dernière en attente
        prise_en_charge: pecActive || pecEnAttente || pecRefusee || null,
        
        // Toutes les PEC pour historique
        toutes_prises_en_charge: toutesLesPEC,

        // Modalités de paiement / échéancier
        echeancier
      },
      paiements: paiementsUniques.map(row => ({
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