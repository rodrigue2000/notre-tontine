// api/accepter-negociation-verrouillage.js
//
// Le membre a reçu une contre-proposition de taux du président sur sa demande de
// verrouillage et l'accepte. Cette action DÉBITE réellement son solde disponible —
// elle ne peut donc pas se faire par une écriture Firestore directe depuis le
// navigateur du membre (les règles de sécurité l'interdisent, à raison : impossible
// de garantir depuis le client que le montant/taux n'ont pas été modifiés avant l'envoi).
//
// Ce endpoint revérifie tout côté serveur avec les droits admin, exactement comme
// activerVerrouillage() côté client le fait pour le président — mais ici on ne
// fait confiance à rien qui vient du navigateur à part l'identité du membre
// (prouvée par son token Firebase Auth) et l'ID du verrouillage à activer.
//
// Variables d'environnement nécessaires (déjà présentes sur ce projet) :
//   FIREBASE_SERVICE_ACCOUNT_JSON

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  // ─── 1. Authentifier l'appelant ───
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'Token manquant' });
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token invalide' });
  }
  const callerEmail = decoded.email;

  const { verrouillageId } = req.body || {};
  if (!verrouillageId) {
    return res.status(400).json({ ok: false, error: 'verrouillageId manquant' });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const vRef = db.collection('verrouillages').doc(verrouillageId);
      const vDoc = await tx.get(vRef);
      if (!vDoc.exists) throw new Error('Verrouillage introuvable');
      const v = vDoc.data();

      // ─── 2. Vérifier que c'est bien LE membre concerné qui accepte SA propre négociation ───
      if (v.membreEmail !== callerEmail) {
        throw new Error('Ce verrouillage ne vous appartient pas');
      }
      if (v.statut !== 'negociation') {
        throw new Error(`Ce verrouillage n'est pas en attente de négociation (statut actuel : ${v.statut})`);
      }

      const tauxFinal = v.tauxPropose || v.taux;
      const montant = v.montant || 0;

      // ─── 3. Revérifier le solde à jour (pas celui envoyé par le client — on ne lui fait pas confiance) ───
      const membresRef = db.collection('tontine').doc('membres');
      const membresDoc = await tx.get(membresRef);
      const membresData = membresDoc.exists ? membresDoc.data() : {};
      const membreActuel = membresData[callerEmail];
      if (!membreActuel) throw new Error('Membre introuvable');
      const soldeActuel = membreActuel.solde || 0;
      if (montant > soldeActuel) {
        throw new Error(`Solde disponible insuffisant (${soldeActuel} FCFA) pour verrouiller ${montant} FCFA`);
      }

      const now = new Date().toISOString();
      const nouveauSolde = soldeActuel - montant;

      tx.set(membresRef, { [callerEmail]: { ...membreActuel, solde: nouveauSolde } }, { merge: true });
      tx.update(vRef, {
        statut: 'actif',
        taux: tauxFinal,
        dateApprobation: now,
        approuvePar: 'membre'
      });
      tx.set(db.collection('transactions').doc(), {
        membreEmail: callerEmail,
        type: 'verrouillage',
        montant: montant,
        responsable: 'membre (négociation acceptée)',
        notes: `Verrouillage activé — ${v.dureeMois} mois, taux ${tauxFinal}%`,
        date: now
      });
      tx.set(db.collection('notifications').doc(), {
        destinataire: 'president',
        type: 'verrouillage_accepte',
        titre: '✅ Négociation acceptée',
        message: `${v.membreNom || callerEmail} a accepté le taux proposé de ${tauxFinal}%.`,
        lu: false,
        date: now,
        verrouillageId: verrouillageId
      });

      return { taux: tauxFinal };
    });

    return res.status(200).json({ ok: true, taux: result.taux });
  } catch (e) {
    console.error('Erreur activation négociation :', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
};
