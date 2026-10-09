// api/coffre-alimenter.js
//
// Transfère un montant du solde disponible d'un membre vers l'un de ses coffres
// d'épargne ciblée. Comme pour le verrouillage, ce mouvement d'argent ne peut pas se
// faire par une écriture Firestore directe depuis le navigateur — toujours revérifié
// et exécuté côté serveur.
//
// Cas particulier : si cette alimentation fait atteindre (ou dépasser) l'objectif du
// coffre, celui-ci "se casse" automatiquement — tout son contenu repart immédiatement
// sur le solde disponible du membre, prêt à être dépensé pour le projet visé.
//
// Variables d'environnement nécessaires (déjà présentes sur ce projet) :
//   FIREBASE_SERVICE_ACCOUNT_JSON

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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

  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ ok: false, error: 'Token manquant' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token invalide' });
  }
  const callerEmail = decoded.email;

  const { coffreId, montant } = req.body || {};
  const montantNum = Number(montant);
  if (!coffreId || !montantNum || montantNum <= 0) {
    return res.status(400).json({ ok: false, error: 'coffreId et montant (positif) requis' });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const coffreRef = db.collection('coffres').doc(coffreId);
      const coffreDoc = await tx.get(coffreRef);
      if (!coffreDoc.exists) throw new Error('Coffre introuvable');
      const coffre = coffreDoc.data();

      if (coffre.membreEmail !== callerEmail) throw new Error('Ce coffre ne vous appartient pas');
      if (coffre.statut !== 'actif') throw new Error('Ce coffre n\'est plus actif');

      const membresRef = db.collection('tontine').doc('membres');
      const membresDoc = await tx.get(membresRef);
      const membresData = membresDoc.exists ? membresDoc.data() : {};
      const membreActuel = membresData[callerEmail];
      if (!membreActuel) throw new Error('Membre introuvable');
      const soldeActuel = membreActuel.solde || 0;
      if (montantNum > soldeActuel) {
        throw new Error(`Solde disponible insuffisant (${soldeActuel} FCFA) pour transférer ${montantNum} FCFA`);
      }

      const now = new Date().toISOString();
      const montantActuelApres = (coffre.montantActuel || 0) + montantNum;
      const objectifAtteint = montantActuelApres >= coffre.objectif;

      // Débit du solde pour le transfert vers le coffre
      let nouveauSolde = soldeActuel - montantNum;
      tx.set(db.collection('transactions').doc(), {
        membreEmail: callerEmail, type: 'coffre_depot', montant: montantNum,
        responsable: callerEmail, notes: `Alimentation du coffre "${coffre.nom}"`, date: now
      });

      if (objectifAtteint) {
        // Le coffre est plein : tout son contenu repart immédiatement sur le solde
        nouveauSolde += montantActuelApres;
        tx.update(coffreRef, { montantActuel: 0, statut: 'atteint', dateAtteinte: now });
        tx.set(db.collection('transactions').doc(), {
          membreEmail: callerEmail, type: 'coffre_atteint', montant: montantActuelApres,
          responsable: 'Système', notes: `Objectif atteint pour "${coffre.nom}" — montant reversé au solde`, date: now
        });
        tx.set(db.collection('notifications').doc(), {
          destinataire: callerEmail, type: 'coffre_atteint',
          titre: '🎉 Objectif atteint !',
          message: `Ton coffre "${coffre.nom}" a atteint son objectif de ${coffre.objectif} FCFA. Le montant est de retour sur ton solde disponible.`,
          lu: false, date: now
        });
      } else {
        tx.update(coffreRef, { montantActuel: montantActuelApres });
      }

      tx.set(membresRef, { [callerEmail]: { ...membreActuel, solde: nouveauSolde } }, { merge: true });

      return { montantActuel: objectifAtteint ? 0 : montantActuelApres, objectifAtteint, soldeApres: nouveauSolde };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('Erreur alimentation coffre :', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
};
