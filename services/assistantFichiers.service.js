// Assistant Fondateur — production de fichiers Excel et Word (2026-08-12).
//
// PRINCIPE, identique à celui des graphiques : le modèle décide de la STRUCTURE
// (quelles colonnes, quels titres, quel commentaire), jamais des CHIFFRES. Les
// valeurs viennent exclusivement des lignes renvoyées par assistantSql, donc du
// SQL réellement exécuté sur la base. Un modèle ne peut pas glisser un montant
// inventé dans un classeur : il n'a aucun champ pour en écrire un.
//
// Les fichiers sont déposés sur disque avec un identifiant aléatoire, jamais
// renvoyés en base64 dans la conversation : un classeur de 2000 lignes en base64
// dans le contexte coûterait plus cher que la question qui l'a produit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, Header, Footer, PageNumber,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, ImageRun,
} = require('docx');
const { executerRequete } = require('./assistantSql.service');
const { rendre: rendreGraphique } = require('./assistantGraphiques.service');

const DOSSIER = path.join(__dirname, '..', 'uploads', 'assistant');
/** Au-delà, le fichier est supprimé au prochain passage : ce sont des livrables
 *  ponctuels, pas un espace de stockage. */
const DUREE_VIE_MS = 24 * 60 * 60 * 1000;
/** Un classeur est fait pour être ouvert dans Excel, pas pour vider la base. */
const LIGNES_MAX = 5000;

const MIMES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Palette IIPEA — bleu marine du blason, or en accent.
const BLEU = '1E4D82';
const OR = 'A97723';
const GRIS = 'F2F4F8';

fs.mkdirSync(DOSSIER, { recursive: true });

/**
 * Registre des fichiers produits. En mémoire volontairement : un livrable est
 * consommé dans la minute qui suit sa génération, et un redémarrage de serveur
 * qui perd le lien est sans conséquence — le fondateur redemande le fichier.
 * Porte le site et l'utilisateur pour que le téléchargement soit vérifiable.
 */
const registre = new Map();

/** Supprime les fichiers expirés. Appelé à chaque génération : pas de minuteur
 *  qui tourne dans le vide sur un serveur inactif. */
function purger() {
  const maintenant = Date.now();
  for (const [id, meta] of registre) {
    if (maintenant - meta.cree_le > DUREE_VIE_MS) {
      fs.promises.unlink(meta.chemin).catch(() => { /* déjà supprimé */ });
      registre.delete(id);
    }
  }
}

// La purge etait declenchee par une generation. Sans nouvelle generation, un
// classeur restait sur le disque indefiniment : on la programme aussi dans le
// temps. `unref` pour que ce minuteur n'empeche jamais le processus de s'arreter.
const minuteurPurge = setInterval(() => purger(), 60 * 60 * 1000);
if (typeof minuteurPurge.unref === 'function') minuteurPurge.unref();

function enregistrer({ nom, extension, chemin, siteId, utilisateurId }) {
  const id = crypto.randomUUID();
  registre.set(id, {
    nom, extension, chemin, siteId, utilisateurId, cree_le: Date.now(),
  });
  return id;
}

/** Résout un identifiant de téléchargement en vérifiant l'appartenance au site.
 *  Un identifiant deviné ne suffit donc pas : il faut être du bon site. */
function resoudre(id, { siteId }) {
  const meta = registre.get(id);
  if (!meta) return { ok: false, motif: 'Fichier introuvable ou expiré.' };
  if (meta.siteId !== siteId) return { ok: false, motif: 'Fichier hors de votre périmètre.' };
  if (!fs.existsSync(meta.chemin)) {
    registre.delete(id);
    return { ok: false, motif: 'Fichier introuvable ou expiré.' };
  }
  return { ok: true, ...meta, mime: MIMES[meta.extension] };
}

/** Un nom de fichier proposé par le modèle ne doit pas pouvoir sortir du dossier. */
function nomSur(propose, extension) {
  const base = String(propose || 'document')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().slice(0, 60) || 'document';
  const horodatage = new Date().toISOString().slice(0, 10);
  return `${base} - ${horodatage}.${extension}`;
}

/** PostgreSQL renvoie numeric et bigint en chaîne : sans cette conversion, Excel
 *  affiche des nombres alignés à gauche, non sommables. */
function versValeur(brut, format) {
  if (brut === null || brut === undefined) return null;
  if (format === 'texte') return String(brut);
  if (brut instanceof Date) return brut;
  const n = Number(brut);
  return Number.isFinite(n) && String(brut).trim() !== '' ? n : String(brut);
}

// ---------------------------------------------------------------------------
//  Excel
// ---------------------------------------------------------------------------

/**
 * Produit un classeur à partir d'une requête SQL et d'une description de colonnes.
 *
 * @param {object} p
 * @param {string} p.titre         Titre porté par la feuille et le nom du fichier
 * @param {string} p.sql           SELECT sur les vues du schéma assistant
 * @param {Array}  p.colonnes      [{ champ, entete, format }] — format : texte|nombre|montant|date
 * @param {number} p.siteId
 * @param {number|null} p.ecoleId
 * @param {number|null} p.utilisateurId
 */
async function genererExcel({ titre, sql, colonnes, siteId, ecoleId = null, utilisateurId = null }) {
  purger();

  const resultat = await executerRequete(sql, { siteId, ecoleId, limiteLignes: LIGNES_MAX });
  if (!resultat.ok) return { ok: false, motif: resultat.motif };
  if (!resultat.lignes.length) {
    return { ok: false, motif: "La requête ne renvoie aucune ligne : il n'y a rien à mettre dans le classeur." };
  }

  // Une colonne citée mais absente produirait une colonne vide sans le signaler.
  const dispo = new Set(resultat.colonnes);
  const retenues = (colonnes || []).filter((c) => dispo.has(c.champ));
  if (!retenues.length) {
    return {
      ok: false,
      motif: `Aucune colonne demandée n'existe dans le résultat. Colonnes disponibles : ${resultat.colonnes.join(', ')}.`,
    };
  }

  const classeur = new ExcelJS.Workbook();
  classeur.creator = 'Assistant du Fondateur — IIPEA';
  classeur.created = new Date();
  const feuille = classeur.addWorksheet(titre.slice(0, 30) || 'Données', {
    views: [{ state: 'frozen', ySplit: 3 }],   // l'en-tête reste visible au défilement
  });

  // Bandeau de titre
  feuille.mergeCells(1, 1, 1, retenues.length);
  const cellTitre = feuille.getCell(1, 1);
  cellTitre.value = titre;
  cellTitre.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  cellTitre.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BLEU}` } };
  cellTitre.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  feuille.getRow(1).height = 26;

  feuille.mergeCells(2, 1, 2, retenues.length);
  const cellSous = feuille.getCell(2, 1);
  cellSous.value = `Extrait le ${new Date().toLocaleString('fr-FR')} — ${resultat.nb_lignes} ligne(s)`
    + (resultat.tronque ? ` (tronqué à ${LIGNES_MAX})` : '');
  cellSous.font = { size: 9, italic: true, color: { argb: 'FF6B7280' } };

  // En-têtes
  const ligneEntete = feuille.getRow(3);
  retenues.forEach((c, i) => {
    const cell = ligneEntete.getCell(i + 1);
    cell.value = c.entete || c.champ;
    cell.font = { bold: true, color: { argb: `FF${BLEU}` } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${GRIS}` } };
    cell.border = { bottom: { style: 'medium', color: { argb: `FF${OR}` } } };
    cell.alignment = { vertical: 'middle' };
  });
  ligneEntete.height = 20;

  // Données
  resultat.lignes.forEach((ligne) => {
    feuille.addRow(retenues.map((c) => versValeur(ligne[c.champ], c.format)));
  });

  // Formats et largeurs
  retenues.forEach((c, i) => {
    const colonne = feuille.getColumn(i + 1);
    if (c.format === 'montant') colonne.numFmt = '# ##0 "F";-# ##0 "F"';
    else if (c.format === 'nombre') colonne.numFmt = '# ##0';
    else if (c.format === 'date') colonne.numFmt = 'dd/mm/yyyy';

    // Largeur d'après le contenu réel, bornée : une colonne de 200 caractères
    // rendrait le classeur illisible.
    let large = String(c.entete || c.champ).length;
    resultat.lignes.forEach((l) => {
      const v = l[c.champ];
      if (v != null) large = Math.max(large, String(v).length);
    });
    colonne.width = Math.min(Math.max(large + 3, 11), 42);
  });

  feuille.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3 + resultat.lignes.length, column: retenues.length },
  };

  const nom = nomSur(titre, 'xlsx');
  const chemin = path.join(DOSSIER, `${crypto.randomUUID()}.xlsx`);
  await classeur.xlsx.writeFile(chemin);

  const id = enregistrer({ nom, extension: 'xlsx', chemin, siteId, utilisateurId });
  return {
    ok: true, id, nom, extension: 'xlsx',
    nb_lignes: resultat.nb_lignes,
    colonnes: retenues.map((c) => c.entete || c.champ),
    sql_execute: resultat.sql_execute,
  };
}

// ---------------------------------------------------------------------------
//  Word — rapport d'audit
// ---------------------------------------------------------------------------

// Nouveau bloc Word — remplace tout depuis `const CADRE` jusqu'avant module.exports.
const CADRE = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
};

/** Largeur utile d'une page A4 en portrait, marges de 2 cm déduites, en points
 *  d'écran : c'est la largeur à laquelle les graphiques sont rendus. */
const LARGEUR_UTILE = 600;

const p = (texte, o = {}) => new Paragraph({
  spacing: { after: o.apres ?? 120, before: o.avant ?? 0, line: o.interligne ?? 300 },
  alignment: o.alignement,
  pageBreakBefore: o.sautAvant,
  border: o.bordure,
  children: [new TextRun({
    text: texte,
    size: o.taille ?? 22,
    bold: o.gras,
    italics: o.italique,
    color: o.couleur ?? '2A3348',
    font: 'Segoe UI',
  })],
});

function celluleTexte(texte, { entete = false, aligneDroite = false } = {}) {
  return new TableCell({
    borders: CADRE,
    shading: entete ? { type: ShadingType.CLEAR, fill: GRIS } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: aligneDroite ? AlignmentType.RIGHT : undefined,
      children: [new TextRun({
        text: texte === null || texte === undefined ? '—' : String(texte),
        bold: entete,
        size: 18,
        color: entete ? BLEU : '2A3348',
        font: 'Segoe UI',
      })],
    })],
  });
}

/** Met en forme une valeur pour un tableau : un montant brut « 690158472.00 »
 *  n'est pas lisible dans un rapport destiné à être présenté. */
function valeurTableau(brut, format) {
  const n = Number(brut);
  if (format === 'montant' && Number.isFinite(n)) return `${Math.round(n).toLocaleString('fr-FR')} F`;
  if (format === 'nombre' && Number.isFinite(n)) return n.toLocaleString('fr-FR');
  if (format === 'pourcentage' && Number.isFinite(n)) return `${n.toFixed(1)} %`;
  if (brut instanceof Date) return brut.toLocaleDateString('fr-FR');
  return brut;
}

function tableau(colonnes, lignes) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: colonnes.map((c) => celluleTexte(c.entete || c.champ, { entete: true })),
      }),
      ...lignes.map((ligne) => new TableRow({
        children: colonnes.map((c) => celluleTexte(
          valeurTableau(ligne[c.champ], c.format),
          { aligneDroite: c.format === 'montant' || c.format === 'nombre' },
        )),
      })),
    ],
  });
}

/**
 * Produit un rapport d'audit Word, structuré et paginé.
 *
 * Chaque section porte l'analyse rédigée par le modèle et, si un SQL est fourni,
 * les données correspondantes sous forme de graphique et/ou de tableau. Le
 * modèle ne fournit JAMAIS de valeur : il choisit quoi montrer, pas combien.
 *
 * `niveau: 1` ouvre un chapitre — saut de page et titre de premier rang. C'est
 * ce qui permet à un audit complet de rester lisible sur trente pages.
 */
async function genererRapportWord({
  titre, objet, secteur, sections, siteId, ecoleId = null, utilisateurId = null,
}) {
  purger();

  const listeSections = Array.isArray(sections) ? sections : [];
  const requetes = [];
  const corps = [];
  const chapitres = listeSections.filter((s) => s.niveau === 1).map((s) => s.titre);

  // ── Page de garde ────────────────────────────────────────────────────────
  corps.push(
    p('IIPEA', { alignement: AlignmentType.CENTER, taille: 20, gras: true, couleur: OR, apres: 60, avant: 1200 }),
    p(titre, { alignement: AlignmentType.CENTER, taille: 40, gras: true, couleur: BLEU, apres: 120 }),
  );
  if (secteur) {
    corps.push(p(secteur, { alignement: AlignmentType.CENTER, taille: 24, couleur: '5F6A80', apres: 240 }));
  }
  corps.push(
    p(`Rapport établi le ${new Date().toLocaleDateString('fr-FR', { dateStyle: 'long' })}`, {
      alignement: AlignmentType.CENTER, taille: 20, italique: true, couleur: '6B7280', apres: 40,
    }),
    p("par l'Assistant du Fondateur", {
      alignement: AlignmentType.CENTER, taille: 20, italique: true, couleur: '6B7280', apres: 600,
    }),
  );

  // ── Sommaire ─────────────────────────────────────────────────────────────
  // Construit à la main plutôt qu'avec un champ TOC : un champ Word arrive vide
  // tant que le lecteur n'a pas accepté « mettre à jour les champs », ce qui
  // donne un rapport qui semble cassé à l'ouverture.
  if (chapitres.length > 1) {
    corps.push(p('Sommaire', { taille: 26, gras: true, couleur: BLEU, sautAvant: true, apres: 200 }));
    chapitres.forEach((c, i) => {
      corps.push(p(`${i + 1}.  ${c}`, { taille: 22, apres: 100, interligne: 280 }));
    });
  }

  if (objet) {
    corps.push(
      p('Objet et périmètre', { taille: 26, gras: true, couleur: BLEU, sautAvant: chapitres.length > 1, avant: 200, apres: 140 }),
      p(objet, { apres: 240 }),
    );
  }

  // ── Sections ─────────────────────────────────────────────────────────────
  let premierChapitre = true;

  for (const section of listeSections) {
    const estChapitre = section.niveau === 1;

    corps.push(p(section.titre || 'Section', {
      taille: estChapitre ? 30 : 24,
      gras: true,
      couleur: BLEU,
      // Un chapitre commence en haut de page ; le premier suit l'objet.
      sautAvant: estChapitre && !premierChapitre,
      avant: estChapitre ? 0 : 280,
      apres: estChapitre ? 200 : 120,
    }));
    if (estChapitre) premierChapitre = false;

    if (section.texte) {
      String(section.texte).split(/\n+/).filter(Boolean)
        .forEach((par) => corps.push(p(par, { apres: 140 })));
    }

    if (!section.sql) continue;

    // eslint-disable-next-line no-await-in-loop
    const resultat = await executerRequete(section.sql, { siteId, ecoleId, limiteLignes: 300 });
    requetes.push({
      intention: section.titre || null,
      sql: resultat.ok ? resultat.sql_execute : section.sql,
      ok: resultat.ok,
      nb_lignes: resultat.ok ? resultat.nb_lignes : 0,
      duree_ms: resultat.duree_ms ?? null,
      motif: resultat.ok ? null : resultat.motif,
    });

    if (!resultat.ok || !resultat.lignes.length) {
      corps.push(p(
        resultat.ok ? 'Aucune donnée sur ce point.' : `Donnée indisponible : ${resultat.motif}`,
        { italique: true, taille: 20, couleur: '9A2617', apres: 160 },
      ));
      continue;
    }

    const dispo = new Set(resultat.colonnes);

    // ── Graphique ──────────────────────────────────────────────────────────
    const g = section.graphique;
    if (g && dispo.has(g.axe_x)) {
      const series = (g.series || []).filter((s) => dispo.has(s.colonne));
      if (series.length) {
        const image = rendreGraphique({
          type: g.type || 'barres',
          titre: g.titre || '',
          lignes: resultat.lignes,
          axeX: g.axe_x,
          series,
          format: g.format_valeur || 'nombre',
          largeur: LARGEUR_UTILE,
          hauteur: 300,
        });
        if (image) {
          corps.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 60 },
            children: [new ImageRun({
              type: 'png',
              data: image.buffer,
              transformation: { width: image.largeur, height: image.hauteur },
            })],
          }));
          if (resultat.lignes.length > 15 && g.type !== 'lignes' && g.type !== 'aire') {
            corps.push(p(
              `Graphique limité aux premières valeurs — le détail complet figure dans le tableau ci-dessous (${resultat.nb_lignes} lignes).`,
              { italique: true, taille: 16, couleur: '9AA2B4', alignement: AlignmentType.CENTER, apres: 140 },
            ));
          }
        }
      }
    }

    // ── Tableau ────────────────────────────────────────────────────────────
    if (section.tableau !== false) {
      const retenues = (section.colonnes || []).filter((c) => dispo.has(c.champ));
      const colonnes = retenues.length
        ? retenues
        : resultat.colonnes.map((champ) => ({ champ, entete: champ }));
      // Au-delà de 40 lignes le tableau noie le lecteur : le classeur Excel est
      // le bon support pour l'exhaustivité.
      const lignesTableau = resultat.lignes.slice(0, 40);
      corps.push(tableau(colonnes, lignesTableau));
      corps.push(p(
        `${resultat.nb_lignes} ligne(s)`
        + (resultat.lignes.length > 40 ? ` — 40 premières présentées` : '')
        + `. Source : requête exécutée le ${new Date().toLocaleString('fr-FR')}.`,
        { italique: true, taille: 16, couleur: '9AA2B4', avant: 80, apres: 200 },
      ));
    }
  }

  // ── Méthode ──────────────────────────────────────────────────────────────
  corps.push(
    p('Méthode et limites', { taille: 26, gras: true, couleur: BLEU, sautAvant: true, apres: 160 }),
    p(
      'Les chiffres de ce rapport proviennent de requêtes exécutées en lecture seule sur la base '
      + 'de production au moment de sa rédaction. Ils reflètent donc l\'état exact du système à cet '
      + 'instant, et non une situation arrêtée ou consolidée.',
      { apres: 140 },
    ),
    p(
      "Le journal d'activité des agents est reconstruit à partir des colonnes d'auteur des tables "
      + "métier. Il couvre les créations d'enregistrements ; les consultations, modifications, "
      + 'suppressions et connexions ne sont pas tracées dans cette base et ne peuvent donc pas '
      + 'être auditées.',
      { apres: 140 },
    ),
    p(
      "L'administrateur de la plateforme est exclu du périmètre d'audit et n'apparaît dans aucune "
      + 'des données présentées.',
      { apres: 140 },
    ),
  );

  const document = new Document({
    creator: "Assistant du Fondateur — IIPEA",
    title: titre,
    description: objet || '',
    styles: { default: { document: { run: { font: 'Segoe UI', size: 22 } } } },
    sections: [{
      properties: {
        page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } },  // 2 cm
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 120 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E3E7EF' } },
            children: [new TextRun({ text: titre, size: 16, color: '9AA2B4', font: 'Segoe UI' })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'IIPEA  ·  ', size: 16, color: '9AA2B4', font: 'Segoe UI' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9AA2B4', font: 'Segoe UI' }),
              new TextRun({ text: ' / ', size: 16, color: '9AA2B4', font: 'Segoe UI' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '9AA2B4', font: 'Segoe UI' }),
            ],
          })],
        }),
      },
      children: corps,
    }],
  });

  const nom = nomSur(titre, 'docx');
  const chemin = path.join(DOSSIER, `${crypto.randomUUID()}.docx`);
  await fs.promises.writeFile(chemin, await Packer.toBuffer(document));

  const id = enregistrer({ nom, extension: 'docx', chemin, siteId, utilisateurId });
  return { ok: true, id, nom, extension: 'docx', requetes, nb_sections: listeSections.length };
}


module.exports = { genererExcel, genererRapportWord, resoudre, LIGNES_MAX };
