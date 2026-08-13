// Assistant Fondateur — réglages personnalisables (2026-08-13).
//
// Le prénom de l'assistante et le mode d'ouverture du vocal sont propres à un
// SITE. Ils sont lus à chaque conversation et injectés dans l'instruction : le
// modèle ne les découvre pas, on les lui donne.
const db = require('../config/db.config');

/**
 * Voix proposees au fondateur.
 *
 * Google ne documente PAS le genre de ses voix preenregistrees, seulement un
 * qualificatif de timbre. Cette selection retient celles qui sont percues
 * comme feminines ; le libelle francais traduit le qualificatif d'origine, qui
 * est la seule information officielle.
 *
 * Liste FERMEE : le nom part directement dans la configuration de la session
 * Live, et une valeur inconnue ferait echouer l'ouverture.
 */
const VOIX = [
  { nom: 'Sulafat', libelle: 'Chaleureuse', origine: 'Warm' },
  { nom: 'Kore', libelle: 'Assuree', origine: 'Firm' },
  { nom: 'Achernar', libelle: 'Douce', origine: 'Soft' },
  { nom: 'Aoede', libelle: 'Legere', origine: 'Breezy' },
  { nom: 'Vindemiatrix', libelle: 'Posee', origine: 'Gentle' },
  { nom: 'Autonoe', libelle: 'Claire', origine: 'Bright' },
  { nom: 'Callirrhoe', libelle: 'Decontractee', origine: 'Easy-going' },
  { nom: 'Leda', libelle: 'Jeune', origine: 'Youthful' },
];

const VOIX_PAR_DEFAUT = 'Sulafat';
const NOMS_VOIX = new Set(VOIX.map((v) => v.nom));

const DEFAUTS = {
  nom_assistant: null,
  lancement_vocal: 'bouton',
  recherche_web: false,
  voix: VOIX_PAR_DEFAUT,
};

const LANCEMENTS = new Set(['bouton', 'double_frappe', 'mot_reveil']);

/**
 * Un prénom saisi librement finit dans l'INSTRUCTION SYSTÈME du modèle. C'est
 * une entrée utilisateur qui traverse la frontière de confiance, et elle doit
 * donc être bornée par sa FORME, pas seulement nettoyée de ses caractères.
 *
 * Trois contraintes, dans cet ordre d'importance :
 *   • deux mots au plus — un prénom en a un, rarement deux ; au-delà on est
 *     dans la phrase, et une phrase peut ressembler à une consigne ;
 *   • 24 caractères — assez pour « Marie-Christine », trop court pour glisser
 *     une instruction crédible ;
 *   • lettres, espaces, apostrophes et traits d'union seulement, de quoi écrire
 *     « Aïcha », « N'Dri » ou « Marie-Claire ».
 */
const MOTS_MAX = 2;
const LONGUEUR_MAX = 24;

function nettoyerNom(brut) {
  if (brut === null || brut === undefined || String(brut).trim() === '') return null;
  const propre = String(brut)
    .replace(/[^\p{L}\p{M} '’-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LONGUEUR_MAX)
    .trim();
  if (!propre) return null;
  // Au-delà de deux mots, ce n'est plus un prénom : on refuse plutôt que de
  // tronquer, pour que le fondateur voie que sa saisie n'a pas été retenue.
  if (propre.split(' ').length > MOTS_MAX) return null;
  return propre;
}

async function getReglages(siteId) {
  if (!siteId) return { ...DEFAUTS };
  const { rows } = await db.query(
    'SELECT nom_assistant, lancement_vocal, recherche_web, voix FROM assistant_reglages WHERE site_id = $1',
    [siteId],
  );
  return rows.length ? { ...DEFAUTS, ...rows[0] } : { ...DEFAUTS };
}

async function majReglages(siteId, utilisateurId, modifs = {}) {
  const actuels = await getReglages(siteId);

  const nom = Object.prototype.hasOwnProperty.call(modifs, 'nom_assistant')
    ? nettoyerNom(modifs.nom_assistant)
    : actuels.nom_assistant;

  const lancement = LANCEMENTS.has(modifs.lancement_vocal)
    ? modifs.lancement_vocal
    : actuels.lancement_vocal;

  const web = typeof modifs.recherche_web === 'boolean'
    ? modifs.recherche_web
    : actuels.recherche_web;

  // La voix est FIGEE a la demande du fondateur : elle n'est plus modifiable.
  // Le champ reste en base et la liste reste ici, pour pouvoir la rouvrir sans
  // migration si le besoin revient — mais aucune saisie ne peut la changer.
  const voix = actuels.voix || VOIX_PAR_DEFAUT;

  await db.query(
    `INSERT INTO assistant_reglages (site_id, nom_assistant, lancement_vocal, recherche_web, voix, maj_le, maj_par)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (site_id) DO UPDATE
       SET nom_assistant = EXCLUDED.nom_assistant,
           lancement_vocal = EXCLUDED.lancement_vocal,
           recherche_web = EXCLUDED.recherche_web,
           voix = EXCLUDED.voix,
           maj_le = now(),
           maj_par = EXCLUDED.maj_par`,
    [siteId, nom, lancement, web, voix, utilisateurId || null],
  );

  return { nom_assistant: nom, lancement_vocal: lancement, recherche_web: web, voix };
}

module.exports = { getReglages, majReglages, nettoyerNom, LANCEMENTS, VOIX, VOIX_PAR_DEFAUT };
