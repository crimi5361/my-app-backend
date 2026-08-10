// Service d'envoi d'e-mail — entièrement nouveau, aucun précédent dans ce backend (vérifié :
// aucune dépendance nodemailer ni trace SMTP avant ce chantier). Utilisé uniquement par le
// module Équivalence pour l'instant.
//
// Dégradation propre si le SMTP n'est pas configuré (variables d'env absentes) : envoyerEmail
// ne lève jamais, elle retourne { success: false, error } — l'appelant journalise
// systématiquement le résultat réel dans demande_equivalence_historique (mail_envoye /
// mail_echec), jamais un envoi silencieusement perdu ni une exception qui remonterait jusqu'à
// annuler une décision métier déjà actée (voir document de conception §5.4/§8).
const nodemailer = require('nodemailer');

let transporter = null;
const isSmtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);

const getTransporter = () => {
  if (!isSmtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transporter;
};

// { to, subject, html, attachments? } -> { success: boolean, error?: string }
exports.envoyerEmail = async ({ to, subject, html, attachments }) => {
  const t = getTransporter();
  if (!t) {
    console.warn(`⚠️  Email non envoyé (SMTP non configuré) — destinataire: ${to}, sujet: "${subject}"`);
    return { success: false, error: 'SMTP non configuré (SMTP_HOST/SMTP_USER/SMTP_PASSWORD absents).' };
  }
  try {
    await t.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, html, attachments });
    return { success: true };
  } catch (error) {
    console.error('Erreur envoi email:', error.message);
    return { success: false, error: error.message };
  }
};

// ── Templates — 4 e-mails du module Équivalence (document de conception §5.6) ──────────────

const enteteHtml = (titre) => `
  <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
    <h2 style="color: #0f2044;">${titre}</h2>`;
const piedHtml = () => `
    <p style="color: #6b7280; font-size: 12px; margin-top: 32px;">IIPEA — Institut International de Prospective et d'Études Appliquées</p>
  </div>`;

exports.templateAccuseReception = ({ prenoms, nom, codeSuivi }) => ({
  subject: 'Accusé de réception — Demande d\'équivalence IIPEA',
  html: `${enteteHtml('Demande enregistrée')}
    <p>Bonjour ${prenoms} ${nom},</p>
    <p>Votre demande d'équivalence a bien été enregistrée.</p>
    <p>Votre dossier sera étudié par notre équipe. Une réponse vous sera communiquée par e-mail dans un délai maximum de 7 jours.</p>
    <p>Votre code de suivi : <strong>${codeSuivi}</strong></p>
    ${piedHtml()}`,
});

exports.templateDemandeComplement = ({ prenoms, nom, codeSuivi, motif }) => ({
  subject: 'Pièces complémentaires demandées — Demande d\'équivalence IIPEA',
  html: `${enteteHtml('Pièces complémentaires demandées')}
    <p>Bonjour ${prenoms} ${nom},</p>
    <p>Votre demande d'équivalence est en cours d'étude. Il manque cependant des éléments pour la poursuivre :</p>
    <p style="background: #fbf1de; border: 1px solid #eed7ab; padding: 12px; border-radius: 6px;">${motif}</p>
    <p>Merci de compléter votre dossier avec votre code de suivi : <strong>${codeSuivi}</strong></p>
    ${piedHtml()}`,
});

exports.templateRefus = ({ prenoms, nom }) => ({
  subject: 'Réponse à votre demande d\'équivalence IIPEA',
  html: `${enteteHtml('Réponse à votre demande')}
    <p>Bonjour ${prenoms} ${nom},</p>
    <p>Après étude de votre dossier, nous regrettons de vous informer que votre demande d'équivalence n'a pas été retenue.</p>
    ${piedHtml()}`,
});

// Correction (Phase 5) : il existe bien un accès public non authentifié à la fiche —
// GET /api/public/public/admission/:id/fiche (etudiantController.afficherFicheInscriptionPublique,
// routes/public.routes.js), déjà utilisé par le portail D:\IIpea (src/lib/api.ts::ficheUrl) pour
// l'admission classique. Fonctionne génériquement par etudiant.id, donc directement réutilisable
// ici — l'affirmation précédente ("aucun mécanisme d'accès candidat sans compte") était erronée,
// je n'avais pas trouvé cette route lors de la Phase 3.
exports.templateValidation = ({ prenoms, nom, matriculeIipea, codePaiement, ficheUrl }) => ({
  subject: 'Votre demande d\'équivalence est validée — IIPEA',
  html: `${enteteHtml('Demande validée')}
    <p>Bonjour ${prenoms} ${nom},</p>
    <p>Votre demande d'équivalence a été validée. Voici les informations de votre dossier d'inscription :</p>
    <ul>
      <li>Matricule IIPEA : <strong>${matriculeIipea}</strong></li>
      <li>Code de paiement : <strong>${codePaiement}</strong></li>
      <li>Fiche d'inscription : <a href="${ficheUrl}">${ficheUrl}</a></li>
    </ul>
    <p>Pour poursuivre votre inscription, vous devez désormais :</p>
    <ol>
      <li>vous présenter chez un agent de vérification avec vos originaux (muni de ce matricule et de ce code) ;</li>
      <li>faire activer votre code de paiement ;</li>
      <li>effectuer votre paiement à la caisse.</li>
    </ol>
    ${piedHtml()}`,
});
