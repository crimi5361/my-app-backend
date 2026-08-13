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
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
} = require('docx');
const { executerRequete } = require('./assistantSql.service');

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

const CADRE = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE9' },
};

function celluleTexte(texte, { entete = false } = {}) {
  return new TableCell({
    borders: CADRE,
    shading: entete ? { type: ShadingType.CLEAR, fill: GRIS } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      children: [new TextRun({
        text: texte === null || texte === undefined ? '—' : String(texte),
        bold: entete,
        size: 18,
        color: entete ? BLEU : '2A3348',
      })],
    })],
  });
}

/**
 * Produit un rapport d'audit Word. Chaque section peut porter un texte rédigé
 * par le modèle et/ou un tableau dont les données viennent d'une requête SQL.
 *
 * @param {object} p
 * @param {string} p.titre
 * @param {string} [p.objet]        Une phrase sur la portée de l'audit
 * @param {Array}  p.sections       [{ titre, texte, sql, colonnes }]
 */
async function genererRapportWord({ titre, objet, sections, siteId, ecoleId = null, utilisateurId = null }) {
  purger();

  const enfants = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: 'IIPEA', bold: true, size: 20, color: OR })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: titre, bold: true, size: 34, color: BLEU })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({
        text: `Rapport établi le ${new Date().toLocaleDateString('fr-FR', { dateStyle: 'long' })} par l'Assistant du Fondateur`,
        italics: true, size: 18, color: '6B7280',
      })],
    }),
  ];

  if (objet) {
    enfants.push(new Paragraph({
      spacing: { after: 280 },
      children: [new TextRun({ text: objet, size: 22, color: '2A3348' })],
    }));
  }

  const requetes = [];

  for (const section of sections || []) {
    enfants.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280, after: 120 },
      children: [new TextRun({ text: section.titre || 'Section', bold: true, size: 26, color: BLEU })],
    }));

    if (section.texte) {
      // Un saut de ligne dans le texte du modèle devient un vrai paragraphe.
      String(section.texte).split(/\n+/).filter(Boolean).forEach((p) => {
        enfants.push(new Paragraph({
          spacing: { after: 120, line: 300 },
          children: [new TextRun({ text: p, size: 22, color: '2A3348' })],
        }));
      });
    }

    if (!section.sql) continue;

    // eslint-disable-next-line no-await-in-loop
    const resultat = await executerRequete(section.sql, { siteId, ecoleId, limiteLignes: 200 });
    requetes.push({
      intention: section.titre || null,
      sql: resultat.ok ? resultat.sql_execute : section.sql,
      ok: resultat.ok,
      nb_lignes: resultat.ok ? resultat.nb_lignes : 0,
      duree_ms: resultat.duree_ms ?? null,
      motif: resultat.ok ? null : resultat.motif,
    });

    if (!resultat.ok || !resultat.lignes.length) {
      enfants.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({
          text: resultat.ok ? 'Aucune donnée sur ce point.' : `Donnée indisponible : ${resultat.motif}`,
          italics: true, size: 20, color: '9A2617',
        })],
      }));
      continue;
    }

    const dispo = new Set(resultat.colonnes);
    const retenues = (section.colonnes || []).filter((c) => dispo.has(c.champ));
    const effectives = retenues.length
      ? retenues
      : resultat.colonnes.map((champ) => ({ champ, entete: champ }));

    enfants.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: effectives.map((c) => celluleTexte(c.entete || c.champ, { entete: true })),
        }),
        ...resultat.lignes.map((ligne) => new TableRow({
          children: effectives.map((c) => {
            const v = ligne[c.champ];
            const n = Number(v);
            const affiche = c.format === 'montant' && Number.isFinite(n)
              ? `${Math.round(n).toLocaleString('fr-FR')} F`
              : c.format === 'nombre' && Number.isFinite(n)
                ? n.toLocaleString('fr-FR')
                : v;
            return celluleTexte(affiche);
          }),
        })),
      ],
    }));

    enfants.push(new Paragraph({
      spacing: { before: 80, after: 160 },
      children: [new TextRun({
        text: `${resultat.nb_lignes} ligne(s) — source : requête exécutée sur la base le ${new Date().toLocaleString('fr-FR')}.`,
        italics: true, size: 16, color: '9AA2B4',
      })],
    }));
  }

  // Mention de méthode : un rapport d'audit qui ne dit pas d'où il tient ses
  // chiffres n'est pas opposable.
  enfants.push(new Paragraph({
    spacing: { before: 400 },
    border: { top: { style: BorderStyle.SINGLE, size: 6, color: OR } },
    children: [new TextRun({
      text: "Méthode — les chiffres de ce rapport proviennent de requêtes exécutées en lecture seule sur la base "
        + "de production au moment de sa rédaction. Le journal d'activité est reconstruit à partir des colonnes "
        + "d'auteur des tables métier : il couvre les créations d'enregistrements, non les consultations, "
        + "modifications, suppressions ni connexions, qui ne sont pas tracées.",
      size: 16, italics: true, color: '6B7280',
    })],
  }));

  const document = new Document({
    creator: 'Assistant du Fondateur — IIPEA',
    title: titre,
    sections: [{ properties: {}, children: enfants }],
  });

  const nom = nomSur(titre, 'docx');
  const chemin = path.join(DOSSIER, `${crypto.randomUUID()}.docx`);
  await fs.promises.writeFile(chemin, await Packer.toBuffer(document));

  const id = enregistrer({ nom, extension: 'docx', chemin, siteId, utilisateurId });
  return { ok: true, id, nom, extension: 'docx', requetes };
}

module.exports = { genererExcel, genererRapportWord, resoudre, LIGNES_MAX };
