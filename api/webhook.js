const { FedaPay, Webhook, Transaction } = require('fedapay');
const admin = require('firebase-admin');

// Empêche le body-parser JSON automatique de Vercel : on a besoin du corps
// BRUT (non modifié) pour vérifier la signature FedaPay.
module.exports.config = { api: { bodyParser: false } };

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-fedapay-signature'];

  let event;
  try {
    event = Webhook.constructEvent(rawBody, signature, process.env.FEDAPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log complet pour diagnostiquer la structure exacte envoyée par FedaPay.
  console.log('Webhook FedaPay reçu, event.name =', event.name);
  console.log('Contenu complet de event :', JSON.stringify(event, null, 2));

  try {
    if (event.name === 'transaction.approved') {
      // On ne fait pas confiance à la forme du payload brut (object / entity / data.object
      // selon les versions) : on récupère l'ID puis on recharge la transaction depuis
      // l'API FedaPay, qui est la source de vérité garantie.
      // event.object est juste la chaîne "transaction" (indicateur de type) —
      // la vraie transaction est dans event.entity.
      const raw = event.entity || (event.data && event.data.object) || {};
      const txId = raw.id;

      if (!txId) {
        console.error('Impossible de trouver l\'ID de transaction dans le webhook. Payload brut :', rawBody);
        return res.status(200).json({ received: true, warning: 'id introuvable' });
      }

      FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
      FedaPay.setEnvironment(process.env.FEDAPAY_ENV || 'sandbox');
      const tx = await Transaction.retrieve(txId);

      console.log('Transaction rechargée depuis l\'API FedaPay :', JSON.stringify(tx, null, 2));

      const meta = tx.custom_metadata || {};
      const { tontineId, membreEmail, type } = meta;

      if (tx.status === 'approved' && type === 'depot' && tontineId && membreEmail) {
        initFirebaseAdmin();
        const db = admin.firestore();

        // Idempotence : un document par transaction FedaPay évite de créditer
        // deux fois si FedaPay renvoie le même webhook plusieurs fois.
        const idempotencyRef = db.collection('transactions').doc(`fedapay_${tx.id}`);

        await db.runTransaction(async (t) => {
          const existing = await t.get(idempotencyRef);
          if (existing.exists) return; // déjà traité, on ignore

          const membresRef = db.collection('tontine').doc('membres');
          const membresSnap = await t.get(membresRef);
          const soldeAvant = membresSnap.exists ? (membresSnap.data()[membreEmail]?.solde || 0) : 0;
          const soldeApres = soldeAvant + tx.amount;

          t.set(membresRef, { [membreEmail]: { solde: soldeApres } }, { merge: true });
          t.set(idempotencyRef, {
            membreEmail,
            type: 'depot',
            montant: tx.amount,
            frais: 0,
            responsable: 'FedaPay (paiement en ligne)',
            notes: `Paiement Mobile Money/Carte — réf. FedaPay #${tx.id}`,
            date: new Date().toISOString(),
            soldeAvant,
            soldeApres,
            fedapayTransactionId: tx.id,
          });
        });

        console.log(`Dépôt crédité pour ${membreEmail} : ${tx.amount} FCFA`);
      } else {
        console.warn('Transaction approuvée mais conditions non remplies pour créditer :', {
          status: tx.status, type, tontineId, membreEmail,
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erreur traitement webhook FedaPay:', err);
    // On renvoie quand même 200 pour éviter des ré-essais infinis si l'erreur
    // n'est pas récupérable ; à ajuster selon ton monitoring.
    return res.status(500).json({ error: 'Erreur interne' });
  }
};
