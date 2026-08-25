// Assistant Fondateur — cerveau analytique (2026-08-12).
//
// Remplace les 4 agrégations figées de geminiAssistant.service.js : le modèle écrit
// désormais lui-même le SQL, ce qui lui permet de répondre à des questions qu'on
// n'a pas anticipées. Toute la sécurité vit dans assistantSql.service.js — ici on
// ne fait qu'orchestrer la conversation et la mise en forme.
//
// CONTRE L'HALLUCINATION DE CHIFFRES — décision de conception centrale :
// la spécification de graphique ne contient AUCUNE valeur, seulement des noms de
// colonnes. Les données affichées sont les lignes SQL réelles, renvoyées par le
// serveur. Le modèle choisit quoi tracer ; il ne peut pas choisir combien.
const { GoogleGenAI, Type } = require('@google/genai');
const { executerRequete, getDictionnaire } = require('./assistantSql.service');
const { enregistrer, extraireUsage } = require('./assistantBudget.service');
const { getReglages } = require('./assistantReglages.service');
const {
  construireIdentite, BLOC_CAPACITES, BLOC_PHOTOS, BLOC_PROTECTION, BLOC_NAVIGATION, DECLARATION_WEB, BLOC_RECHERCHE, BLOC_EXPERTISE, BLOC_AUDIT, BLOC_PRUDENCE, DECLARATIONS, executerOutil,
} = require('./assistantOutils.service');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// MODÈLE ÉPINGLÉ, et c'est un revirement assumé. On visait « gemini-flash-latest »
// pour qu'un retrait de modèle daté ne casse pas la production (vécu avec
// gemini-2.5-flash le 2026-08-07). Mais un alias suit la demande : le 2026-08-21,
// « gemini-flash-latest » répondait 503 « high demand » sur toutes les requêtes,
// pendant que gemini-3.6-flash répondait normalement. Un alias indisponible coûte
// plus cher qu'un modèle retiré : le retrait se voit et se corrige, l'indisponibilité
// intermittente se confond avec une assistante défaillante.
// La variable d'environnement permet de changer de modèle sans redéployer le code.
const MODELE_ANALYSTE = process.env.ASSISTANT_MODELE_TEXTE || 'gemini-3.6-flash';

// Nombre d'appels d'outils autorises dans un tour.
const MAX_OUTILS = 8;

/**
 * Envoi au modèle, avec reprise sur indisponibilité passagère.
 *
 * POURQUOI. Le 2026-08-21, l'API Gemini répondait 503 « This model is currently
 * experiencing high demand » de façon intermittente. Sans reprise, chacune de ces
 * secondes de surcharge se traduisait pour le fondateur par une assistante en
 * panne — alors que le même appel passe à la tentative suivante.
 *
 * Uniquement sur 503 et 429 : une erreur de quota définitive, une clé invalide ou
 * une requête malformée ne se réparent pas en attendant. L'attente double à chaque
 * essai (1 s, 2 s) pour ne pas aggraver la surcharge qu'on subit.
 */
async function envoyerAuModele(chat, message) {
  const ATTENTES = [1000, 2000];
  for (let essai = 0; ; essai += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await chat.sendMessage(message);
    } catch (erreur) {
      const texte = String(erreur?.message || '');
      const passager = /\b(503|429)\b/.test(texte)
        || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(texte);
      if (!passager || essai >= ATTENTES.length) throw erreur;
      console.warn(`[assistant] modele indisponible, reprise ${essai + 1}/${ATTENTES.length}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, ATTENTES[essai]); });
    }
  }
}

// Declares une seule fois dans assistantOutils.service.js : le canal vocal utilise
// exactement les memes, sans quoi une capacite existerait au clavier et pas a l'oral.
// La recherche web n'est proposee au modele que si le fondateur l'a activee :
// un outil absent de la liste ne peut pas etre appele, ce qui est plus sur que
// de compter sur une consigne pour l'en dissuader.
const outilsPour = (reglages) => [{
  functionDeclarations: reglages?.recherche_web
    ? [...DECLARATIONS, DECLARATION_WEB]
    : DECLARATIONS,
}];

// Un tour peut desormais enchainer requetes ET production de fichier : le plafond
// monte de 4 a 8, sinon un rapport d'audit en trois sections n'aboutit jamais.
const SCHEMA_REPONSE = {
  type: Type.OBJECT,
  properties: {
    message: {
      type: Type.STRING,
      description:
        "La réponse au fondateur, en français. Elle sera LUE À VOIX HAUTE : phrases complètes, "
        + "aucun markdown, aucun tableau, aucune puce. Les montants sont arrondis et dits "
        + "naturellement (« environ 145 millions de francs CFA »), jamais « 145320000.00 ».",
    },
    visualisation: {
      type: Type.OBJECT,
      nullable: true,
      description:
        "À renseigner UNIQUEMENT si des chiffres comparables gagnent à être vus (évolution, "
        + "répartition, classement). Porte toujours sur le résultat de ta DERNIÈRE requête. "
        + "Ne contient aucune valeur : seulement des noms de colonnes.",
      properties: {
        type: { type: Type.STRING, format: 'enum', enum: ['barres', 'lignes', 'aire', 'camembert', 'barres_empilees'] },
        titre: { type: Type.STRING },
        axe_x: { type: Type.STRING, description: "Nom exact de la colonne portant les catégories ou les dates." },
        series: {
          type: Type.ARRAY,
          description: 'Une entrée par courbe/barre à tracer.',
          items: {
            type: Type.OBJECT,
            properties: {
              colonne: { type: Type.STRING, description: 'Nom exact de la colonne numérique.' },
              libelle: { type: Type.STRING, description: 'Libellé lisible affiché dans la légende.' },
            },
            required: ['colonne', 'libelle'],
          },
        },
        format_valeur: { type: Type.STRING, format: 'enum', enum: ['nombre', 'montant', 'pourcentage'] },
      },
      required: ['type', 'titre', 'axe_x', 'series', 'format_valeur'],
    },
  },
  required: ['message'],
};

function construireInstruction(dictionnaire, aujourdhui, annees, reglages) {
  // Deux niveaux de detail, et c'est deliberе : voir getDictionnaire.
  // Les vues metier en entier, les reflets de table simplement nommes.
  const catalogue = dictionnaire.metier
    .map((v) => `### ${v.vue}\n${v.description || ''}\nColonnes : ${v.colonnes.join(', ')}`)
    .join('\n\n');
  const reflets = dictionnaire.tables
    .map((v) => `- ${v.vue} (${v.nb_colonnes} col.) ${v.resume}`)
    .join('\n');

  // Injecté d'emblée plutôt que laissé à découvrir : sans ça, le modèle dépensait
  // une à deux requêtes par question rien que pour situer « l'année passée ».
  const calendrier = annees.length
    ? annees.map((a) => `- id ${a.annee_academique_id} : ${a.annee} (état : ${a.etat || 'non renseigné'})`).join('\n')
    : '- (aucune année académique enregistrée pour ce site)';

  return `${construireIdentite(reglages.nom_assistant)}

${BLOC_CAPACITES}

${BLOC_PHOTOS}

${BLOC_PROTECTION}

${BLOC_NAVIGATION}

${BLOC_RECHERCHE}

${BLOC_EXPERTISE}

${BLOC_AUDIT}

${BLOC_PRUDENCE}

Nous sommes le ${aujourdhui}.

## Années académiques de ce site
${calendrier}

Utilise ces identifiants directement : n'interroge pas v_annees_academiques pour les retrouver.
Si le fondateur dit « l'année passée » et qu'une seule année existe, réponds sur celle-là en
précisant que c'est la seule enregistrée.

## Ta seule source de vérité
Tu ne connais AUCUN chiffre de tête. Pour toute question chiffrée, tu DOIS appeler
\`executer_sql\`. N'invente jamais un nombre, même approximatif, même « à titre d'exemple ».
Si une donnée n'existe pas dans les vues ci-dessous, dis-le simplement.

## Ce que tu peux lire
Uniquement ces vues, en lecture seule. Toute écriture est impossible — n'essaie pas.
Elles sont déjà filtrées sur le site (et l'école) du fondateur connecté : n'ajoute
jamais de condition sur le site ou l'école, c'est fait pour toi.

${catalogue}

## Le reste du schema, a la demande
Ces vues refletent une table telle quelle, deja filtree sur le site du fondateur.
Elles repondent aux questions que les vues metier ne couvrent pas : notes,
scolarite, recus, tarifs, programme pedagogique, stock, candidatures.

Tu n'en connais que le NOM. Pour obtenir leurs colonnes, appelle \`decrire_table\`
AVANT d'ecrire le SQL. N'invente jamais un nom de colonne.

${reflets}

## Règles de rédaction du SQL
- Un seul SELECT à la fois, sans point-virgule final.
- Préfixe toujours les vues par \`assistant.\` (exemple : \`assistant.v_etudiants\`).
- Les effectifs se comptent avec \`WHERE standing = 'Inscrit'\`.
- Donne des colonnes aux noms lisibles (\`AS effectif\`, \`AS total_encaisse\`) : ils
  serviront de légende dans les graphiques.
- En cas d'erreur renvoyée, corrige et relance. Tu as ${MAX_OUTILS} appels d'outils par question,
  alors vise juste du premier coup : une requête bien construite plutôt que trois explorations.

## Ne calcule JAMAIS de tête
C'est ta faiblesse principale. Additionner ou moyenner des lignes mentalement produit
des chiffres faux — tu l'as déjà fait. Si tu as besoin d'un total, d'une moyenne, d'un
pourcentage ou d'un cumul, demande-le à SQL (\`SUM\`, \`AVG\`, \`ROUND\`, \`COUNT\`), même si
ça coûte une requête de plus. Ne cite qu'un chiffre lu tel quel dans un résultat.
Si des libellés désignent visiblement la même chose (par exemple 'CI' et 'CÔTE D'IVOIRE'),
regroupe-les DANS la requête, pas dans ta tête.

## Comment tu réponds
Ta réponse sera LUE À VOIX HAUTE. Donc :
- Phrases complètes. Aucun markdown, aucun tableau, aucune puce, aucun symbole.
- Le chiffre demandé en premier, dans la première phrase.
- Arrondis et prononce naturellement : « environ 1,9 milliard de francs CFA »,
  « un peu plus de sept mille étudiants ». Jamais « 1931320000.00 ».
- Deux à trois phrases suffisent. Le fondateur relancera s'il veut le détail.
- Quand des chiffres comparables se prêtent à un visuel, renseigne \`visualisation\`
  et propose-le à l'oral en une courte phrase (« Je peux te le montrer en graphique »).
- Les montants sont en francs CFA.`;
}

/**
 * Répond à une question du fondateur en interrogeant la base.
 *
 * @param {object} p
 * @param {string} p.question
 * @param {Array}  [p.historique]  historique "curated" d'un tour précédent (types.Content[])
 * @param {number} p.siteId        issu du JWT — jamais du modèle
 * @param {number|null} p.ecoleId  issu du JWT
 * @returns {Promise<{message, visualisation, donnees, colonnes, requetes, historique}>}
 */
async function repondreQuestion({ question, historique = [], siteId, ecoleId = null, utilisateurId = null }) {
  const [dictionnaire, calendrier, reglages] = await Promise.all([
    getDictionnaire({ siteId, ecoleId }),
    executerRequete(
      'SELECT annee_academique_id, annee, etat FROM assistant.v_annees_academiques ORDER BY annee DESC',
      { siteId, ecoleId }
    ),
    getReglages(siteId),
  ]);
  const aujourdhui = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const chat = ai.chats.create({
    model: MODELE_ANALYSTE,
    config: {
      systemInstruction: construireInstruction(
        dictionnaire, aujourdhui, calendrier.ok ? calendrier.lignes : [], reglages
      ),
      tools: outilsPour(reglages),
      // tools + responseSchema dans le même appel : le modèle boucle sur ses outils
      // puis émet directement le JSON final, sans appel de mise en forme séparé.
      responseMimeType: 'application/json',
      responseSchema: SCHEMA_REPONSE,
    },
    history: historique,
  });

  // Chaque échange avec le modèle est comptabilisé : le budget se calcule sur la
  // consommation réelle déclarée par Gemini, pas sur une estimation.
  const comptabiliser = (r) => enregistrer({
    siteId,
    utilisateurId,
    canal: 'texte',
    modele: MODELE_ANALYSTE,
    usage: extraireUsage(r?.usageMetadata),
  });

  let reponse = await envoyerAuModele(chat, { message: question });
  await comptabiliser(reponse);

  const requetes = [];        // trace de ce qui a été exécuté, montrée au fondateur
  const fichiers = [];        // classeurs et rapports produits pendant le tour
  const fiches = [];          // fiches d'identite dessinees a l'ecran
  let navigation = null;      // ecran vers lequel conduire le fondateur
  let dernierResultat = null; // alimente le graphique — jamais le modèle

  let tours = 0;
  while (reponse.functionCalls?.length && tours < MAX_OUTILS) {
    tours += 1;
    const reponsesOutils = [];

    for (const appel of reponse.functionCalls) {
      // eslint-disable-next-line no-await-in-loop
      const sortie = await executerOutil(appel.name, appel.args, { siteId, ecoleId, utilisateurId });

      if (sortie.trace) requetes.push(sortie.trace);
      if (sortie.traces) requetes.push(...sortie.traces);
      // Le dernier resultat SQL alimente le graphique : il ne repasse jamais par
      // le modele, qui ne peut donc pas en alterer les valeurs.
      if (sortie.resultat?.ok) dernierResultat = sortie.resultat;
      if (sortie.fichier) fichiers.push(sortie.fichier);
      if (sortie.fiche) fiches.push(sortie.fiche);
      if (sortie.navigation) navigation = sortie.navigation;

      reponsesOutils.push({ id: appel.id, name: appel.name, response: sortie.reponse });
    }

    // eslint-disable-next-line no-await-in-loop
    reponse = await envoyerAuModele(chat, {
      message: reponsesOutils.map((r) => ({ functionResponse: r })),
    });
    // eslint-disable-next-line no-await-in-loop
    await comptabiliser(reponse);
  }

  let structure;
  try {
    structure = JSON.parse(reponse.text);
    if (typeof structure?.message !== 'string') throw new Error('schéma non respecté');
  } catch {
    structure = {
      message: reponse.text?.slice(0, 800) || "Je n'ai pas réussi à formuler de réponse.",
      visualisation: null,
    };
  }

  const visualisation = validerVisualisation(structure.visualisation, dernierResultat);

  return {
    message: structure.message,
    visualisation,
    // Les lignes viennent du serveur, pas du modèle : le graphique ne peut pas mentir.
    donnees: visualisation ? dernierResultat.lignes : null,
    colonnes: dernierResultat?.colonnes ?? null,
    requetes,
    fichiers,
    fiches,
    navigation,
    historique: chat.getHistory(),
  };
}

/**
 * Vérifie que la spécification de graphique correspond aux colonnes réellement
 * renvoyées. Une spec qui référence une colonne inexistante produirait un
 * graphique vide côté écran : on préfère ne rien afficher.
 */
function validerVisualisation(spec, resultat) {
  if (!spec || !resultat?.ok || !resultat.lignes?.length) return null;

  const colonnes = new Set(resultat.colonnes);
  if (!colonnes.has(spec.axe_x)) return null;

  const series = (spec.series || []).filter((s) => colonnes.has(s.colonne));
  if (series.length === 0) return null;

  return {
    type: spec.type || 'barres',
    titre: spec.titre || '',
    axe_x: spec.axe_x,
    series,
    format_valeur: spec.format_valeur || 'nombre',
  };
}

module.exports = { repondreQuestion, MODELE_ANALYSTE };
