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
 * Seuil de ressemblance entre DEUX MOTS.
 *
 * Mesuré sur les cas réels, ce qui a décidé la valeur :
 *
 *     mani  ↔ manni     0,571   ← à retenir (prononciation)
 *     manny ↔ manni     0,500   ← à retenir (faute de frappe)
 *     mani  ↔ amani     0,375   ← à REJETER (personne différente)
 *     mani  ↔ manuella  0,273   ← à rejeter
 *
 * 0,45 passe entre 0,500 et 0,375 : il absorbe l'approximation sans confondre
 * deux noms distincts. C'est exactement le reproche déjà entendu — « quand je
 * dis Mani, c'est Mani, pas Maniga ».
 */
const SEUIL_MOT = 0.45;

/** Au-delà, la recherche n'est plus un nom mais une phrase. */
const MOTS_MAX = 5;

/** Mots utiles d'un terme de recherche, normalisés comme en base. */
function motsDuTerme(terme) {
  return String(terme || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length >= 2)
    .slice(0, MOTS_MAX);
}

/**
 * Condition « chaque mot cherché a un mot proche dans le nom ».
 *
 * POURQUOI PAS `word_similarity`, essayé d'abord et écarté : cette fonction
 * mesure à quel point le terme couvre UNE PORTION du nom. « grace » y vaut donc
 * 1,000 contre les deux cents personnes dont le nom contient « grace », et
 * « mani grace » remonte « GRACE MANUELLA » devant l'agent cherché. Elle
 * récompense exactement ce qu'il ne faut pas.
 *
 * Ici, chaque mot de la recherche doit trouver SON correspondant parmi les mots
 * du nom. C'est la version tolérante de `assistant.correspond`, et elle garde sa
 * propriété essentielle : tous les mots comptent.
 */
function conditionApprochante(colonneNom, mots) {
  return mots
    .map((m) => `EXISTS (SELECT 1 FROM unnest(assistant.mots(${colonneNom})) mo `
      + `WHERE similarity(mo, '${m}') > ${SEUIL_MOT})`)
    .join(' AND ');
}

/** Assemble la requête de recherche à partir d'une condition par catégorie. */
function requeteRecherche(condAgent, condEtudiant, tri) {
  return `
    SELECT * FROM (
      SELECT 'agent'::text AS categorie,
             a.agent_id AS id,
             a.agent AS nom_complet,
             a.matricule AS reference,
             a.role AS rattachement,
             a.statut AS etat,
             1 AS priorite,
             ${condAgent.score} AS score
      FROM assistant.v_agents a
      WHERE ${condAgent.ou}

      UNION ALL

      SELECT 'etudiant'::text,
             e.id,
             TRIM(COALESCE(e.nom,'') || ' ' || COALESCE(e.prenoms,'')),
             e.matricule_iipea,
             e.statut_scolaire,
             e.standing,
             2,
             ${condEtudiant.score}
      FROM assistant.t_etudiant e
      WHERE ${condEtudiant.ou}
    ) p
    ORDER BY ${tri}
    LIMIT ${MAX_CANDIDATS + 1}`;
}

/**
 * Retrouve les personnes qui correspondent à un terme.
 *
 * DEUX PASSES, et la seconde a été ajoutée après un échec en conditions
 * réelles. Le fondateur cherchait « Manni Grace », prononcé « Mani Grace » ;
 * la recherche par mots entiers ne trouvait rien, alors que l'agent
 * « MANNI CLAUDINE GRACE » était bien là. Une lettre d'écart suffisait à le
 * rendre introuvable — c'est inacceptable pour une assistante à qui on parle.
 *
 *   1. MOTS ENTIERS (`assistant.correspond`) — précis, aucun faux positif.
 *      « christian boga » retrouve « BOGA ANGE CHRISTIAN GUEMA », et « mani »
 *      ne ramène pas « MANIGA ». C'est la passe qui doit gagner quand elle
 *      trouve.
 *   2. APPROCHANT (trigrammes) — seulement si la première ne rend rien.
 *      Elle absorbe les fautes de frappe et les approximations de la
 *      reconnaissance vocale, au prix d'un classement par ressemblance.
 *
 * L'ordre compte : intervertir les deux passes ferait remonter des homonymes
 * approximatifs devant une correspondance exacte.
 *
 * La recherche porte sur les tables exposées et non sur v_personnes : cette
 * dernière identifie les étudiants par `matricule`, qui compte 588 doublons.
 * Ici on rend l'identifiant technique, seul moyen sûr de désigner quelqu'un.
 */
async function chercherPersonnes(terme, { siteId, ecoleId = null }, categorie = null) {
  const t = String(terme || '').trim().replace(/'/g, "''");
  if (t.length < 2) return { ok: false, motif: 'Terme de recherche trop court.' };

  const nomEtudiant = "COALESCE(e.nom,'') || ' ' || COALESCE(e.prenoms,'')";

  /**
   * Filtre par catégorie, quand le fondateur a précisé « l'agent » ou
   * « l'étudiante ».
   *
   * Sans lui, la recherche tournait en rond sur les homonymes. Cas réel :
   * « Manni Claudine Grace » désigne À LA FOIS une agente de la scolarité et une
   * étudiante, et les deux noms contiennent les trois mots. L'assistante
   * redemandait laquelle, le fondateur répondait « l'agent », et rien ne
   * permettait de traduire cette réponse en requête — la boucle ne pouvait pas
   * se refermer.
   */
  const garder = (c) => !categorie || categorie === c;
  const jamais = '1 = 0';

  // ── Passe 1 : mots entiers ───────────────────────────────────────────────
  const exact = await executerRequete(
    requeteRecherche(
      { ou: garder('agent') ? `assistant.correspond(a.agent, '${t}')` : jamais, score: '1' },
      { ou: garder('etudiant') ? `assistant.correspond(${nomEtudiant}, '${t}')` : jamais, score: '1' },
      'p.priorite, p.nom_complet',
    ),
    { siteId, ecoleId, limiteLignes: MAX_CANDIDATS + 1 },
  );
  if (!exact.ok) return { ok: false, motif: exact.motif };
  if (exact.lignes.length) {
    return {
      ok: true, approchant: false,
      candidats: exact.lignes.slice(0, MAX_CANDIDATS),
      tronque: exact.lignes.length > MAX_CANDIDATS,
    };
  }

  // ── Passe 2 : approchant, mot par mot ────────────────────────────────────
  const mots = motsDuTerme(t);
  if (!mots.length) return { ok: true, approchant: false, candidats: [], tronque: false };

  // Le classement se fait sur la ressemblance du nom ENTIER : à conditions
  // égales, le nom le plus proche en longueur passe devant.
  const scoreAgent = `similarity(assistant.normaliser(a.agent), '${t}')`;
  const scoreEtudiant = `similarity(assistant.normaliser(${nomEtudiant}), '${t}')`;
  const flou = await executerRequete(
    requeteRecherche(
      { ou: garder('agent') ? conditionApprochante('a.agent', mots) : jamais, score: scoreAgent },
      { ou: garder('etudiant') ? conditionApprochante(nomEtudiant, mots) : jamais, score: scoreEtudiant },
      'p.score DESC, p.priorite, p.nom_complet',
    ),
    { siteId, ecoleId, limiteLignes: MAX_CANDIDATS + 1 },
  );
  if (!flou.ok) return { ok: false, motif: flou.motif };

  return {
    ok: true,
    // Le drapeau remonte jusqu'au modèle : une correspondance approchante se
    // confirme auprès du fondateur, elle ne s'affiche pas comme une certitude.
    approchant: flou.lignes.length > 0,
    candidats: flou.lignes.slice(0, MAX_CANDIDATS),
    tronque: flou.lignes.length > MAX_CANDIDATS,
  };
}

// ───────────────────────────────────────────────────────────────────────────
//  Fiche — TOUT ce que la base contient sur la personne
// ───────────────────────────────────────────────────────────────────────────
const { BLOCS_ETUDIANT, BLOCS_AGENT, LACUNES_AGENT, LACUNES_ETUDIANT } = require('./assistantFicheChamps');
const { analyseEtudiant } = require('./assistantFicheAnalyse');

/** Formule imposee pour toute personne protegee. Elle ne dit ni pourquoi ni
 *  qui : confirmer l'existence du compte serait deja une information. */
const REFUS_PROTEGE = "Les informations de cet utilisateur sont protegees et ne peuvent pas etre consultees.";

/**
 * La personne est-elle hors perimetre ?
 *
 * Les vues excluent deja l'administrateur, donc une fiche le concernant echoue
 * naturellement. Ce controle sert a donner la BONNE RAISON : « aucun agent ne
 * porte cet identifiant » laisserait croire a une erreur de saisie et
 * inviterait a chercher encore.
 */
async function estProtege(id, { siteId, ecoleId = null }) {
  const r = await executerRequete(
    `SELECT COUNT(*)::int AS n FROM assistant.agent_exclu WHERE utilisateur_id = ${Number(id)}`,
    { siteId, ecoleId, limiteLignes: 1 },
  );
  return r.ok && Number(r.lignes[0]?.n) > 0;
}

const ligne = (r) => (r.ok && r.lignes.length ? r.lignes[0] : {});

async function ficheEtudiant(id, contexte) {
  const n = Number(id);

  const [base, parcours, analyse] = await Promise.all([
    executerRequete(`
      SELECT e.*, s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant
      FROM assistant.t_etudiant e
      LEFT JOIN assistant.t_scolarite s ON s.id = e.scolarite_id
      WHERE e.id = ${n}`, { ...contexte, limiteLignes: 1 }),
    executerRequete(`
      SELECT annee_academique, ecole, filiere, filiere_sigle, niveau, cursus, statut_paiement
      FROM assistant.v_etudiants
      WHERE matricule = (SELECT matricule FROM assistant.t_etudiant WHERE id = ${n})
      ORDER BY annee_academique DESC LIMIT 1`, { ...contexte, limiteLignes: 1 }),
    analyseEtudiant(n, contexte),
  ]);

  if (!base.ok) return { ok: false, motif: base.motif };
  if (!base.lignes.length) return { ok: false, motif: "Aucun etudiant ne porte cet identifiant." };

  const e = base.lignes[0];
  const a = ligne(parcours);

  return {
    ok: true,
    fiche: {
      categorie: 'etudiant',
      libelle_categorie: 'Étudiant',
      id: e.id,
      nom_complet: `${e.nom || ''} ${e.prenoms || ''}`.replace(/\s+/g, ' ').trim(),
      reference: e.matricule_iipea || e.matricule,
      photo_url: e.photo_url || null,
      etat: e.standing || null,
      soustitre: [a.filiere, a.niveau, a.annee_academique].filter(Boolean).join(' — ') || null,
      blocs: BLOCS_ETUDIANT(e, a, e),
      analyse,
      lacunes: LACUNES_ETUDIANT,
    },
  };
}

async function ficheAgent(id, contexte) {
  if (await estProtege(id, contexte)) return { ok: false, protege: true, motif: REFUS_PROTEGE };
  const n = Number(id);

  const [base, activite, domaines] = await Promise.all([
    executerRequete(`
      SELECT a.agent_id, a.agent, a.matricule, a.role, a.role_description,
             a.statut, a.site, a.ecole, u.email
      FROM assistant.v_agents a
      LEFT JOIN assistant.t_utilisateur u ON u.id = a.agent_id
      WHERE a.agent_id = ${n}`, { ...contexte, limiteLignes: 1 }),
    executerRequete(`
      SELECT COUNT(*)::int AS actes, MIN(horodatage)::date AS premier, MAX(horodatage)::date AS dernier
      FROM assistant.v_activite_agents WHERE agent_id = ${n}`, { ...contexte, limiteLignes: 1 }),
    executerRequete(`
      SELECT domaine, acte, COUNT(*)::int AS actes
      FROM assistant.v_activite_agents WHERE agent_id = ${n}
      GROUP BY domaine, acte ORDER BY COUNT(*) DESC`, { ...contexte, limiteLignes: 30 }),
  ]);

  if (!base.ok) return { ok: false, motif: base.motif };
  if (!base.lignes.length) return { ok: false, motif: "Aucun agent ne porte cet identifiant." };

  const a = base.lignes[0];
  const act = ligne(activite);
  const parDomaine = domaines.ok ? domaines.lignes : [];
  act.domaines = parDomaine.length
    ? [...new Set(parDomaine.map((d) => d.domaine))].join(', ')
    : null;

  return {
    ok: true,
    fiche: {
      categorie: 'agent',
      libelle_categorie: 'Personnel',
      id: a.agent_id,
      nom_complet: a.agent,
      reference: a.matricule,
      photo_url: null,
      etat: a.statut,
      soustitre: a.role_description || a.role,
      blocs: BLOCS_AGENT(a, act),
      // L'activite d'un agent se lit mieux en barres qu'en tableau : c'est la
      // repartition qui informe, pas le detail des libelles.
      analyse: parDomaine.length ? {
        disponible: true,
        synthese: { actes: Number(act.actes) || 0, domaines: parDomaine.length },
        graphiques: [{
          type: 'barres', titre: "Activité par type d'acte", cle: 'acte',
          series: [{ colonne: 'actes', libelle: 'Actes' }],
          donnees: parDomaine.map((d) => ({ acte: d.acte, actes: Number(d.actes), domaine: d.domaine })),
          lecture: `${parDomaine.reduce((t, d) => t + Number(d.actes), 0)} actes tracés `
            + `dans ${new Set(parDomaine.map((d) => d.domaine)).size} domaine(s).`,
        }],
        lacunes: [],
      } : {
        disponible: false,
        motif: "Aucun acte n'est tracé pour cet agent.",
        lacunes: [],
      },
      lacunes: LACUNES_AGENT,
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
  return { ok: false, motif: `Categorie inconnue : ${categorie}.` };
}

module.exports = { chercherPersonnes, construireFiche, MAX_CANDIDATS, REFUS_PROTEGE };
