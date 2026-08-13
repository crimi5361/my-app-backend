// Assistant Fondateur — moteur Gemini (function calling + sortie structurée).
//
// Sécurité (non négociable, cf. cahier des charges) : Gemini n'exécute JAMAIS de SQL. Il ne peut
// appeler que les 4 fonctions ci-dessous, qui délèguent toutes à getFondateurOverview (même
// agrégation "vetted" que le Dashboard Fondateur), déjà cloisonnée par site + école. Le siteId et
// l'ecoleId viennent du token JWT (req.user), jamais d'un paramètre fourni par le modèle.
const { GoogleGenAI, Type, createPartFromFunctionResponse } = require('@google/genai');
const db = require('../config/db.config');
const { getFondateurOverview } = require('./fondateurOverview.service');
const { resolveAnneeAcademiqueId } = require('./anneeAcademique.service');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// 'gemini-2.5-flash' n'est plus disponible pour les nouveaux projets (2026-08-07) — on reste sur
// l'alias "-latest" (résout actuellement vers gemini-3.6-flash, quota gratuit 5 req/min). La
// boucle ci-dessous est optimisée pour tenir dans ce quota (1-2 appels/tour au lieu de 3).
const MODEL = 'gemini-flash-latest';

const SYSTEM_INSTRUCTION = `Tu es l'Assistant Fondateur de l'application de gestion IIPEA.
Tu aides le fondateur d'un site IIPEA à piloter son établissement (finances, effectifs, stock, caisse).

Règles strictes :
- Réponds toujours en français, de façon claire, concise et professionnelle.
- N'invente JAMAIS de chiffre : utilise uniquement les données renvoyées par tes outils.
- Si une donnée n'est pas disponible via tes outils, dis-le clairement plutôt que d'halluciner.
- Les montants sont en francs CFA (XOF).
- Tu n'as accès qu'aux données du site du fondateur connecté — ne prétends jamais avoir une vue sur d'autres sites.`;

const ANNEE_PARAM = {
  annee_academique_id: {
    type: Type.INTEGER,
    description: "ID de l'année académique à interroger. Omettre pour utiliser l'année en cours du site.",
  },
};

const TOOL_DECLARATIONS = [
  {
    name: 'get_finances',
    description: "Situation financière du site : scolarité totale due, montant versé, montant restant, prises en charge (PEC) validées, et évolution mensuelle des recettes sur l'année académique.",
    parameters: { type: Type.OBJECT, properties: ANNEE_PARAM },
  },
  {
    name: 'get_effectifs',
    description: 'Effectifs et inscriptions du site : total inscrits, en attente, inscriptions du jour/semaine/mois/année, répartitions par école, filière, niveau, cursus et statut scolaire, évolution des inscriptions sur 30 jours.',
    parameters: { type: Type.OBJECT, properties: ANNEE_PARAM },
  },
  {
    name: 'get_caisse',
    description: 'Vue de synthèse des caisses du site : nombre de caisses, sessions actuellement ouvertes, encaissements du jour et du mois.',
    parameters: { type: Type.OBJECT, properties: ANNEE_PARAM },
  },
  {
    name: 'get_stock_moyens_generaux',
    description: 'État du stock et de la distribution des accessoires (Moyens Généraux) : étudiants servis, taux de couverture, références en rupture ou en stock faible, valeur estimée du stock, alertes, évolution des distributions.',
    parameters: { type: Type.OBJECT, properties: ANNEE_PARAM },
  },
];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    message: { type: Type.STRING, description: 'Réponse finale en français, destinée au fondateur.' },
    display_type: { type: Type.STRING, format: 'enum', enum: ['none', 'chart', 'table'] },
    chart: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        type: { type: Type.STRING, format: 'enum', enum: ['bar', 'line'] },
        title: { type: Type.STRING },
        labels: { type: Type.ARRAY, items: { type: Type.STRING } },
        data: { type: Type.ARRAY, items: { type: Type.NUMBER } },
      },
    },
    table: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        title: { type: Type.STRING },
        columns: { type: Type.ARRAY, items: { type: Type.STRING } },
        rows: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.STRING } } },
      },
    },
  },
  required: ['message', 'display_type'],
};

const FORMAT_INSTRUCTION = "Formate ta dernière réponse ci-dessus au format JSON demandé. Mets display_type à 'chart' ou 'table' UNIQUEMENT si des données chiffrées comparables (évolution, répartition) gagnent vraiment à être visualisées ; sinon 'none' et laisse chart/table à null. N'invente aucune donnée supplémentaire : chart/table doivent reprendre exactement les chiffres déjà donnés dans ta réponse.";

async function executeTool(name, args, toolContext) {
  const { siteId, ecoleId, overviewCache } = toolContext;
  const anneeAcademiqueId = args?.annee_academique_id ?? await resolveAnneeAcademiqueId(db, siteId);
  if (!anneeAcademiqueId) {
    return { error: 'Aucune année académique disponible pour ce site.' };
  }

  const cacheKey = `${anneeAcademiqueId}-${ecoleId}`;
  if (!overviewCache.has(cacheKey)) {
    overviewCache.set(cacheKey, await getFondateurOverview(db, { anneeAcademiqueId, siteId, ecoleId }));
  }
  const overview = overviewCache.get(cacheKey);

  switch (name) {
    case 'get_finances':
      return { finance: overview.finance };
    case 'get_effectifs':
      return {
        etudiants: overview.etudiants,
        inscriptions: overview.inscriptions,
        parEcole: overview.parEcole,
        parFiliere: overview.parFiliere,
        parNiveau: overview.parNiveau,
        parCursus: overview.parCursus,
        evolutionInscriptions: overview.evolutionInscriptions,
      };
    case 'get_caisse':
      return { caisses: overview.caisses };
    case 'get_stock_moyens_generaux':
      return { moyensGeneraux: overview.moyensGeneraux };
    default:
      return { error: `Fonction inconnue : ${name}` };
  }
}

// history : historique "curated" renvoyé par un précédent appel (types.Content[]), pour garder le
// fil de la conversation d'un message à l'autre — le frontend le repasse tel quel à chaque appel,
// aucune session n'est gardée en mémoire côté serveur (stateless, cohérent avec le reste de l'API).
//
// Quota (2026-08-07) : le tier gratuit de l'API Gemini est très restrictif (5 req/min sur
// certains modèles). On demande donc le schéma JSON final dès le départ (tools + responseSchema
// dans la même config) pour n'avoir besoin QUE des appels du function-calling, sans appel
// supplémentaire de mise en forme. On ne retombe sur l'appel séparé (plus coûteux en quota) que
// si jamais le modèle n'a pas respecté le schéma pendant la boucle d'outils.
async function runAssistantTurn({ userMessage, history, siteId, ecoleId }) {
  const chat = ai.chats.create({
    model: MODEL,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
    history,
  });

  const overviewCache = new Map();
  const toolContext = { siteId, ecoleId, overviewCache };

  let response = await chat.sendMessage({ message: userMessage });

  let safety = 0;
  while (response.functionCalls?.length && safety < 4) {
    safety += 1;
    const parts = [];
    for (const call of response.functionCalls) {
      // eslint-disable-next-line no-await-in-loop
      const result = await executeTool(call.name, call.args, toolContext);
      parts.push(createPartFromFunctionResponse(call.id ?? call.name, call.name, result));
    }
    // eslint-disable-next-line no-await-in-loop
    response = await chat.sendMessage({ message: parts });
  }

  let structured;
  try {
    structured = JSON.parse(response.text);
    if (typeof structured?.message !== 'string' || typeof structured?.display_type !== 'string') {
      throw new Error('Schéma non respecté');
    }
  } catch {
    // Filet de sécurité : un appel de plus, uniquement si le modèle n'a pas renvoyé le JSON
    // attendu directement (rare avec responseSchema, mais pas garanti à 100%).
    const formatResponse = await ai.models.generateContent({
      model: MODEL,
      contents: [
        ...chat.getHistory(),
        { role: 'user', parts: [{ text: FORMAT_INSTRUCTION }] },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    try {
      structured = JSON.parse(formatResponse.text);
    } catch {
      structured = {
        message: response.text || "Désolé, je n'ai pas pu formuler de réponse.",
        display_type: 'none',
      };
    }
  }

  return {
    structured,
    history: chat.getHistory(),
  };
}

module.exports = { runAssistantTurn };
