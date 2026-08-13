// Assistant Fondateur — outils et identité, partagés par les deux canaux (2026-08-12).
//
// Le canal écrit (assistantAnalyste) et le canal vocal (assistantVocal) doivent
// offrir EXACTEMENT les mêmes capacités : un fondateur qui demande un classeur à
// l'oral et ne l'obtient qu'au clavier ne comprendrait pas. Les déclarations
// d'outils et leur exécution vivent donc ici, en un seul exemplaire.
//
// PRINCIPE CONSTANT — le modèle décide de la STRUCTURE, jamais des CHIFFRES.
// Aucun outil n'accepte de valeur numérique métier en paramètre : ni le
// graphique, ni le classeur, ni le rapport. Les nombres viennent tous de SQL.
const { Type } = require('@google/genai');
const { executerRequete } = require('./assistantSql.service');
const { genererExcel, genererRapportWord } = require('./assistantFichiers.service');
const google = require('./assistantGoogle.service');

// ---------------------------------------------------------------------------
//  Identité — reprise mot pour mot par les deux canaux
// ---------------------------------------------------------------------------
const FONDATEUR = 'Monsieur Koné Ismaël';

const BLOC_IDENTITE = `# RÈGLE N°1 — TA PHRASE DE PRÉSENTATION, MOT POUR MOT

Dans CHACUN de ces cas :
  - la toute première fois que tu prends la parole dans une conversation ;
  - si on te dit bonjour, salut, ou qu'on ouvre la discussion sans rien demander ;
  - si on te demande qui tu es, ce que tu es, ce que tu fais, ou de te présenter ;

tu prononces EXACTEMENT ce texte, intégralement, sans un mot de plus ni de moins :

Bonjour, je suis l'assistante de ${FONDATEUR} et je suis là pour l'aider à piloter l'établissement. De ce fait, je suis dotée de certaines fonctionnalités qui me permettront de pouvoir l'aider dans sa prise de décision. Voulez-vous que je cite les fonctionnalités et que je vous explique ce que je suis capable de faire ?

C'est une citation, pas une consigne à interpréter. Tu ne la reformules pas, tu ne
l'abrèges pas, tu ne la personnalises pas, tu n'y ajoutes aucune phrase d'accroche.
Tu ne dis JAMAIS "je suis l'assistant vocal de l'IIPEA" ni aucune variante : tu es
l'assistante de ${FONDATEUR}, et c'est la phrase ci-dessus qui le dit.

Après l'avoir prononcée, tu T'ARRÊTES et tu attends. Aucune énumération, aucun
exemple, aucune autre question tant qu'il n'a pas répondu.
Ce n'est que s'il répond oui que tu détailles les fonctionnalités du catalogue
ci-dessous, groupées par domaine, en langage clair — il n'a pas à savoir que tu
écris du SQL.

## Qui tu es le reste du temps
L'assistante de ${FONDATEUR}, Fondateur et Directeur de l'IIPEA. Tu l'aides à piloter
son établissement et à décider sur des chiffres vérifiés. Tu parles de toi au
féminin et tu vouvoies ton interlocuteur, avec respect mais sans raideur, comme une
collaboratrice de confiance.`;

const BLOC_CAPACITES = `## Ce que tu sais faire (à n'énumérer que si on te le demande)
1. Répondre sur les chiffres — effectifs, recettes, caisse, stock, enseignants,
   candidatures, emploi du temps, salles — en interrogeant directement la base.
2. Montrer un graphique : barres, courbes, aires, camembert, barres empilées.
3. Produire un rapport d'activité par agent : qui a inscrit, encaissé, validé quoi.
4. Générer un classeur Excel de n'importe quelle extraction, prêt à télécharger.
5. Rédiger un rapport d'audit interne en Word, avec ses tableaux, téléchargeable.
6. Programmer une réunion dans l'agenda, avec lien Google Meet et invitations.
7. Consulter l'agenda et dire ce qui est prévu.
8. Faire le point sur les messages reçus dans la boîte du fondateur.
9. Rédiger un message, le lui lire, et ne l'envoyer qu'après son accord.`;

const BLOC_PRUDENCE = `## Ce que tu ne fais jamais
- Tu n'écris rien dans la base : tu es en lecture seule, définitivement.
- Tu n'envoies jamais un message sans avoir lu son contenu au fondateur et obtenu
  son accord explicite. Rédiger un brouillon et envoyer sont deux actes distincts.
- Tu n'inventes aucun chiffre, même approximatif, même « pour donner un ordre d'idée ».
- L'administrateur de la plateforme est hors de ton périmètre d'audit. Il n'apparaît
  dans aucune de tes données : si on te pose une question sur lui, dis simplement
  qu'il est exclu du périmètre d'audit.`;

// ---------------------------------------------------------------------------
//  Déclarations d'outils
// ---------------------------------------------------------------------------
const COLONNES_FICHIER = {
  type: Type.ARRAY,
  description: 'Colonnes à faire figurer, dans l\'ordre. Chaque `champ` doit exister dans le résultat du SQL.',
  items: {
    type: Type.OBJECT,
    properties: {
      champ: { type: Type.STRING, description: 'Nom exact de la colonne renvoyée par la requête.' },
      entete: { type: Type.STRING, description: 'Intitulé lisible affiché en tête de colonne.' },
      format: {
        type: Type.STRING, format: 'enum', enum: ['texte', 'nombre', 'montant', 'date'],
        description: 'Détermine la mise en forme. « montant » pour des francs CFA.',
      },
    },
    required: ['champ', 'entete'],
  },
};

const DECLARATIONS = [
  {
    name: 'executer_sql',
    description:
      "Exécute une requête SQL de LECTURE sur les vues du schéma `assistant` et renvoie les lignes. "
      + "C'est le SEUL moyen d'obtenir un chiffre. En cas d'erreur, le message explique quoi corriger : "
      + "relance une requête corrigée.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        sql: { type: Type.STRING, description: 'La requête SELECT complète.' },
        intention: {
          type: Type.STRING,
          description: "En une phrase, ce que cette requête cherche à établir (trace montrée au fondateur).",
        },
      },
      required: ['sql', 'intention'],
    },
  },
  {
    name: 'generer_excel',
    description:
      "Produit un classeur Excel téléchargeable à partir d'une requête. Utilise-le dès que le fondateur "
      + "demande un fichier, un tableau à garder, une extraction, une liste à envoyer ou à imprimer. "
      + "Le classeur contient les lignes réelles de la requête : tu ne fournis que la structure.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        titre: { type: Type.STRING, description: "Titre du classeur, sert aussi de nom de fichier." },
        sql: { type: Type.STRING, description: 'SELECT dont les lignes rempliront le classeur.' },
        colonnes: COLONNES_FICHIER,
      },
      required: ['titre', 'sql', 'colonnes'],
    },
  },
  {
    name: 'generer_rapport_audit',
    description:
      "Produit un rapport d'audit en Word, téléchargeable. Chaque section porte ton analyse rédigée et, "
      + "si tu fournis un SQL, le tableau des données correspondantes. Utilise-le pour un audit interne, "
      + "un rapport d'activité des agents, un bilan à présenter ou à archiver. "
      + "Interroge la base AVANT pour savoir ce que tu vas commenter : n'écris pas un commentaire à l'aveugle.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        titre: { type: Type.STRING },
        objet: { type: Type.STRING, description: "Une à deux phrases sur la portée de l'audit." },
        sections: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              titre: { type: Type.STRING },
              texte: { type: Type.STRING, description: "Ton analyse rédigée. Prose, pas de puces." },
              sql: { type: Type.STRING, description: 'Optionnel : SELECT dont le résultat sera mis en tableau.' },
              colonnes: COLONNES_FICHIER,
            },
            required: ['titre'],
          },
        },
      },
      required: ['titre', 'sections'],
    },
  },
  {
    name: 'programmer_reunion',
    description:
      "Crée une réunion dans l'agenda Google du fondateur, avec un lien Google Meet et l'envoi des "
      + "invitations. Demande-lui confirmation de la date, de l'heure et des participants avant d'appeler cet outil.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        titre: { type: Type.STRING },
        debut: { type: Type.STRING, description: "Début au format 2026-08-20T15:00:00 (heure locale d'Abidjan)." },
        duree_minutes: { type: Type.NUMBER },
        description: { type: Type.STRING },
        participants: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Adresses e-mail des invités.' },
        avec_meet: { type: Type.BOOLEAN, description: 'Vrai par défaut : crée un lien Meet.' },
      },
      required: ['titre', 'debut'],
    },
  },
  {
    name: 'consulter_agenda',
    description: "Liste les prochaines réunions de l'agenda du fondateur.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        depuis: { type: Type.STRING, description: 'Date ISO. Par défaut : maintenant.' },
        jusqua: { type: Type.STRING, description: 'Date ISO de fin de fenêtre.' },
        limite: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'consulter_messages',
    description:
      "Liste les messages de la boîte du fondateur (expéditeur, objet, date, extrait). Utilise la syntaxe "
      + "de recherche Gmail dans `requete` : `is:unread`, `newer_than:7d`, `from:...`, `has:attachment`. "
      + "Sers-t'en pour faire le point sur les messages reçus.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        requete: { type: Type.STRING, description: "Filtre Gmail. Défaut : in:inbox" },
        limite: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'rediger_message',
    description:
      "Rédige un message et l'enregistre en BROUILLON dans Gmail. N'ENVOIE RIEN. "
      + "Après l'appel, lis le contenu au fondateur et demande son accord avant d'appeler envoyer_message.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        destinataires: { type: Type.ARRAY, items: { type: Type.STRING } },
        copie: { type: Type.ARRAY, items: { type: Type.STRING } },
        objet: { type: Type.STRING },
        corps: { type: Type.STRING, description: 'Le message complet, en texte simple.' },
      },
      required: ['destinataires', 'objet', 'corps'],
    },
  },
  {
    name: 'envoyer_message',
    description:
      "Envoie un message. À N'APPELER QUE si le fondateur a explicitement dit d'envoyer, après avoir "
      + "entendu le contenu. Passe `brouillon_id` pour envoyer un brouillon déjà rédigé.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        brouillon_id: { type: Type.STRING, description: "Identifiant renvoyé par rediger_message." },
        destinataires: { type: Type.ARRAY, items: { type: Type.STRING } },
        copie: { type: Type.ARRAY, items: { type: Type.STRING } },
        objet: { type: Type.STRING },
        corps: { type: Type.STRING },
      },
    },
  },
];

/** Le graphique n'existe que sur les canaux qui savent l'afficher. */
const DECLARATION_GRAPHIQUE = {
  name: 'afficher_graphique',
  description:
    "Affiche un graphique à l'écran du fondateur à partir du résultat de ta DERNIÈRE requête. "
    + "Ne contient aucune valeur : seulement des noms de colonnes.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, format: 'enum', enum: ['barres', 'lignes', 'aire', 'camembert', 'barres_empilees'] },
      titre: { type: Type.STRING },
      axe_x: { type: Type.STRING, description: 'Nom exact de la colonne portant les catégories ou les dates.' },
      series: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            colonne: { type: Type.STRING },
            libelle: { type: Type.STRING },
          },
          required: ['colonne', 'libelle'],
        },
      },
      format_valeur: { type: Type.STRING, format: 'enum', enum: ['nombre', 'montant', 'pourcentage'] },
    },
    required: ['type', 'titre', 'axe_x', 'series', 'format_valeur'],
  },
};

const NOMS_SQL = new Set(['executer_sql']);
const NOMS_GOOGLE = new Set([
  'programmer_reunion', 'consulter_agenda', 'consulter_messages', 'rediger_message', 'envoyer_message',
]);

/**
 * Exécute un appel d'outil.
 *
 * @returns {Promise<{reponse:object, trace?:object, fichier?:object, resultat?:object}>}
 *   `reponse` repart au modèle ; `trace` et `fichier` sont destinés à l'écran du
 *   fondateur et ne sont jamais relus par le modèle.
 */
async function executerOutil(nom, args = {}, { siteId, ecoleId = null, utilisateurId = null }) {
  const contexte = { siteId, ecoleId, utilisateurId };

  if (NOMS_SQL.has(nom)) {
    const resultat = await executerRequete(args.sql, { siteId, ecoleId });
    const trace = {
      intention: args.intention || null,
      sql: resultat.ok ? resultat.sql_execute : args.sql,
      ok: resultat.ok,
      nb_lignes: resultat.ok ? resultat.nb_lignes : 0,
      duree_ms: resultat.duree_ms ?? null,
      motif: resultat.ok ? null : resultat.motif,
    };
    return {
      trace,
      resultat,
      reponse: resultat.ok
        ? {
          colonnes: resultat.colonnes,
          lignes: resultat.lignes,
          nb_lignes: resultat.nb_lignes,
          tronque: resultat.tronque,
        }
        : { erreur: resultat.motif },
    };
  }

  if (nom === 'generer_excel') {
    const r = await genererExcel({ ...args, ...contexte });
    if (!r.ok) return { reponse: { erreur: r.motif } };
    return {
      fichier: { id: r.id, nom: r.nom, extension: r.extension, nb_lignes: r.nb_lignes },
      trace: { intention: `Classeur « ${args.titre} »`, sql: r.sql_execute, ok: true, nb_lignes: r.nb_lignes, duree_ms: null, motif: null },
      // Le modèle apprend que le fichier est prêt, mais n'en reçoit pas le contenu :
      // rapatrier 5000 lignes dans le contexte coûterait plus que la question.
      reponse: {
        pret: true, nom_fichier: r.nom, nb_lignes: r.nb_lignes, colonnes: r.colonnes,
        note: "Le fichier est affiché à l'écran du fondateur avec un bouton de téléchargement. "
          + "Annonce-le simplement, ne redonne pas les données.",
      },
    };
  }

  if (nom === 'generer_rapport_audit') {
    const r = await genererRapportWord({ ...args, ...contexte });
    if (!r.ok) return { reponse: { erreur: r.motif || 'Rapport non produit.' } };
    return {
      fichier: { id: r.id, nom: r.nom, extension: r.extension },
      traces: r.requetes,
      reponse: {
        pret: true, nom_fichier: r.nom, sections: (args.sections || []).length,
        note: "Le rapport Word est affiché à l'écran avec un bouton de téléchargement. Annonce-le en une phrase.",
      },
    };
  }

  if (NOMS_GOOGLE.has(nom)) {
    if (!google.estConfigure()) {
      return {
        reponse: {
          erreur: "L'accès Google n'est pas encore configuré sur le serveur. Dis au fondateur que "
            + "l'agenda et la messagerie ne sont pas disponibles pour l'instant.",
        },
      };
    }
    const p = { utilisateurId, ...args };
    const r = nom === 'programmer_reunion' ? await google.creerReunion(p)
      : nom === 'consulter_agenda' ? await google.listerReunions(p)
        : nom === 'consulter_messages' ? await google.listerEmails(p)
          : nom === 'rediger_message' ? await google.redigerEmail(p)
            : await google.envoyerEmail(p);
    return { reponse: r.ok ? r : { erreur: r.motif } };
  }

  return { reponse: { erreur: `Outil inconnu : ${nom}` } };
}

module.exports = {
  FONDATEUR,
  BLOC_IDENTITE,
  BLOC_CAPACITES,
  BLOC_PRUDENCE,
  DECLARATIONS,
  DECLARATION_GRAPHIQUE,
  executerOutil,
};
