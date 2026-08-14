// Assistant Fondateur — protocole du canal vocal (2026-08-14).
//
// Les décisions que prend le serveur sur un message venu du navigateur, isolées
// ici SANS aucune dépendance : ni base, ni clé Gemini, ni socket. C'est ce qui
// permet de les tester pour ce qu'elles sont — des règles — plutôt que de monter
// une session temps réel pour vérifier une condition.
//
// La règle centrale est la coupure du micro. Le navigateur débranche déjà sa
// capture, mais s'il fuyait, seul le serveur peut empêcher l'audio d'atteindre
// Google. La coupure ne doit donc dépendre d'aucun code tournant sur le poste du
// fondateur.

/**
 * Décide du sort d'un message venu du navigateur, selon l'état du micro.
 *
 * @param {object} msg   message JSON reçu du navigateur
 * @param {{microCoupe:boolean}} etat  état courant de la session
 * @returns {{action:'audio'|'texte'|'fin_flux'|'micro'|'ignorer', [k:string]:any}}
 */
function routerMessageNavigateur(msg, etat) {
  if (!msg || typeof msg !== 'object') return { action: 'ignorer', motif: 'message illisible' };

  if (msg.type === 'micro') return { action: 'micro', coupe: msg.coupe === true };

  // Demande d'accueil. C'est le NAVIGATEUR qui la déclenche, parce que lui seul
  // sait si l'accueil a déjà été joué depuis la connexion : le serveur, lui, voit
  // une nouvelle session à chaque ouverture de l'écran vocal et rejouerait la
  // phrase à chaque fois.
  if (msg.type === 'accueil') return { action: 'accueil' };

  if (msg.type === 'audio' && msg.pcm) {
    // LA barrière. Une trame reçue micro coupé s'arrête ici.
    if (etat.microCoupe) return { action: 'ignorer', motif: 'micro coupé' };
    return { action: 'audio', pcm: msg.pcm };
  }

  // Couper le micro n'est pas quitter la conversation : le clavier reste ouvert.
  if (msg.type === 'texte' && msg.texte) return { action: 'texte', texte: msg.texte };

  if (msg.type === 'fin_flux') return { action: 'fin_flux' };

  return { action: 'ignorer', motif: 'type inconnu' };
}

/**
 * Une transcription du fondateur est-elle recevable ?
 *
 * Micro coupé, la réponse est non : le texte qui arrive encore décrit un audio
 * parti avant la coupure, que Google avait déjà en file. L'afficher donnerait
 * l'impression que le bouton n'a servi à rien — c'est exactement le défaut qui
 * était signalé.
 */
function transcriptionAdmise(etat) {
  return !etat.microCoupe;
}

module.exports = { routerMessageNavigateur, transcriptionAdmise };
