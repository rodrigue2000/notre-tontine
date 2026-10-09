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

    // 1. Qui appelle VRAIMENT ?
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
    }

    // 2. Quel est son VRAI rôle ?
    const callerDoc = await db.collection('utilisateurs').doc(decoded.uid).get();
    const callerData = callerDoc.exists ? callerDoc.data() : {};
    const callerRole = callerData.role || null;
    const estStaff = ['tresorier', 'president'].includes(callerRole);

    // 3. Validation des données
    // NB : 'remboursement' et les 4 actions 'demande_retrait' ont été fusionnés ici (au lieu
    // d'endpoints séparés) pour rester sous la limite de 12 fonctions serverless du plan
    // gratuit Vercel.
    const {
      type, montant: montantBrut, notes, responsable, pretId, debiterSolde,
      demandeId, preuveUrl, preuveReference, motif,
    } = req.body || {};
    let { membreEmail } = req.body || {};
    const montant = Number(montantBrut);

    // ── Signature Cloudinary (upload direct navigateur → Cloudinary, sans passer par le
    // serveur) — nécessaire car Firebase Storage exige le forfait Blaze, indisponible ici.
    // N'importe quel utilisateur authentifié peut demander une signature ; en pratique seul
    // le formulaire de traitement d'une demande de retrait (réservé aux admins côté UI) s'en
    // sert, et la signature seule ne permet aucune action sur les données de l'app.
    if (type === 'cloudinary_signature') {
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      const apiKey = process.env.CLOUDINARY_API_KEY;
      const apiSecret = process.env.CLOUDINARY_API_SECRET;
      if (!cloudName || !apiKey || !apiSecret) {
        return res.status(500).json({ error: 'Cloudinary non configuré côté serveur (variables d\'environnement manquantes)' });
      }
      const crypto = require('crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const folder = 'preuves-retraits';
      const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest('hex');
      return res.status(200).json({ success: true, signature, timestamp, apiKey, cloudName, folder });
    }

    const TYPES_DEMANDE_RETRAIT = ['traiter_demande_retrait', 'rejeter_demande_retrait', 'confirmer_demande_retrait', 'signaler_demande_retrait'];
    const TYPES_VALIDES = ['depot', 'retrait', 'remboursement', ...TYPES_DEMANDE_RETRAIT];
    if (!TYPES_VALIDES.includes(type)) {
      return res.status(400).json({ error: 'Type invalide' });
    }

    // Taux de frais de retrait, partagé par le retrait "en personne" et le retrait
    // décentralisé — les frais s'appliquent toujours, quel que soit l'admin qui traite.
    const parametresDoc = await db.collection('tontine').doc('parametres').get();
    const fraisRetraitPct = parametresDoc.exists ? (parametresDoc.data().fraisRetrait ?? 3) : 3;

    if (TYPES_DEMANDE_RETRAIT.includes(type)) {
      // Actions sur une demande de retrait décentralisé (voir bloc dédié plus bas) —
      // le montant vient toujours du document de la demande, jamais du client.
      if (!demandeId) return res.status(400).json({ error: 'demandeId requis' });
    } else if (!montant || montant < 1) {
      return res.status(400).json({ error: 'Champs invalides (type, montant requis)' });
    }

    if (type === 'remboursement') {
      if (!pretId) return res.status(400).json({ error: 'pretId requis pour un remboursement' });
      // Autorisé pour le trésorier/président (n'importe quel prêt) ET pour le membre
      // lui-même (uniquement son propre prêt — vérifié plus bas via le token, jamais via
      // membreEmail envoyé par le client).
    } else if (type === 'depot' || type === 'retrait') {
      // Dépôt / retrait "en personne" restent réservés au trésorier/président, comme avant.
      if (!estStaff) return res.status(403).json({ error: 'Accès réservé au trésorier/président' });
      if (!membreEmail) return res.status(400).json({ error: 'membreEmail requis' });
    }

    // ── Actions sur une demande de retrait décentralisé (à distance, initiée par le membre) ──
    // 'traiter_demande_retrait'  : trésorier/président — envoie l'argent puis clôture la
    //                              demande (débite le solde, met à jour son plafond).
    // 'rejeter_demande_retrait'  : trésorier/président — refuse la demande, rien ne bouge.
    // 'confirmer_demande_retrait': le membre confirme avoir reçu l'argent.
    // 'signaler_demande_retrait' : le membre signale ne PAS avoir reçu l'argent → litige.
    if (TYPES_DEMANDE_RETRAIT.includes(type)) {
      const demandeRef = db.collection('demandesRetrait').doc(demandeId);

      if (type === 'traiter_demande_retrait') {
        if (!estStaff) return res.status(403).json({ error: 'Accès réservé au trésorier/président' });
        if (!preuveUrl || !preuveReference) {
          return res.status(400).json({ error: 'La capture de preuve ET la référence de transaction sont obligatoires' });
        }
        const membresRef = db.collection('tontine').doc('membres');
        const plafondRef = db.collection('plafonds').doc(decoded.uid);

        const resultat = await db.runTransaction(async (t) => {
          const demandeSnap = await t.get(demandeRef);
          if (!demandeSnap.exists) throw new Error('Demande introuvable');
          const demande = demandeSnap.data();
          if (demande.statut !== 'en_attente') {
            throw new Error(`Cette demande a déjà été traitée${demande.traiteParNom ? ` par ${demande.traiteParNom}` : ''}`);
          }

          const membresSnap = await t.get(membresRef);
          const soldeAvant = membresSnap.exists ? (membresSnap.data()[demande.membreEmail]?.solde || 0) : 0;
          const dateTraitement = new Date().toISOString();

          // Frais de retrait, toujours appliqués quel que soit l'admin qui traite — le membre
          // reçoit exactement le montant demandé, les frais sont EN PLUS, déduits de son solde.
          const frais = Math.round(demande.montant * fraisRetraitPct / 100);
          const debitTotal = demande.montant + frais;

          // Le solde peut avoir changé depuis la création de la demande (remboursement de
          // prêt, verrouillage, etc.) — dernière vérification avant tout mouvement réel.
          if (debitTotal - soldeAvant > 0.01) {
            t.update(demandeRef, {
              statut: 'annulee',
              motifAnnulation: `Solde disponible insuffisant au moment du traitement (montant ${demande.montant} + frais ${frais} = ${debitTotal} > solde ${soldeAvant})`,
              dateTraitement,
            });
            const notifRef = db.collection('notifications').doc();
            t.set(notifRef, {
              destinataire: demande.membreEmail,
              type: 'demande_retrait_annulee',
              titre: '⚠️ Demande de retrait annulée',
              message: `Votre demande de retrait de ${demande.montant} FCFA (+ ${frais} FCFA de frais) a été annulée : solde disponible insuffisant.`,
              lu: false,
              date: dateTraitement,
              demandeId,
            });
            return { annulee: true, motif: 'solde_insuffisant' };
          }

          const soldeApres = parseFloat((soldeAvant - debitTotal).toFixed(2));
          t.set(membresRef, { [demande.membreEmail]: { solde: soldeApres } }, { merge: true });
          // Un retrait payé par un trésorier "libère" une partie de son plafond de dépôt —
          // seul le montant réellement décaissé compte (pas les frais, qui restent dans la
          // tontine plutôt que sortir de la poche du trésorier). Le cumul peut devenir
          // négatif, en attendant de futurs dépôts (choix assumé).
          t.set(plafondRef, { cumul: admin.firestore.FieldValue.increment(-demande.montant) }, { merge: true });

          const dateLimiteConfirmation = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
          t.update(demandeRef, {
            statut: 'traite',
            traitePar: decoded.uid,
            traiteParNom: callerData.nom || decoded.email || callerRole,
            dateTraitement,
            preuveUrl,
            preuveReference,
            frais,
            confirmationStatut: 'en_attente',
            dateLimiteConfirmation,
          });

          const txRef = db.collection('transactions').doc();
          t.set(txRef, {
            membreEmail: demande.membreEmail,
            type: 'retrait_demande',
            montant: demande.montant,
            frais,
            responsable: callerData.nom || decoded.email || callerRole,
            notes: `Retrait décentralisé — envoyé au ${demande.numeroReception} — réf. ${preuveReference}`,
            date: dateTraitement,
            soldeAvant,
            soldeApres,
            enregistrePar: decoded.uid,
            demandeId,
          });

          const notifRef = db.collection('notifications').doc();
          t.set(notifRef, {
            destinataire: demande.membreEmail,
            type: 'demande_retrait_traitee',
            titre: '💸 Retrait envoyé',
            message: `${demande.montant} FCFA vous ont été envoyés au ${demande.numeroReception} (frais de retrait : ${frais} FCFA, total débité : ${debitTotal} FCFA). Merci de confirmer la réception dans l'app.`,
            lu: false,
            date: dateTraitement,
            demandeId,
          });

          return { annulee: false, soldeAvant, soldeApres, frais, txId: txRef.id };
        });

        return res.status(200).json({ success: true, ...resultat });
      }

      if (type === 'rejeter_demande_retrait') {
        if (!estStaff) return res.status(403).json({ error: 'Accès réservé au trésorier/président' });
        if (!motif) return res.status(400).json({ error: 'Un motif de refus est requis' });

        await db.runTransaction(async (t) => {
          const demandeSnap = await t.get(demandeRef);
          if (!demandeSnap.exists) throw new Error('Demande introuvable');
          const demande = demandeSnap.data();
          if (demande.statut !== 'en_attente') {
            throw new Error(`Cette demande a déjà été traitée${demande.traiteParNom ? ` par ${demande.traiteParNom}` : ''}`);
          }
          const dateTraitement = new Date().toISOString();
          t.update(demandeRef, { statut: 'rejetee', motifRejet: motif, traitePar: decoded.uid, traiteParNom: callerData.nom || decoded.email || callerRole, dateTraitement });
          const notifRef = db.collection('notifications').doc();
          t.set(notifRef, {
            destinataire: demande.membreEmail,
            type: 'demande_retrait_rejetee',
            titre: '❌ Demande de retrait refusée',
            message: `Votre demande de retrait de ${demande.montant} FCFA a été refusée : ${motif}`,
            lu: false,
            date: dateTraitement,
            demandeId,
          });
        });

        return res.status(200).json({ success: true });
      }

      if (type === 'confirmer_demande_retrait' || type === 'signaler_demande_retrait') {
        const callerEmail = (decoded.email || '').toLowerCase();
        await db.runTransaction(async (t) => {
          const demandeSnap = await t.get(demandeRef);
          if (!demandeSnap.exists) throw new Error('Demande introuvable');
          const demande = demandeSnap.data();
          if ((demande.membreEmail || '').toLowerCase() !== callerEmail) {
            throw new Error('Cette demande ne vous appartient pas');
          }
          if (demande.statut !== 'traite' || demande.confirmationStatut !== 'en_attente') {
            throw new Error('Cette demande ne peut plus être confirmée');
          }
          const dateConfirmation = new Date().toISOString();
          if (type === 'confirmer_demande_retrait') {
            t.update(demandeRef, { confirmationStatut: 'confirme', dateConfirmation });
          } else {
            t.update(demandeRef, { confirmationStatut: 'litige', dateConfirmation });
            const notifRef = db.collection('notifications').doc();
            t.set(notifRef, {
              destinataire: 'president',
              type: 'demande_retrait_litige',
              titre: '🚨 Litige sur un retrait',
              message: `${callerData.nom || demande.membreEmail} déclare ne pas avoir reçu ${demande.montant} FCFA (traité par ${demande.traiteParNom || '?'}).`,
              lu: false,
              date: dateConfirmation,
              demandeId,
            });
          }
        });

        return res.status(200).json({ success: true });
      }
    }

    const membresRef = db.collection('tontine').doc('membres');
    const plafondRef = db.collection('plafonds').doc(decoded.uid);
    const pretRef = pretId ? db.collection('prets').doc(pretId) : null;

    // 4. Écriture atomique : lecture des soldes / du prêt / du plafond, puis écriture.
    const resultat = await db.runTransaction(async (t) => {
      let pret = null;

      if (type === 'remboursement') {
        const pretSnap = await t.get(pretRef);
        if (!pretSnap.exists) throw new Error('Prêt introuvable');
        pret = pretSnap.data();
        if (pret.statut !== 'en_cours') throw new Error("Ce prêt n'est plus en cours");

        if (estStaff) {
          // Le trésorier rembourse toujours le prêt lui-même (pas un autre membre "à côté").
          membreEmail = pret.membreEmail;
        } else {
          const callerEmail = (decoded.email || '').toLowerCase();
          if ((pret.membreEmail || '').toLowerCase() !== callerEmail) {
            throw new Error('Vous ne pouvez rembourser que votre propre prêt');
          }
          membreEmail = pret.membreEmail;
        }
      }

      // -- Lectures d'abord (obligatoire avant toute écriture dans une transaction Firestore) --
      const membresSnap = await t.get(membresRef);
      const plafondSnap = type === 'depot' ? await t.get(plafondRef) : null;

      const soldeAvant = membresSnap.exists ? (membresSnap.data()[membreEmail]?.solde || 0) : 0;
      let frais = 0;
      let soldeApres = soldeAvant;
      let debitApplique = false;
      let pretRembourseTotal = null;
      let pretNouveauStatut = null;
      let pretReste = null;

      if (type === 'depot') {
        // Plafond de flux de dépôt du trésorier, défini par le président.
        // S'applique uniquement si un plafond a été explicitement configuré.
        if (plafondSnap && plafondSnap.exists) {
          const { plafond, cumul = 0 } = plafondSnap.data();
          if (plafond !== null && plafond !== undefined) {
            const nouveauCumul = cumul + montant;
            if (nouveauCumul > plafond) {
              const restant = Math.max(plafond - cumul, 0);
              throw new Error(
                `Plafond de dépôt atteint. Il te reste ${restant} FCFA disponibles sur un plafond de ${plafond} FCFA. ` +
                `Demande au président de notifier ton reversement pour rouvrir le compteur.`
              );
            }
          }
        }
        soldeApres = soldeAvant + montant;
      } else if (type === 'retrait') {
        frais = Math.round(montant * fraisRetraitPct / 100);
        const debitTotal = montant + frais;
        if (soldeAvant < debitTotal) {
          throw new Error(
            `Solde insuffisant — retrait ${montant} + frais ${frais} = ${debitTotal} > solde ${soldeAvant}`
          );
        }
        soldeApres = soldeAvant - debitTotal;
      } else {
        // remboursement
        const total = pret.total ?? (pret.montant + (pret.montant * pret.interet) / 100);
        const dejaRembourse = pret.rembourse || 0;
        const reste = parseFloat((total - dejaRembourse).toFixed(2));
        if (montant - reste > 0.01) {
          throw new Error(`Le montant dépasse le reste à payer (${reste})`);
        }
        // Le trésorier choisit (case à cocher côté client) si le remboursement est pris sur
        // le solde du membre (débit) ou remis en espèces (pas de débit). Un membre qui
        // rembourse lui-même est TOUJOURS débité de son propre solde — c'est le seul moyen
        // de rembourser depuis l'app.
        debitApplique = estStaff ? !!debiterSolde : true;
        if (debitApplique) {
          if (montant - soldeAvant > 0.01) throw new Error('Solde disponible insuffisant');
          soldeApres = parseFloat((soldeAvant - montant).toFixed(2));
        }
        pretRembourseTotal = parseFloat((dejaRembourse + montant).toFixed(2));
        pretNouveauStatut = pretRembourseTotal >= total - 0.01 ? 'rembourse' : 'en_cours';
        pretReste = parseFloat((total - pretRembourseTotal).toFixed(2));
      }

      // -- Écritures --
      if (soldeApres !== soldeAvant) {
        t.set(membresRef, { [membreEmail]: { solde: soldeApres } }, { merge: true });
      }

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        membreEmail,
        type,
        montant,
        frais,
        responsable: responsable || decoded.email || callerRole,
        notes: type === 'remboursement'
          ? `Remboursement prêt${debitApplique ? ' (débité du solde disponible)' : ' (espèces / hors solde)'}${notes ? ` — ${notes}` : ''}`
          : (notes || ''),
        date: new Date().toISOString(),
        soldeAvant,
        soldeApres,
        enregistrePar: decoded.uid, // traçabilité + utilisé pour le plafond
        ...(pretId ? { pretId } : {}),
      });

      if (type === 'depot' && plafondSnap && plafondSnap.exists && plafondSnap.data().plafond !== null && plafondSnap.data().plafond !== undefined) {
        t.update(plafondRef, { cumul: admin.firestore.FieldValue.increment(montant) });
      }

      if (type === 'remboursement') {
        t.update(pretRef, { rembourse: pretRembourseTotal, statut: pretNouveauStatut });

        // Notification : le staff notifie le membre, le membre notifie le président
        // (les trésoriers voient aussi les notifications 'president', comme partout
        // ailleurs dans l'app).
        const notifRef = db.collection('notifications').doc();
        if (estStaff) {
          t.set(notifRef, {
            destinataire: membreEmail,
            type: 'remboursement_enregistre',
            titre: '💰 Remboursement enregistré',
            message: pretNouveauStatut === 'rembourse'
              ? `Un remboursement de ${montant} FCFA a été enregistré — votre prêt est totalement soldé 🎉`
              : `Un remboursement de ${montant} FCFA a été enregistré sur votre prêt — reste ${pretReste} FCFA.`,
            lu: false,
            date: new Date().toISOString(),
            pretId,
          });
        } else {
          t.set(notifRef, {
            destinataire: 'president',
            type: 'remboursement_membre',
            titre: '💰 Remboursement reçu',
            message: pretNouveauStatut === 'rembourse'
              ? `${callerData.nom || membreEmail} a remboursé ${montant} FCFA et a totalement soldé son prêt.`
              : `${callerData.nom || membreEmail} a remboursé ${montant} FCFA sur son prêt (reste ${pretReste} FCFA).`,
            lu: false,
            date: new Date().toISOString(),
            pretId,
          });
        }
      }

      return {
        soldeAvant,
        soldeApres,
        frais,
        txId: txRef.id,
        ...(type === 'remboursement' ? {
          pretRembourseTotal,
          pretNouveauStatut,
          pretReste,
          debiterSolde: debitApplique,
        } : {}),
      };
    });

    return res.status(200).json({ success: true, ...resultat });
  } catch (err) {
    console.error('Erreur transaction manuelle:', err);
    return res.status(400).json({ error: err.message || 'Erreur lors de la transaction' });
  }
};
