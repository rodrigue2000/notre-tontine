const admin = require('firebase-admin');

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const ALLOWED_ORIGIN = process.env.APP_URL || '*';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    initFirebaseAdmin();
    const db = admin.firestore();

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
    }

    const callerDoc = await db.collection('utilisateurs').doc(decoded.uid).get();
    const callerRole = callerDoc.exists ? callerDoc.data().role : null;
    if (!['tresorier', 'president'].includes(callerRole)) {
      return res.status(403).json({ error: 'Accès réservé au trésorier/président' });
    }

    const { txId } = req.body || {};
    if (!txId) return res.status(400).json({ error: 'txId requis' });

    const membresRef = db.collection('tontine').doc('membres');
    const txRef = db.collection('transactions').doc(txId);

    const resultat = await db.runTransaction(async (t) => {
      // -- Lectures --
      const txSnap = await t.get(txRef);
      if (!txSnap.exists) throw new Error('Transaction introuvable');
      const tx = txSnap.data();

      // Vérifie que c'est bien la dernière transaction (protège l'intégrité de l'historique).
      const derniereSnap = await db.collection('transactions').orderBy('date', 'desc').limit(1).get();
      if (derniereSnap.empty || derniereSnap.docs[0].id !== txId) {
        throw new Error('Seule la dernière transaction peut être annulée');
      }

      const membresSnap = await t.get(membresRef);
      const soldeActuel = membresSnap.exists ? (membresSnap.data()[tx.membreEmail]?.solde || 0) : 0;
      const soldeRestaure = tx.soldeAvant !== undefined ? tx.soldeAvant : soldeActuel;

      let pretRef = null, pretSnap = null;
      if (tx.type === 'remboursement' && tx.pretId) {
        pretRef = db.collection('prets').doc(tx.pretId);
        pretSnap = await t.get(pretRef);
      }

      let plafondRef = null, plafondSnap = null;
      if (tx.type === 'depot' && tx.enregistrePar) {
        plafondRef = db.collection('plafonds').doc(tx.enregistrePar);
        plafondSnap = await t.get(plafondRef);
      }

      // -- Écritures --
      t.delete(txRef);
      t.set(membresRef, { [tx.membreEmail]: { solde: soldeRestaure } }, { merge: true });

      if (pretRef && pretSnap && pretSnap.exists) {
        const pret = pretSnap.data();
        const nouveauRembourse = Math.max(0, (pret.rembourse || 0) - tx.montant);
        const statut = nouveauRembourse < pret.total ? 'en_cours' : 'rembourse';
        t.update(pretRef, { rembourse: nouveauRembourse, statut });
      }

      // Rembourse le compteur de plafond si ce dépôt avait été compté dedans.
      if (plafondRef && plafondSnap && plafondSnap.exists && plafondSnap.data().plafond !== null && plafondSnap.data().plafond !== undefined) {
        const cumulActuel = plafondSnap.data().cumul || 0;
        t.update(plafondRef, { cumul: Math.max(0, cumulActuel - tx.montant) });
      }

      return { membreEmail: tx.membreEmail, soldeRestaure, type: tx.type, montant: tx.montant };
    });

    return res.status(200).json({ success: true, ...resultat });
  } catch (err) {
    console.error('Erreur annulation transaction:', err);
    return res.status(400).json({ error: err.message || 'Erreur lors de l\'annulation' });
  }
};
