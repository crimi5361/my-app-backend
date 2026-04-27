const db = require('../config/db.config');

exports.getAllCertificat = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validation de l'ID
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
        e.annee_bac,
        e.serie_bac,
        e.etablissement_origine,
        e.photo_url,
        e.date_inscription,
        e.statut_scolaire,
        e.nationalite,
        e.sexe,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,
        e.pays_naissance,
        e.nom_parent_1,
        e.nom_parent_2,
        
        -- Informations de la filière
        f.id as filiere_id,
        f.nom as filiere_nom,
        f.sigle as filiere_sigle,
        
        -- Informations du niveau
        n.id as niveau_id,
        n.libelle as niveau_libelle,
        n.prix_formation as niveau_prix,
        
        -- Informations de l'année académique
        a.id as annee_academique_id,
        a.annee as annee_academique,
        a.etat as annee_etat,
        
        -- Informations du groupe
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        
        -- Informations de la classe (via groupe)
        c.id as classe_id,
        c.nom as classe_nom,
        
        -- Informations des documents
        d.extrait_naissance,
        d.justificatif_identite,
        d.dernier_diplome,
        d.fiche_orientation,
        
        -- Informations de la scolarité
        s.montant_scolarite,
        s.scolarite_verse,
        s.scolarite_restante
        
      FROM etudiant e
      
      -- Jointures obligatoires
      LEFT JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN niveau n ON e.niveau_id = n.id
      LEFT JOIN anneeacademique a ON e.annee_academique_id = a.id
      
      -- Jointures optionnelles (un étudiant peut ne pas avoir de groupe ou documents)
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN document d ON e.document_id = d.id
      LEFT JOIN scolarite s ON e.scolarite_id = s.id
      
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
    
    // Structurer les données pour le certificat
    const certificatData = {
      // Informations personnelles
      informations_personnelles: {
        id: etudiantData.id,
        matricule: etudiantData.matricule,
        code_unique: etudiantData.code_unique,
        nom: etudiantData.nom,
        prenoms: etudiantData.prenoms,
        date_naissance: etudiantData.date_naissance,
        lieu_naissance: etudiantData.lieu_naissance,
        sexe: etudiantData.sexe,
        nationalite: etudiantData.nationalite,
        telephone: etudiantData.telephone,
        email: etudiantData.email,
        contact_etudiant: etudiantData.contact_etudiant,
        contact_parent: etudiantData.contact_parent,
        contact_parent_2: etudiantData.contact_parent_2,
        lieu_residence: etudiantData.lieu_residence,
        photo_url: etudiantData.photo_url,
        matricule_iipea: etudiantData.matricule_iipea,
        pays_naissance: etudiantData.pays_naissance,
        nom_parent_1: etudiantData.nom_parent_1,
        nom_parent_2: etudiantData.nom_parent_2
      },
      
      // Informations académiques
      informations_academiques: {
        filiere: {
          id: etudiantData.filiere_id,
          nom: etudiantData.filiere_nom,
          sigle: etudiantData.filiere_sigle
        },
        niveau: {
          id: etudiantData.niveau_id,
          libelle: etudiantData.niveau_libelle,
          prix_formation: etudiantData.niveau_prix
        },
        annee_academique: {
          id: etudiantData.annee_academique_id,
          annee: etudiantData.annee_academique,
          etat: etudiantData.annee_etat
        },
        groupe: etudiantData.groupe_id ? {
          id: etudiantData.groupe_id,
          nom: etudiantData.groupe_nom,
          capacite_max: etudiantData.groupe_capacite
        } : null,
        classe: etudiantData.classe_id ? {
          id: etudiantData.classe_id,
          nom: etudiantData.classe_nom
        } : null
      },
      
      // Historique scolaire
      historique: {
        annee_bac: etudiantData.annee_bac,
        serie_bac: etudiantData.serie_bac,
        etablissement_origine: etudiantData.etablissement_origine,
        date_inscription: etudiantData.date_inscription,
        statut_scolaire: etudiantData.statut_scolaire
      },
      
      // Documents déposés
      documents: {
        extrait_naissance: etudiantData.extrait_naissance,
        justificatif_identite: etudiantData.justificatif_identite,
        dernier_diplome: etudiantData.dernier_diplome,
        fiche_orientation: etudiantData.fiche_orientation
      },
      
      // Scolarité
      scolarite: {
        montant: etudiantData.montant_scolarite || 0,
        verse: etudiantData.scolarite_verse || 0,
        restant: etudiantData.scolarite_restante || 0
      }
    };

    return res.status(200).json({
      success: true,
      data: certificatData,
      message: "Données du certificat récupérées avec succès"
    });

  } catch (err) {
    console.error("Erreur récupération données certificat:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur lors de la récupération des données du certificat",
      code: "CERTIFICAT_SERVER_ERROR",
      details: err.message
    });
  }
};