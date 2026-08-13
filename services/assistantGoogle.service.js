// Assistant Fondateur — agenda, visioconférence et messagerie (2026-08-12).
//
// POURQUOI OAUTH ET PAS UN COMPTE DE SERVICE — services/documentStorage.service.js
// documente déjà l'impasse rencontrée sur Drive : « un compte de service Google ne
// peut pas écrire dans un Drive personnel classique sans quota propre ». Le même
// mur existe pour Gmail et Agenda : un compte de service n'a ni boîte mail ni
// calendrier, et la délégation à l'échelle du domaine exige Google Workspace.
// On passe donc par un consentement OAuth du fondateur lui-même : l'assistant
// agit dans SON agenda et SA boîte, avec un jeton qu'il peut révoquer à tout
// moment depuis myaccount.google.com.
//
// LE JETON DE RAFRAÎCHISSEMENT EST UN SECRET DE LONGUE DURÉE. Il est stocké
// chiffré (AES-256-GCM) avec une clé dérivée de JWT_SECRET, pour qu'une lecture
// de la table ne suffise pas à prendre la main sur la boîte mail du fondateur.
//
// RÈGLE DE CONCEPTION — l'assistant n'envoie JAMAIS un message ni ne crée un
// événement sans que le fondateur ait vu le contenu exact et validé. Les outils
// de rédaction produisent un brouillon ; l'envoi est un acte distinct.
const crypto = require('crypto');
const db = require('../config/db.config');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

const estConfigure = () => !!(
  process.env.GOOGLE_OAUTH_CLIENT_ID
  && process.env.GOOGLE_OAUTH_CLIENT_SECRET
  && process.env.GOOGLE_OAUTH_REDIRECT_URI
);

// ---------------------------------------------------------------------------
//  Chiffrement du jeton au repos
// ---------------------------------------------------------------------------
const cle = () => crypto.createHash('sha256')
  .update(`${process.env.JWT_SECRET || ''}::google-oauth`).digest();

function chiffrer(clair) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(), iv);
  const donnees = Buffer.concat([c.update(clair, 'utf8'), c.final()]);
  // iv:tag:données — tout ce qu'il faut pour déchiffrer, sauf la clé.
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${donnees.toString('base64')}`;
}

function dechiffrer(chiffre) {
  const [iv, tag, donnees] = String(chiffre).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', cle(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(donnees, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
//  Client OAuth
// ---------------------------------------------------------------------------
function clientOAuth() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

/**
 * URL de consentement. `state` porte l'utilisateur et une valeur aléatoire :
 * sans elle, n'importe qui pourrait rejouer le retour de Google pour rattacher
 * SON compte Google au compte IIPEA d'un autre.
 */
function urlConsentement({ utilisateurId, siteId }) {
  const etat = crypto.randomBytes(16).toString('hex');
  etatsEnAttente.set(etat, { utilisateurId, siteId, expire: Date.now() + 10 * 60 * 1000 });
  return clientOAuth().generateAuthUrl({
    access_type: 'offline',          // sans quoi aucun refresh_token n'est délivré
    prompt: 'consent',               // force la redélivrance du refresh_token
    scope: SCOPES,
    state: etat,
    include_granted_scopes: true,
  });
}

const etatsEnAttente = new Map();

function consommerEtat(etat) {
  const trouve = etatsEnAttente.get(etat);
  etatsEnAttente.delete(etat);
  if (!trouve || trouve.expire < Date.now()) return null;
  return trouve;
}

/** Échange le code de retour contre des jetons et les range en base. */
async function enregistrerConsentement(code, etat) {
  const contexte = consommerEtat(etat);
  if (!contexte) return { ok: false, motif: 'Demande expirée ou invalide. Relancez la connexion.' };

  const client = clientOAuth();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    return {
      ok: false,
      motif: "Google n'a pas renvoyé de jeton durable. Révoquez l'accès sur myaccount.google.com "
        + 'puis relancez la connexion.',
    };
  }

  client.setCredentials(tokens);
  const { google } = require('googleapis');
  const profil = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

  await db.query(
    `INSERT INTO assistant_google_compte
       (utilisateur_id, site_id, email_google, jeton_rafraichissement, portees, cree_le, maj_le)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (utilisateur_id) DO UPDATE
       SET email_google = EXCLUDED.email_google,
           jeton_rafraichissement = EXCLUDED.jeton_rafraichissement,
           portees = EXCLUDED.portees,
           maj_le = now()`,
    [contexte.utilisateurId, contexte.siteId, profil.data.email,
      chiffrer(tokens.refresh_token), SCOPES.join(' ')],
  );

  return { ok: true, email: profil.data.email };
}

/** Client authentifié pour un utilisateur donné, ou null s'il n'a pas consenti. */
async function clientPour(utilisateurId) {
  if (!estConfigure()) return null;
  const { rows } = await db.query(
    'SELECT jeton_rafraichissement, email_google FROM assistant_google_compte WHERE utilisateur_id = $1',
    [utilisateurId],
  );
  if (!rows.length) return null;

  const client = clientOAuth();
  client.setCredentials({ refresh_token: dechiffrer(rows[0].jeton_rafraichissement) });
  return { client, email: rows[0].email_google };
}

async function statut(utilisateurId) {
  if (!estConfigure()) {
    return { configure: false, connecte: false, motif: 'Identifiants OAuth Google absents du serveur.' };
  }
  const { rows } = await db.query(
    'SELECT email_google, maj_le FROM assistant_google_compte WHERE utilisateur_id = $1',
    [utilisateurId],
  );
  return rows.length
    ? { configure: true, connecte: true, email: rows[0].email_google, depuis: rows[0].maj_le }
    : { configure: true, connecte: false };
}

async function deconnecter(utilisateurId) {
  await db.query('DELETE FROM assistant_google_compte WHERE utilisateur_id = $1', [utilisateurId]);
  return { ok: true };
}

const INDISPONIBLE = {
  ok: false,
  motif: "Le compte Google du fondateur n'est pas connecté. Il doit d'abord autoriser l'accès "
    + "depuis l'écran de l'assistant (bouton « Connecter Google »). Dis-le-lui simplement.",
};

// ---------------------------------------------------------------------------
//  Agenda et visioconférence
// ---------------------------------------------------------------------------

/**
 * Crée un événement, avec lien Meet si demandé.
 * @param {string} p.debut  ISO 8601 (ex. 2026-08-20T15:00:00)
 */
async function creerReunion({
  utilisateurId, titre, debut, duree_minutes = 60, description, participants = [], avec_meet = true,
}) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;

  const dateDebut = new Date(debut);
  if (Number.isNaN(dateDebut.getTime())) {
    return { ok: false, motif: `Date de début illisible : « ${debut} ». Utilise le format 2026-08-20T15:00:00.` };
  }
  const dateFin = new Date(dateDebut.getTime() + duree_minutes * 60000);

  const { google } = require('googleapis');
  const agenda = google.calendar({ version: 'v3', auth: auth.client });

  const corps = {
    summary: titre,
    description: description || undefined,
    start: { dateTime: dateDebut.toISOString(), timeZone: process.env.FUSEAU_HORAIRE || 'Africa/Abidjan' },
    end: { dateTime: dateFin.toISOString(), timeZone: process.env.FUSEAU_HORAIRE || 'Africa/Abidjan' },
    attendees: participants.filter(Boolean).map((email) => ({ email })),
  };
  if (avec_meet) {
    // requestId doit être unique par demande : Google renvoie sinon le même lien.
    corps.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }

  try {
    const { data } = await agenda.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: avec_meet ? 1 : 0,
      sendUpdates: participants.length ? 'all' : 'none',
      requestBody: corps,
    });
    return {
      ok: true,
      titre: data.summary,
      debut: data.start?.dateTime,
      fin: data.end?.dateTime,
      lien_meet: data.hangoutLink || null,
      lien_agenda: data.htmlLink,
      participants: (data.attendees || []).map((a) => a.email),
    };
  } catch (e) {
    return { ok: false, motif: `Google Agenda a refusé : ${e.message}` };
  }
}

async function listerReunions({ utilisateurId, depuis, jusqua, limite = 20 }) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;

  const { google } = require('googleapis');
  try {
    const { data } = await google.calendar({ version: 'v3', auth: auth.client }).events.list({
      calendarId: 'primary',
      timeMin: depuis ? new Date(depuis).toISOString() : new Date().toISOString(),
      timeMax: jusqua ? new Date(jusqua).toISOString() : undefined,
      maxResults: Math.min(limite, 50),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return {
      ok: true,
      reunions: (data.items || []).map((e) => ({
        titre: e.summary || '(sans titre)',
        debut: e.start?.dateTime || e.start?.date,
        fin: e.end?.dateTime || e.end?.date,
        lien_meet: e.hangoutLink || null,
        participants: (e.attendees || []).map((a) => a.email),
        organisateur: e.organizer?.email || null,
      })),
    };
  } catch (e) {
    return { ok: false, motif: `Google Agenda a refusé : ${e.message}` };
  }
}

async function annulerReunion({ utilisateurId, identifiant }) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;
  const { google } = require('googleapis');
  try {
    await google.calendar({ version: 'v3', auth: auth.client })
      .events.delete({ calendarId: 'primary', eventId: identifiant, sendUpdates: 'all' });
    return { ok: true };
  } catch (e) {
    return { ok: false, motif: `Google Agenda a refusé : ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
//  Messagerie
// ---------------------------------------------------------------------------

const entete = (message, nom) => (message.payload?.headers || [])
  .find((h) => h.name.toLowerCase() === nom.toLowerCase())?.value || null;

/** Liste les messages reçus, en ne renvoyant que l'extrait fourni par Gmail :
 *  rapatrier des corps entiers gonflerait le contexte pour rien. */
async function listerEmails({ utilisateurId, requete = 'in:inbox', limite = 15 }) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;

  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: auth.client });
  try {
    const { data } = await gmail.users.messages.list({
      userId: 'me', q: requete, maxResults: Math.min(limite, 30),
    });
    const messages = await Promise.all((data.messages || []).map(async ({ id }) => {
      const { data: m } = await gmail.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      return {
        identifiant: m.id,
        de: entete(m, 'From'),
        objet: entete(m, 'Subject'),
        date: entete(m, 'Date'),
        extrait: m.snippet,
        non_lu: (m.labelIds || []).includes('UNREAD'),
      };
    }));
    return { ok: true, nb: messages.length, emails: messages };
  } catch (e) {
    return { ok: false, motif: `Gmail a refusé : ${e.message}` };
  }
}

/** Encodage RFC 2047 de l'objet : sans lui, les accents arrivent en mojibake. */
const objetEncode = (objet) => `=?UTF-8?B?${Buffer.from(objet || '', 'utf8').toString('base64')}?=`;

function construireMessage({ destinataires, copie, objet, corps }) {
  const lignes = [
    `To: ${destinataires.join(', ')}`,
    copie?.length ? `Cc: ${copie.join(', ')}` : null,
    `Subject: ${objetEncode(objet)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(corps, 'utf8').toString('base64'),
  ].filter((l) => l !== null);

  return Buffer.from(lignes.join('\r\n'), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Crée un BROUILLON. C'est l'opération par défaut : un modèle qui envoie
 * directement un message au nom du fondateur est une mauvaise idée, même quand
 * il a raison — l'erreur n'est pas rattrapable.
 */
async function redigerEmail({ utilisateurId, destinataires, copie = [], objet, corps }) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;
  if (!destinataires?.length) return { ok: false, motif: 'Aucun destinataire.' };

  const { google } = require('googleapis');
  try {
    const { data } = await google.gmail({ version: 'v1', auth: auth.client }).users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: construireMessage({ destinataires, copie, objet, corps }) } },
    });
    return {
      ok: true, brouillon_id: data.id, destinataires, copie, objet, corps,
      note: "Brouillon créé dans Gmail. Il n'est PAS envoyé : lis-le au fondateur et demande "
        + "sa validation avant d'appeler envoyer_email.",
    };
  } catch (e) {
    return { ok: false, motif: `Gmail a refusé : ${e.message}` };
  }
}

/** Envoie — soit un brouillon validé, soit un message complet. */
async function envoyerEmail({ utilisateurId, brouillon_id, destinataires, copie = [], objet, corps }) {
  const auth = await clientPour(utilisateurId);
  if (!auth) return INDISPONIBLE;

  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: auth.client });
  try {
    if (brouillon_id) {
      const { data } = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: brouillon_id } });
      return { ok: true, message_id: data.id, envoye: true };
    }
    if (!destinataires?.length) return { ok: false, motif: 'Aucun destinataire.' };
    const { data } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: construireMessage({ destinataires, copie, objet, corps }) },
    });
    return { ok: true, message_id: data.id, envoye: true, destinataires, objet };
  } catch (e) {
    return { ok: false, motif: `Gmail a refusé : ${e.message}` };
  }
}

module.exports = {
  SCOPES,
  estConfigure,
  urlConsentement,
  enregistrerConsentement,
  statut,
  deconnecter,
  creerReunion,
  listerReunions,
  annulerReunion,
  listerEmails,
  redigerEmail,
  envoyerEmail,
};
