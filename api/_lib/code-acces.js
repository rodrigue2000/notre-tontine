// api/_lib/code-acces.js
//
// Calcule un code d'accès de 8 caractères, qui change chaque jour à minuit (heure du
// Bénin, UTC+1), à partir de la date + d'un secret connu seulement du serveur
// (CODE_ACCES_SECRET). Rien n'est stocké en base : le code se recalcule à la volée,
// à l'identique, à chaque appel — donc rien à synchroniser, rien à faire expirer
// manuellement.
//
// Alphabet volontairement sans caractères ambigus à l'oral/à l'écrit (pas de 0/O,
// pas de 1/I) puisque ce code sera dicté oralement par le président à un trésorier.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 33 caractères, sans 0,O,1,I
const LONGUEUR_CODE = 8;

function calculerCode(dateStr, secret) {
  const hash = crypto.createHmac('sha256', secret).update(dateStr).digest('hex');
  let code = '';
  for (let i = 0; i < LONGUEUR_CODE; i++) {
    const octet = parseInt(hash.substr(i * 2, 2), 16);
    code += ALPHABET[octet % ALPHABET.length];
  }
  return code;
}

// Date du jour au format 'YYYY-MM-DD', en heure du Bénin (UTC+1, pas de changement d'heure)
function dateBenin(offsetJours = 0) {
  const maintenant = new Date(Date.now() + offsetJours * 24 * 3600 * 1000);
  const heureBenin = new Date(maintenant.getTime() + 60 * 60 * 1000); // UTC+1
  return heureBenin.toISOString().slice(0, 10);
}

function heureActuelleBenin() {
  return new Date(Date.now() + 60 * 60 * 1000).getUTCHours();
}

// Renvoie la liste des codes actuellement valides.
// Avant midi (heure du Bénin), le code de la veille reste valable en plus de celui
// du jour — pour éviter qu'un code donné à 23h50 devienne inutilisable 10 minutes après.
function codesValides(secret) {
  const codeAujourdhui = calculerCode(dateBenin(0), secret);
  if (heureActuelleBenin() < 12) {
    const codeHier = calculerCode(dateBenin(-1), secret);
    return [codeAujourdhui, codeHier];
  }
  return [codeAujourdhui];
}

function verifierCode(codeFourni, secret) {
  if (!codeFourni) return false;
  const normalise = String(codeFourni).toUpperCase().trim();
  return codesValides(secret).includes(normalise);
}

module.exports = { calculerCode, codesValides, verifierCode, dateBenin };
