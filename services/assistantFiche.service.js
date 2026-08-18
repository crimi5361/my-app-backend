// Assistant Fondateur — fiche d'identité d'une personne (2026-08-18).
//
// Le fondateur demande « qui est Boga Christian ? » et veut voir une fiche
// s'afficher, pas lire un paragraphe. Ce service produit deux choses distinctes,
// et c'est délibéré :
//
//   • LA FICHE — l'essentiel, poussé à l'écran et dessiné en direct. Elle tient
//     dans un cadre, elle se lit d'un coup d'œil. Ce que le fondateur retient.
//   • LE RAPPORT — tout ce que la base sait, en Word. Il n'est produit que s'il
//     le demande, parce que quatre-vingts champs à l'écran ne se lisent pas.
//
// LES CHIFFRES NE VIENNENT PAS DU MODÈLE. Il choisit DE QUI parler ; le contenu
// est lu en SQL et poussé au navigateur sans repasser par lui. Il ne peut donc
// pas inventer un montant ni une date de naissance.
const { executerRequete } = require('./assistantSql.service');

/** Au-delà, ce n'est plus une recherche mais un listing : on demande de préciser. */
const MAX_CANDIDATS = 8;

// ───────────────────────────────────────────────────────────────────────────
//  Recherche
// ───────────────────────────────────────────────────────────────────────────

/**
 * Retrouve les personnes qui correspondent à un terme.
 *
 * La recherche porte sur les tables exposées et non sur v_personnes : cette
 * dernière identifie les étudiants par `matricule`, qui compte 588 doublons.
 * Ici on rend l'identifiant technique, seul moyen sûr de désigner quelqu'un.
 *
 * `assistant.correspond` exige que TOUS les mots cherchés figurent dans le nom,
 * dans n'importe quel ordre : « christian boga » retrouve « BOGA ANGE CHRISTIAN
 * GUEMA », et « mani » ne ramène pas « MANIGA ».
 */
async function chercherPersonnes(terme, { siteId, ecoleId = null }) {
  const t = String(terme || '').trim().replace(/'/g, "''");
  if (t.length < 2) return { ok: false, motif: 'Terme de recherche trop court.' };

  const sql = `
    SELECT * FROM (
      SELECT 'agent'::text AS categorie,
             a.agent_id AS id,
             a.agent AS nom_complet,
             a.matricule AS reference,
             a.role AS rattachement,
             a.statut AS etat,
             1 AS priorite
      FROM assistant.v_agents a
      WHERE assistant.correspond(a.agent, '${t}')

      UNION ALL

      SELECT 'etudiant'::text,
             e.id,
             TRIM(COALESCE(e.nom,'') || ' ' || COALESCE(e.prenoms,'')),
             e.matricule_iipea,
             e.statut_scolaire,
             e.standing,
             2
      FROM assistant.t_etudiant e
      WHERE assistant.correspond(COALESCE(e.nom,'') || ' ' || COALESCE(e.prenoms,''), '${t}')
    ) p
    ORDER BY p.priorite, p.nom_complet
    LIMIT ${MAX_CANDIDATS + 1}`;

  const r = await executerRequete(sql, { siteId, ecoleId, limiteLignes: MAX_CANDIDATS + 1 });
  if (!r.ok) return { ok: false, motif: r.motif };
  return { ok: true, candidats: r.lignes.slice(0, MAX_CANDIDATS), tronque: r.lignes.length > MAX_CANDIDATS };
}

// ───────────────────────────────────────────────────────────────────────────
//  Fiche — l'essentiel, pour l'écran
// ───────────────────────────────────────────────────────────────────────────

const vide = (v) => v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '-';

/** Un champ absent n'est pas affiché : une fiche criblée de tirets donne
 *  l'impression d'une base incomplète alors qu'elle est simplement muette
 *  sur ce point. */
const champs = (paires) => paires
  .filter(([, v]) => !vide(v))
  .map(([libelle, valeur]) => ({ libelle, valeur: String(valeur) }));

function nombreLisible(v) {
  const n = Number(v || 0);
  return `${Math.round(n).toLocaleString('fr-FR')} FCFA`;
}

function dateLisible(v) {
  if (vide(v)) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function ficheEtudiant(id, contexte) {
  const r = await executerRequete(`
    SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.matricule, e.photo_url,
           e.sexe, e.date_naissance, e.lieu_naissance, e.nationalite, e.pays_naissance,
           e.telephone, e.contact_etudiant, e.email, e.email_personnel, e.lieu_residence,
           e.standing, e.statut_scolaire, e.date_inscription, e.source_inscription,
           e.serie_bac, e.annee_bac, e.mention_bac, e.etablissement_origine,
           e.nom_parent_1, e.contact_parent, e.nom_parent_2, e.contact_parent_2,
           s.montant_scolarite, s.scolarite_verse, s.scolarite_restante
    FROM assistant.t_etudiant e
    LEFT JOIN assistant.t_scolarite s ON s.id = e.scolarite_id
    WHERE e.id = ${Number(id)}`, { ...contexte, limiteLignes: 1 });

  if (!r.ok) return { ok: false, motif: r.motif };
  if (!r.lignes.length) return { ok: false, motif: "Aucun étudiant ne porte cet identifiant." };
  const e = r.lignes[0];

  // Parcours académique : la dernière année d'abord, c'est celle qui compte.
  const p = await executerRequete(`
    SELECT annee_academique, ecole, filiere, niveau, cursus, statut_paiement
    FROM assistant.v_etudiants WHERE matricule = '${String(e.matricule).replace(/'/g, "''")}'
    ORDER BY annee_academique DESC LIMIT 1`, { ...contexte, limiteLignes: 1 });
  const a = p.ok && p.lignes.length ? p.lignes[0] : {};

  return {
    ok: true,
    fiche: {
      categorie: 'etudiant',
      libelle_categorie: 'Étudiant',
      id: e.id,
      nom_complet: `${e.nom || ''} ${e.prenoms || ''}`.trim(),
      reference: e.matricule_iipea || e.matricule,
      photo_url: e.photo_url || null,
      etat: e.standing || null,
      soustitre: [a.filiere, a.niveau].filter(Boolean).join(' — ') || null,
      blocs: [
        {
          titre: 'Identité',
          champs: champs([
            ['Sexe', e.sexe],
            ['Naissance', dateLisible(e.date_naissance)],
            ['Lieu', e.lieu_naissance],
            ['Nationalité', e.nationalite],
            ['Résidence', e.lieu_residence],
          ]),
        },
        {
          titre: 'Contact',
          champs: champs([
            ['Téléphone', e.telephone || e.contact_etudiant],
            ['E-mail', e.email],
            ['E-mail personnel', e.email_personnel],
          ]),
        },
        {
          titre: 'Scolarité',
          champs: champs([
            ['Année', a.annee_academique],
            ['École', a.ecole],
            ['Filière', a.filiere],
            ['Niveau', a.niveau],
            ['Cursus', a.cursus],
            ['Statut', e.statut_scolaire],
            ['Inscrit le', dateLisible(e.date_inscription)],
          ]),
        },
        {
          titre: 'Situation financière',
          champs: champs([
            ['Scolarité', vide(e.montant_scolarite) ? null : nombreLisible(e.montant_scolarite)],
            ['Versé', vide(e.scolarite_verse) ? null : nombreLisible(e.scolarite_verse)],
            ['Reste à payer', vide(e.scolarite_restante) ? null : nombreLisible(e.scolarite_restante)],
            ['État', a.statut_paiement],
          ]),
        },
        {
          titre: 'Parents',
          champs: champs([
            ['Parent 1', e.nom_parent_1],
            ['Contact 1', e.contact_parent],
            ['Parent 2', e.nom_parent_2],
            ['Contact 2', e.contact_parent_2],
          ]),
        },
      ].filter((b) => b.champs.length > 0),
    },
  };
}

async function ficheAgent(id, contexte) {
  const r = await executerRequete(`
    SELECT a.agent_id, a.agent, a.matricule, a.role, a.role_description,
           a.statut, a.site, a.ecole, u.email
    FROM assistant.v_agents a
    LEFT JOIN assistant.t_utilisateur u ON u.id = a.agent_id
    WHERE a.agent_id = ${Number(id)}`, { ...contexte, limiteLignes: 1 });

  if (!r.ok) return { ok: false, motif: r.motif };
  if (!r.lignes.length) return { ok: false, motif: "Aucun agent ne porte cet identifiant." };
  const a = r.lignes[0];

  // Activité : reconstruite depuis les colonnes auteur, seule trace existante.
  const act = await executerRequete(`
    SELECT COUNT(*)::int AS actes,
           MIN(horodatage)::date AS premier,
           MAX(horodatage)::date AS dernier
    FROM assistant.v_activite_agents WHERE agent_id = ${Number(id)}`, { ...contexte, limiteLignes: 1 });
  const v = act.ok && act.lignes.length ? act.lignes[0] : {};

  return {
    ok: true,
    fiche: {
      categorie: 'agent',
      libelle_categorie: 'Personnel',
      id: a.agent_id,
      nom_complet: a.agent,
      reference: a.matricule,
      photo_url: null,               // la table utilisateur ne porte pas de photo
      etat: a.statut,
      soustitre: a.role_description || a.role,
      blocs: [
        {
          titre: 'Fonction',
          champs: champs([
            ['Rôle', a.role],
            ['Statut', a.statut],
            ['Site', a.site],
            ['École', a.ecole],
          ]),
        },
        { titre: 'Contact', champs: champs([['E-mail', a.email]]) },
        {
          titre: 'Activité tracée',
          champs: champs([
            ['Actes', v.actes],
            ['Premier', dateLisible(v.premier)],
            ['Dernier', dateLisible(v.dernier)],
          ]),
        },
      ].filter((b) => b.champs.length > 0),
    },
  };
}

/**
 * Construit la fiche d'une personne.
 *
 * @param {'etudiant'|'agent'} categorie
 * @param {number} id
 */
async function construireFiche(categorie, id, contexte) {
  if (!Number.isInteger(Number(id))) return { ok: false, motif: 'Identifiant invalide.' };
  if (categorie === 'agent') return ficheAgent(id, contexte);
  if (categorie === 'etudiant') return ficheEtudiant(id, contexte);
  return { ok: false, motif: `Catégorie inconnue : ${categorie}.` };
}

module.exports = { chercherPersonnes, construireFiche, MAX_CANDIDATS };
