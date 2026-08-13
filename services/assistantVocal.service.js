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
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const { executerRequete, getDictionnaire } = require('./assistantSql.service');
const { verifierBudget, enregistrer, extraireUsage, getConsommationMois } = require('./assistantBudget.service');
const {
  BLOC_IDENTITE, BLOC_CAPACITES, BLOC_PRUDENCE, DECLARATIONS, DECLARATION_GRAPHIQUE, executerOutil,
} = require('./assistantOutils.service');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Tous les modèles Live disponibles sont en `preview` : un retrait est déjà arrivé
// (gemini-2.5-flash, 2026-08-07). Repli d'une ligne en cas de disparition.
const MODELE_VOCAL = process.env.ASSISTANT_MODELE_VOCAL || 'gemini-3.1-flash-live-preview';
const MODELE_VOCAL_REPLI = 'gemini-2.5-flash-native-audio-latest';

const ROLES_AUTORISES = new Set(['admin', 'fondateur']);

// Memes outils que le canal ecrit, plus le graphique : une capacite qui existerait
// au clavier et pas a l'oral serait incomprehensible pour le fondateur.
const OUTILS = [{ functionDeclarations: [...DECLARATIONS, DECLARATION_GRAPHIQUE] }];

function construireInstruction(dictionnaire, annees, aujourdhui) {
  const catalogue = dictionnaire
    .map((v) => `### ${v.vue}\n${v.description || ''}\nColonnes : ${v.colonnes.join(', ')}`)
    .join('\n\n');
  const calendrier = annees.length
    ? annees.map((a) => `- id ${a.annee_academique_id} : ${a.annee} (état : ${a.etat || 'non renseigné'})`).join('\n')
    : '- (aucune année académique enregistrée)';

  return `${BLOC_IDENTITE}

${BLOC_CAPACITES}

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
Quand des chiffres se prêtent à un visuel, PROPOSE-le en une phrase courte
(« Veux-tu que je te le montre en graphique ? ») et attends la réponse.
Si le fondateur accepte, appelle \`afficher_graphique\` puis commente le résultat
en une ou deux phrases — ce qu'on y voit, pas ce qu'il contient.
S'il demande directement un graphique, fais la requête puis affiche-le sans demander.`;
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

    // Le plafond est vérifié AVANT d'ouvrir la session : une session ouverte
    // consomme dès la première seconde d'écoute.
    const budget = await verifierBudget(siteId);
    if (!budget.autorise) {
      envoyer('budget_depasse', { message: budget.motif, budget: budget.consommation });
      return fermer('budget dépassé');
    }

    const [dictionnaire, calendrier] = await Promise.all([
      getDictionnaire({ siteId, ecoleId }),
      executerRequete(
        'SELECT annee_academique_id, annee, etat FROM assistant.v_annees_academiques ORDER BY annee DESC',
        { siteId, ecoleId }
      ),
    ]);
    const aujourdhui = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const instruction = construireInstruction(
      dictionnaire, calendrier.ok ? calendrier.lignes : [], aujourdhui
    );

    const config = {
      responseModalities: [Modality.AUDIO],
      // Les transcriptions servent à afficher le fil de la conversation à l'écran
      // et à journaliser ce qui a été dit — l'audio seul n'est pas vérifiable.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: { languageCode: 'fr-FR' },
      systemInstruction: instruction,
      tools: OUTILS,
    };

    // L'écouteur navigateur est branché AVANT d'annoncer 'pret' (plus bas) : le
    // client répond dans la milliseconde qui suit, et un 'pret' envoyé trop tôt
    // faisait tomber son premier message dans le vide. Les messages arrivés avant
    // que la session Live existe sont mis en attente plutôt que perdus.
    const enAttente = [];
    let sessionPrete = false;

    const traiterMessageNavigateur = (msg) => {
      if (msg.type === 'audio' && msg.pcm) {
        // PCM 16 bits, 16 kHz, mono — le format attendu par l'API Live en entrée.
        sessionLive.sendRealtimeInput({ audio: { data: msg.pcm, mimeType: 'audio/pcm;rate=16000' } });
      } else if (msg.type === 'texte' && msg.texte) {
        sessionLive.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: msg.texte }] }], turnComplete: true,
        });
      } else if (msg.type === 'fin_flux') {
        sessionLive.sendRealtimeInput({ audioStreamEnd: true });
      }
    };

    ws.on('message', (donnees) => {
      if (fermee) return;
      let msg;
      try { msg = JSON.parse(donnees.toString()); } catch { return; }
      if (sessionPrete) traiterMessageNavigateur(msg);
      else enAttente.push(msg);
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

    let modeleUtilise = MODELE_VOCAL;
    try {
      sessionLive = await ai.live.connect({ model: MODELE_VOCAL, config, callbacks: rappels });
    } catch (e) {
      // Modèle en preview retiré ou indisponible : on bascule sur le repli plutôt
      // que de laisser le fondateur devant un micro muet.
      console.warn(`[vocal] ${MODELE_VOCAL} indisponible (${e.message}), repli sur ${MODELE_VOCAL_REPLI}`);
      modeleUtilise = MODELE_VOCAL_REPLI;
      sessionLive = await ai.live.connect({ model: MODELE_VOCAL_REPLI, config, callbacks: rappels });
    }

    // Session Live établie et écouteur navigateur déjà branché : on peut annoncer
    // 'pret' sans risque de perdre la réponse immédiate du client.
    sessionPrete = true;
    envoyer('pret', { budget: budget.consommation, modele: modeleUtilise });
    while (enAttente.length) traiterMessageNavigateur(enAttente.shift());

    async function traiterMessageLive(msg) {
      // ── Appels d'outils ──────────────────────────────────────────────────
      if (msg.toolCall?.functionCalls?.length) {
        const reponses = [];

        for (const appel of msg.toolCall.functionCalls) {
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

          // eslint-disable-next-line no-await-in-loop
          const sortie = await executerOutil(appel.name, appel.args, { siteId, ecoleId, utilisateurId });

          if (sortie.trace) envoyer('requete', sortie.trace);
          if (sortie.traces) sortie.traces.forEach((t) => envoyer('requete', t));
          if (sortie.resultat?.ok) dernierResultat = sortie.resultat;
          // Le fichier remonte a l'ecran : a l'oral, un classeur sans bouton de
          // telechargement visible n'existe pas pour le fondateur.
          if (sortie.fichier) envoyer('fichier', sortie.fichier);

          reponses.push({ id: appel.id, name: appel.name, response: sortie.reponse });
        }

        sessionLive.sendToolResponse({ functionResponses: reponses });
        return;
      }

      // ── Transcriptions (affichées au fil de l'eau) ────────────────────────
      if (msg.serverContent?.inputTranscription?.text) {
        envoyer('transcription_fondateur', { texte: msg.serverContent.inputTranscription.text });
      }
      if (msg.serverContent?.outputTranscription?.text) {
        envoyer('transcription_assistant', { texte: msg.serverContent.outputTranscription.text });
      }

      // ── Audio du modèle ──────────────────────────────────────────────────
      for (const part of msg.serverContent?.modelTurn?.parts || []) {
        if (part.inlineData?.data) envoyer('audio', { pcm: part.inlineData.data });
      }

      // Le fondateur a coupé la parole : le navigateur doit vider sa file de lecture,
      // sinon on entend la fin d'une phrase que le modèle a abandonnée.
      if (msg.serverContent?.interrupted) envoyer('interrompu');

      if (msg.serverContent?.turnComplete) envoyer('tour_termine');

      // ── Comptabilisation ─────────────────────────────────────────────────
      if (msg.usageMetadata) {
        await enregistrer({
          siteId, utilisateurId, canal: 'vocal', modele: modeleUtilise,
          usage: extraireUsage(msg.usageMetadata),
        });
        const conso = await getConsommationMois(siteId);
        envoyer('budget', { budget: conso });
        if (conso.fcfa >= conso.budget_fcfa) {
          envoyer('budget_depasse', {
            message: `Budget mensuel atteint (${conso.fcfa.toLocaleString('fr-FR')} FCFA). Session interrompue.`,
            budget: conso,
          });
          fermer('budget dépassé');
        }
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
