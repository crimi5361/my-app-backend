// Écrans du tableau de bord vers lesquels l'assistante peut conduire (2026-08-19).
//
// Le fondateur demande où trouver telle information ; l'assistante répond en
// nommant l'écran, propose de l'y emmener, et n'y va que s'il accepte.
//
// POURQUOI UNE LISTE FERMÉE, et non les routes lues dynamiquement :
//
//   • un chemin qui vient du modèle est du TEXTE NON FIABLE. En le validant
//     contre cette liste, une route inventée ne peut pas être ouverte, et une
//     tentative d'injection dans l'URL non plus ;
//   • les routes à paramètre (`/Etudiant/Details_Etudiant/:id`) sont exclues :
//     sans identifiant elles mènent à un écran vide. Pour une personne précise,
//     la fiche existe déjà et vaut mieux qu'une redirection ;
//   • une liste écrite à la main porte une DESCRIPTION métier. « Niviaux » ne
//     dit rien au modèle ; « les niveaux d'études, de la Licence 1 au Master 2 »
//     lui permet de faire le rapprochement avec la question posée.
//
// Le libellé est ce que l'assistante prononce. Il doit se dire à voix haute :
// « la page des effectifs », pas « /Gestion_academique/Effectifs ».

const DESTINATIONS = [
  // ── Vue d'ensemble ───────────────────────────────────────────────────────
  { chemin: '/dashboard/fondateur', libelle: 'le tableau de bord du fondateur',
    sujets: "vue d'ensemble, chiffres clés, situation générale de l'établissement" },
  { chemin: '/dashboard/fondateur/assistant', libelle: "l'assistante",
    sujets: "cet écran-ci, la conversation avec l'assistante" },

  // ── Étudiants ────────────────────────────────────────────────────────────
  { chemin: '/Etudiant/Listes_Etudiant', libelle: 'la liste des étudiants',
    sujets: 'rechercher un étudiant, consulter ou modifier son dossier, liste complète' },
  { chemin: '/Etudiant/Effectifs', libelle: 'les effectifs',
    sujets: "combien d'étudiants par filière, par niveau, par école" },
  { chemin: '/Etudiant/Nouvelle_Admission', libelle: 'une nouvelle admission',
    sujets: 'inscrire un nouvel étudiant, admission' },
  { chemin: '/Etudiant/Inscriptions_En_Attente', libelle: 'les inscriptions en attente',
    sujets: 'dossiers déposés non encore validés, en attente de traitement' },
  { chemin: '/Etudiant/Reinscription', libelle: 'les réinscriptions',
    sujets: "réinscrire un étudiant pour l'année suivante" },
  { chemin: '/Etudiant/Verification', libelle: 'la vérification des dossiers',
    sujets: "contrôler les pièces d'un dossier d'inscription" },
  { chemin: '/Etudiant/Dossiers', libelle: 'les dossiers étudiants',
    sujets: "pièces justificatives, actes de naissance, diplômes" },
  { chemin: '/Etudiant/Cartes', libelle: 'les cartes étudiantes',
    sujets: 'éditer ou imprimer les cartes' },
  { chemin: '/Etudiant/Listes_Ministere', libelle: 'les listes du ministère',
    sujets: 'listes à transmettre au ministère, étudiants affectés' },

  // ── Scolarité et finances ────────────────────────────────────────────────
  { chemin: '/scolarite/paiements', libelle: 'les paiements de scolarité',
    sujets: 'qui a payé, qui doit encore, situation financière des étudiants' },
  { chemin: '/scolarite/statuts', libelle: 'les statuts de scolarité',
    sujets: 'soldé, non soldé, état de règlement' },
  { chemin: '/dashboard/comptabilite', libelle: 'le tableau de bord comptable',
    sujets: 'recettes, encaissements, situation comptable' },
  { chemin: '/dashboard/ListePec', libelle: 'les prises en charge',
    sujets: 'bourses, réductions, exonérations accordées' },

  // ── Caisse ───────────────────────────────────────────────────────────────
  { chemin: '/caisse/dashboard', libelle: 'le tableau de bord de la caisse',
    sujets: 'activité de la caisse, sessions ouvertes' },
  { chemin: '/caisse/encaisser', libelle: "l'encaissement",
    sujets: 'enregistrer un paiement au guichet' },
  { chemin: '/caisse/paiements-jour', libelle: 'les paiements du jour',
    sujets: "ce qui a été encaissé aujourd'hui" },
  { chemin: '/caisse/situation-etudiant', libelle: "la situation d'un étudiant en caisse",
    sujets: "ce qu'un étudiant a payé et ce qu'il doit" },
  { chemin: '/caisse/recherche', libelle: 'la recherche en caisse',
    sujets: 'retrouver un reçu, un paiement' },

  // ── Structure académique ─────────────────────────────────────────────────
  { chemin: '/Gestion_academique/Ecoles', libelle: 'les écoles',
    sujets: "les écoles de l'établissement" },
  { chemin: '/Gestion_academique/Departements', libelle: 'les départements',
    sujets: 'organisation en départements' },
  { chemin: '/Gestion_academique/Filieres', libelle: 'les filières',
    sujets: "les filières d'études proposées" },
  { chemin: '/Gestion_academique/Niviaux', libelle: 'les niveaux',
    sujets: "les niveaux d'études, de la Licence 1 au Master 2, les BTS" },
  { chemin: '/Gestion_academique/Classes', libelle: 'les classes',
    sujets: 'les classes constituées' },
  { chemin: '/Gestion_academique/GestionGroupes', libelle: 'les groupes',
    sujets: 'répartition des étudiants en groupes' },
  { chemin: '/Gestion_academique/Maquettes', libelle: 'les maquettes pédagogiques',
    sujets: 'programme, unités d\'enseignement, matières et crédits' },
  { chemin: '/Gestion_academique/Salles', libelle: 'les salles',
    sujets: 'salles de cours, capacités' },
  { chemin: '/Gestion_academique/Annes_accademique', libelle: 'les années académiques',
    sujets: "ouvrir ou fermer une année, l'année en cours" },
  { chemin: '/Gestion_academique/Sites', libelle: 'les sites',
    sujets: "les campus de l'établissement" },
  { chemin: '/Gestion_academique/Professeur', libelle: 'les professeurs',
    sujets: 'corps enseignant' },

  // ── Résultats ────────────────────────────────────────────────────────────
  { chemin: '/Gestion_academique/Resultats', libelle: 'les résultats',
    sujets: 'notes, moyennes, délibérations, admis et ajournés' },
  { chemin: '/Gestion_academique/statistique_Resulat', libelle: 'les statistiques de résultats',
    sujets: 'taux de réussite, taux d\'échec, comparaisons' },
  { chemin: '/Gestion_academique/Statistique', libelle: 'les statistiques académiques',
    sujets: 'chiffres de la scolarité, répartitions' },
  { chemin: '/Gestion_academique/Memoires', libelle: 'les mémoires',
    sujets: 'mémoires de fin de cycle, soutenances' },

  // ── Ressources humaines et pédagogie ─────────────────────────────────────
  { chemin: '/rh/dashboard', libelle: 'le tableau de bord des ressources humaines',
    sujets: 'vue RH, recrutement enseignant' },
  { chemin: '/rh/enseignants', libelle: 'les enseignants',
    sujets: 'enseignants recrutés, leurs contrats' },
  { chemin: '/rh/offres', libelle: "les offres d'emploi",
    sujets: 'postes publiés, recrutement' },
  { chemin: '/rh/candidatures', libelle: 'les candidatures',
    sujets: 'candidatures reçues pour un poste' },
  { chemin: '/rh/contrats', libelle: 'les contrats',
    sujets: 'contrats des enseignants, volumes horaires' },
  { chemin: '/charge-pedagogique/emploi-du-temps', libelle: "l'emploi du temps",
    sujets: 'planning des cours, séances, occupation des salles' },
  { chemin: '/charge-pedagogique/besoins', libelle: 'les besoins en enseignants',
    sujets: 'matières à pourvoir' },

  // ── Moyens généraux ──────────────────────────────────────────────────────
  { chemin: '/moyens-generaux/stock', libelle: 'le stock',
    sujets: 'accessoires, fournitures, niveaux de stock et alertes' },
  { chemin: '/moyens-generaux/distribution', libelle: 'la distribution',
    sujets: 'remise des kits et accessoires aux étudiants' },
  { chemin: '/moyens-generaux/commandes', libelle: 'les commandes fournisseurs',
    sujets: 'achats, commandes en cours' },
  { chemin: '/moyens-generaux/fournisseurs', libelle: 'les fournisseurs',
    sujets: 'liste des fournisseurs' },

  // ── Administration ───────────────────────────────────────────────────────
  { chemin: '/Parametres/gestion_utilisateur', libelle: 'la gestion des utilisateurs',
    sujets: 'comptes du personnel, créer ou désactiver un compte' },
  { chemin: '/Parametres/gestion_permission', libelle: 'la gestion des permissions',
    sujets: 'droits et rôles applicatifs' },
];

/** Index par chemin — la validation doit être immédiate et exacte. */
const PAR_CHEMIN = new Map(DESTINATIONS.map((d) => [d.chemin, d]));

/** Un chemin proposé par le modèle est-il une destination connue ? */
function destinationValide(chemin) {
  return PAR_CHEMIN.get(String(chemin || '').trim()) || null;
}

/** Catalogue compact pour l'instruction système. Une ligne par écran. */
function catalogueTexte() {
  return DESTINATIONS
    .map((d) => `- ${d.chemin} — ${d.libelle} : ${d.sujets}`)
    .join('\n');
}

module.exports = { DESTINATIONS, destinationValide, catalogueTexte };
