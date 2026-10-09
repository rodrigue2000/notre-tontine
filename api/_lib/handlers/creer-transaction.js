const { FedaPay, Transaction } = require('fedapay');

// Autorise uniquement ton domaine d'app en prod (remplace * ci-dessous une fois testé)
const ALLOWED_ORIGIN = process.env.APP_URL || '*';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { montant, type, membreEmail, membreNom, tontineId, telephone } = req.body || {};
     console.log("Données reçues :", req.body);
    console.log("membreEmail =", membreEmail);
    console.log("tontineId =", tontineId);

    if (!montant || Number(montant) < 1) {
        return res.status(400).json({ error: 'Montant invalide' });
    }

    if (!membreEmail || !tontineId) {
        return res.status(400).json({ error: 'membreEmail et tontineId sont requis' });
    }

    if (!montant || Number(montant) < 1) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    
    FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
    FedaPay.setEnvironment(process.env.FEDAPAY_ENV || 'live');

    const [firstname, ...rest] = (membreNom || 'Membre Tontine').split(' ');
    const lastname = rest.join(' ') || 'Tontine';

    const transaction = await Transaction.create({
      description: `${type === 'retrait' ? 'Retrait' : 'Dépôt'} OKR TONTINE - ${membreNom || membreEmail}`,
      amount: Math.round(Number(montant)),
      currency: { iso: 'XOF' },
      callback_url: `${process.env.APP_URL}?paiement=retour`,
      customer: {
        email: membreEmail,
        firstname,
        lastname,
        ...(telephone ? { phone_number: { number: telephone, country: 'BJ' } } : {}),
      },
      // Ces métadonnées reviennent dans le webhook : c'est ce qui nous permet
      // de savoir QUI a payé et POUR QUELLE tontine, sans faire confiance au client.
      custom_metadata: {
        tontineId,
        membreEmail,
        type: type === 'retrait' ? 'retrait' : 'depot',
      },
    });

    const token = await transaction.generateToken();

    return res.status(200).json({ url: token.url, transactionId: transaction.id });
  } catch (err) {
    console.error('Erreur création transaction FedaPay:', err);
    return res.status(500).json({ error: 'Impossible de créer la transaction de paiement' });
  }
};
