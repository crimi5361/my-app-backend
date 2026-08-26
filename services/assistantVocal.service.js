// Assistant Fondateur — passerelle vocale temps réel (2026-08-12).
//
// POURQUOI UN PROXY, ET PAS UNE CONNEXION DIRECTE DEPUIS LE NAVIGATEUR
// L'API Live s'ouvre avec la clé Gemini. La donner au navigateur revient à la
// publier : n'importe qui ouvre la console et la récupère. Le serveur reste donc
// au milieu — il garde la clé, vérifie le JWT (fondateur/admin uniquement), impose
// le cloisonnement site/école et compte la consommation.
//
// RÉPARTITION DES RÔLES
//   • Le modèle Live tient la conversation ET écrit le SQL. On a écarté le montage
//     « Live appelle l'analyste texte » : il doublait le coût et ajoutait ~10 s de
//     latence par question, ce qui détruit précisément la sensation de temps réel.
//     Avec des vues curées et le dictionnaire en contexte, le SQL reste simple.
//   • Le serveur exécute (assistantSql), construit le graphique et le pousse au
//     navigateur. Le modèle choisit quoi tracer, jamais avec quelles valeurs.
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality, Type, EndSensitivity } = require('@google/genai');
const { executerRequete, getDictionnaire } = require('./assistantSql.service');
const { verifierBudget, enregistrer, extraireUsage } = require('./assistantBudget.service');
const {
  construireIdentite, construireCapacites, BLOC_PHOTOS, BLOC_PROTECTION, BLOC_NAVIGATION, DECLARATION_WEB, BLOC_RECHERCHE, BLOC_SYNONYMES, BLOC_GRAPHIQUES, BLOC_PAGE, BLOC_EXPERTISE, BLOC_AUDIT, BLOC_PRUDENCE, DECLARATIONS, DECLARATIONS_GOOGLE, DECLARATION_GRAPHIQUE, executerOutil,
} = require('./assistantOutils.service');
const { formePour } = require('./assistantFormes.service');
const { getReglages } = require('./assistantReglages.service');
const { getVocabulaire } = require('./assistantVocabulaire.service');
const { routerMessageNavigateur, transcriptionAdmise } = require('./assistantVocalProtocole');
const { corrigerTranscription } = require('./assistantTranscription');
const { intentionOuiNon } = require('./assistantIntention');
const { debriefingVeille } = require('./assistantDebriefing.service');
const { preparerAccueil } = require('./assistantAccueil.service');
// Catalogue des ecrans : sert a traduire une route en intitule lisible avant
// de l'annoncer au modele.
const { destinationValide } = require('../config/destinations');
// Uniquement pour savoir si l'acces Google est configure — voir outilsPour.
const google = require('./assistantGoogle.service');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Tous les modèles Live disponibles sont en `preview` : un retrait est déjà arrivé
// (gemini-2.5-flash, 2026-08-07). Repli d'une ligne en cas de disparition.
const MODELE_VOCAL = process.env.ASSISTANT_MODELE_VOCAL || 'gemini-3.1-flash-live-preview';
const MODELE_VOCAL_REPLI = 'gemini-2.5-flash-native-audio-latest';

const ROLES_AUTORISES = new Set(['admin', 'fondateur']);

/**
 * Silence à observer avant de considérer que le fondateur a fini de parler.
 *
 * POURQUOI 800 ms. Un locuteur francophone qui hésite — typiquement avant un
 * chiffre, « on a encaissé… huit millions » — marque une pause de 300 à 600 ms.
 * En dessous de 700 ms l'assistante lui coupe la parole au milieu de sa phrase
 * et répond à une demi-question. Au-delà de 1200 ms, l'échange devient poussif :
 * on attend visiblement la machine. 800 ms couvre la pause naturelle en gardant
 * la réplique vive.
 *
 * `END_SENSITIVITY_LOW` va dans le même sens : la fin de parole est déclarée
 * moins facilement. C'est le réglage patient, celui qui convient à quelqu'un qui
 * réfléchit en parlant.
 */
const SILENCE_MS = Number(process.env.ASSISTANT_SILENCE_MS) || 800;

/** Marge avant le début de parole détecté, pour ne pas décapiter le premier mot. */
const PADDING_MS = 300;

/** Reprise sur échec réseau. Trois tentatives, doublées à chaque fois : au-delà,
 *  ce n'est plus un incident passager et le fondateur doit être averti plutôt
 *  que de regarder un écran qui tourne. */
const DELAIS_REPRISE_MS = [1000, 2000, 4000];

const attendre = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Un échec mérite-t-il une nouvelle tentative ?
 *
 * Le quota et l'authentification ne s'arrangent pas en réessayant : insister
 * consomme le peu qui reste et retarde le message d'erreur. Seules les coupures
 * réseau et les indisponibilités passagères sont reprises.
 */
function estReessayable(erreur) {
  const m = String(erreur?.message || '');
  if (/RESOURCE_EXHAUSTED|quota|429|PERMISSION_DENIED|UNAUTHENTICATED|API key/i.test(m)) return false;
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|UNAVAILABLE|503|500|502|504|timeout/i.test(m);
}

/**
 * Ouvre la session Live, en reprenant sur les échecs passagers.
 *
 * Deux boucles imbriquées, et pas une seule : le modèle en preview peut avoir
 * été retiré (il faut alors changer de modèle, pas réessayer le même), tandis
 * qu'une coupure réseau se répare en réessayant (et changer de modèle n'y
 * changerait rien).
 */
async function ouvrirSessionLive(ai, config, rappels) {
  const modeles = [MODELE_VOCAL, MODELE_VOCAL_REPLI];
  let derniere = null;

  for (const modele of modeles) {
    for (let essai = 0; essai <= DELAIS_REPRISE_MS.length; essai += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const session = await ai.live.connect({ model: modele, config, callbacks: rappels });
        return { session, modele };
      } catch (erreur) {
        derniere = erreur;
        if (!estReessayable(erreur)) break;               // modèle ou plan en cause
        if (essai === DELAIS_REPRISE_MS.length) break;    // reprises épuisées
        console.warn(`[vocal] ${modele} : ${erreur.message} — reprise dans ${DELAIS_REPRISE_MS[essai]} ms`);
        // eslint-disable-next-line no-await-in-loop
        await attendre(DELAIS_REPRISE_MS[essai]);
      }
    }
    if (derniere) console.warn(`[vocal] ${modele} indisponible (${derniere.message})`);
  }

  throw derniere || new Error('Aucun modèle vocal disponible.');
}

/**
 * Sessions vocales ouvertes, par utilisateur.
 *
 * Sans ce registre, ouvrir cinq onglets ouvrait cinq sessions Live simultanees,
 * chacune facturant son audio en continu : le plafond mensuel pouvait etre
 * consomme en une heure sans que personne s'en apercoive. La session la plus
 * ancienne est fermee au profit de la nouvelle, ce qui correspond a l'intention
 * du fondateur quand il rouvre l'ecran ailleurs.
 */
const sessionsOuvertes = new Map();

/**
 * Débriefing de la veille.
 *
 * L'outil prend la RÉPONSE BRUTE du fondateur, pas une interprétation. C'est le
 * serveur qui tranche, avec `intentionOuiNon` — une fonction déterministe et
 * testée. Laisser le modèle décider seul de ce qu'est un « oui » reviendrait à
 * confier à une génération de texte le déclenchement d'un rapport entier lu à
 * voix haute, sans possibilité de le vérifier.
 *
 * Propre au canal vocal, comme le graphique : le débriefing pousse plusieurs
 * visuels à l'écran, ce que seul cet écran sait afficher.
 */
const DECLARATION_DEBRIEFING = {
  name: 'debriefing_veille',
  description:
    "Établit le débriefing des mouvements de la veille : volumétrie, répartition par type d'acte, "
    + "agents les plus actifs, comparaison à la semaine. À appeler dès que le fondateur répond à ta "
    + "proposition de débriefing, QUELLE QUE SOIT sa réponse — accord, refus ou hésitation — en lui "
    + "passant sa réponse mot pour mot. N'interprète jamais toi-même : c'est l'outil qui tranche et "
    + "qui te dit quoi faire. À appeler aussi s'il redemande le débriefing plus tard dans la "
    + "conversation, avec `reponse` valant « oui ».",
  parameters: {
    type: Type.OBJECT,
    properties: {
      reponse: {
        type: Type.STRING,
        description: "Ce que le fondateur vient de répondre, mot pour mot, sans reformulation.",
      },
    },
    required: ['reponse'],
  },
};

// Memes outils que le canal ecrit, plus le graphique et le debriefing : une
// capacite qui existerait au clavier et pas a l'oral serait incomprehensible
// pour le fondateur.
const outilsPour = (reglages) => {
  const liste = [...DECLARATIONS, DECLARATION_GRAPHIQUE, DECLARATION_DEBRIEFING];
  if (reglages?.recherche_web) liste.push(DECLARATION_WEB);
  // Meme regle que pour la recherche web : un outil qu'on ne peut pas honorer
  // n'est pas declare. Voir DECLARATIONS_GOOGLE dans assistantOutils.
  if (google.estConfigure()) liste.push(...DECLARATIONS_GOOGLE);
  return [{ functionDeclarations: liste }];
};

/**
 * Protocole de l'accueil. Il est dans l'instruction et non dans le code du
 * modèle : c'est lui qui parle, on ne peut que lui dire quoi faire — mais la
 * DÉCISION, elle, est reprise côté serveur par l'outil.
 */
const blocAccueil = (phrase) => `## L'ouverture de la conversation

Quand on te demande d'ouvrir la conversation, tu prononces EXACTEMENT cette
phrase, mot pour mot, sans rien ajouter ni retirer :

${phrase}

Puis tu T'ARRÊTES et tu attends la réponse.

Dès que le fondateur répond — quoi qu'il dise, un accord, un refus ou une
hésitation — tu appelles \`debriefing_veille\` en lui passant sa réponse MOT POUR
MOT. Tu n'interprètes pas toi-même, tu ne décides pas si c'est un oui : l'outil
te répond ce qu'il faut faire, et tu le fais.

Si l'outil te renvoie un résumé, tu le lis tel quel, sans y ajouter de chiffre.
S'il te dit que la réponse est ambiguë, tu reposes la question une seule fois.
S'il te dit que c'est un refus, tu enchaînes normalement sans insister.`;

function construireInstruction(dictionnaire, annees, aujourdhui, reglages, phraseAccueil) {
  // Deux niveaux de detail, et c'est deliberе : voir getDictionnaire.
  // Les vues metier en entier, les reflets de table simplement nommes.
  const catalogue = dictionnaire.metier
    .map((v) => `### ${v.vue}\n${v.description || ''}\nColonnes : ${v.colonnes.join(', ')}`)
    .join('\n\n');
  const reflets = dictionnaire.tables
    .map((v) => `- ${v.vue} (${v.nb_colonnes} col.) ${v.resume}`)
    .join('\n');
  const calendrier = annees.length
    ? annees.map((a) => `- id ${a.annee_academique_id} : ${a.annee} (état : ${a.etat || 'non renseigné'})`).join('\n')
    : '- (aucune année académique enregistrée)';

  return `${construireIdentite(reglages.nom_assistant)}

${blocAccueil(phraseAccueil)}

${construireCapacites({ google: google.estConfigure() })}

${BLOC_PHOTOS}

${BLOC_PROTECTION}

${BLOC_NAVIGATION}

${BLOC_PAGE}

${BLOC_RECHERCHE}

${BLOC_SYNONYMES}

${BLOC_GRAPHIQUES}

${BLOC_EXPERTISE}

${BLOC_AUDIT}

${BLOC_PRUDENCE}

Vous PARLEZ ensemble : tout ce que tu ecris sera lu a voix haute.

Nous sommes le ${aujourdhui}.

## Années académiques de ce site
${calendrier}
Utilise ces identifiants directement, sans les rechercher.

## Ta seule source de vérité
Tu ne connais aucun chiffre de tête. Pour toute question chiffrée, appelle \`executer_sql\`.
N'invente jamais un nombre. Ne calcule JAMAIS de tête : un total, une moyenne ou un
pourcentage se demande à SQL (SUM, AVG, COUNT, ROUND), même si ça coûte une requête
de plus. Ne cite qu'un chiffre lu tel quel dans un résultat.

## Ce que tu peux lire
Uniquement ces vues, en lecture seule. Elles sont déjà filtrées sur le site et l'école
du fondateur : n'ajoute jamais de condition sur le site ou l'école.

${catalogue}

## Le reste du schema, a la demande
Ces vues refletent une table telle quelle, deja filtree sur le site du fondateur.
Elles repondent aux questions que les vues metier ne couvrent pas : notes,
scolarite, recus, tarifs, programme pedagogique, stock, candidatures.

Tu n'en connais que le NOM. Pour obtenir leurs colonnes, appelle \`decrire_table\`
AVANT d'ecrire le SQL. N'invente jamais un nom de colonne.

${reflets}

## Règles SQL
- Un seul SELECT, sans point-virgule final, vues préfixées par \`assistant.\`.
- Les effectifs se comptent avec \`WHERE standing = 'Inscrit'\`.
- Nomme tes colonnes lisiblement (\`AS effectif\`, \`AS total_encaisse\`) : ces noms
  deviennent les légendes des graphiques.

## Comment tu parles
Tu es à l'oral. Donc :
- Phrases courtes et complètes. Jamais de markdown, de liste à puces ni de symbole.
- Le chiffre demandé dans la première phrase.
- Arrondis et prononce naturellement : « environ 1,9 milliard de francs CFA »,
  « un peu plus de sept mille étudiants ». Jamais « 1931320000,00 ».
- Deux ou trois phrases maximum. Le fondateur relance s'il veut le détail.
- Les montants sont en francs CFA.

## Les fichiers
Quand le fondateur demande un tableau, une extraction, un classeur ou un rapport,
appelle \`generer_excel\` ou \`generer_rapport_audit\`. Le fichier apparait a son ecran
avec un bouton de telechargement : annonce-le en une phrase, ne lis pas les donnees.

## Les graphiques

DEUX SITUATIONS, et il ne faut pas les confondre.

**Tu proposes de toi-même.** Des chiffres se prêtent à un visuel, il n'a rien
demandé : propose-le en une phrase courte (« Veux-tu que je te le montre en
graphique ? ») et ATTENDS sa réponse. S'il accepte, appelle
\`afficher_graphique\`, puis commente en une ou deux phrases — ce qu'on y voit,
pas ce qu'il contient.

**Il demande un graphique.** Alors il en veut un : fais la requête et affiche-le,
sans demander confirmation. Cela vaut AUSSI quand il nomme un type que tu n'as
pas : tu dis que ce type-là t'est impossible, tu annonces celui que tu produis à
la place, et tu l'affiches dans le même tour. Ne lui redemande pas ce qu'il
préfère — il a déjà dit ce qu'il voulait voir, seule la forme change.`;
}

/**
 * Monte la passerelle sur le serveur HTTP existant.
 * Chemin : /ws/assistant-vocal
 */
function monterPasserelleVocale(serveurHttp) {
  // noServer : on gère nous-mêmes l'upgrade pour pouvoir refuser AVANT la poignée
  // de main WebSocket (un refus après coup laisse le navigateur croire à un succès).
  const wss = new WebSocketServer({ noServer: true });

  serveurHttp.on('upgrade', (requete, socket, tete) => {
    if (!requete.url?.startsWith('/ws/assistant-vocal')) return;

    // Le jeton passe par le sous-protocole WebSocket, pas par l'URL : les query
    // strings finissent dans les journaux d'accès, pas les en-têtes.
    const protocoles = (requete.headers['sec-websocket-protocol'] || '')
      .split(',').map((p) => p.trim());
    const jeton = protocoles[1];

    let utilisateur;
    try {
      utilisateur = jwt.verify(jeton, process.env.JWT_SECRET);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!ROLES_AUTORISES.has(utilisateur.role)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(requete, socket, tete, (ws) => {
      const precedente = sessionsOuvertes.get(utilisateur.id);
      if (precedente && precedente.readyState <= precedente.OPEN) {
        try { precedente.close(1000, 'session reprise ailleurs'); } catch { /* deja fermee */ }
      }
      sessionsOuvertes.set(utilisateur.id, ws);
      ws.on('close', () => {
        if (sessionsOuvertes.get(utilisateur.id) === ws) sessionsOuvertes.delete(utilisateur.id);
      });

      demarrerSession(ws, {
        siteId: utilisateur.departement_id,
        ecoleId: utilisateur.ecole_id ?? null,
        utilisateurId: utilisateur.id,
      });
    }, 'jwt');
  });

  console.log('  ✅ /ws/assistant-vocal (passerelle Gemini Live)');
  return wss;
}

async function demarrerSession(ws, { siteId, ecoleId, utilisateurId }) {
  const envoyer = (type, charge = {}) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...charge }));
  };

  let sessionLive = null;
  let dernierResultat = null; // alimente les graphiques — jamais le modèle
  let fermee = false;

  const fermer = (raison) => {
    if (fermee) return;
    fermee = true;
    try { sessionLive?.close(); } catch { /* déjà fermée */ }
    if (ws.readyState === ws.OPEN) ws.close(1000, raison || 'fin de session');
  };

  try {
    if (!siteId) { envoyer('erreur', { message: 'Site introuvable. Reconnectez-vous.' }); return fermer(); }

    // La consommation est relue a l'ouverture pour la journaliser cote serveur.
    // Elle ne conditionne plus l'ouverture : le plafond applicatif mesurait une
    // depense qui n'existait pas (voir assistantBudget.verifierBudget).
    const budget = await verifierBudget(siteId);

    const [dictionnaire, calendrier, reglages, vocabulaire, accueil] = await Promise.all([
      getDictionnaire({ siteId, ecoleId }),
      executerRequete(
        'SELECT annee_academique_id, annee, etat FROM assistant.v_annees_academiques ORDER BY annee DESC',
        { siteId, ecoleId }
      ),
      getReglages(siteId),
      getVocabulaire({ siteId, ecoleId }),
      // Le nom est relu en base à chaque ouverture : le jeton ne porte que
      // l'identifiant, et le navigateur n'a pas à dicter qui il est.
      preparerAccueil({ utilisateurId, siteId }),
    ]);
    const aujourdhui = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const instruction = construireInstruction(
      dictionnaire, calendrier.ok ? calendrier.lignes : [], aujourdhui, reglages, accueil.phrase
    );

    const config = {
      responseModalities: [Modality.AUDIO],
      // Les transcriptions servent à afficher le fil de la conversation à l'écran
      // et à journaliser ce qui a été dit — l'audio seul n'est pas vérifiable.
      // La langue est DECLAREE des deux cotes. Un objet vide laissait la
      // detection automatique trancher, et sur du francais parle avec des noms
      // ivoiriens elle produisait « Commentaire puis-je vous athlete » pour
      // « Comment puis-je vous aider ».
      //
      // Le vocabulaire, lui, est construit depuis la base : noms des agents,
      // ecoles et filieres. Ce sont exactement les mots qu'un modele acoustique
      // generique n'a jamais rencontres, et ceux que le fondateur prononce le
      // plus souvent.
      inputAudioTranscription: { languageCodes: ['fr-FR'], customVocabulary: vocabulaire },
      outputAudioTranscription: { languageCodes: ['fr-FR'], customVocabulary: vocabulaire },
      // Découpage de la parole. Sans ce réglage, la valeur par défaut coupait la
      // phrase à la moindre hésitation — voir SILENCE_MS pour le raisonnement.
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: SILENCE_MS,
          prefixPaddingMs: PADDING_MS,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        },
      },
      speechConfig: {
        languageCode: 'fr-FR',
        // Le nom vient des reglages du site, borne par assistantReglages :
        // une valeur inconnue ferait echouer l'ouverture de la session.
        voiceConfig: { prebuiltVoiceConfig: { voiceName: reglages.voix } },
      },
      systemInstruction: instruction,
      tools: outilsPour(reglages),
    };

    // L'écouteur navigateur est branché AVANT d'annoncer 'pret' (plus bas) : le
    // client répond dans la milliseconde qui suit, et un 'pret' envoyé trop tôt
    // faisait tomber son premier message dans le vide. Les messages arrivés avant
    // que la session Live existe sont mis en attente plutôt que perdus.
    const enAttente = [];
    let sessionPrete = false;

    // État du micro, tenu par le SERVEUR. Le navigateur l'annonce, le serveur
    // l'applique : c'est la seule façon d'avoir une coupure qui ne dépende pas
    // du bon fonctionnement du code client.
    const etatMicro = { microCoupe: false };

    // Accueil : joué au plus une fois par session Live. Le navigateur décide
    // s'il le demande (il connaît la connexion) ; le serveur garantit qu'il ne
    // sera pas rejoué (il connaît la session).
    let accueilJoue = false;

    // Dernier ecran annonce par le navigateur. Sert a ne pas repeter le meme
    // contexte quand React re-rend sans que la route ait change.
    let pageCourante = null;

    // Relances déjà faites sur une réponse ambiguë. Le protocole en autorise UNE :
    // au-delà, insister sur une question à laquelle le fondateur ne répond pas
    // devient une boucle dont il ne peut plus sortir qu'en fermant l'écran.
    let relancesAccueil = 0;

    /**
     * Transcriptions en cours d'accumulation, par locuteur.
     *
     * Les fragments arrivent mot par mot. On les renvoie tels quels pour que
     * l'écran suive la parole, MAIS on ne les corrige pas : capitaliser chaque
     * morceau produirait « Bonjour Monsieur Comment Puis-je ». La correction
     * n'a de sens que sur le texte entier, à la fin du tour.
     */
    const tampons = { fondateur: '', assistant: '' };

    /** Derniere question du fondateur, transcrite. Sert au journal des echecs. */
    let derniereQuestion = null;

    /** Clôt un tour de transcription : le texte complet est corrigé une seule
     *  fois, puis renvoyé pour REMPLACER les fragments déjà affichés. */
    const finaliserTranscription = (qui) => {
      const brut = tampons[qui];
      tampons[qui] = '';
      if (!brut.trim()) return;
      const texte = corrigerTranscription(brut);
      // La dernière question posée à voix haute, retenue pour le SEUL journal des
      // échecs : sans elle, un échec vocal se lirait « outil X, zéro ligne » sans
      // qu'on sache ce que le fondateur avait demandé. Elle n'est jamais renvoyée
      // au modèle et ne sert à rien d'autre.
      if (qui === 'fondateur') derniereQuestion = texte;
      envoyer(qui === 'fondateur' ? 'transcription_fondateur' : 'transcription_assistant', {
        texte,
        partiel: false,
      });
    };

    const traiterMessageNavigateur = (msg) => {
      const decision = routerMessageNavigateur(msg, etatMicro);

      switch (decision.action) {
        case 'audio':
          // PCM 16 bits, 16 kHz, mono — le format attendu par l'API Live en entrée.
          sessionLive.sendRealtimeInput({ audio: { data: decision.pcm, mimeType: 'audio/pcm;rate=16000' } });
          break;

        case 'texte':
          sessionLive.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: decision.texte }] }], turnComplete: true,
          });
          break;

        case 'fin_flux':
          sessionLive.sendRealtimeInput({ audioStreamEnd: true });
          break;

        case 'page': {
          /**
           * Le fondateur vient de changer d'ecran.
           *
           * `turnComplete: false` est la cle : le contenu s'ajoute a la
           * conversation SANS demander de reponse. Avec `true`, l'assistante
           * prendrait la parole a chaque navigation pour commenter un ecran que
           * personne ne lui a demande de commenter.
           *
           * On ne renvoie rien si l'ecran est inconnu du catalogue : lui donner
           * un chemin brut ne lui apprendrait rien qu'elle puisse dire.
           */
          const ecran = destinationValide(decision.chemin);
          if (!ecran || ecran.chemin === pageCourante) break;
          pageCourante = ecran.chemin;
          try {
            sessionLive.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{
                  text: `[Contexte, ne reponds pas] Le fondateur est maintenant sur `
                    + `${ecran.libelle} (${ecran.chemin}). Tu ne VOIS pas son ecran : `
                    + `s'il te demande ce qui y figure, interroge la base.`,
                }],
              }],
              turnComplete: false,
            });
          } catch { /* session deja fermee */ }
          break;
        }

        case 'accueil':
          // Une seule fois par session, même si le navigateur redemandait.
          if (accueilJoue) break;
          accueilJoue = true;
          sessionLive.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: "[Consigne système] Ouvre la conversation maintenant, selon le protocole d'ouverture." }] }],
            turnComplete: true,
          });
          break;

        case 'micro':
          if (decision.coupe === etatMicro.microCoupe) break;
          etatMicro.microCoupe = decision.coupe;
          if (decision.coupe) {
            // Le début de phrase capté avant le clic est abandonné : le finaliser
            // ferait apparaître, micro coupé, une phrase que le fondateur croyait
            // avoir interrompue.
            tampons.fondateur = '';
            // Clôture le tour d'entrée en cours : Google vide sa file et arrête
            // sa détection d'activité, au lieu de continuer à transcrire ce qui
            // était déjà en vol. C'est ce qui rend la coupure immédiate à
            // l'oreille comme à l'écran.
            try { sessionLive.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* session déjà close */ }
          }
          break;

        default:
          break;
      }
    };

    ws.on('message', (donnees) => {
      if (fermee) return;
      let msg;
      try { msg = JSON.parse(donnees.toString()); } catch { return; }
      // ENVELOPPE OBLIGATOIRE. Une exception levee ici remonte a l'emetteur
      // d'evenements de `ws`, que personne n'ecoute : Node considere l'erreur
      // comme non geree et TUE LE PROCESSUS. Le serveur entier tombe pour un
      // message malforme. Vecu le 2026-08-25 sur un simple import oublie.
      try {
        if (sessionPrete) traiterMessageNavigateur(msg);
        else enAttente.push(msg);
      } catch (erreur) {
        console.error('[vocal] message navigateur ignore :', erreur.message);
      }
    });
    ws.on('close', () => fermer('navigateur déconnecté'));
    ws.on('error', () => fermer('erreur socket'));

    const rappels = {
      onmessage: (msg) => traiterMessageLive(msg).catch((e) => {
        console.error('[vocal] traitement message:', e.message);
      }),
      onerror: (e) => { envoyer('erreur', { message: e.message || 'Erreur du service vocal.' }); fermer('erreur'); },
      onclose: (e) => { envoyer('termine', { raison: e?.reason || null }); fermer('fermeture distante'); },
    };

    const ouverture = await ouvrirSessionLive(ai, config, rappels);
    sessionLive = ouverture.session;
    const modeleUtilise = ouverture.modele;

    // Session Live établie et écouteur navigateur déjà branché : on peut annoncer
    // 'pret' sans risque de perdre la réponse immédiate du client.
    sessionPrete = true;
    // Le nom du modele NE PART PAS au navigateur. Il n'y etait affiche nulle
    // part, mais il restait lisible dans la console de developpement — et le
    // fondateur ne doit rien savoir de la technique qui le sert. Il reste
    // journalise cote serveur, ou il est utile au diagnostic.
    console.log(`[vocal] session ouverte sur ${modeleUtilise}`);
    envoyer('pret', {});
    while (enAttente.length) traiterMessageNavigateur(enAttente.shift());

    async function traiterMessageLive(msg) {
      // ── Appels d'outils ──────────────────────────────────────────────────
      if (msg.toolCall?.functionCalls?.length) {
        const reponses = [];

        // GARANTIE : le modele Live attend UNE reponse par appel d'outil. S'il
        // n'en recoit pas, il ne signale rien — il enchaine, et comble le vide
        // avec un chiffre de son cru. Le `finally` plus bas garantit donc qu'une
        // reponse part toujours, meme si le traitement casse en cours de route.
        const attendus = msg.toolCall.functionCalls;
        try {
          for (const appel of attendus) {
            // La forme 3D suit ce que l'assistante FAIT, pas ce qui a ete dit :
            // elle est deduite de l'outil appele et de la vue interrogee.
            envoyer('forme', { forme: formePour(appel.name) });

            // Le graphique est le seul outil propre au canal vocal : il a besoin du
            // dernier resultat SQL, que seul ce service conserve.
            if (appel.name === 'afficher_graphique') {
              const visualisation = validerVisualisation(appel.args, dernierResultat);
              if (visualisation) {
                envoyer('graphique', { visualisation, donnees: dernierResultat.lignes });
                reponses.push({ id: appel.id, name: appel.name, response: {
                  affiche: true, nb_points: dernierResultat.lignes.length,
                } });
              } else {
                reponses.push({ id: appel.id, name: appel.name, response: {
                  erreur: "Impossible d'afficher : les colonnes citees n'existent pas dans le dernier resultat, "
                    + "ou aucune requete n'a encore ete executee.",
                } });
              }
              continue;
            }

            // Débriefing de la veille. La décision — accord, refus, hésitation —
            // est prise ICI, par une fonction déterministe et testée, et non par
            // le modèle : il ne fait que transmettre la réponse et lire le résumé.
            if (appel.name === 'debriefing_veille') {
              const intention = intentionOuiNon(appel.args?.reponse);

              if (intention === 'non') {
                relancesAccueil = 0;
                reponses.push({ id: appel.id, name: appel.name, response: {
                  accepte: false,
                  instruction: "Le fondateur ne souhaite pas de débriefing. Dis-lui simplement que "
                    + "tu restes à sa disposition, en une phrase, et attends sa question.",
                } });
                continue;
              }

              if (intention === 'ambigu') {
                if (relancesAccueil === 0) {
                  relancesAccueil += 1;
                  reponses.push({ id: appel.id, name: appel.name, response: {
                    ambigu: true,
                    instruction: "Sa réponse n'est pas claire. Repose la question UNE SEULE FOIS, "
                      + "brièvement : « Voulez-vous que je vous présente les mouvements d'hier ? »",
                  } });
                } else {
                  // Deuxième hésitation : on n'insiste pas davantage.
                  relancesAccueil = 0;
                  reponses.push({ id: appel.id, name: appel.name, response: {
                    accepte: false,
                    instruction: "La réponse reste incertaine. N'insiste pas : dis que tu restes "
                      + "disponible s'il veut le débriefing, et passe à autre chose.",
                  } });
                }
                continue;
              }

              relancesAccueil = 0;
              // eslint-disable-next-line no-await-in-loop
              const brief = await debriefingVeille({ siteId, ecoleId });

              // Les graphiques partent à l'écran, pas au modèle : il choisit de
              // déclencher le débriefing, il n'en fabrique jamais les chiffres.
              if (brief.graphiques.length) {
                envoyer('debriefing', {
                  date: brief.date,
                  phrases: brief.phrases,
                  graphiques: brief.graphiques,
                });
                envoyer('forme', { forme: 'graphe' });
              }

              reponses.push({ id: appel.id, name: appel.name, response: {
                accepte: true,
                aucune_activite: brief.aucune_activite,
                resume: brief.phrases,
                instruction: brief.aucune_activite
                  ? "Lis ce résumé tel quel. N'invente aucun chiffre et ne cherche pas à combler le vide."
                  : "Lis ce résumé tel quel, dans l'ordre, sans y ajouter aucun chiffre. Les graphiques "
                    + "sont déjà affichés à son écran : mentionne-les en une phrase à la fin.",
                limite: "Ce débriefing ne couvre que les CRÉATIONS tracées (inscriptions, encaissements, "
                  + "prises en charge, sessions de caisse, mouvements de stock). Les connexions, "
                  + "consultations, modifications et suppressions ne sont enregistrées nulle part dans "
                  + "cette base. Si le fondateur demande plus, dis-le-lui franchement.",
              } });
              continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const sortie = await executerOutil(appel.name, appel.args, {
              siteId, ecoleId, utilisateurId, canal: 'vocal', question: derniereQuestion,
            });

            // Trace d'exploitation. Le modele ANNONCE parfois une action qu'il n'a
            // pas demandee — « j'affiche la fiche » sans appeler l'outil. Sans
            // cette ligne, impossible de distinguer un outil qui echoue d'un outil
            // qui n'a jamais ete appele, et on en est reduit a supposer.
            console.log(`[vocal] outil ${appel.name}`, JSON.stringify(appel.args || {}).slice(0, 120),
              sortie.fiche ? '-> FICHE ENVOYEE' : sortie.fichier ? '-> fichier' : '');

            if (sortie.trace) envoyer('requete', sortie.trace);
            if (sortie.traces) sortie.traces.forEach((t) => envoyer('requete', t));
            if (sortie.resultat?.ok) dernierResultat = sortie.resultat;
            // Le fichier remonte a l'ecran : a l'oral, un classeur sans bouton de
            // telechargement visible n'existe pas pour le fondateur.
            if (sortie.fichier) envoyer('fichier', sortie.fichier);
            // La fiche se dessine a l'ecran : elle ne repasse jamais par le modele,
            // qui n'en connait que le nom et l'identifiant.
            if (sortie.fiche) envoyer('fiche', { fiche: sortie.fiche });

            // Redirection : le message part, la reponse d'outil est renvoyee pour
            // que l'assistante annonce le depart, puis la session se ferme d'
            // elle-meme apres sa phrase — la fermeture est declenchee cote
            // navigateur, quand il a fini de l'entendre parler.
            if (sortie.navigation) envoyer('navigation', sortie.navigation);

            reponses.push({ id: appel.id, name: appel.name, response: sortie.reponse });
          }
        } catch (erreur) {
          console.error("[vocal] boucle d'outils interrompue :", erreur.message);
        } finally {
          // Tout appel resté sans reponse en recoit une, explicite : mieux vaut
          // une assistante qui dit « je n'ai pas pu lire » qu'une assistante qui
          // invente.
          const repondus = new Set(reponses.map((r) => r.id));
          for (const appel of attendus) {
            if (repondus.has(appel.id)) continue;
            reponses.push({ id: appel.id, name: appel.name, response: {
              erreur: 'Outil interrompu : aucune donnee obtenue.',
              instruction: "Tu n'as PAS obtenu cette donnee. N'avance aucun chiffre, aucune "
                + 'estimation, aucun ordre de grandeur. Dis au fondateur que la lecture a '
                + 'echoue et propose de reessayer.',
            } });
          }
          try { sessionLive.sendToolResponse({ functionResponses: reponses }); }
          catch (e) { console.error("[vocal] envoi des reponses d'outils :", e.message); }
        }
        return;
      }

      // ── Transcriptions ────────────────────────────────────────────────────
      // Deux temps, et c'est délibéré : le fragment part immédiatement pour que
      // l'écran suive la parole (`partiel: true`, affiché en gris), puis le
      // texte complet et corrigé le remplace quand le tour se ferme
      // (`partiel: false`). Traiter les fragments ne donnerait ni l'un ni
      // l'autre — ni la fluidité, ni un texte correct.
      const entree = msg.serverContent?.inputTranscription;
      if (entree?.text && transcriptionAdmise(etatMicro)) {
        tampons.fondateur += entree.text;
        envoyer('transcription_fondateur', { texte: entree.text, partiel: true });
      }
      if (entree?.finished) finaliserTranscription('fondateur');

      const sortie = msg.serverContent?.outputTranscription;
      if (sortie?.text) {
        tampons.assistant += sortie.text;
        envoyer('transcription_assistant', { texte: sortie.text, partiel: true });
      }
      if (sortie?.finished) finaliserTranscription('assistant');

      // ── Audio du modèle ──────────────────────────────────────────────────
      for (const part of msg.serverContent?.modelTurn?.parts || []) {
        if (part.inlineData?.data) envoyer('audio', { pcm: part.inlineData.data });
      }

      // Le fondateur a coupé la parole : le navigateur doit vider sa file de lecture,
      // sinon on entend la fin d'une phrase que le modèle a abandonnée.
      if (msg.serverContent?.interrupted) {
        // Le tour de l'assistante est abandonné : sa transcription partielle n'a
        // plus d'objet, elle décrit une phrase qui ne sera jamais dite en entier.
        tampons.assistant = '';
        envoyer('interrompu');
      }

      if (msg.serverContent?.turnComplete) {
        // Filet de sécurité : `finished` n'est pas garanti sur tous les modèles
        // Live, tous en preview. Sans cette clôture, un tour resterait affiché
        // en gris, jamais corrigé.
        finaliserTranscription('fondateur');
        finaliserTranscription('assistant');
        envoyer('forme', { forme: 'sphere' });
        envoyer('tour_termine');
      }

      // ── Comptabilisation ─────────────────────────────────────────────────
      // La consommation reelle continue d'etre ECRITE — c'est elle qui donne le
      // cout par question. Ce qui a disparu, c'est la COUPURE : une session ne
      // s'interrompt plus au milieu d'une phrase sur un plafond applicatif qui
      // ne mesure pas la vraie contrainte (voir assistantBudget.verifierBudget).
      // Le montant n'est plus non plus pousse a l'ecran : le fondateur pilote
      // son etablissement, il n'a pas a surveiller une jauge pendant qu'il parle.
      if (msg.usageMetadata) {
        await enregistrer({
          siteId, utilisateurId, canal: 'vocal', modele: modeleUtilise,
          usage: extraireUsage(msg.usageMetadata),
        });
      }
    }

  } catch (error) {
    console.error('[vocal] démarrage de session:', error);
    envoyer('erreur', {
      message: /RESOURCE_EXHAUSTED|quota/i.test(error.message || '')
        ? "Quota Gemini atteint. Activez la facturation ou patientez."
        : "Impossible de démarrer la session vocale.",
    });
    fermer('échec de démarrage');
  }
}

/** Une spécification qui cite une colonne absente produirait un graphique vide. */
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

module.exports = { monterPasserelleVocale, MODELE_VOCAL };
