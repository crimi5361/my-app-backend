// Assistant Fondateur — endpoint de discussion.
//
// 2026-08-12 : bascule de services/geminiAssistant.service.js (4 agrégations figées,
// donc 4 questions possibles) vers services/assistantAnalyste.service.js, où le modèle
// écrit lui-même du SQL de lecture sur les vues du schéma `assistant`. L'ancien service
// est conservé tel quel comme point de retour, mais n'est plus appelé.
//
// Ce contrôleur ne fait que valider la requête, poser le contexte de sécurité
// (site + école depuis le JWT, jamais depuis le corps de la requête) et renvoyer
// la réponse. Toute la logique métier est dans les services.
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { repondreQuestion } = require('../services/assistantAnalyste.service');
const { verifierBudget, getConsommationMois } = require('../services/assistantBudget.service');
const { resoudre } = require('../services/assistantFichiers.service');
const google = require('../services/assistantGoogle.service');
const { getReglages, majReglages } = require('../services/assistantReglages.service');
const { pointDuJour } = require('../services/assistantPointDuJour.service');
const { SIGLES, CORRECTIONS, OUVERTURES_QUESTION } = require('../config/vocabulaireMetier');

exports.chat = async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Le message est requis.' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ success: false, message: "L'assistant n'est pas configuré (clé API manquante)." });
    }
    if (!process.env.ASSISTANT_DATABASE_URL) {
      return res.status(503).json({
        success: false,
        message: "L'accès aux données n'est pas configuré. Lancez : node migrations/setup-role-assistant.js",
      });
    }

    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site introuvable. Reconnectez-vous.' });
    }

    // La consommation est relue pour etre journalisee cote serveur. Elle ne
    // bloque plus la reponse : le plafond applicatif valorisait les jetons a des
    // tarifs sans rapport avec la facturation reelle, et coupait donc a cote de
    // la vraie contrainte (voir assistantBudget.verifierBudget).
    await verifierBudget(siteId);

    const resultat = await repondreQuestion({
      question: message,
      historique: Array.isArray(history) ? history : [],
      siteId,
      ecoleId,
      utilisateurId: req.user.id,
    });

    res.status(200).json({
      success: true,
      message: resultat.message,
      // Consommation relue après l'échange : le fondateur voit le montant à jour.
      budget: await getConsommationMois(siteId),
      // La spécification ne contient que des noms de colonnes ; les valeurs
      // affichées viennent de `donnees`, produit par le serveur. Le modèle
      // choisit quoi tracer, jamais combien.
      visualisation: resultat.visualisation,
      donnees: resultat.donnees,
      // Trace des requêtes exécutées : le fondateur peut vérifier d'où sort un chiffre.
      requetes: resultat.requetes,
      // Classeurs et rapports produits pendant le tour, à télécharger.
      fichiers: resultat.fichiers,
      fiches: resultat.fiches,
      navigation: resultat.navigation,
      history: resultat.historique,
    });
  } catch (error) {
    console.error('Erreur assistant.chat:', error);

    if (error.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(error.message || '')) {
      return res.status(429).json({
        success: false,
        message: "Quota Gemini atteint. Le plan gratuit est limité à 5 requêtes par minute, "
          + "et une seule question en consomme plusieurs. Activez la facturation sur le projet "
          + "Google AI Studio, ou patientez une minute.",
      });
    }
    if (error.status === 503) {
      return res.status(503).json({
        success: false,
        message: "Le modèle est momentanément surchargé côté Google — réessayez dans quelques instants.",
      });
    }

    res.status(500).json({ success: false, message: "L'assistant n'a pas pu répondre pour le moment." });
  }
};

/** Consommation du mois — alimente l'indicateur de budget affiché au fondateur. */
exports.budget = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    if (!siteId) return res.status(400).json({ success: false, message: 'Site introuvable.' });
    res.status(200).json({ success: true, budget: await getConsommationMois(siteId) });
  } catch (error) {
    console.error('Erreur assistant.budget:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};


/**
 * Téléchargement d'un fichier produit par l'assistant.
 *
 * L'identifiant est aléatoire, mais ça ne suffit pas : le service revérifie que
 * le fichier appartient au site de l'appelant. Un lien fuité hors du site reste
 * inutilisable.
 */
exports.telecharger = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const fichier = resoudre(req.params.id, { siteId });
    if (!fichier.ok) return res.status(404).json({ success: false, message: fichier.motif });

    res.setHeader('Content-Type', fichier.mime);
    // RFC 5987 : sans filename*, un nom accentué arrive tronqué ou illisible.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fichier.nom.replace(/[^ -~]/g, '_')}"; `
      + `filename*=UTF-8''${encodeURIComponent(fichier.nom)}`,
    );
    res.sendFile(fichier.chemin);
  } catch (error) {
    console.error('Erreur assistant.telecharger:', error);
    res.status(500).json({ success: false, message: 'Téléchargement impossible.' });
  }
};

/** État du rattachement Google du fondateur — alimente le bouton de l'écran. */
exports.googleStatut = async (req, res) => {
  try {
    res.status(200).json({ success: true, google: await google.statut(req.user.id) });
  } catch (error) {
    console.error('Erreur assistant.googleStatut:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Démarre le consentement OAuth : renvoie l'URL Google à ouvrir. */
exports.googleConnexion = async (req, res) => {
  try {
    if (!google.estConfigure()) {
      return res.status(503).json({
        success: false,
        message: "L'accès Google n'est pas configuré sur le serveur "
          + '(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI).',
      });
    }
    res.status(200).json({
      success: true,
      url: google.urlConsentement({ utilisateurId: req.user.id, siteId: req.user.departement_id }),
    });
  } catch (error) {
    console.error('Erreur assistant.googleConnexion:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Retour de Google. Volontairement SANS authentification JWT : le navigateur
 * arrive ici depuis google.com, sans en-tête Authorization. C'est le paramètre
 * `state`, à usage unique et lié à l'utilisateur, qui fait foi.
 */
exports.googleRetour = async (req, res) => {
  const page = (titre, message, ok) => `<!doctype html><meta charset="utf-8">
<title>${titre}</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6fc;color:#101a33">
<div style="text-align:center;max-width:420px;padding:32px;background:#fff;border-radius:18px;
     border:1px solid rgba(16,26,51,.1);box-shadow:0 20px 50px -30px rgba(16,26,51,.5)">
  <div style="font-size:34px">${ok ? '✓' : '⚠'}</div>
  <h1 style="font-size:18px;margin:12px 0 8px">${titre}</h1>
  <p style="font-size:14px;color:#55607a;line-height:1.6">${message}</p>
  <p style="font-size:13px;color:#9aa2b4">Vous pouvez fermer cet onglet.</p>
</div>`;

  try {
    if (req.query.error) {
      return res.status(400).send(page('Autorisation refusée', "Aucun accès n'a été accordé.", false));
    }
    const resultat = await google.enregistrerConsentement(req.query.code, req.query.state);
    if (!resultat.ok) return res.status(400).send(page('Connexion impossible', resultat.motif, false));

    res.send(page(
      'Compte Google connecté',
      `L'assistante peut désormais gérer l'agenda et la messagerie de ${resultat.email}.`,
      true,
    ));
  } catch (error) {
    console.error('Erreur assistant.googleRetour:', error);
    res.status(500).send(page('Connexion impossible', 'Une erreur est survenue côté serveur.', false));
  }
};

/** Révocation locale — le fondateur peut aussi révoquer chez Google. */
exports.googleDeconnexion = async (req, res) => {
  try {
    await google.deconnecter(req.user.id);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erreur assistant.googleDeconnexion:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Réglages du site : prénom de l'assistante, mode d'ouverture du vocal. */
exports.reglages = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      reglages: await getReglages(req.user.departement_id),
    });
  } catch (error) {
    console.error('Erreur assistant.reglages:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.majReglages = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    if (!siteId) return res.status(400).json({ success: false, message: 'Site introuvable.' });

    const reglages = await majReglages(siteId, req.user.id, req.body || {});

    // Le prénom est refusé s'il ne ressemble pas à un prénom (plus de deux mots,
    // caractères interdits). On le dit plutôt que d'enregistrer en silence.
    const nomRefuse = Object.prototype.hasOwnProperty.call(req.body || {}, 'nom_assistant')
      && String(req.body.nom_assistant || '').trim() !== ''
      && reglages.nom_assistant === null;

    res.status(200).json({
      success: true,
      reglages,
      message: nomRefuse
        ? "Ce nom n'a pas été retenu : un prénom, deux mots au maximum."
        : undefined,
    });
  } catch (error) {
    console.error('Erreur assistant.majReglages:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Configuration de correction de la dictée, servie au navigateur.
 *
 * La dictée du chat écrit passe par l'API Web Speech, qui n'atteint jamais le
 * serveur : c'est le navigateur qui doit corriger. Il le fait avec CES données —
 * celles de config/vocabulaireMetier.js, donc exactement les mêmes que le mode
 * vocal. Ajouter une correction là-bas la propage aux deux canaux.
 */
exports.vocabulaire = async (_req, res) => {
  res.status(200).json({
    success: true,
    sigles: SIGLES,
    corrections: CORRECTIONS,
    ouvertures_question: OUVERTURES_QUESTION,
  });
};

/** Point du jour — affiché à l'ouverture, sans que le fondateur ait à demander. */
exports.pointDuJour = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    if (!siteId) return res.status(400).json({ success: false, message: 'Site introuvable.' });
    res.status(200).json({ success: true, point: await pointDuJour({ siteId, ecoleId: getEcoleScopeFromUser(req) }) });
  } catch (error) {
    console.error('Erreur assistant.pointDuJour:', error);
    // Un point du jour indisponible ne doit pas empêcher d'ouvrir l'assistante.
    res.status(200).json({ success: true, point: { ok: false, phrases: [], alertes: [] } });
  }
};
