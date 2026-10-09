// api/[action].js  — PASSERELLE UNIQUE (Phase 1 : regroupement des fonctions Vercel)
//
// Ce fichier doit s'appeler exactement  api/[action].js  (avec les crochets) : Vercel le traite
// comme UNE seule fonction qui reçoit toutes les adresses /api/<nom>. Les anciennes adresses
// (/api/coffre-alimenter, /api/transaction-manuelle, …) restent donc identiques : index.html
// n'a rien à changer.
//
// Les anciens fichiers vivent maintenant dans api/_lib/handlers/ (un dossier commençant par « _ »
// n'est pas compté comme fonction). Ils sont INCHANGÉS, à une exception près : le chemin relatif
// vers _lib/code-acces dans creer-membre.js et code-jour.js.
//
// Restent des fonctions séparées : api/webhook.js (corps brut requis pour la signature FedaPay)
// et api/cron/jobs-tontine.js (chemin appelé par Vercel Cron). Total : 3 fonctions.
//
// Chaque handler est chargé seulement quand son action est appelée (un fichier défaillant
// n'empêche pas les autres de fonctionner). Les « require » sont écrits en toutes lettres
// pour que Vercel inclue bien ces fichiers dans le déploiement.

const CHARGEURS = {
  'transaction-manuelle': () => require('./_lib/handlers/transaction-manuelle'),
  'accepter-negociation-verrouillage': () => require('./_lib/handlers/accepter-negociation-verrouillage'),
  'annuler-transaction': () => require('./_lib/handlers/annuler-transaction'),
  'code-jour': () => require('./_lib/handlers/code-jour'),
  'coffre-alimenter': () => require('./_lib/handlers/coffre-alimenter'),
  'coffre-retirer': () => require('./_lib/handlers/coffre-retirer'),
  'creer-membre': () => require('./_lib/handlers/creer-membre'),
  'creer-transaction': () => require('./_lib/handlers/creer-transaction'),
  'definir-plafond': () => require('./_lib/handlers/definir-plafond'),
  'notifier-reversement': () => require('./_lib/handlers/notifier-reversement'),
};

const connue = (nom) => typeof nom === 'string' && Object.prototype.hasOwnProperty.call(CHARGEURS, nom);

// L'action est lue d'abord dans le chemin réel de la requête (le client ne peut pas la
// falsifier par un paramètre), puis, en secours, dans le paramètre fourni par Vercel.
function actionDemandee(req) {
  const chemin = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const depuisChemin = chemin.split('/').pop();
  if (connue(depuisChemin)) return depuisChemin;
  const q = req.query && req.query.action;
  const depuisQuery = Array.isArray(q) ? q[0] : q;
  return connue(depuisQuery) ? depuisQuery : null;
}

module.exports = async function gateway(req, res) {
  const action = actionDemandee(req);

  if (!action) {
    res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    return res.status(404).json({ error: 'Action inconnue' });
  }

  let handler;
  try {
    handler = CHARGEURS[action]();
  } catch (e) {
    // Cause fréquente : variable d'environnement absente pour cet environnement (Preview/Production).
    console.error(`Chargement impossible de l'action « ${action} » :`, e);
    res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
    return res.status(500).json({ error: 'Service momentanément indisponible' });
  }
  return handler(req, res);
};

module.exports.__test = { actionDemandee, ACTIONS: Object.keys(CHARGEURS) };
