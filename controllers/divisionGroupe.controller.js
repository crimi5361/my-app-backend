// // controllers/divisionGroupeController.js
// const db = require('../config/db.config');

// exports.diviserGroupes = async (req, res) => {
//   const client = await db.connect();
  
//   try {
//     await client.query('BEGIN');
    
//     const { classe_id, nombre_groupes, capacite_max } = req.body;
    
//     if (!classe_id) {
//       throw new Error('classe_id est requis');
//     }

//     // 1. Récupérer les informations de la classe
//     const classeResult = await client.query(
//       'SELECT id, nom FROM classe WHERE id = $1',
//       [classe_id]
//     );
    
//     if (classeResult.rows.length === 0) {
//       throw new Error('Classe non trouvée');
//     }
    
//     const nomClasse = classeResult.rows[0].nom;

//     // 2. Récupérer le groupe 1 de la classe
//     const groupe1Result = await client.query(
//       `SELECT id, nom FROM groupe 
//        WHERE classe_id = $1 AND nom LIKE '%Groupe 1%'`,
//       [classe_id]
//     );

//     if (groupe1Result.rows.length === 0) {
//       throw new Error('Aucun groupe 1 trouvé pour cette classe');
//     }

//     const groupe1Id = groupe1Result.rows[0].id;

//     // 3. Compter les étudiants dans le groupe 1
//     const countResult = await client.query(
//       `SELECT COUNT(*) as total_etudiants 
//        FROM etudiant 
//        WHERE groupe_id = $1`,
//       [groupe1Id]
//     );
    
//     const totalEtudiants = parseInt(countResult.rows[0].total_etudiants);

//     if (totalEtudiants === 0) {
//       throw new Error('Aucun étudiant dans le groupe 1');
//     }

//     // 4. Déterminer le nombre de groupes et la capacité
//     let nombreGroupesFinal;
//     let capaciteMaxFinal;
    
//     if (capacite_max) {
//       nombreGroupesFinal = Math.ceil(totalEtudiants / capacite_max);
//       capaciteMaxFinal = capacite_max;
//     } else if (nombre_groupes) {
//       nombreGroupesFinal = nombre_groupes;
//       capaciteMaxFinal = Math.ceil(totalEtudiants / nombre_groupes);
//     } else {
//       throw new Error('Soit nombre_groupes, soit capacite_max doit être spécifié');
//     }

//     // 5. Mettre à jour la capacité du groupe 1
//     await client.query(
//       `UPDATE groupe SET capacite_max = $1 
//        WHERE id = $2`,
//       [capaciteMaxFinal, groupe1Id]
//     );

//     // 6. Créer les nouveaux groupes supplémentaires si nécessaire
//     const groupesIds = [groupe1Id];
    
//     for (let i = 2; i <= nombreGroupesFinal; i++) {
//       const nouveauGroupeResult = await client.query(
//         `INSERT INTO groupe (nom, capacite_max, classe_id) 
//          VALUES ($1, $2, $3) RETURNING id`,
//         [`${nomClasse} Groupe ${i}`, capaciteMaxFinal, classe_id]
//       );
//       groupesIds.push(nouveauGroupeResult.rows[0].id);
//     }

//     // 7. Répartir les étudiants équitablement
//     const etudiantsResult = await client.query(
//       `SELECT id FROM etudiant 
//        WHERE groupe_id = $1 
//        ORDER BY id`,
//       [groupe1Id]
//     );
    
//     const etudiants = etudiantsResult.rows;
//     const etudiantsParGroupe = Math.ceil(etudiants.length / nombreGroupesFinal);

//     for (let i = 0; i < etudiants.length; i++) {
//       const groupeIndex = Math.floor(i / etudiantsParGroupe);
//       const nouveauGroupeId = groupesIds[groupeIndex];
      
//       await client.query(
//         `UPDATE etudiant SET groupe_id = $1 WHERE id = $2`,
//         [nouveauGroupeId, etudiants[i].id]
//       );
//     }

//     await client.query('COMMIT');
    
//     res.status(200).json({
//       success: true,
//       message: `Division réussie en ${nombreGroupesFinal} groupes`,
//       data: {
//         total_etudiants: totalEtudiants,
//         nombre_groupes: nombreGroupesFinal,
//         capacite_max: capaciteMaxFinal,
//         etudiants_par_groupe: etudiantsParGroupe,
//         groupes_crees: groupesIds
//       }
//     });
    
//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('Erreur lors de la division des groupes:', error);
    
//     res.status(400).json({
//       success: false,
//       message: error.message
//     });
//   } finally {
//     client.release();
//   }
// };

// // Fonction pour obtenir les statistiques des groupes d'une classe
// exports.getStatistiquesGroupes = async (req, res) => {
//   const client = await db.connect();
  
//   try {
//     const { classe_id } = req.params;
    
//     const result = await client.query(
//       `SELECT 
//         g.id,
//         g.nom,
//         g.capacite_max,
//         COUNT(e.id) as nombre_etudiants,
//         (g.capacite_max - COUNT(e.id)) as places_restantes
//        FROM groupe g
//        LEFT JOIN etudiant e ON e.groupe_id = g.id
//        WHERE g.classe_id = $1
//        GROUP BY g.id, g.nom, g.capacite_max
//        ORDER BY g.nom`,
//       [classe_id]
//     );
    
//     res.status(200).json({
//       success: true,
//       data: result.rows
//     });
    
//   } catch (error) {
//     console.error('Erreur lors de la récupération des statistiques:', error);
    
//     res.status(500).json({
//       success: false,
//       message: error.message
//     });
//   } finally {
//     client.release();
//   }
// };