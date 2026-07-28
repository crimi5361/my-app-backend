// Parcours JOUR/SOIR (curcus) : détection partagée entre l'admission (nouvelle inscription) et
// la réinscription — extraite dans un service dédié pour éviter toute dépendance circulaire entre
// reinscription.controller.js et etudiant.controller.js (qui se référencent déjà l'un l'autre).
//
// Le critère métier n'est jamais "inscription" vs "réinscription", mais uniquement le niveau
// académique sur lequel l'étudiant est effectivement affecté : dès qu'un niveau professionnel
// avancé (contenant "PRO", hors LICENCE 1/2) est atteint — que ce soit par une admission directe,
// une progression normale ou un changement de cycle en réinscription — le choix du parcours doit
// être exigé de la même façon.
exports.requiertChoixParcours = (typeFiliereLibelle, niveauLibelle) => {
  const lib = (niveauLibelle || '').trim().toUpperCase();
  const contientPro = lib.includes('PRO');
  const estL1OuL2 = /^LICENCE\s*[12]\b/.test(lib);
  return typeFiliereLibelle === 'Professionnelles' && contientPro && !estL1OuL2;
};

// Résolution atomique d'une formation (niveau + tarif + parcours) — une correction de niveau
// n'est jamais un correctif de champ isolé : le tarif applicable et l'exigence de parcours en
// dépendent tous les deux et doivent être recalculés ensemble. Source unique partagée par
// l'admission portail Web (demanderAdmissionPublic), l'admission agent (addEtudiant) et la future
// page de vérification scolarité — pour ne jamais dupliquer cette règle à trois endroits.
// Retourne soit { niveauLibelle, typeFiliereLibelle, parcoursRequis, tarif, erreur: null },
// soit { erreur: { status, code, message } } si le tarif est introuvable ou le parcours manquant.
exports.resoudreFormationEtParcours = async (dbClient, { niveauId, filiereId, curcusId, statutScolaire }) => {
  const { calculerMontantScolarite } = require('../controllers/tarif.controller');

  const tarifApplicable = await calculerMontantScolarite(niveauId, statutScolaire);
  if (!tarifApplicable || tarifApplicable.montant === null) {
    return {
      erreur: {
        status: 409,
        code: 'TARIF_INTROUVABLE',
        message: 'Aucun tarif configuré pour ce niveau. Contactez un administrateur.'
      }
    };
  }

  const niveauInfoResult = await dbClient.query(
    `SELECT n.libelle, n.filiere_id, tf.libelle AS type_filiere_libelle
     FROM niveau n
     LEFT JOIN filiere f ON f.id = n.filiere_id
     LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
     WHERE n.id = $1`,
    [niveauId]
  );
  const niveauLibelle = niveauInfoResult.rows[0]?.libelle || null;
  const typeFiliereLibelle = niveauInfoResult.rows[0]?.type_filiere_libelle || null;

  const parcoursRequis = exports.requiertChoixParcours(typeFiliereLibelle, niveauLibelle);
  if (parcoursRequis) {
    const curcusCheck = curcusId
      ? await dbClient.query(`SELECT id FROM curcus WHERE id = $1 AND type_parcours != 'Universitaire'`, [curcusId])
      : { rows: [] };
    if (curcusCheck.rows.length === 0) {
      return {
        erreur: {
          status: 400,
          code: 'PARCOURS_REQUIS',
          message: 'Le choix du parcours (Jour/Soir) est obligatoire pour ce niveau.'
        }
      };
    }
  }

  return {
    niveauLibelle,
    typeFiliereLibelle,
    filiereId: filiereId ?? niveauInfoResult.rows[0]?.filiere_id ?? null,
    parcoursRequis,
    tarif: tarifApplicable,
    erreur: null
  };
};
